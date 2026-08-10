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
import { domainGuard } from './progression-resolver.js';
// ── Wake scheduling ──────────────────────────────────────────────────────
/** Set (or clear) the next progression wake-up time for a case.
 *
 *  Called after a WAIT_TIME decision to schedule the next progression
 *  attempt, or after a COMPLETE / terminal decision to clear the wake time.
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function scheduleNextProgression(db, domain, caseId, nextProgressionAt, now) {
    domainGuard(db, domain, caseId, 'scheduleNextProgression');
    db.prepare(`UPDATE case_progression_state
     SET next_progression_at = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`).run(nextProgressionAt, now, domain, caseId);
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
export function findDueCases(db, domain, now, limit = 50) {
    const rows = db.prepare(`SELECT case_id, next_progression_at, progression_claimed_by,
            progression_claim_expires_at
     FROM case_progression_state
     WHERE domain = ?
       AND progression_enabled = 1
       AND next_progression_at IS NOT NULL
       AND next_progression_at <= ?
     ORDER BY next_progression_at ASC
     LIMIT ?`).all(domain, now, limit);
    return rows.map(r => ({
        case_id: r.case_id,
        next_progression_at: r.next_progression_at,
        claimed_by_other: r.progression_claimed_by !== null &&
            r.progression_claim_expires_at !== null &&
            r.progression_claim_expires_at > now,
    }));
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
export function tryClaimProgression(db, domain, caseId, runId, leaseDurationSeconds, now) {
    domainGuard(db, domain, caseId, 'tryClaimProgression');
    const expiresAt = now + leaseDurationSeconds;
    const result = db.prepare(`UPDATE case_progression_state
     SET progression_claimed_by = ?,
         progression_claim_expires_at = ?,
         updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_enabled = 1
       AND next_progression_at IS NOT NULL
       AND next_progression_at <= ?
       AND (progression_claimed_by IS NULL
            OR progression_claim_expires_at < ?)`).run(runId, expiresAt, now, domain, caseId, now, now);
    return result.changes === 1 ? caseId : null;
}
// ── Claim release ────────────────────────────────────────────────────────
/** Release a progression claim.
 *
 *  Only releases if the claim is held BY the given runId — prevents a
 *  late-running worker from accidentally releasing a claim it no longer owns
 *  (because another runner reclaimed it after expiry).
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function releaseProgressionClaim(db, domain, caseId, runId, now) {
    domainGuard(db, domain, caseId, 'releaseProgressionClaim');
    db.prepare(`UPDATE case_progression_state
     SET progression_claimed_by = NULL,
         progression_claim_expires_at = NULL,
         updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_claimed_by = ?`).run(now, domain, caseId, runId);
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
export function extendProgressionLease(db, domain, caseId, runId, newExpiresAt, now) {
    domainGuard(db, domain, caseId, 'extendProgressionLease');
    const result = db.prepare(`UPDATE case_progression_state
     SET progression_claim_expires_at = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?
       AND progression_claimed_by = ?`).run(newExpiresAt, now, domain, caseId, runId);
    return result.changes === 1;
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
export function setProgressionEnabled(db, domain, caseId, enabled, mode = 'shadow', now = Math.floor(Date.now() / 1000)) {
    domainGuard(db, domain, caseId, 'setProgressionEnabled');
    db.prepare(`UPDATE case_progression_state
     SET progression_enabled = ?, progression_mode = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`).run(enabled ? 1 : 0, mode, now, domain, caseId);
}
