// APG 1.9 §35 (WP6) -- the scheduled live feed, and the liveness it is judged by.
//
// THE FINDING THIS FILE COVERS is the 1.8 conformance audit's summary of the
// whole APG deployment: "ami ma valós Marveen-munka ellen fut, az egy kézzel
// indított szkript hét átmásolt kártyán". `a1_pilot.poll_and_ingest` was real,
// tested and had no production caller, so observe mode measured nothing.
//
// FOUR THINGS ARE ASSERTED HERE, and only the first is about behaviour:
//
//  1. THE CALL SITE EXISTS. A test that only exercised the tick would pass just
//     as happily with the web.ts mount deleted -- which is precisely the state
//     the audit found for `poll_and_ingest`. So the mount is asserted at the
//     source level, the same standard costops-collector-schedule-wiring.test.ts
//     applies to the provider collectors.
//
//  2. THE CHILD IS SPAWNED ASYNCHRONOUSLY. `ops/scheduled-tasks/
//     costops-alert-monitor/check.py` records the incident in its own header:
//     the schedule-runner used `spawnSync`, which blocks the Node event loop,
//     and the child called the dashboard's own HTTP API -- which cannot be
//     served while the loop is blocked. Every scheduled run timed out. The APG
//     feed reads /api/kanban from this very dashboard, so it is the same shape
//     exactly, and the synchronous spawn forms are asserted ABSENT.
//
//  3. THE FEED IS PACED FROM STORED HISTORY, not an in-memory timer, so a
//     restart does not re-hammer the source.
//
//  4. A STALL IS DETECTABLE, and an unfed observe mode reports §35's own words.
//
// No subprocess is spawned by any test in this file: the tick's two side
// effects (reading the last run, kicking the child) are injectable seams, and
// the production defaults are what `apgFeedTickSafely` uses when they are not
// injected.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  apgFeedTickSafely, isApgFeedDue, resolveApgKernelRoot, resolveApgFeedScript,
  APG_FEED_CADENCE_SECONDS, APG_FEED_TICK_MS,
} from '../apg/live-feed.js'
import {
  buildApgFeedHealth, consecutiveDayStreak, readDoneNotAcceptedCount,
  APG_FEED_STALL_AFTER_SECONDS, REQUIRED_OBSERVATION_DAYS, REQUIRED_ELIGIBLE_WORK_ITEMS,
} from '../apg/feed-health.js'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8')

const T0 = 1784281157
const HOUR = 3600
const DAY = 24 * HOUR

// ---------------------------------------------------------------------------
// 1 + 2: the wiring, and the deadlock lesson
// ---------------------------------------------------------------------------

describe('§35: the feed has a production caller (the whole 1.8 finding)', () => {
  const WEB = read('../web.ts')
  const FEED = read('../apg/live-feed.ts')

  it('HEADLINE: web.ts starts the APG live feed at boot', () => {
    expect(WEB).toMatch(/import \{ startApgLiveFeed \} from '\.\/apg\/live-feed\.js'/)
    expect(WEB).toMatch(/const apgFeedIntervals = webOnly \? \[\] : startApgLiveFeed\(\)/)
    // ...and the intervals are cleared on shutdown, like every other runner's.
    expect(WEB).toMatch(/apgFeedIntervals\.forEach\(clearInterval\)/)
  })

  it('the cycle is spawned ASYNCHRONOUSLY -- the costops-alert-monitor deadlock', () => {
    // The child calls this dashboard's own HTTP API. A synchronous spawn blocks
    // the event loop that would have to serve it: fails=15 on every scheduled
    // run while manual runs succeeded. See ops/scheduled-tasks/
    // costops-alert-monitor/check.py's own header for the incident.
    expect(FEED).toMatch(/import \{ execFile \} from 'node:child_process'/)
    // Matched on the CALL and on the import list, not on the bare word: the
    // module's header names `spawnSync` when explaining the incident, and that
    // paragraph is the most useful thing in the file.
    for (const synchronous of ['spawnSync', 'execFileSync', 'execSync']) {
      expect(FEED).not.toMatch(new RegExp(`\\b${synchronous}\\s*\\(`))
      expect(FEED).not.toMatch(new RegExp(`import \\{[^}]*${synchronous}`))
    }
  })

  it('the incident it is guarding against is still recorded where it happened', () => {
    // If this file is ever deleted or rewritten, the reason for the async spawn
    // becomes folklore. Asserting the source note keeps the two together.
    const monitor = read('../../ops/scheduled-tasks/costops-alert-monitor/check.py')
    expect(monitor).toMatch(/spawnSync/)
    expect(monitor).toMatch(/deadlock/)
  })

  it('a cycle has a timeout, so a wedged child cannot accumulate one per tick', () => {
    expect(FEED).toMatch(/timeout: APG_FEED_TIMEOUT_MS/)
  })
})

// ---------------------------------------------------------------------------
// 3: due-checking from stored history
// ---------------------------------------------------------------------------

describe('§35.1: the feed runs on a schedule, paced by stored history', () => {
  it('a feed that never ran is due; one inside its cadence is not', () => {
    expect(isApgFeedDue(null, T0)).toBe(true)
    expect(isApgFeedDue(T0, T0 + APG_FEED_CADENCE_SECONDS - 1)).toBe(false)
    expect(isApgFeedDue(T0, T0 + APG_FEED_CADENCE_SECONDS)).toBe(true)
  })

  it('the tick kicks a cycle when due and stays silent when not', () => {
    const kicks: string[] = []
    const deps = { spawnCycle: (root: string) => { kicks.push(root) }, lastRunAt: () => null }

    expect(apgFeedTickSafely({ ...deps, now: () => T0 }).state).toBe('ran')
    expect(kicks).toHaveLength(1)

    const notDue = apgFeedTickSafely({
      spawnCycle: (root: string) => { kicks.push(root) },
      lastRunAt: () => T0,
      now: () => T0 + 60,
    })
    expect(notDue.state).toBe('not_due')
    expect(notDue.reason).toMatch(/^NOT_DUE_UNTIL:/)
    expect(kicks).toHaveLength(1)
  })

  it('the tick NEVER throws, whatever the seams do', () => {
    const result = apgFeedTickSafely({
      lastRunAt: () => { throw new Error('kernel database is locked') },
      spawnCycle: () => { /* unreached */ },
    })
    expect(result.state).toBe('kernel_absent')
    expect(result.reason).toBe('TICK_THREW')
  })

  it('with no kernel installed the feed is INERT WITH A NAMED REASON, not quietly fine', () => {
    // The honesty requirement. A host with no kernel checkout cannot feed
    // anything, and saying nothing would be indistinguishable from a feed that
    // ran and found no work.
    const previous = process.env.APG_KERNEL_ROOT
    process.env.APG_KERNEL_ROOT = join(__dirname, 'no-such-kernel-root')
    try {
      const result = apgFeedTickSafely({ lastRunAt: () => null, now: () => T0 })
      expect(result.state).toBe('kernel_absent')
      expect(result.reason).toMatch(/^KERNEL_NOT_PRESENT:/)
      expect(resolveApgFeedScript(resolveApgKernelRoot())).toMatch(/apg_feed\.py$/)
    } finally {
      if (previous === undefined) delete process.env.APG_KERNEL_ROOT
      else process.env.APG_KERNEL_ROOT = previous
    }
  })

  it('the tick interval is bounded and the cadence is the kernel\'s hour', () => {
    expect(APG_FEED_TICK_MS).toBeGreaterThan(0)
    expect(APG_FEED_CADENCE_SECONDS).toBe(HOUR)
  })
})

// ---------------------------------------------------------------------------
// 4: the liveness signal read back
// ---------------------------------------------------------------------------

/** A kernel store with just the two WP6 feed tables, matching migration 0021. */
function kernelStore(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE ingest_runs (
      id TEXT PRIMARY KEY, feed TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL, status TEXT NOT NULL, reason_code TEXT NOT NULL,
      work_items_seen INTEGER NOT NULL, items_ingested INTEGER NOT NULL,
      eligible_work_items INTEGER NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE work_item_eligibility (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, feed TEXT NOT NULL,
      source TEXT NOT NULL, source_ref TEXT, eligibility TEXT NOT NULL,
      reason_code TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  return db
}

function recordRun(db: Database.Database, startedAt: number, status: string, items = 1): void {
  db.prepare(`INSERT INTO ingest_runs (id, feed, started_at, finished_at, status, reason_code,
    work_items_seen, items_ingested, eligible_work_items, detail, created_at)
    VALUES (?, 'marveen-kanban', ?, ?, ?, 'FEED_COMPLETED', 1, ?, 0, '', ?)`)
    .run(`marveen-kanban|${startedAt}`, startedAt, startedAt, status, items, startedAt)
}

function observe(db: Database.Database, workItem: string, at: number, eligibility: string): void {
  db.prepare(`INSERT INTO work_item_eligibility (id, work_item_id, feed, source, source_ref,
    eligibility, reason_code, observed_at, created_at)
    VALUES (?, ?, 'marveen-kanban', 'kanban_card_event', ?, ?, 'LIVE_EVIDENCE_INGESTED', ?, ?)`)
    .run(`${workItem}|${at}`, workItem, `kanban:${workItem}`, eligibility, at, at)
}

describe('§35.2: the liveness signal is visible and a stall is detectable', () => {
  let db: Database.Database
  beforeEach(() => { db = kernelStore() })

  it('a fresh feed reports STAGE_1_IN_PROGRESS / OBSERVE_FED', () => {
    recordRun(db, T0, 'OK', 4)
    const health = buildApgFeedHealth(db, T0 + 60)
    expect(health.state).toBe('FRESH')
    expect(health.rollout_stage).toBe('STAGE_1_IN_PROGRESS')
    expect(health.reason).toBe('OBSERVE_FED')
    expect(health.items_ingested_last_success).toBe(4)
    expect(health.seconds_since_success).toBe(60)
  })

  it('HEADLINE: a stalled feed reports §35\'s exact words', () => {
    recordRun(db, T0, 'OK')
    const health = buildApgFeedHealth(db, T0 + APG_FEED_STALL_AFTER_SECONDS + 1)
    expect(health.state).toBe('STALLED')
    // §35: "rollout_stage = NOT_STARTED / reason = OBSERVE_NOT_FED", and NOT
    // some softer word -- the spec's point is that a stopped system and an
    // early one must not share a status.
    expect(health.rollout_stage).toBe('NOT_STARTED')
    expect(health.reason).toBe('OBSERVE_NOT_FED')
  })

  it('a feed that runs hourly and never succeeds is stalled, not fresh', () => {
    // The failure a naive "when did it last run" check would miss.
    for (let i = 0; i < 4; i++) recordRun(db, T0 + i * HOUR, 'NO_SOURCE', 0)
    const health = buildApgFeedHealth(db, T0 + 4 * HOUR)
    expect(health.state).toBe('STALLED')
    expect(health.last_run_at).toBe(T0 + 3 * HOUR)      // the scheduler IS calling it
    expect(health.last_run_status).toBe('NO_SOURCE')
    expect(health.last_success_at).toBeNull()            // ...and it is reaching nothing
    expect(health.detail).toMatch(/never succeeded/)
  })

  it('a feed that never ran is NEVER_RUN, which is a different problem', () => {
    const health = buildApgFeedHealth(db, T0)
    expect(health.state).toBe('NEVER_RUN')
    expect(health.rollout_stage).toBe('NOT_STARTED')
  })

  it('a kernel with no WP6 tables reports UNAVAILABLE, never a false FRESH', () => {
    const bare = new Database(':memory:')
    const health = buildApgFeedHealth(bare, T0)
    expect(health.state).toBe('UNAVAILABLE')
    expect(health.rollout_stage).toBe('NOT_STARTED')
    expect(health.reason).toBe('OBSERVE_NOT_FED')
  })
})

describe('§35.3: the eligible work item is counted by query', () => {
  let db: Database.Database
  beforeEach(() => { db = kernelStore() })

  it('the count folds the LATEST observation per work item', () => {
    recordRun(db, T0, 'OK')
    observe(db, 'card-a', T0, 'ELIGIBLE')
    observe(db, 'card-b', T0, 'ELIGIBLE')
    observe(db, 'card-c', T0, 'INELIGIBLE')
    expect(buildApgFeedHealth(db, T0 + 60).eligible_work_items).toBe(2)

    // card-a is archived on a later pass: a NEW observation, not an edit.
    observe(db, 'card-a', T0 + HOUR, 'INELIGIBLE')
    expect(buildApgFeedHealth(db, T0 + HOUR + 60).eligible_work_items).toBe(1)
    // ...and the history is intact, so the window stays reconstructable.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM work_item_eligibility').get() as { n: number }
    expect(rows.n).toBe(4)
  })

  it('the promotion thresholds are reported alongside the counts', () => {
    recordRun(db, T0, 'OK')
    const health = buildApgFeedHealth(db, T0 + 60)
    expect(health.required_eligible_work_items).toBe(REQUIRED_ELIGIBLE_WORK_ITEMS)
    expect(health.required_observation_days).toBe(REQUIRED_OBSERVATION_DAYS)
    expect(REQUIRED_ELIGIBLE_WORK_ITEMS).toBe(20)
    expect(REQUIRED_OBSERVATION_DAYS).toBe(7)
  })

  it('the observation window counts CONSECUTIVE days only', () => {
    // §35 says "7 EGYMÁST KÖVETŐ naptári nap"; a scattered seven is not evidence
    // of continuous operation.
    for (const day of [0, 1, 2, 4, 5, 6, 7]) recordRun(db, T0 + day * DAY, 'OK')
    expect(buildApgFeedHealth(db, T0 + 7 * DAY + 60).consecutive_observation_days).toBe(4)
  })

  it('the streak arithmetic survives a month boundary', () => {
    expect(consecutiveDayStreak(['2026-01-30', '2026-01-31', '2026-02-01'])).toBe(3)
    expect(consecutiveDayStreak(['2026-01-30', '2026-02-01'])).toBe(1)
    expect(consecutiveDayStreak([])).toBe(0)
  })

  it('a day the feed failed does not count towards the window', () => {
    recordRun(db, T0, 'OK')
    recordRun(db, T0 + DAY, 'NO_SOURCE', 0)
    recordRun(db, T0 + 2 * DAY, 'OK')
    // Two measured days, and they are NOT consecutive -- the middle day the feed
    // reached nothing is a day with no measurement.
    expect(buildApgFeedHealth(db, T0 + 2 * DAY + 60).consecutive_observation_days).toBe(1)
  })
})

describe('§15.2: done_not_accepted has a writer behind it', () => {
  it('counts claims whose newest verification is not ACCEPTED, and unverified ones', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE completion_claims (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL);
      CREATE TABLE completion_verifications (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL,
        acceptance_status TEXT NOT NULL, verified_at INTEGER NOT NULL
      );
    `)
    db.prepare('INSERT INTO completion_claims VALUES (?, ?)').run('c1', 'card-a')
    db.prepare('INSERT INTO completion_claims VALUES (?, ?)').run('c2', 'card-b')
    db.prepare('INSERT INTO completion_claims VALUES (?, ?)').run('c3', 'card-c')
    // card-a: verified and refused. card-b: accepted. card-c: never verified.
    db.prepare('INSERT INTO completion_verifications VALUES (?, ?, ?, ?)')
      .run('v1', 'card-a', 'DONE_NOT_ACCEPTED', T0)
    db.prepare('INSERT INTO completion_verifications VALUES (?, ?, ?, ?)')
      .run('v2', 'card-b', 'ACCEPTED', T0)

    // An unverified claim counts: §15.2's second field is empty until the chain
    // fills it, and reporting it as unknown would let "nobody has checked yet"
    // read as "possibly accepted".
    expect(readDoneNotAcceptedCount(db)).toBe(2)
  })

  it('returns null on a kernel with no WP6 tables, so the caller can fall back', () => {
    // A false 0 would report perfect acceptance on the one deployment shape
    // that cannot measure it.
    expect(readDoneNotAcceptedCount(new Database(':memory:'))).toBeNull()
  })
})
