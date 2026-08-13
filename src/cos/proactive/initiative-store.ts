// v1.4 Proactive Core — promotion and persistence (§5.1, §6.2, §9, §15.1).
//
// Two doors, and both of them write:
//
//   recordQualification — EVERY verdict, PROMOTE and SUPPRESS alike. §6.3 needs
//     suppression to be measurable and §7.2 needs the dedupe decision to be
//     replayable. A policy that records only what it let through can be scored
//     on precision and never on recall, which is the more expensive error here:
//     a proactive layer that misses things quietly looks exactly like one that
//     had nothing to say.
//
//   promoteSignal — the ONLY way a ProactiveInitiative comes into existence,
//     and it refuses without a §9 desired outcome. "The Initiative must not stay
//     in a 'let's have a look' state without an outcome" is enforceable at
//     exactly one place, and this is it.

import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  INTERNAL_PREPARATION_CLASSES,
  type DesiredOutcome,
  type InitiativeQualificationResult,
  type InitiativeState,
  type InternalPreparationClass,
  type ProactiveDomain,
  type ProactiveInitiative,
  type ProactiveSignal,
} from './types.js'

export function recordQualification(
  db: Database.Database,
  domain: ProactiveDomain,
  r: InitiativeQualificationResult,
  now: number,
): void {
  db.prepare(
    `INSERT INTO proactive_qualifications (
       qualification_id, signal_id, domain, decision, reason_codes_json, matched_case_id,
       materiality_score, urgency_score, actionability_score, interruption_score,
       confidence, decided_at)
     VALUES (@id, @signal_id, @domain, @decision, @reasons, @matched,
       @materiality, @urgency, @actionability, @interruption, @confidence, @now)`,
  ).run({
    id: `pq-${createHash('sha256').update(`${r.signalId}${now}${r.decision}`).digest('hex').slice(0, 24)}`,
    signal_id: r.signalId,
    domain,
    decision: r.decision,
    reasons: JSON.stringify(r.reasonCodes),
    matched: r.matchedCaseId ?? null,
    materiality: r.materialityScore,
    urgency: r.urgencyScore,
    actionability: r.actionabilityScore,
    interruption: r.interruptionScore,
    confidence: r.confidence,
    now,
  })
}

export interface PromotionInput {
  desiredOutcome: DesiredOutcome
  currentGap: string
  allowedPreparationClasses: InternalPreparationClass[]
  unresolvedRequirements?: string[]
  decisionDeadline?: number
  /** §10: how long preparation needs before the decision deadline. The internal
   *  safe deadline is derived from it below rather than accepted, so the two can
   *  never disagree. */
  preparationLeadSec?: number
}

export type PromotionResult =
  | { outcome: 'PROMOTED'; initiative: ProactiveInitiative }
  | { outcome: 'REFUSED'; reason: string }

/** Default preparation lead: a working day. Long enough that "prepared" means
 *  prepared rather than assembled in the last hour, short enough not to declare
 *  every week-out deadline already urgent. */
export const DEFAULT_PREPARATION_LEAD_SEC = 24 * 3600

/**
 * §5.1: promote a qualified signal into an Initiative.
 *
 * Refuses on anything the promotion rule requires and does not have. The
 * refusals are not defensive noise: each one corresponds to a state the spec
 * says an Initiative may not be in, and a store that accepts them is a store
 * that makes the spec unverifiable from the data.
 */
export function promoteSignal(
  db: Database.Database,
  signal: ProactiveSignal,
  qualification: InitiativeQualificationResult,
  input: PromotionInput,
  now: number,
): PromotionResult {
  if (qualification.decision !== 'PROMOTE') {
    return { outcome: 'REFUSED', reason: `a qualification nem PROMOTE, hanem ${qualification.decision}` }
  }
  if (qualification.signalId !== signal.signalId) {
    // A verdict about a different signal is not a verdict about this one. Cheap
    // to check, and the alternative is an Initiative citing evidence that was
    // never weighed for it.
    return { outcome: 'REFUSED', reason: 'a qualification egy másik signalról szól' }
  }
  const outcomeRefusal = desiredOutcomeRefusal(input.desiredOutcome)
  if (outcomeRefusal) return { outcome: 'REFUSED', reason: outcomeRefusal }
  if (!input.currentGap?.trim()) {
    return { outcome: 'REFUSED', reason: 'a §9 gap kötelező: mi hiányzik a jelenlegi és a kívánt állapot között' }
  }
  const classes = input.allowedPreparationClasses ?? []
  if (classes.length === 0) {
    return { outcome: 'REFUSED', reason: 'egy Initiative-nak legalább egy megengedett előkészítési osztálya kell (§15.1)' }
  }
  // §15.2 / §15.3(5): the allowlist is checked at the door as well as by the
  // standing test. The standing test catches the list being widened in a diff;
  // this catches a value that never went through the list at all — a string
  // built at runtime, or read from a config file nobody reviewed.
  const foreign = classes.filter(c => !INTERNAL_PREPARATION_CLASSES.includes(c))
  if (foreign.length) {
    return { outcome: 'REFUSED', reason: `nem engedélyezett előkészítési osztály (§15.1): ${foreign.join(', ')}` }
  }

  const decisionDeadline = input.decisionDeadline ?? signal.candidateDeadline
  const lead = input.preparationLeadSec ?? DEFAULT_PREPARATION_LEAD_SEC
  // Derived, never below zero, and never after the decision deadline itself.
  const internalSafeDeadline = decisionDeadline != null
    ? Math.max(0, decisionDeadline - lead)
    : undefined

  const initiativeId = `pini-${randomUUID()}`
  const state: InitiativeState = qualification.matchedCaseId ? 'LINKED_TO_CASE' : 'QUALIFIED'
  const row = {
    initiative_id: initiativeId,
    domain: signal.domain,
    signal_ids_json: JSON.stringify([signal.signalId]),
    initiative_type: signal.signalType,
    materiality: signal.estimatedMateriality,
    urgency: signal.estimatedUrgency,
    case_id: qualification.matchedCaseId ?? null,
    desired_outcome_json: JSON.stringify(input.desiredOutcome),
    current_gap: input.currentGap,
    decision_deadline: decisionDeadline ?? null,
    internal_safe_deadline: internalSafeDeadline ?? null,
    allowed_preparation_classes_json: JSON.stringify(classes),
    unresolved_requirements_json: JSON.stringify(input.unresolvedRequirements ?? []),
    // Computed and stored; NOT acted upon anywhere in this release. §27 Stage 0
    // is replay only, and the interruption path is not imported by this
    // directory at all — see the import-boundary standing check.
    user_interruption_required: qualification.interruptionScore >= 0.7 ? 1 : 0,
    interruption_reason: qualification.interruptionScore >= 0.7
      ? qualification.reasonCodes.find(c => c.startsWith('urgency_deadline:')) ?? 'materiality'
      : null,
    state,
    confidence: qualification.confidence,
    now,
  }
  db.prepare(
    `INSERT INTO proactive_initiatives (
       initiative_id, domain, signal_ids_json, initiative_type, materiality, urgency, case_id,
       desired_outcome_json, current_gap, decision_deadline, internal_safe_deadline,
       allowed_preparation_classes_json, unresolved_requirements_json,
       user_interruption_required, interruption_reason, state, confidence, created_at, updated_at)
     VALUES (
       @initiative_id, @domain, @signal_ids_json, @initiative_type, @materiality, @urgency, @case_id,
       @desired_outcome_json, @current_gap, @decision_deadline, @internal_safe_deadline,
       @allowed_preparation_classes_json, @unresolved_requirements_json,
       @user_interruption_required, @interruption_reason, @state, @confidence, @now, @now)`,
  ).run(row)

  return { outcome: 'PROMOTED', initiative: readInitiative(db, initiativeId)! }
}

/** §9. An outcome that names no target state and no completion evidence is a
 *  wish, and a wish cannot be checked off — which means the Initiative could
 *  never be RESOLVED on evidence, only declared done. */
export function desiredOutcomeRefusal(o: DesiredOutcome | undefined): string | null {
  if (!o) return 'a §9 desired outcome kötelező minden promotált Initiative-hoz'
  if (!o.outcomeType?.trim()) return 'a desired outcome típusa kötelező (§9)'
  if (!o.targetState?.trim()) return 'a desired outcome célállapota kötelező (§9)'
  if (!o.completionEvidence?.length) {
    return 'a desired outcome-hoz kell legalább egy bizonyíték, ami alapján lezártnak tekinthető (§9)'
  }
  return null
}

export function readInitiative(db: Database.Database, initiativeId: string): ProactiveInitiative | null {
  const r = db.prepare(`SELECT * FROM proactive_initiatives WHERE initiative_id = ?`).get(initiativeId) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    initiativeId: r.initiative_id as string,
    domain: r.domain as ProactiveDomain,
    signalIds: JSON.parse(r.signal_ids_json as string) as string[],
    initiativeType: r.initiative_type as ProactiveInitiative['initiativeType'],
    materiality: r.materiality as ProactiveInitiative['materiality'],
    urgency: r.urgency as ProactiveInitiative['urgency'],
    caseId: (r.case_id as string | null) ?? undefined,
    desiredOutcome: JSON.parse(r.desired_outcome_json as string) as DesiredOutcome,
    currentGap: r.current_gap as string,
    decisionDeadline: (r.decision_deadline as number | null) ?? undefined,
    internalSafeDeadline: (r.internal_safe_deadline as number | null) ?? undefined,
    allowedPreparationClasses: JSON.parse(r.allowed_preparation_classes_json as string) as InternalPreparationClass[],
    unresolvedRequirements: JSON.parse(r.unresolved_requirements_json as string) as string[],
    userInterruptionRequired: (r.user_interruption_required as number) === 1,
    interruptionReason: (r.interruption_reason as string | null) ?? undefined,
    state: r.state as InitiativeState,
    confidence: r.confidence as number,
  }
}

/** The §7.1 tier-4 input: the situations already represented by an open
 *  Initiative in this domain. Domain-scoped, because an Initiative on one side
 *  of the house must not suppress a signal on the other. */
export function activeInitiativeDedupeKeys(db: Database.Database, domain: ProactiveDomain): Set<string> {
  const rows = db.prepare(
    `SELECT s.dedupe_key AS k
       FROM proactive_initiatives i
       JOIN proactive_signals s ON s.domain = i.domain
        AND instr(i.signal_ids_json, '"' || s.signal_id || '"') > 0
      WHERE i.domain = ? AND i.state NOT IN ('SUPPRESSED','RESOLVED')`,
  ).all(domain) as Array<{ k: string }>
  return new Set(rows.map(r => r.k))
}
