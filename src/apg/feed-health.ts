// APG 1.9 §35 -- the live feed's health, READ BACK from the kernel's own store.
//
// §35's second requirement is not that the feed writes a liveness signal; it is
// that the signal is "a dashboardon látható, és amelynek elakadása észlelhető".
// A liveness row nobody renders is a log line. This module is the read side:
// `src/apg/live-feed.ts` schedules the cycle, the kernel's `live_ingest.py`
// records what happened, and this turns those rows into the two sentences a
// human needs -- is the feed alive, and has Stage 1 actually started.
//
// THE ONE THING TO WATCH: THESE THRESHOLDS ARE A SECOND COPY. The stall window,
// the seven days and the twenty items are defined in the kernel
// (`live_ingest.DEFAULT_STALL_AFTER_SECONDS`, `REQUIRED_OBSERVATION_DAYS`,
// `REQUIRED_ELIGIBLE_WORK_ITEMS`) and again here, because a TypeScript read
// path cannot import a Python constant. That is exactly the drift this
// codebase has been bitten by before, so it is handled the way
// `apg-projection-contract.test.ts` already handles the shared enums: a
// cross-repo contract test reads the kernel source and asserts these three
// numbers against it. If the kernel changes a threshold and this file does not,
// the test goes red rather than the dashboard quietly reporting FRESH about a
// feed the kernel considers stalled.
//
// WHY NOT ASK THE KERNEL. Because the answer depends on `now`, and the kernel
// writes only immutable facts -- a stored "rollout_stage" would be a verdict
// frozen at write time that goes stale by the second. The facts are stored, the
// verdict is derived on read, on both sides, from the same numbers.
//
// DEGRADATION. Every read here is defensive and returns an UNAVAILABLE state
// rather than throwing: a kernel that is not installed, a database that predates
// migration 0021, a locked file. All three mean the same thing for §35's
// purposes -- there is no evidence this deployment is measuring anything -- and
// all three report `rollout_stage: NOT_STARTED, reason: OBSERVE_NOT_FED`, which
// is what §35 asks for and is never softened into "probably fine".

import type Database from 'better-sqlite3'
import { openApgKernelReadonly } from './ui-projection.js'

/** Kernel `live_ingest.DEFAULT_STALL_AFTER_SECONDS` (3 missed hourly cycles). */
export const APG_FEED_STALL_AFTER_SECONDS = 3 * 60 * 60
/** Kernel `live_ingest.REQUIRED_OBSERVATION_DAYS` -- §35's seven CONSECUTIVE days. */
export const REQUIRED_OBSERVATION_DAYS = 7
/** Kernel `live_ingest.REQUIRED_ELIGIBLE_WORK_ITEMS` -- §35's twenty. */
export const REQUIRED_ELIGIBLE_WORK_ITEMS = 20

/** Kernel `live_ingest.LIVENESS_STATES`, plus the read-side-only UNAVAILABLE. */
export type ApgFeedState = 'FRESH' | 'STALLED' | 'NEVER_RUN' | 'UNAVAILABLE'

export interface ApgFeedHealth {
  state: ApgFeedState
  /** §35's own words for an unfed observe mode. */
  rollout_stage: 'NOT_STARTED' | 'STAGE_1_IN_PROGRESS'
  reason: 'OBSERVE_NOT_FED' | 'OBSERVE_FED'
  last_run_at: number | null
  last_run_status: string | null
  last_success_at: number | null
  items_ingested_last_success: number | null
  seconds_since_success: number | null
  /** §35.3's countable number, straight out of the kernel's query. */
  eligible_work_items: number
  required_eligible_work_items: number
  /** §35's "7 egymást követő naptári nap", as a streak ending on the newest day. */
  consecutive_observation_days: number
  required_observation_days: number
  /** One sentence a human can act on. */
  detail: string
}

function unavailable(detail: string): ApgFeedHealth {
  return {
    state: 'UNAVAILABLE',
    rollout_stage: 'NOT_STARTED',
    reason: 'OBSERVE_NOT_FED',
    last_run_at: null,
    last_run_status: null,
    last_success_at: null,
    items_ingested_last_success: null,
    seconds_since_success: null,
    eligible_work_items: 0,
    required_eligible_work_items: REQUIRED_ELIGIBLE_WORK_ITEMS,
    consecutive_observation_days: 0,
    required_observation_days: REQUIRED_OBSERVATION_DAYS,
    detail,
  }
}

/**
 * The consecutive-day streak ending on the newest measured day.
 *
 * Exported because it is the one piece of arithmetic here that is easy to get
 * subtly wrong across a month boundary, and a test that could not call it
 * directly would have to construct eight days of fixture rows to check
 * February. Mirrors the kernel's `consecutive_observation_days`.
 */
export function consecutiveDayStreak(days: readonly string[]): number {
  if (days.length === 0) return 0
  const sorted = [...days].sort()
  let streak = 1
  for (let i = sorted.length - 1; i > 0; i--) {
    const gap = (Date.parse(`${sorted[i]}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`)) / 86_400_000
    if (gap !== 1) break
    streak++
  }
  return streak
}

/**
 * Build the feed health from an OPEN kernel connection. `nowSec` is supplied by
 * the caller so the derivation is testable without a clock.
 */
export function buildApgFeedHealth(db: Database.Database, nowSec: number): ApgFeedHealth {
  let newest: { started_at: number; status: string; items_ingested: number } | undefined
  let newestOk: { started_at: number; items_ingested: number } | undefined
  let days: string[] = []
  let eligible = 0
  try {
    newest = db.prepare(
      'SELECT started_at, status, items_ingested FROM ingest_runs ORDER BY started_at DESC, rowid DESC LIMIT 1',
    ).get() as typeof newest
    newestOk = db.prepare(
      "SELECT started_at, items_ingested FROM ingest_runs WHERE status = 'OK' ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get() as typeof newestOk
    days = (db.prepare(
      "SELECT DISTINCT strftime('%Y-%m-%d', started_at, 'unixepoch') AS day FROM ingest_runs WHERE status = 'OK' ORDER BY day",
    ).all() as Array<{ day: string }>).map((r) => r.day)
    // The kernel's `count_eligible_work_items`: the LATEST observation per work
    // item, folded. Re-expressed rather than re-invented -- an eligibility count
    // that ignored later observations would keep counting archived cards.
    eligible = (db.prepare(`
      SELECT COUNT(DISTINCT e.work_item_id) AS n
      FROM work_item_eligibility e
      JOIN (SELECT work_item_id, MAX(observed_at) AS newest FROM work_item_eligibility GROUP BY work_item_id) latest
        ON latest.work_item_id = e.work_item_id AND latest.newest = e.observed_at
      WHERE e.eligibility = 'ELIGIBLE'
    `).get() as { n: number }).n
  } catch {
    return unavailable(
      'the APG kernel store has no WP6 feed tables: either the kernel is older than migration 0021 or it has never been migrated on this host',
    )
  }

  const streak = consecutiveDayStreak(days)
  const base = {
    eligible_work_items: eligible,
    required_eligible_work_items: REQUIRED_ELIGIBLE_WORK_ITEMS,
    consecutive_observation_days: streak,
    required_observation_days: REQUIRED_OBSERVATION_DAYS,
  }

  if (!newest) {
    return {
      ...base,
      state: 'NEVER_RUN',
      rollout_stage: 'NOT_STARTED',
      reason: 'OBSERVE_NOT_FED',
      last_run_at: null,
      last_run_status: null,
      last_success_at: null,
      items_ingested_last_success: null,
      seconds_since_success: null,
      detail: 'the live feed has never run: the ingest is not wired on this host',
    }
  }
  const secondsSinceSuccess = newestOk ? nowSec - newestOk.started_at : null
  const stalled = secondsSinceSuccess === null || secondsSinceSuccess > APG_FEED_STALL_AFTER_SECONDS
  return {
    ...base,
    state: stalled ? 'STALLED' : 'FRESH',
    rollout_stage: stalled ? 'NOT_STARTED' : 'STAGE_1_IN_PROGRESS',
    reason: stalled ? 'OBSERVE_NOT_FED' : 'OBSERVE_FED',
    last_run_at: newest.started_at,
    last_run_status: newest.status,
    last_success_at: newestOk?.started_at ?? null,
    items_ingested_last_success: newestOk?.items_ingested ?? null,
    seconds_since_success: secondsSinceSuccess,
    detail: stalled
      ? (newestOk
        ? `the last successful ingest was ${secondsSinceSuccess}s ago, past the ${APG_FEED_STALL_AFTER_SECONDS}s stall threshold`
        : `the feed is running (last attempt ${newest.status}) and has never succeeded; observe mode is measuring nothing`)
      : `last successful ingest ${secondsSinceSuccess}s ago, ${newestOk?.items_ingested ?? 0} item(s) ingested`,
  }
}

/** Open the kernel read-only, build the health, close. Never throws. */
export function readApgFeedHealth(nowSec: number): ApgFeedHealth {
  const db = openApgKernelReadonly()
  if (!db) {
    return unavailable(
      'no APG kernel store is readable on this host, so nothing is feeding observe mode',
    )
  }
  try {
    return buildApgFeedHealth(db, nowSec)
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err))
  } finally {
    try { db.close() } catch { /* a failed reader must not escape */ }
  }
}

/**
 * §15.2's count, from the WRITER that finally exists.
 *
 * The UI has had a `done_not_accepted` badge since 1.8 and it was computed from
 * the SHAPE of the transition log -- a change whose latest transition targeted
 * `done` and whose display state was not `accepted`. That was the best available
 * signal when nothing recorded a completion claim and nothing recorded an
 * acceptance verdict. Both now exist, so the count is a query over them:
 * work items with a producer claim whose newest verification is not ACCEPTED
 * (and, deliberately, items claimed but never verified -- an unverified claim is
 * DONE_NOT_ACCEPTED, because §15.2's second field is empty until the chain
 * fills it, and reporting UNKNOWN would let "nobody has checked" read as
 * "possibly accepted").
 *
 * Returns null when the tables are absent, so the caller can keep the old
 * shape-based count on an un-migrated kernel rather than reporting a false 0.
 */
export function readDoneNotAcceptedCount(db: Database.Database): number | null {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT c.work_item_id AS work_item_id,
               (SELECT v.acceptance_status FROM completion_verifications v
                 WHERE v.work_item_id = c.work_item_id
                 ORDER BY v.verified_at DESC, v.rowid DESC LIMIT 1) AS status
        FROM completion_claims c GROUP BY c.work_item_id
      ) WHERE status IS NULL OR status != 'ACCEPTED'
    `).get() as { n: number }
    return row.n
  } catch {
    return null
  }
}
