// Autonomous Case Progression Layer v1.1 — Wait/Wake scheduling + claim/lease.
// Checkpoint E.3 (card b29f99d2, epic 2aab1221).
//
// Provides the scheduling and concurrency-control primitives for the
// progression runner loop:
//
//   scheduleNextProgression()    — set next_progression_at after a WAIT_TIME decision
//   findDueCases()               — discover cases ready for progression (read-only)
//   tryClaimProgression()        — atomically claim ONE due case (concurrency-safe)
//   releaseProgressionClaim()    — release claim after a run completes
//   extendProgressionLease()     — extend a running claim's expiry
//
// All operations are domain-scoped (domainGuard reuse) and ZERO side effects:
// write ONLY to case_progression_state columns (next_progression_at,
// progression_claimed_by, progression_claim_expires_at, updated_at).
//
// Concurrency safety: claim is a SINGLE conditional UPDATE within a transaction.
// SQLite serializes writes — two concurrent runners cannot both pass the WHERE
// clause and get changes()=1. The UNIQUE(domain, case_id) primary key and the
// WHERE guard on progression_claimed_by/progression_claim_expires_at together
// provide the atomicity guarantee.
//
// HARD INVARIANTS (Checkpoint E.3 scope):
//   - ZERO side effects: no writes to personal_cases/zst_cases, no email, no send
//   - Domain-scoped everywhere (CrossDomainReadError on cross-domain operations)
//   - progression_enabled stays at its current value (this module reads it; the
//     owning pipeline sets it — see runProgressionCycle in progression-pipeline.ts)

import type Database from 'better-sqlite3'
import { evaluateWaitCondition } from './wait-condition.js'
import type { ProgressionMode } from './outbound-mode-gate.js'
import { domainGuard } from './progression-resolver.js'

// ── Wake scheduling ──────────────────────────────────────────────────────

/** Set (or clear) the next progression wake-up time for a case.
 *
 *  Called after a WAIT_TIME decision to schedule the next progression
 *  attempt, or after a COMPLETE / terminal decision to clear the wake time.
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function scheduleNextProgression(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  nextProgressionAt: number | null,
  now: number,
): void {
  domainGuard(db, domain, caseId, 'scheduleNextProgression')

  db.prepare(
    `UPDATE case_progression_state
     SET next_progression_at = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(nextProgressionAt, now, domain, caseId)
}

/** Push a case's next check OUT, without ever pulling it in or resurrecting a
 *  case that has been taken off the schedule.
 *
 *  scheduleNextProgression is unconditional, which is right for "arm this wait"
 *  and wrong for "come back later": the heartbeat calls this after a sweep, and
 *  the same sweep may have COMPLETED the case (next_progression_at set to NULL,
 *  progression disabled). An unconditional write there would put a finished case
 *  back into the queue. So this only moves a case that is still scheduled, still
 *  enabled, and currently due.
 *
 *  Returns true when the check was actually moved. */
export function deferProgression(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  nextProgressionAt: number,
  now: number,
): boolean {
  const r = db.prepare(
    `UPDATE case_progression_state
     SET next_progression_at = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_enabled = 1
       AND next_progression_at IS NOT NULL
       AND next_progression_at <= ?`,
  ).run(nextProgressionAt, now, domain, caseId, now)
  return r.changes === 1
}

// ── Due-case discovery ───────────────────────────────────────────────────

export interface DueCase {
  case_id: string
  next_progression_at: number
  /** True if currently claimed by another runner (and claim is not expired). */
  claimed_by_other: boolean
  /** §10.4 closure C (owner, 2026-08-27). Which band this case was selected in.
   *  Reported rather than inferred: "it ran" and "it ran because it had just
   *  been woken" are different facts, and a starvation counter that cannot tell
   *  them apart measures nothing. */
  band?: DueBand
}

/**
 * Selection bands, in priority order.
 *
 * WHY BANDS AND NOT A BIGGER LIMIT. The observed defect was NOT the size of the
 * page. `next_progression_at ASC` orders by freshness, and ARMING a wait pushes
 * that value FORWARD -- so a wait that has just been satisfied sorts to the BACK
 * of the queue it most needs to be at the front of. Measured live on 2026-08-27:
 * 49 and 50 cases due, and 49 sorting ahead of each active typed wait. Raising
 * the bound moves the cliff; it does not move the ordering.
 */
export const DUE_BANDS = ['WOKEN', 'DEADLINE', 'NORMAL'] as const
export type DueBand = typeof DUE_BANDS[number]

/**
 * How many of one page each band may take.
 *
 * BOUNDED AND FAIR, both deliberately. Unbounded priority is starvation with
 * extra steps: a hundred satisfied waits would then fill every page and the
 * ordinary queue would never move -- the same failure, pointed the other way.
 * So each band has a floor of the page, and whatever a band does not use is
 * given back to the ones below it rather than wasted.
 */
export const BAND_SHARE: Record<DueBand, number> = {
  WOKEN: 0.5,
  DEADLINE: 0.25,
  NORMAL: 0.25,
}

/** Find cases that are due for progression (next_progression_at <= now,
 *  progression_enabled = 1) in a domain. Returns cases ordered by
 *  next_progression_at ascending (oldest due first).
 *
 *  Read-only — does NOT claim. Call tryClaimProgression() to atomically
 *  reserve a case from the returned set.
 *
 *  Domain-scoped: reads only from the given domain's rows (no cross-domain
 *  leakage possible — the WHERE domain = ? clause is the scope boundary). */
export function findDueCases(
  db: Database.Database,
  domain: 'personal' | 'zst',
  now: number,
  limit: number = 50,
): DueCase[] {
  return findDuePage(db, domain, now, limit).cases
}

/** One page of due cases, and what the page LEFT BEHIND.
 *
 *  §11 C-invariant: a bounded read has to say the bound was reached. The plain
 *  array cannot — a caller receiving 50 cases cannot tell "these are all of
 *  them" from "these are the first 50 of 400", and the heartbeat's report has
 *  said "processed 50" for both cases since it was written. Those two states
 *  need different responses: one is a healthy sweep, the other is a backlog
 *  that the sweep interval alone will never drain. */
export interface DuePage {
  cases: DueCase[]
  /** Due cases in this domain, ignoring the bound. */
  totalDue: number
  /** True when the bound cut the list short. */
  hasMore: boolean
  /** Due cases this page did not return. Zero on a complete sweep. */
  remaining: number
  /** §10.4 closure C metrics. The owner named all six; they are computed at
   *  SELECTION time because that is where the starvation happens, and a metric
   *  gathered afterwards cannot see what was not chosen. */
  metrics: DueMetrics
}

export interface DueMetrics {
  /** Due cases, ignoring the bound. */
  backlog: number
  /** Seconds since the oldest due case became due. 0 when nothing is due. */
  oldestDueAgeSec: number
  /** Selected this page, per band. */
  selected: Record<DueBand, number>
  /** Due in each band, ignoring the bound. */
  due: Record<DueBand, number>
  /** Cases with a satisfied or expired typed wait that this page did NOT take.
   *  The starvation counter, and the one number this whole closure exists to
   *  drive to zero. */
  starvedWoken: number
  /** Longest wait-to-selection latency in this page, in seconds: how long the
   *  oldest WOKEN case had been woken before it was picked. */
  wakeLatencySec: number
}

export function findDuePage(
  db: Database.Database,
  domain: 'personal' | 'zst',
  now: number,
  limit: number = 50,
): DuePage {
  // Counted rather than inferred from `cases.length === limit`: a page that is
  // exactly full is the ambiguous case, and guessing there is how a backlog of
  // one gets reported the same as a backlog of a thousand.
  const totalDue = (db.prepare(
    `SELECT COUNT(*) AS n FROM case_progression_state
     WHERE domain = ? AND progression_enabled = 1
       AND next_progression_at IS NOT NULL AND next_progression_at <= ?`,
  ).get(domain, now) as { n: number }).n

  const pools = bandPools(db, domain, now)
  const picked: DueCase[] = []
  const seen = new Set<string>()
  const selected: Record<DueBand, number> = { WOKEN: 0, DEADLINE: 0, NORMAL: 0 }

  // Each band takes its floor first, then the leftovers cascade DOWNWARD. A band
  // that is empty must not hold its share hostage -- that would turn a fairness
  // rule into an idle page, which is the same starvation from the other end.
  let spare = 0
  for (const band of DUE_BANDS) {
    const share = Math.max(1, Math.floor(limit * BAND_SHARE[band]))
    let room = share + spare
    for (const c of pools[band]) {
      if (picked.length >= limit || room <= 0) break
      if (seen.has(c.case_id)) continue
      seen.add(c.case_id)
      picked.push({ ...c, band })
      selected[band]++
      room--
    }
    spare = Math.max(0, room)
  }
  // Any capacity still unused after the cascade goes back to the oldest-first
  // order, so a quiet system behaves exactly as it did before the bands existed.
  //
  // THE BAND TRAVELS WITH THE CASE. The first version labelled everything picked
  // here as NORMAL, which made two things false at once: the audit field said a
  // freshly woken case ran as ordinary work, and `starvedWoken` counted it as
  // left behind when it had in fact been selected. A test caught it (35 vs 30)
  // and the number was right -- the labelling was wrong.
  if (picked.length < limit) {
    const rest: Array<[DueBand, DueCase]> = [
      ...pools.NORMAL.map(c => ['NORMAL', c] as [DueBand, DueCase]),
      ...pools.DEADLINE.map(c => ['DEADLINE', c] as [DueBand, DueCase]),
      ...pools.WOKEN.map(c => ['WOKEN', c] as [DueBand, DueCase]),
    ]
    for (const [band, c] of rest) {
      if (picked.length >= limit) break
      if (seen.has(c.case_id)) continue
      seen.add(c.case_id)
      picked.push({ ...c, band })
      selected[band]++
    }
  }

  const oldest = pools.WOKEN.concat(pools.DEADLINE, pools.NORMAL)
    .reduce<number | null>((m, c) => (m === null || c.next_progression_at < m ? c.next_progression_at : m), null)
  const takenWoken = new Set(picked.filter(c => c.band === 'WOKEN').map(c => c.case_id))
  const remaining = Math.max(0, totalDue - picked.length)
  return {
    cases: picked, totalDue, hasMore: remaining > 0, remaining,
    metrics: {
      backlog: totalDue,
      oldestDueAgeSec: oldest === null ? 0 : Math.max(0, now - oldest),
      selected,
      due: { WOKEN: pools.WOKEN.length, DEADLINE: pools.DEADLINE.length, NORMAL: pools.NORMAL.length },
      // Named by what it is: woken cases the page LEFT BEHIND. Zero is the goal
      // and a non-zero value is the alarm the owner asked for.
      starvedWoken: pools.WOKEN.filter(c => !takenWoken.has(c.case_id)).length,
      wakeLatencySec: pools.WOKEN.length === 0 ? 0
        : Math.max(0, now - Math.min(...pools.WOKEN.map(c => c.next_progression_at))),
    },
  }
}

/**
 * The three pools, each already ordered oldest-due-first inside itself.
 *
 * WOKEN is computed by ASKING THE EVALUATOR, not by reading a flag: a wait is
 * woken when its condition is satisfied or expired, and that is a live judgement
 * about clocks, events and probes. A cached boolean would be a fourth place for
 * the wake to be true, and this codebase has paid for those.
 *
 * The evaluator is read-only and cheap (a row plus, for CAPABILITY waits, a
 * local probe), and it is only asked about cases that BOTH are due AND have an
 * active condition -- so the cost is bounded by the number of live waits, not by
 * the size of the board.
 */
function bandPools(
  db: Database.Database, domain: 'personal' | 'zst', now: number,
): Record<DueBand, DueCase[]> {
  const all = queryDueCases(db, domain, now, MAX_SELECTION_SCAN)
  const withWait = new Set(
    (db.prepare(
      `SELECT case_id FROM case_wait_conditions WHERE domain = ? AND resolved_at IS NULL`,
    ).all(domain) as Array<{ case_id: string }>).map(r => r.case_id),
  )
  const pools: Record<DueBand, DueCase[]> = { WOKEN: [], DEADLINE: [], NORMAL: [] }
  for (const c of all) {
    if (withWait.has(c.case_id)) {
      let verdict = 'NONE'
      try { verdict = evaluateWaitCondition(db, domain, c.case_id, now).verdict } catch { verdict = 'NONE' }
      if (verdict === 'SATISFIED' || verdict === 'EXPIRED') { pools.WOKEN.push(c); continue }
    }
    if (hasDueDeadline(db, domain, c.case_id, now)) { pools.DEADLINE.push(c); continue }
    pools.NORMAL.push(c)
  }
  return pools
}

/** How deep the selection looks before banding.
 *
 *  Bounded, and LOUDLY so: a scan that silently stopped at the page size could
 *  not see a woken case sitting at position 51, which is the entire defect this
 *  closure fixes. Four pages deep is enough for a board an order of magnitude
 *  larger than this one, and `hasMore` still reports what was left. */
export const MAX_SELECTION_SCAN = 200

/** Does this case have a deadline that has come due and not been handled?
 *  Read from the case's own columns -- the same two the trigger contract uses,
 *  so the band and the trigger cannot disagree about what "due" means. */
function hasDueDeadline(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, now: number,
): boolean {
  try {
    const t = domain === 'personal' ? 'personal_cases' : 'zst_cases'
    const r = db.prepare(
      `SELECT due_at, follow_up_at FROM ${t} WHERE case_id = ?`,
    ).get(caseId) as { due_at: number | null; follow_up_at: number | null } | undefined
    if (!r) return false
    return [r.due_at, r.follow_up_at].some(d => d !== null && d <= now)
  } catch { return false }
}

function queryDueCases(
  db: Database.Database,
  domain: 'personal' | 'zst',
  now: number,
  limit: number,
): DueCase[] {
  const rows = db.prepare(
    `SELECT case_id, next_progression_at, progression_claimed_by,
            progression_claim_expires_at
     FROM case_progression_state
     WHERE domain = ?
       AND progression_enabled = 1
       AND next_progression_at IS NOT NULL
       AND next_progression_at <= ?
     ORDER BY next_progression_at ASC
     LIMIT ?`,
  ).all(domain, now, limit) as Array<{
    case_id: string
    next_progression_at: number
    progression_claimed_by: string | null
    progression_claim_expires_at: number | null
  }>

  return rows.map(r => ({
    case_id: r.case_id,
    next_progression_at: r.next_progression_at,
    claimed_by_other:
      r.progression_claimed_by !== null &&
      r.progression_claim_expires_at !== null &&
      r.progression_claim_expires_at > now,
  }))
}

// ── Atomic claim ─────────────────────────────────────────────────────────

/** Atomically claim a case for progression.
 *
 *  Succeeds only when ALL of these are true:
 *    1. progression_enabled = 1
 *    2. next_progression_at <= now (the case is "due")
 *    3. EITHER progression_claimed_by IS NULL
 *       OR progression_claim_expires_at < now (lease expired)
 *
 *  The claim is a SINGLE conditional UPDATE. SQLite serializes writes, so two
 *  concurrent runners cannot both see changes() = 1 on the same row — the
 *  second UPDATE's WHERE clause fails because progression_claimed_by was
 *  already set (and the new expiry is in the future).
 *
 *  Returns the case_id if claimed, null if the claim failed (case not due,
 *  already claimed by another runner, or not enabled).
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function tryClaimProgression(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  leaseDurationSeconds: number,
  now: number,
  opts: {
    /** A14. The sweep claims only cases that are DUE — that is what makes it a
     *  scheduler. A manual trigger (the Mission Control owner action) is not
     *  scheduled and never will be, so requiring due-ness there would refuse
     *  the cycle almost every time and quietly re-open the race it is meant to
     *  close. Set false to contend for the SAME lease without the schedule
     *  predicate: mutual exclusion, not eligibility. */
    requireDue?: boolean
  } = {},
): string | null {
  domainGuard(db, domain, caseId, 'tryClaimProgression')

  const expiresAt = now + leaseDurationSeconds
  const requireDue = opts.requireDue !== false

  const dueClause = requireDue
    ? `AND progression_enabled = 1
       AND next_progression_at IS NOT NULL
       AND next_progression_at <= @now`
    : ''

  const result = db.prepare(
    `UPDATE case_progression_state
     SET progression_claimed_by = @runId,
         progression_claim_expires_at = @expiresAt,
         updated_at = @now
     WHERE domain = @domain AND case_id = @caseId
       ${dueClause}
       AND (progression_claimed_by IS NULL
            OR progression_claim_expires_at < @now)`,
  ).run({ runId, expiresAt, now, domain, caseId })

  return result.changes === 1 ? caseId : null
}

// ── Claim release ────────────────────────────────────────────────────────

/** Release a progression claim.
 *
 *  Only releases if the claim is held BY the given runId — prevents a
 *  late-running worker from accidentally releasing a claim it no longer owns
 *  (because another runner reclaimed it after expiry).
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function releaseProgressionClaim(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  now: number,
): void {
  domainGuard(db, domain, caseId, 'releaseProgressionClaim')

  db.prepare(
    `UPDATE case_progression_state
     SET progression_claimed_by = NULL,
         progression_claim_expires_at = NULL,
         updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_claimed_by = ?`,
  ).run(now, domain, caseId, runId)
}

// ── Lease extension ──────────────────────────────────────────────────────

/** Extend the lease of a progression claim.
 *
 *  Only extends if the claim is STILL held by the given runId — prevents
 *  extending a claim that was already reclaimed by another runner.
 *
 *  Returns true if the extension succeeded, false if the claim is no longer
 *  held by this runId (expired and reclaimed, or released).
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function extendProgressionLease(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  newExpiresAt: number,
  now: number,
): boolean {
  domainGuard(db, domain, caseId, 'extendProgressionLease')

  const result = db.prepare(
    `UPDATE case_progression_state
     SET progression_claim_expires_at = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_claimed_by = ?`,
  ).run(newExpiresAt, now, domain, caseId, runId)

  return result.changes === 1
}

// ── Enable progression ───────────────────────────────────────────────────

/** Enable (or disable) progression on a case and optionally set the
 *  progression mode. Used to activate a case for autonomous progression.
 *
 *  This is a thin write helper — the progression pipeline itself sets
 *  progression_enabled during runProgressionCycle in shadow/internal mode.
 *  This function exists for activation separate from a progression run
 *  (e.g. when an operator manually enables progression on a case).
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function setProgressionEnabled(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  enabled: boolean,
  // 2026-08-15: was `mode: string = 'shadow'`. Untyped, so a typo reached the
  // schema CHECK at runtime instead of tsc at build time — and since this is the
  // ONLY writer of progression_mode outside the pipeline's own defaults, it is
  // the one place `external_shadow` or `live` can ever be set. The value that
  // decides whether an approval may run by itself should not be a free string.
  mode: ProgressionMode = 'shadow',
  now: number = Math.floor(Date.now() / 1000),
): void {
  domainGuard(db, domain, caseId, 'setProgressionEnabled')

  db.prepare(
    `UPDATE case_progression_state
     SET progression_enabled = ?, progression_mode = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(enabled ? 1 : 0, mode, now, domain, caseId)
}
