// §11 / §26(14–16): the Scheduled Proactive Sweep.
//
// The sweep's job is the states that change WITHOUT an event: a deadline
// arriving, a wait going stale, a case stalling. None of those send an email,
// and the reactive engine is built entirely around things that do.
//
// The six invariants of §11.2 are the structure of this file, because they are
// the structure of the module. D is the one that looks like bookkeeping and is
// not: without it the sweep claims and releases the same head of the queue for
// ever — 10 716 runs over 101 cases in 24 hours was the measured cost of that
// exact shape in the reactive engine, and this sweep would reproduce it one
// layer up, with a model call attached to each pass.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { roundRobinByDomain, starvedDomains } from '../cos/fair-interleave.js'
import {
  ensureSweepSchema, selectCandidates, claimCandidate, releaseCandidate,
  cursorRegressions, SWEEP_REVIEW_BACKOFF_SEC, STALE_WAIT_SEC, STALL_RUN_THRESHOLD,
} from '../cos/proactive/sweep.js'

const T0 = 1_700_000_000
const DAY = 86400

function setup(): void {
  initDatabase(':memory:')
  initProgressionSchema(getDb())
  ensureSweepSchema(getDb())
}

/** A personal case with a due deadline. */
function dueCase(id: string, dueAt = T0 - DAY): void {
  const db = getDb()
  createCase(db, { caseId: id, title: id, caseType: 'ADMIN' }, T0 - 10 * DAY)
  db.prepare(`UPDATE personal_cases SET due_at = ? WHERE case_id = ?`).run(dueAt, id)
}

function dueZstCase(id: string, dueAt = T0 - DAY): void {
  const db = getDb()
  createZstCase(db, { caseId: id, title: id, caseType: 'ADMIN' }, T0 - 10 * DAY)
  db.prepare(`UPDATE zst_cases SET due_at = ? WHERE case_id = ?`).run(dueAt, id)
}

describe('§11.1 candidate selection comes from indexed sources', () => {
  beforeEach(setup)

  it('HEADLINE: finds a due deadline with no event behind it', () => {
    dueCase('c1')
    const r = selectCandidates(getDb(), T0)
    expect(r.candidates.map(c => c.caseId)).toEqual(['c1'])
    expect(r.candidates[0].reason).toBe('DEADLINE_DUE')
  })

  it('finds a stale wait', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c1', caseType: 'ADMIN' }, T0 - 100 * DAY)
    db.prepare(`UPDATE personal_cases SET status='WAITING_EXTERNAL', updated_at=? WHERE case_id='c1'`)
      .run(T0 - STALE_WAIT_SEC - DAY)
    const r = selectCandidates(db, T0)
    expect(r.candidates[0]).toMatchObject({ caseId: 'c1', reason: 'STALE_WAIT' })
  })

  it('finds a stalled case from the counter the engine already maintains', () => {
    // §25's audit found `no_progress_run_count` present and maintained. Reusing
    // it rather than counting again is the brownfield rule of §3: a second
    // stall counter would be a second answer to one question.
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c1', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
         no_progress_run_count, created_at, updated_at)
       VALUES ('personal','c1',1,'internal',?,?,?)`,
    ).run(STALL_RUN_THRESHOLD, T0 - DAY, T0 - DAY)
    expect(selectCandidates(db, T0).candidates[0]).toMatchObject({ reason: 'STALLED' })
  })

  it('a case that is BOTH stalled and overdue is one candidate, not two', () => {
    // Counting it twice would inflate every number in §11.3 at once, and the
    // owner would see one situation twice.
    const db = getDb()
    dueCase('c1')
    db.prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
         no_progress_run_count, created_at, updated_at)
       VALUES ('personal','c1',1,'internal',?,?,?)`,
    ).run(STALL_RUN_THRESHOLD, T0 - DAY, T0 - DAY)
    const r = selectCandidates(db, T0)
    expect(r.candidates).toHaveLength(1)
    // The more binding reason wins.
    expect(r.candidates[0].reason).toBe('DEADLINE_DUE')
  })

  it('a deadline in the future is not due yet', () => {
    dueCase('c1', T0 + 30 * DAY)
    expect(selectCandidates(getDb(), T0).candidates).toHaveLength(0)
  })
})

describe('§11.2 A fairness — neither domain may starve', () => {
  beforeEach(setup)

  it('HEADLINE: a large personal backlog does not consume the whole budget', () => {
    // The failure this exists for: enumerate personal in full, then zst, then
    // slice. With any personal backlog at all the corporate half is never
    // reached — not "later", never, because the same sweeps refill the backlog.
    for (let i = 0; i < 10; i++) dueCase(`p${i}`)
    dueZstCase('z1')
    const r = selectCandidates(getDb(), T0, { limit: 4 })
    expect(r.candidates.filter(c => c.domain === 'zst')).toHaveLength(1)
    expect(r.starvationDetected).toEqual([])
  })

  it('starvation is "had candidates, got zero" — not "got fewer"', () => {
    // Interleaving guarantees a fair split of what fits, and an odd budget has
    // to go somewhere. An alarm on every uneven split would fire constantly and
    // be muted, which is how the real signal gets lost.
    const items = [{ domain: 'personal' }, { domain: 'personal' }, { domain: 'zst' }]
    expect(starvedDomains(items, roundRobinByDomain(items, 2))).toEqual([])
    expect(starvedDomains(items, roundRobinByDomain(items, 1))).toEqual(['zst'])
  })
})

describe('§11.2 C no silent truncation', () => {
  beforeEach(setup)

  it('HEADLINE: the bound says what it left behind, and how to reach it', () => {
    for (let i = 0; i < 10; i++) dueCase(`p${String(i).padStart(2, '0')}`)
    const r = selectCandidates(getDb(), T0, { limit: 3 })
    expect(r.candidates).toHaveLength(3)
    expect(r.hasMore).toBe(true)
    expect(r.nextCursor).toBe(3)
    expect(r.domainLag.personal).toBe(7)
    expect(r.dueBacklogDepth).toBe(10)
    expect(r.silentTruncationCount).toBe(0)
  })

  it('the continuation cursor reaches the rest, without repeating', () => {
    for (let i = 0; i < 6; i++) dueCase(`p${i}`)
    const first = selectCandidates(getDb(), T0, { limit: 3 })
    const second = selectCandidates(getDb(), T0, { limit: 3, after: first.nextCursor! })
    const ids = [...first.candidates, ...second.candidates].map(c => c.caseId)
    expect(new Set(ids).size).toBe(6)
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
    expect(second.continuationDepth).toBe(3)
  })

  it('backlog age is measured, not just depth', () => {
    dueCase('old', T0 - 30 * DAY)
    dueCase('new', T0 - DAY)
    const r = selectCandidates(getDb(), T0, { limit: 1 })
    expect(r.oldestUnprocessedAge).toBe(30 * DAY)
  })
})

describe('§11.2 E priority fairness — never read order', () => {
  beforeEach(setup)

  it('HEADLINE: a legal cliff outranks a wake note, whatever the read order', () => {
    // The precedence comes from the §10.2 deadline index, where it is assigned
    // by HOW BINDING a deadline is rather than by how soon it falls. Inherited
    // rather than re-invented, so the sweep and the question queue cannot end up
    // with two subtly different notions of urgent.
    const db = getDb()
    createZstCase(db, { caseId: 'z-contract', title: 'z', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(
      `INSERT INTO zst_contracts (contract_id, case_id, title, termination_deadline, created_at, updated_at)
       VALUES ('k1','z-contract','Szerzodes','2023-01-01',?,?)`,
    ).run(T0 - DAY, T0 - DAY)
    dueZstCase('z-due', T0 - 100 * DAY)
    const r = selectCandidates(db, T0)
    expect(r.candidates[0].caseId).toBe('z-contract')
  })

  it('is deterministic — the same store yields the same page every time', () => {
    // What makes a continuation cursor mean anything. A page that shuffles
    // between calls turns "the next three" into "three more, maybe some of the
    // same".
    for (let i = 0; i < 5; i++) dueCase(`p${i}`, T0 - DAY)
    const a = selectCandidates(getDb(), T0, { limit: 3 }).candidates.map(c => c.caseId)
    const b = selectCandidates(getDb(), T0, { limit: 3 }).candidates.map(c => c.caseId)
    expect(b).toEqual(a)
  })
})

describe('§11.2 D due-state advancement — the infinite-loop guard', () => {
  beforeEach(setup)

  it('HEADLINE: a swept candidate is NOT immediately due again', () => {
    // The invariant that keeps the whole sweep from becoming the 10 716-run
    // shape. Release and advance are one operation precisely because they were
    // two in the engine that produced that number.
    dueCase('c1')
    expect(claimCandidate(getDb(), 'personal', 'c1', 'sweep-1', T0)).toBe(true)
    expect(releaseCandidate(getDb(), 'personal', 'c1', 'sweep-1', 'PROCESSED', T0)).toBe(true)
    const row = getDb().prepare(
      `SELECT next_review_at, claimed_by FROM proactive_sweep_state WHERE case_id='c1'`,
    ).get() as { next_review_at: number; claimed_by: string | null }
    expect(row.claimed_by).toBeNull()
    expect(row.next_review_at).toBe(T0 + SWEEP_REVIEW_BACKOFF_SEC)
  })

  it('a NO_OP backs off further than a PROCESSED one — but never to never', () => {
    dueCase('c1'); dueCase('c2')
    claimCandidate(getDb(), 'personal', 'c1', 's', T0)
    releaseCandidate(getDb(), 'personal', 'c1', 's', 'NO_OP', T0)
    claimCandidate(getDb(), 'personal', 'c2', 's', T0)
    releaseCandidate(getDb(), 'personal', 'c2', 's', 'PROCESSED', T0)
    const rows = getDb().prepare(
      `SELECT case_id, next_review_at, no_op_count FROM proactive_sweep_state ORDER BY case_id`,
    ).all() as Array<{ case_id: string; next_review_at: number; no_op_count: number }>
    expect(rows[0].next_review_at).toBeGreaterThan(rows[1].next_review_at)
    expect(rows[0].no_op_count).toBe(1)
    // Bounded: it comes back, just later.
    expect(rows[0].next_review_at).toBeLessThan(T0 + 7 * DAY)
  })

  it('a scheduled review becomes a candidate again when it comes due', () => {
    dueCase('c1')
    claimCandidate(getDb(), 'personal', 'c1', 's', T0)
    releaseCandidate(getDb(), 'personal', 'c1', 's', 'PROCESSED', T0)
    // The deadline is still overdue, so the case is still a candidate — but now
    // for a reason that has a schedule behind it.
    const later = selectCandidates(getDb(), T0 + SWEEP_REVIEW_BACKOFF_SEC + 1)
    expect(later.candidates.map(c => c.caseId)).toContain('c1')
  })
})

describe('§11.2 F claim idempotency', () => {
  beforeEach(setup)

  it('HEADLINE: two sweeps cannot both claim one candidate', () => {
    dueCase('c1')
    expect(claimCandidate(getDb(), 'personal', 'c1', 'sweep-A', T0)).toBe(true)
    expect(claimCandidate(getDb(), 'personal', 'c1', 'sweep-B', T0)).toBe(false)
  })

  it('an expired lease frees the candidate — a crashed sweep does not pin it', () => {
    dueCase('c1')
    claimCandidate(getDb(), 'personal', 'c1', 'sweep-A', T0)
    expect(claimCandidate(getDb(), 'personal', 'c1', 'sweep-B', T0 + 10_000)).toBe(true)
  })

  it('only the holder may release — a late release from a dead sweep is refused', () => {
    dueCase('c1')
    claimCandidate(getDb(), 'personal', 'c1', 'sweep-A', T0)
    expect(releaseCandidate(getDb(), 'personal', 'c1', 'sweep-B', 'PROCESSED', T0)).toBe(false)
    expect(releaseCandidate(getDb(), 'personal', 'c1', 'sweep-A', 'PROCESSED', T0)).toBe(true)
  })
})

describe('§11.2 B monotonic cursor', () => {
  beforeEach(setup)

  it('HEADLINE: a late release cannot rewind a cursor a newer sweep moved', () => {
    // The shape this defends against: sweep A's lease expires, sweep B claims,
    // works and releases at T+2. Sweep A then wakes and releases at T+1. Under a
    // plain assignment the cursor would go backwards, and every rule that reads
    // "when did we last look" would be reading a lie.
    dueCase('c1')
    claimCandidate(getDb(), 'personal', 'c1', 'B', T0)
    releaseCandidate(getDb(), 'personal', 'c1', 'B', 'PROCESSED', T0 + 2000)
    claimCandidate(getDb(), 'personal', 'c1', 'A', T0 + 2001)
    releaseCandidate(getDb(), 'personal', 'c1', 'A', 'PROCESSED', T0 + 1000)
    const row = getDb().prepare(`SELECT review_cursor FROM proactive_sweep_state WHERE case_id='c1'`)
      .get() as { review_cursor: number }
    expect(row.review_cursor).toBe(T0 + 2000)
  })

  it('§11.3: cursor_regression_count is computed, and is zero', () => {
    // A number nobody computes is not a zero — and production acceptance
    // requires this one to BE zero.
    dueCase('c1')
    claimCandidate(getDb(), 'personal', 'c1', 's', T0)
    releaseCandidate(getDb(), 'personal', 'c1', 's', 'PROCESSED', T0)
    expect(cursorRegressions(getDb())).toBe(0)
  })
})

describe('§11.3 observability', () => {
  beforeEach(setup)

  it('reports every counter the spec names, on an empty store too', () => {
    const r = selectCandidates(getDb(), T0)
    expect(Object.keys(r).sort()).toEqual([
      'candidates', 'claimedCount', 'completedCount', 'continuationDepth',
      'cursorRegressionCount', 'dueBacklogDepth', 'domainLag', 'hasMore',
      'nextCursor', 'noOpCount', 'oldestUnprocessedAge', 'retryCount',
      'silentTruncationCount', 'starvationDetected',
    ].sort())
    expect(r.oldestUnprocessedAge).toBe(0)
    expect(r.starvationDetected).toEqual([])
  })

  it('selection writes nothing — it is a read', () => {
    dueCase('c1')
    selectCandidates(getDb(), T0)
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM proactive_sweep_state`).get()).toEqual({ n: 0 })
  })
})
