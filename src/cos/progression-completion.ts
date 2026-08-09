// Autonomous Case Progression Layer v1.1 — Semantic Completion (Checkpoint E.4).
// Card 25e06d97, epic 2aab1221. HIGHEST STAKES — DoD-based completion detection.
//
// A wrong COMPLETED silently closes a live case. This module provides the
// guard that prevents that: every path to COMPLETED (progression pipeline AND
// existing case-close path) must pass `canCompleteCase()`.
//
// ── DoD verification model ───────────────────────────────────────────────
//
//   dod_verification_json on case_progression_state tracks per-criterion
//   satisfaction. It is initialised on first progression run and updated
//   progressively as each run satisfies criteria.
//
//   Shape:
//     {
//       "criteria": [
//         {"label": "Case triaged",           "met": true,  "met_at": 123, "met_by_run": "r1"},
//         {"label": "Required actions done",   "met": false, "met_at": null, "met_by_run": null},
//         {"label": "Owner assigned",          "met": false, "met_at": null, "met_by_run": null}
//       ],
//       "all_met": false,
//       "evaluated_at": 123,
//       "evaluated_by_run": "r1"
//     }
//
// ── Completion gate logic ─────────────────────────────────────────────────
//
//   canCompleteCase() returns {allowed: false} unless ONE of these is true:
//     1. The case has NO progression state (not progression-controlled).
//     2. progression_enabled = 0 (progression is off; legacy close works).
//     3. dod_verification_json.all_met = true (all DoD criteria satisfied).
//
//   When all_met is false, the reason lists which criteria are still unmet
//   so the caller can surface it.
//
// ── HARD INVARIANTS (all of checkpoint E) ─────────────────────────────────
//
//   - ZERO side effects: write ONLY to dod_verification_json on
//     case_progression_state. No writes to personal_cases/zst_cases.
//   - Domain-scoped everywhere (CrossDomainReadError on cross-domain reads).
//   - Idempotent: marking a criterion as met twice is a no-op.
//   - Completion guard is a READ + gate; it never mutates on its own.

import type Database from 'better-sqlite3'
import { domainGuard } from './progression-resolver.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface DoDCriterionState {
  label: string
  met: boolean
  met_at: number | null
  met_by_run: string | null
}

export interface DoDVerification {
  criteria: DoDCriterionState[]
  all_met: boolean
  evaluated_at: number
  evaluated_by_run: string | null
}

export interface DoDCompletenessResult {
  totalCriteria: number
  metCriteria: number
  unmetCriteria: string[]
  allMet: boolean
  /** The full verification state, or null if no DoD criteria exist. */
  verification: DoDVerification | null
}

export interface CompletionGateResult {
  allowed: boolean
  reason: string
  unmet: string[]
}

// ── Internal helpers ──────────────────────────────────────────────────────

const DEFAULT_DOD_VERIFICATION: Readonly<DoDVerification> = {
  criteria: [],
  all_met: false,
  evaluated_at: 0,
  evaluated_by_run: null,
}

function parseVerification(raw: string | null | undefined): DoDVerification | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.criteria)) return parsed as DoDVerification
    return null
  } catch {
    return null
  }
}

// ── Initialisation ────────────────────────────────────────────────────────

/** Initialise dod_verification_json from the definition_of_done criteria.
 *  Idempotent: if already initialised, returns the existing verification
 *  without changes. Called by the progression pipeline on first run.
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function initializeDoDVerification(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  criteria: string[],
  now: number,
): DoDVerification {
  domainGuard(db, domain, caseId, 'initializeDoDVerification')

  // Idempotent: if already initialised, return existing
  const existing = db.prepare(
    'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { dod_verification_json: string | null } | undefined

  if (existing?.dod_verification_json) {
    const parsed = parseVerification(existing.dod_verification_json)
    if (parsed && parsed.criteria.length > 0) return parsed
  }

  const criteriaStates: DoDCriterionState[] = criteria.map(c => ({
    label: c,
    met: false,
    met_at: null,
    met_by_run: null,
  }))

  const verification: DoDVerification = {
    criteria: criteriaStates,
    all_met: false,
    evaluated_at: now,
    evaluated_by_run: null,
  }

  db.prepare(
    `UPDATE case_progression_state
     SET dod_verification_json = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(JSON.stringify(verification), now, domain, caseId)

  return verification
}

// ── Criterion satisfaction ────────────────────────────────────────────────

/** Mark a single DoD criterion as satisfied.
 *
 *  Idempotent: marking the same criterion as met twice is a no-op.
 *  After marking, re-evaluates all_met and updates the flag.
 *
 *  Returns true if this call changed the criterion from unmet to met.
 *
 *  Domain-scoped. */
export function satisfyDoDCriterion(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  criterionIndex: number,
  runId: string,
  now: number,
): boolean {
  domainGuard(db, domain, caseId, 'satisfyDoDCriterion')

  const row = db.prepare(
    'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { dod_verification_json: string | null } | undefined

  if (!row) return false

  const verification = parseVerification(row.dod_verification_json)
  if (!verification) return false
  if (criterionIndex < 0 || criterionIndex >= verification.criteria.length) return false

  const c = verification.criteria[criterionIndex]
  if (c.met) return false // already met — idempotent no-op

  c.met = true
  c.met_at = now
  c.met_by_run = runId

  // Re-evaluate all_met
  verification.all_met = verification.criteria.every(c => c.met)
  verification.evaluated_at = now
  verification.evaluated_by_run = runId

  db.prepare(
    `UPDATE case_progression_state
     SET dod_verification_json = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(JSON.stringify(verification), now, domain, caseId)

  return true
}

/** Auto-satisfy the next unmet DoD criterion after a successful progression
 *  run. This is the progression pipeline's hook: after each successful run,
 *  gradually mark criteria as met. When all are met, completion is allowed.
 *
 *  Returns the index of the criterion that was satisfied, or -1 if none
 *  were unsatisfied (all already met, or no criteria exist).
 *
 *  Domain-scoped. */
export function autoSatisfyNextDoDCriterion(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  now: number,
): number {
  domainGuard(db, domain, caseId, 'autoSatisfyNextDoDCriterion')

  const row = db.prepare(
    'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { dod_verification_json: string | null } | undefined

  if (!row) return -1

  const verification = parseVerification(row.dod_verification_json)
  if (!verification || verification.criteria.length === 0) return -1

  // Find the first unmet criterion
  const idx = verification.criteria.findIndex(c => !c.met)
  if (idx === -1) return -1 // all already met

  satisfyDoDCriterion(db, domain, caseId, idx, runId, now)
  return idx
}

// ── Evaluation ────────────────────────────────────────────────────────────

/** Evaluate DoD completeness for a case.
 *
 *  Reads dod_verification_json and returns which criteria are met/unmet.
 *  Returns null verification when no DoD criteria have been set up yet
 *  (the case is not under DoD control).
 *
 *  Read-only — no mutation.
 *  Domain-scoped. */
export function evaluateDoDCompleteness(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
): DoDCompletenessResult {
  domainGuard(db, domain, caseId, 'evaluateDoDCompleteness')

  const row = db.prepare(
    'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { dod_verification_json: string | null } | undefined

  if (!row?.dod_verification_json) {
    return {
      totalCriteria: 0,
      metCriteria: 0,
      unmetCriteria: [],
      allMet: true, // no criteria = nothing blocking completion
      verification: null,
    }
  }

  const verification = parseVerification(row.dod_verification_json)
  if (!verification || verification.criteria.length === 0) {
    return {
      totalCriteria: 0,
      metCriteria: 0,
      unmetCriteria: [],
      allMet: true,
      verification: null,
    }
  }

  const unmet = verification.criteria.filter(c => !c.met).map(c => c.label)
  const met = verification.criteria.filter(c => c.met).length

  return {
    totalCriteria: verification.criteria.length,
    metCriteria: met,
    unmetCriteria: unmet,
    allMet: verification.all_met,
    verification,
  }
}

// ── Completion gate ───────────────────────────────────────────────────────

/** Determine whether a case can be completed (transitioned to COMPLETED).
 *
 *  This is the single gate that BOTH code paths must pass:
 *    1. The progression pipeline (decide → COMPLETE)
 *    2. The existing case-close path (transitionCase → COMPLETED)
 *
 *  Returns allowed=true when:
 *    a. The case has NO progression state row (not progression-controlled)
 *    b. progression_enabled = 0 (legacy mode, DoD not enforced)
 *    c. All DoD criteria are met (all_met = true)
 *
 *  Returns allowed=false with a reason listing unmet criteria when the case
 *  IS progression-enabled and some DoD criteria are not yet met.
 *
 *  Read-only — no mutation.
 *  Domain-scoped. */
export function canCompleteCase(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
): CompletionGateResult {
  domainGuard(db, domain, caseId, 'canCompleteCase')

  // Check if progression state exists and is enabled
  const state = db.prepare(
    `SELECT progression_enabled, dod_verification_json
     FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(domain, caseId) as {
    progression_enabled: number
    dod_verification_json: string | null
  } | undefined

  // No progression state → case is not progression-controlled → allowed
  if (!state) {
    return { allowed: true, reason: 'Case is not under progression control', unmet: [] }
  }

  // Progression disabled → legacy close path → allowed
  if (state.progression_enabled === 0) {
    return { allowed: true, reason: 'Progression is disabled on this case', unmet: [] }
  }

  // Progression-enabled → must verify DoD
  const completeness = evaluateDoDCompleteness(db, domain, caseId)

  if (completeness.allMet) {
    return { allowed: true, reason: `All ${completeness.totalCriteria} DoD criteria met`, unmet: [] }
  }

  return {
    allowed: false,
    reason: `${completeness.metCriteria}/${completeness.totalCriteria} DoD criteria met. Unmet: ${completeness.unmetCriteria.join(', ')}`,
    unmet: completeness.unmetCriteria,
  }
}

// ── Premature completion error ─────────────────────────────────────────────

/** Thrown when a case close is attempted but the DoD is not met.
 *  The caller can catch this and surface it to the owner, or the progression
 *  pipeline can catch it and downgrade the decision. */
export class PrematureCompletionError extends Error {
  public readonly errorCode = 'PREMATURE_COMPLETION'
  constructor(
    public readonly caseId: string,
    reason: string,
  ) {
    super(`Premature completion blocked for case ${caseId}: ${reason}`)
    this.name = 'PrematureCompletionError'
  }
}

// ── Close guard for case-store integration ─────────────────────────────────

/** Guard a case transition to COMPLETED. Call this from the case-store
 *  / zst-case-store wrapper BEFORE calling engine.transitionCase().
 *
 *  Throws PrematureCompletionError if the case is progression-enabled
 *  and the DoD is not met.
 *
 *  Returns void on success (completion is allowed).
 *  Domain-scoped. */
export function guardCaseCompletion(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
): void {
  const gate = canCompleteCase(db, domain, caseId)
  if (!gate.allowed) {
    throw new PrematureCompletionError(caseId, gate.reason)
  }
}
