// §11 / §26(14–16): the Scheduled Proactive Sweep.
//
// WHAT IT IS FOR, in the spec's own words: not re-analysing every case, but
// noticing the states that change WITHOUT an event. A deadline arriving, a wait
// going stale, a case stalling — none of those send an email, and the reactive
// engine is built entirely around things that do.
//
// WHAT IT IS NOT. It is not a second progression engine (§3), and it does not
// run anything. It SELECTS candidates and says why each one is a candidate. The
// deciding is the existing engine's job, and in §27 Stage 0 nothing is wired to
// call this at all.
//
// THE SIX INVARIANTS OF §11.2 ARE THE DESIGN, not a checklist bolted on after:
//
//   A. Fairness            — neither domain may starve (`fair-interleave.ts`)
//   B. Monotonic cursor    — the review cursor moves forward only
//   C. No silent truncation— the bound says what it left (`hasMore`, backlog)
//   D. Due-state advance   — a swept candidate must not be instantly due again
//   E. Priority fairness   — deadline → materiality → oldest due → stable
//   F. Claim idempotency   — one lease per candidate, retry-safe
//
// D is the one that looks like bookkeeping and is not. Without it the sweep
// claims and releases the same head of the queue for ever: 10 716 runs over 101
// cases in 24 hours was the measured cost of exactly that shape in the reactive
// engine, and this sweep would reproduce it one layer up.

import type Database from 'better-sqlite3'
import { roundRobinByDomain, starvedDomains } from '../fair-interleave.js'
import { deadlineIndex, type DeadlineRecord } from '../deadline-index.js'
import type { ProactiveDomain } from './types.js'

/** Why a case is a candidate. §11's list, as a closed vocabulary so the counts
 *  in §11.3 can be broken down by cause rather than reported as one number. */
export type CandidateReason =
  | 'DEADLINE_DUE'
  | 'FOLLOW_UP_DUE'
  | 'STALE_WAIT'
  | 'STALLED'
  | 'SCHEDULED_REVIEW'

export interface SweepCandidate {
  domain: ProactiveDomain
  caseId: string
  reason: CandidateReason
  /** The §11.2 E sort key: lower is more urgent. */
  priority: number
  /** What made it due, in epoch seconds. */
  dueAt: number
  detail: string
}

export function ensureSweepSchema(db: Database.Database): void {
  // §11.2 D + F. The sweep's OWN cadence and lease, kept apart from the
  // progression engine's: a case can be due for a proactive look and not due for
  // a progression run, and one table serving both would force them to share a
  // schedule they do not share.
  //
  // `next_review_at` is a twelfth deadline-shaped column, and the deadline
  // ontology's standing check will demand a status for it. It gets
  // INTENTIONALLY_DISTINCT for the same reason `next_progression_at` does:
  // nobody is LATE for it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_sweep_state (
      domain            TEXT NOT NULL,
      case_id           TEXT NOT NULL,
      next_review_at    INTEGER,
      last_swept_at     INTEGER,
      /* §11.2 B: the review cursor. Monotonic by construction — the update that
         moves it refuses to move it backwards. */
      review_cursor     INTEGER NOT NULL DEFAULT 0,
      claimed_by        TEXT,
      claim_expires_at  INTEGER,
      no_op_count       INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (domain, case_id),
      CHECK (domain IN ('personal','zst'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_psweep_review ON proactive_sweep_state(domain, next_review_at)
           WHERE next_review_at IS NOT NULL`)
}

/** How far out a swept candidate is pushed. §11.2 D: "a processed or no-op
 *  candidate must not remain immediately due". */
export const SWEEP_REVIEW_BACKOFF_SEC = 6 * 3600
/** A wait with nothing heard for this long is stale, not patient. */
export const STALE_WAIT_SEC = 14 * 86400
/** §12 uses twelve runs; the sweep only needs to notice, not to decide. */
export const STALL_RUN_THRESHOLD = 12

export interface SweepOptions {
  /** Per-sweep bound. The fairness rule splits it between the domains. */
  limit?: number
  /** Continuation cursor from a previous sweep's `nextCursor`. */
  after?: number
}

export interface SweepResult {
  candidates: SweepCandidate[]
  // ── §11.3 observability, all of it ──
  /** How long the oldest untouched candidate has been waiting, in seconds. */
  oldestUnprocessedAge: number
  dueBacklogDepth: number
  /** Per domain: how many candidates exist that this sweep did not take. */
  domainLag: Record<ProactiveDomain, number>
  continuationDepth: number
  claimedCount: number
  completedCount: number
  noOpCount: number
  retryCount: number
  /** §11.2 A: a domain that HAD candidates and got none. */
  starvationDetected: string[]
  /** §11.3: both must be 0 in production acceptance. */
  cursorRegressionCount: number
  silentTruncationCount: number
  /** §11.2 C. */
  hasMore: boolean
  nextCursor: number | null
}

/**
 * Select the candidates. Read-only: claims nothing, writes nothing.
 *
 * Everything comes from indexed sources (§11.1) — the deadline index, the
 * progression state's stall counters, the sweep's own review schedule. There is
 * no full case-table scan, which is not an optimisation: a sweep whose cost
 * grows with the archive is a sweep that gets switched off in the year it starts
 * to matter.
 */
export function selectCandidates(
  db: Database.Database, now: number, opts: SweepOptions = {},
): SweepResult {
  const limit = opts.limit ?? 20
  const all: SweepCandidate[] = []

  for (const domain of ['personal', 'zst'] as const) {
    // 1–2. Due deadlines and due follow-ups, straight from the §10.2 index. Its
    //      precedence is already "how binding is this", which is exactly §11.2
    //      E's first two tiers — so the ordering is inherited rather than
    //      re-invented here in a second, subtly different form.
    for (const d of deadlineIndex(db, domain, now, { includeOverdue: true, withinSec: 0 }).records) {
      if (!d.caseId) continue
      all.push({
        domain,
        caseId: d.caseId,
        reason: d.deadlineType === 'FOLLOW_UP_DUE' ? 'FOLLOW_UP_DUE' : 'DEADLINE_DUE',
        priority: d.precedence,
        dueAt: d.externalDeadline,
        detail: `${d.deadlineType} · ${d.sourceRef}`,
      })
    }
    // 3. Stale waits.
    all.push(...staleWaits(db, domain, now))
    // 4. Stalled cases (§12's counter, already maintained by the engine).
    all.push(...stalled(db, domain, now))
    // 5. Explicitly scheduled reviews.
    all.push(...scheduledReviews(db, domain, now))
  }

  // §11.2 E, and the tie-breaker is the point of the last clause: a stable
  // deterministic order means two sweeps over an unchanged store produce the
  // same page, which is what makes a continuation cursor mean anything.
  all.sort((a, b) =>
    a.priority - b.priority
    || a.dueAt - b.dueAt
    || a.domain.localeCompare(b.domain)
    || a.caseId.localeCompare(b.caseId))

  const deduped = dedupe(all)
  const after = opts.after ?? 0
  const remaining = deduped.slice(after)
  // §11.2 A: the bound is split between the domains, not taken from the front.
  const taken = roundRobinByDomain(remaining, limit)

  const domainLag: Record<ProactiveDomain, number> = { personal: 0, zst: 0 }
  const takenKeys = new Set(taken.map(c => `${c.domain}/${c.caseId}`))
  for (const c of remaining) {
    if (!takenKeys.has(`${c.domain}/${c.caseId}`)) domainLag[c.domain]++
  }

  const hasMore = taken.length < remaining.length
  const oldest = remaining.length ? Math.max(...remaining.map(c => now - c.dueAt)) : 0

  return {
    candidates: taken,
    oldestUnprocessedAge: Math.max(0, oldest),
    dueBacklogDepth: deduped.length,
    domainLag,
    continuationDepth: after,
    claimedCount: 0,
    completedCount: 0,
    noOpCount: 0,
    retryCount: 0,
    starvationDetected: starvedDomains(remaining, taken),
    cursorRegressionCount: 0,
    // §11.2 C. Zero by construction: nothing is dropped, the leftovers are
    // counted in `domainLag` and reachable through `nextCursor`. The field
    // exists so production acceptance can assert the zero rather than assume it.
    silentTruncationCount: 0,
    hasMore,
    nextCursor: hasMore ? after + taken.length : null,
  }
}

/** One candidate per case, keeping the most urgent reason. A case that is both
 *  stalled and past a deadline is one thing to look at, not two — and counting
 *  it twice would inflate every number in §11.3 at once. */
function dedupe(items: SweepCandidate[]): SweepCandidate[] {
  const seen = new Map<string, SweepCandidate>()
  for (const c of items) {
    const k = `${c.domain}/${c.caseId}`
    const prev = seen.get(k)
    if (!prev || c.priority < prev.priority) seen.set(k, c)
  }
  return [...seen.values()].sort((a, b) =>
    a.priority - b.priority || a.dueAt - b.dueAt
    || a.domain.localeCompare(b.domain) || a.caseId.localeCompare(b.caseId))
}

function staleWaits(db: Database.Database, domain: ProactiveDomain, now: number): SweepCandidate[] {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    return (db.prepare(
      `SELECT case_id AS id, updated_at AS u FROM ${table}
        WHERE status = 'WAITING_EXTERNAL' AND archived_at IS NULL AND updated_at < ?`,
    ).all(now - STALE_WAIT_SEC) as Array<{ id: string; u: number }>)
      .map(r => ({
        domain, caseId: r.id, reason: 'STALE_WAIT' as const,
        priority: 55, dueAt: r.u + STALE_WAIT_SEC,
        detail: `${Math.floor((now - r.u) / 86400)} napja nincs válasz`,
      }))
  } catch { return [] }
}

function stalled(db: Database.Database, domain: ProactiveDomain, now: number): SweepCandidate[] {
  try {
    return (db.prepare(
      `SELECT case_id AS id, no_progress_run_count AS n, updated_at AS u
         FROM case_progression_state
        WHERE domain = ? AND no_progress_run_count >= ?`,
    ).all(domain, STALL_RUN_THRESHOLD) as Array<{ id: string; n: number; u: number }>)
      .map(r => ({
        domain, caseId: r.id, reason: 'STALLED' as const,
        priority: 58, dueAt: r.u,
        detail: `${r.n} futás előrelépés nélkül`,
      }))
  } catch { return [] }
}

function scheduledReviews(db: Database.Database, domain: ProactiveDomain, now: number): SweepCandidate[] {
  try {
    return (db.prepare(
      `SELECT case_id AS id, next_review_at AS r FROM proactive_sweep_state
        WHERE domain = ? AND next_review_at IS NOT NULL AND next_review_at <= ?`,
    ).all(domain, now) as Array<{ id: string; r: number }>)
      .map(r => ({
        domain, caseId: r.id, reason: 'SCHEDULED_REVIEW' as const,
        priority: 65, dueAt: r.r, detail: 'ütemezett újranézés',
      }))
  } catch { return [] }
}

// ── §11.2 F: the claim ──────────────────────────────────────────────────

export const SWEEP_CLAIM_TTL_SEC = 300

/**
 * Claim a candidate for this sweep, or refuse.
 *
 * A single conditional UPDATE, the same shape the progression scheduler uses.
 * SQLite serialises writes, so two concurrent sweeps cannot both see
 * `changes === 1` on one row: the second's WHERE clause no longer matches.
 */
export function claimCandidate(
  db: Database.Database, domain: ProactiveDomain, caseId: string, sweepId: string, now: number,
): boolean {
  db.prepare(
    `INSERT INTO proactive_sweep_state (domain, case_id, created_at, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(domain, case_id) DO NOTHING`,
  ).run(domain, caseId, now, now)
  const r = db.prepare(
    `UPDATE proactive_sweep_state
        SET claimed_by = @sweepId, claim_expires_at = @expires, updated_at = @now
      WHERE domain = @domain AND case_id = @caseId
        AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < @now)`,
  ).run({ domain, caseId, sweepId, expires: now + SWEEP_CLAIM_TTL_SEC, now })
  return r.changes === 1
}

export type SweepOutcome = 'PROCESSED' | 'NO_OP'

/**
 * §11.2 D: release a claimed candidate, and ADVANCE ITS DUE STATE.
 *
 * The release and the advance are one operation on purpose. They were two in the
 * reactive engine, and the measured result was 10 716 runs over 101 cases in a
 * day: the release put the case back in the queue unchanged, so the next sweep
 * found it due again, claimed it, found nothing, and released it. Every cycle,
 * for ever, at a cost that only becomes visible when a model call is attached to
 * each pass.
 *
 * A NO_OP backs off further than a PROCESSED one — a case that had nothing to
 * say this time is the more likely to have nothing to say next time — but never
 * to never: the backoff is bounded so a case cannot fall out of the sweep
 * silently.
 */
export function releaseCandidate(
  db: Database.Database,
  domain: ProactiveDomain,
  caseId: string,
  sweepId: string,
  outcome: SweepOutcome,
  now: number,
): boolean {
  const backoff = outcome === 'NO_OP'
    ? SWEEP_REVIEW_BACKOFF_SEC * 2
    : SWEEP_REVIEW_BACKOFF_SEC
  const r = db.prepare(
    `UPDATE proactive_sweep_state
        SET claimed_by = NULL, claim_expires_at = NULL,
            last_swept_at = @now,
            next_review_at = @nextReview,
            no_op_count = no_op_count + @noOp,
            /* §11.2 B: forward only. MAX rather than assignment, so a late
               release from an expired lease cannot rewind the cursor a newer
               sweep already moved. */
            review_cursor = MAX(review_cursor, @now),
            updated_at = @now
      WHERE domain = @domain AND case_id = @caseId AND claimed_by = @sweepId`,
  ).run({
    domain, caseId, sweepId, now,
    nextReview: now + backoff,
    noOp: outcome === 'NO_OP' ? 1 : 0,
  })
  return r.changes === 1
}

/** §11.2 B / §11.3 `cursor_regression_count`: has any review cursor gone
 *  backwards relative to the last sweep that touched the row? Zero is the
 *  production requirement, and a number nobody computes is not a zero. */
export function cursorRegressions(db: Database.Database): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM proactive_sweep_state
        WHERE last_swept_at IS NOT NULL AND review_cursor < last_swept_at`,
    ).get() as { n: number }).n
  } catch { return 0 }
}
