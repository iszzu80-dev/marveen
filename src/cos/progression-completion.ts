// Autonomous Case Progression Layer v1.1 — Semantic Completion (Checkpoint E.4).
// Card 25e06d97, epic 2aab1221. HIGHEST STAKES — DoD-based completion detection.
//
// A wrong COMPLETED silently closes a live case. This module provides the
// guard that prevents that: every path to COMPLETED (progression pipeline AND
// existing case-close path) must pass `canCompleteCase()`.
//
// ── What went wrong, 2026-08-09/10 (read this before changing the gate) ───
//
//   The engine closed 17 of 19 personal cases and all 9 corporate ones, and
//   every single one of the 72 COMPLETE decisions in case_progression_runs
//   carried the identical reason string "All 4 plan steps completed and DoD
//   criteria satisfied". Zero variance across 72 decisions is not a system
//   agreeing with itself; it is a system not looking. Two independent defects
//   produced it, and both are fixed here:
//
//   1. SELF-CERTIFICATION. autoSatisfyNextDoDCriterion() used to tick off the
//      next unmet criterion after every successful run, purely as a function
//      of the run count. Nothing was checked. Three runs later "Case triaged,
//      Required actions identified, Owner assigned" were all "met", the gate
//      read the state it had itself written, and agreed. A guard whose input
//      is its own output is not a guard. Criteria now require an evidence
//      reference, and the pipeline — which has no evidence extractor — no
//      longer satisfies anything.
//
//   2. A GENERIC DoD IS NOT THIS CASE'S DoD. The criteria came from a per-
//      STATUS template (deriveOutcomeContract), so every NEW case shared the
//      same three. "Case triaged" being true says the triage happened; it says
//      nothing about the child-support settlement, the water bill, or the
//      tooth. Closing on it turns "I looked at this" into "this is handled".
//      A template-derived DoD is now marked GENERIC_STATUS_TEMPLATE and can
//      never close a case autonomously, however many criteria are ticked.
//
//   Both gates are fail-closed: a verification row with no provenance recorded
//   (every row written before 2026-08-10) counts as GENERIC.
//
// ── DoD verification model ───────────────────────────────────────────────
//
//   dod_verification_json on case_progression_state tracks per-criterion
//   satisfaction. It is initialised on first progression run and updated as
//   criteria are satisfied WITH EVIDENCE.
//
//   Shape:
//     {
//       "provenance": "GENERIC_STATUS_TEMPLATE" | "CASE_SPECIFIC",
//       "criteria": [
//         {"label": "Invoice paid", "met": true,  "met_at": 123, "met_by_run": "r1",
//          "met_by_evidence": "case_event:4711"},
//         {"label": "Receipt filed", "met": false, "met_at": null, "met_by_run": null,
//          "met_by_evidence": null}
//       ],
//       "all_met": false,
//       "evaluated_at": 123,
//       "evaluated_by_run": "r1"
//     }
//
// ── Completion gate logic ─────────────────────────────────────────────────
//
//   canCompleteCase(db, domain, caseId, by) — `by` is who wants to close.
//
//   by = 'OWNER' (a person, or anything that is not the progression engine):
//     always allowed. A person deciding a case is finished IS the evidence,
//     and an assistant that cannot be told "this is done" is broken. This is
//     also why the engine-side gate can afford to be absolute.
//
//   by = 'ENGINE' — allowed only when ALL of:
//     1. the case has progression state and it is enabled — otherwise the case
//        is not engine-controlled, and an engine closing a case it does not
//        drive is the failure this gate exists to stop, AND
//     2. the DoD provenance is CASE_SPECIFIC, AND
//     3. every criterion is met, each with an evidence reference.
//
//   When it refuses, the reason names which of the three failed, because a
//   refusal nobody can act on gets switched off.
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

/** Where the DoD criteria came from. This is the difference between "the
 *  engine ticked the boxes it invented for every case in this status" and "the
 *  case has an outcome contract of its own". Only the latter may close a case
 *  without a person. */
export type DoDProvenance = 'GENERIC_STATUS_TEMPLATE' | 'CASE_SPECIFIC'

/** Who is asking to close the case. */
export type CompletionActor = 'ENGINE' | 'OWNER'

/** The actor string the progression pipeline stamps on its own transitions.
 *  Exported so the mapping below and the pipeline cannot drift apart. */
export const PROGRESSION_ENGINE_ACTOR = 'progression-engine'

/** Map a case-event actor string to a completion actor. Lives here rather than
 *  in each case store so the personal and corporate sides cannot answer this
 *  question differently — the corporate side inherited the closure bug from the
 *  shared engine, and a per-store copy of this rule is how it would inherit the
 *  next one. Anything that is not the engine counts as the owner. */
export function completionActor(actor: string | null | undefined): CompletionActor {
  return actor === PROGRESSION_ENGINE_ACTOR ? 'ENGINE' : 'OWNER'
}

export interface DoDCriterionState {
  label: string
  met: boolean
  met_at: number | null
  met_by_run: string | null
  /** What proves it. A criterion met with a null reference is a claim, not a
   *  fact — satisfyDoDCriterion refuses to write one. Nullable only because
   *  unmet criteria have nothing to point at, and because rows written before
   *  2026-08-10 have no such field. */
  met_by_evidence: string | null
}

export interface DoDVerification {
  /** Absent in every row written before 2026-08-10. Absence reads as
   *  GENERIC_STATUS_TEMPLATE — the safe answer, not the convenient one. */
  provenance: DoDProvenance
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
  provenance: 'GENERIC_STATUS_TEMPLATE',
  criteria: [],
  all_met: false,
  evaluated_at: 0,
  evaluated_by_run: null,
}

/** Read a stored verification, normalising the two fields that did not exist
 *  before 2026-08-10. Both normalise DOWNWARD: a row that never recorded its
 *  provenance is generic, and a criterion that never recorded its evidence has
 *  none. This is the difference between migrating the old rows and quietly
 *  promoting them. */
function parseVerification(raw: string | null | undefined): DoDVerification | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.criteria)) return null
    const v = parsed as DoDVerification
    if (v.provenance !== 'CASE_SPECIFIC') v.provenance = 'GENERIC_STATUS_TEMPLATE'
    for (const c of v.criteria) {
      if (typeof c.met_by_evidence !== 'string' || c.met_by_evidence.trim() === '') {
        c.met_by_evidence = null
      }
    }
    return v
  } catch {
    return null
  }
}

/** A criterion is proven when it is met AND names what met it. Stored all_met
 *  is never trusted on its own: the pre-fix rows carry all_met = true over
 *  evidence-free ticks, and reading that flag back is how a bad state survives
 *  the fix that was supposed to end it. */
function criteriaAllProven(v: DoDVerification): boolean {
  if (v.criteria.length === 0) return false
  return v.criteria.every(c => c.met && typeof c.met_by_evidence === 'string' && c.met_by_evidence !== '')
}

// ── Initialisation ────────────────────────────────────────────────────────

/** Initialise dod_verification_json from the definition_of_done criteria.
 *  Idempotent: if already initialised, returns the existing verification
 *  without changes. Called by the progression pipeline on first run.
 *
 *  `provenance` is required and has no default on purpose. The whole 2026-08-09
 *  incident is one caller not having to say where its criteria came from; a
 *  default would let the next caller not say either, and defaults are chosen
 *  for convenience.
 *
 *  Domain-scoped: throws CrossDomainReadError if case is in the wrong domain. */
export function initializeDoDVerification(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  criteria: string[],
  provenance: DoDProvenance,
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
    met_by_evidence: null,
  }))

  const verification: DoDVerification = {
    provenance,
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

/** Mark a single DoD criterion as satisfied, against a piece of evidence.
 *
 *  `evidence` is a reference to the thing that proves it — a case event id, an
 *  outbound ledger id, a Gmail message id. It is required and must be
 *  non-blank: the call is REFUSED (returns false, writes nothing) otherwise.
 *  Before 2026-08-10 this parameter did not exist, the pipeline called it on a
 *  timer, and 72 cases closed on criteria nobody had checked.
 *
 *  The reference is stored, not resolved. Storing it does not make it true —
 *  it makes it checkable, which is the part that was missing.
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
  evidence: string,
  now: number,
): boolean {
  domainGuard(db, domain, caseId, 'satisfyDoDCriterion')

  // No evidence, no satisfaction. Checked before the read so the refusal costs
  // nothing and cannot be mistaken for "criterion not found".
  if (typeof evidence !== 'string' || evidence.trim() === '') return false

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
  c.met_by_evidence = evidence.trim()

  // Re-evaluate all_met. A criterion counts only when it is met AND says what
  // met it — otherwise the 17 personal cases the engine closed on evidence-free
  // ticks would still read as complete after this fix.
  verification.all_met = criteriaAllProven(verification)
  verification.evaluated_at = now
  verification.evaluated_by_run = runId

  db.prepare(
    `UPDATE case_progression_state
     SET dod_verification_json = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(JSON.stringify(verification), now, domain, caseId)

  return true
}

/** Satisfy the next unmet DoD criterion, against a piece of evidence.
 *
 *  This replaces autoSatisfyNextDoDCriterion(), which took no evidence and was
 *  called by the pipeline after every successful run. That function is the
 *  2026-08-09 incident in eleven lines: it advanced the DoD as a function of
 *  how many times the engine had woken up, and the completion gate then read
 *  back what it had written. It is deliberately gone rather than deprecated —
 *  a call site that still compiles is a call site that still runs.
 *
 *  The caller must supply the evidence. The pipeline currently supplies none,
 *  because it has no evidence extractor, so it no longer calls this at all.
 *  That is the honest state of the engine today, and the point of the fix: it
 *  is better for a case to sit visibly unfinished than to be filed as done.
 *
 *  Returns the index of the criterion that was satisfied, or -1 if there was
 *  nothing unmet, no criteria, or no usable evidence.
 *
 *  Domain-scoped. */
export function satisfyNextDoDCriterionWithEvidence(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  evidence: string,
  now: number,
): number {
  domainGuard(db, domain, caseId, 'satisfyNextDoDCriterionWithEvidence')

  if (typeof evidence !== 'string' || evidence.trim() === '') return -1

  const row = db.prepare(
    'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { dod_verification_json: string | null } | undefined

  if (!row) return -1

  const verification = parseVerification(row.dod_verification_json)
  if (!verification || verification.criteria.length === 0) return -1

  // Find the first unmet criterion
  const idx = verification.criteria.findIndex(c => !c.met)
  if (idx === -1) return -1 // all already met

  return satisfyDoDCriterion(db, domain, caseId, idx, runId, evidence, now) ? idx : -1
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
      // No criteria is not "nothing blocking completion" — it is nothing
      // verified. It used to read as true here, which meant a progression-
      // enabled case whose DoD was never initialised sailed through the gate.
      // Whether that should still close is a policy question, and policy lives
      // in canCompleteCase(); this function only reports.
      allMet: false,
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

  // "Proven", not "met": a tick with no evidence reference behind it is the
  // state this module used to write on a timer, and it must not read back as
  // satisfied now.
  const proven = (c: DoDCriterionState): boolean =>
    c.met && typeof c.met_by_evidence === 'string' && c.met_by_evidence !== ''
  const unmet = verification.criteria.filter(c => !proven(c)).map(c => c.label)
  const met = verification.criteria.filter(proven).length

  return {
    totalCriteria: verification.criteria.length,
    metCriteria: met,
    unmetCriteria: unmet,
    allMet: criteriaAllProven(verification),
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
 *  `by` defaults to 'ENGINE' — the strict side. A caller that forgets to say
 *  who is closing gets the answer that cannot silently close a live case.
 *
 *  OWNER is always allowed. That is not a loophole: an assistant you cannot
 *  tell "this one is finished" is broken, and a person saying so is better
 *  evidence than anything this module can compute. It is also what lets the
 *  engine side be absolute.
 *
 *  ENGINE is allowed only when the case is engine-controlled (a progression
 *  state row exists AND progression_enabled = 1), its DoD is CASE_SPECIFIC, and
 *  every criterion is met with an evidence reference. A case the engine does
 *  not control is a case the engine has no business closing.
 *
 *  Read-only — no mutation.
 *  Domain-scoped. */
export function canCompleteCase(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  by: CompletionActor = 'ENGINE',
): CompletionGateResult {
  domainGuard(db, domain, caseId, 'canCompleteCase')

  if (by === 'OWNER') {
    return { allowed: true, reason: 'Owner-authorized closure', unmet: [] }
  }

  // Check if progression state exists and is enabled
  const state = db.prepare(
    `SELECT progression_enabled, dod_verification_json
     FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(domain, caseId) as {
    progression_enabled: number
    dod_verification_json: string | null
  } | undefined

  // NOT ENGINE-CONTROLLED → THE ENGINE MAY NOT CLOSE IT.
  //
  // Both of these used to return allowed:true, described as "the legacy close
  // path". That was true of the path this gate was written for — a person or an
  // older code path closing a case — but the progression pipeline calls this
  // very function as its OWN plan-exhaustion trigger and as its downgrade guard.
  // So any state row with progression_enabled = 0 that got cycled sailed
  // straight through on a GENERIC_STATUS_TEMPLATE DoD, and the engine
  // transitioned the case to COMPLETED: the 2026-08-09 "72 false closures"
  // failure, re-admitted through the disabled branch, on cases the engine had
  // explicitly been told not to drive.
  //
  // "Not engine-controlled" now means what it says. The legitimate closures the
  // old branch was protecting all arrive as by = 'OWNER' (completionActor maps
  // everything except the progression engine's own actor string to OWNER), and
  // that path returned above without reading any of this.
  if (!state) {
    return {
      allowed: false,
      reason: 'Case is not under progression control; the engine may not close it (the owner can)',
      unmet: [],
    }
  }

  if (state.progression_enabled === 0) {
    return {
      allowed: false,
      reason: 'Progression is disabled on this case; the engine may not close it (the owner can)',
      unmet: [],
    }
  }

  // Progression-enabled → the DoD has to be this case's DoD before it can be
  // this case's evidence. A per-status template says the same three things
  // about every case in that status, so satisfying it proves the engine ran,
  // not that the matter is settled.
  const verification = parseVerification(state.dod_verification_json)
  const provenance: DoDProvenance = verification?.provenance ?? 'GENERIC_STATUS_TEMPLATE'
  if (provenance !== 'CASE_SPECIFIC') {
    return {
      allowed: false,
      reason: 'DoD is a generic status template, not this case\'s outcome contract. '
        + 'The engine may not close on it; the owner can.',
      unmet: verification?.criteria.map(c => c.label) ?? [],
    }
  }

  const completeness = evaluateDoDCompleteness(db, domain, caseId)

  if (completeness.totalCriteria === 0) {
    return {
      allowed: false,
      reason: 'No DoD criteria recorded — nothing was verified',
      unmet: [],
    }
  }

  if (completeness.allMet) {
    return { allowed: true, reason: `All ${completeness.totalCriteria} DoD criteria met`, unmet: [] }
  }

  return {
    allowed: false,
    reason: `${completeness.metCriteria}/${completeness.totalCriteria} DoD criteria met with evidence. Unmet: ${completeness.unmetCriteria.join(', ')}`,
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
 *  Throws PrematureCompletionError if the engine is closing a case whose DoD
 *  does not carry it. Owner closures pass.
 *
 *  Returns void on success (completion is allowed).
 *  Domain-scoped. */
export function guardCaseCompletion(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  by: CompletionActor = 'ENGINE',
): void {
  const gate = canCompleteCase(db, domain, caseId, by)
  if (!gate.allowed) {
    throw new PrematureCompletionError(caseId, gate.reason)
  }
}
