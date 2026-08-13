// v1.4 Proactive Core — Initiative Qualification Policy (§6).
//
// DETERMINISTIC ON PURPOSE, and the spec says so in its first line: "the
// Reader/model suggestion is only input". The same argument the evidence planner
// and the owner-question writer already make in this codebase — the judgement
// already happened upstream; re-asking a model to decide turns a reproducible
// verdict into one that drifts between runs.
//
// It has to be reproducible for a second reason that is specific to this
// release. §1.4.3 measures incremental value by BLIND ADJUDICATION against a
// frozen corpus. A policy whose verdict on the same input can differ between the
// shadow run and the replay makes that comparison meaningless: the thing being
// measured has to hold still.
//
// §6.3, which is the sentence that should govern every threshold below:
//
//   "The goal is not to notice everything, but to reliably surface the few
//    things genuinely worth acting on."
//
// So the defaults are deliberately strict, and every suppression is recorded
// with a machine-readable reason code (§6.3, V4-F10) rather than as silence.

import type {
  Actionability,
  InitiativeQualificationResult,
  Materiality,
  ProactiveSignal,
  Urgency,
} from './types.js'

/** The §6.1 decision sequence, as data. Each stage may only SUPPRESS or
 *  downgrade; nothing later can undo an earlier refusal. Exported so the tests
 *  assert the ORDER, not just the outcome — "hard gate before evidence" is the
 *  half of the policy that decides what a leak looks like. */
export const QUALIFICATION_STAGES = [
  'hard_gate',
  'evidence_sufficiency',
  'duplicate_novelty',
  'materiality',
  'urgency_deadline',
  'actionability',
  'existing_case_relevance',
  'interruption_cost',
  'promotion',
] as const

const MATERIALITY_SCORE: Record<Materiality, number> = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 1 }
const URGENCY_SCORE: Record<Urgency, number> = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 1 }
const ACTIONABILITY_SCORE: Record<Actionability, number> = { LOW: 0.2, MEDIUM: 0.6, HIGH: 1 }

export interface QualificationPolicy {
  /** §6.3 configurable materiality threshold. */
  minMaterialityScore: number
  /** Below this, the detector is not confident enough for the signal to be
   *  worth anyone's attention — annotate and move on. */
  minConfidence: number
  /** A signal that nobody can act on is an FYI, and §8.1 says an FYI is not a
   *  reason to open anything. */
  minActionabilityScore: number
  /** How close a deadline has to be for urgency to override a middling
   *  materiality. Seconds. */
  deadlineImminentSec: number
  /** §17: what an interruption costs before it is worth making. Scored, not
   *  acted on — nothing in Stage 0 interrupts anybody. */
  interruptionThreshold: number
}

/** §1.4 / V4-F14: these numbers become part of the frozen `value_gate_registration`
 *  once shadow starts. They are defaults, not settings to tune while a
 *  measurement window is open — changing a threshold after seeing results is the
 *  named FAIL condition of V4-F14. */
export const DEFAULT_QUALIFICATION_POLICY: QualificationPolicy = {
  minMaterialityScore: 0.5,
  minConfidence: 0.5,
  minActionabilityScore: 0.6,
  deadlineImminentSec: 72 * 3600,
  interruptionThreshold: 0.7,
}

export interface QualificationContext {
  /** Active Cases in this signal's domain, by id, with the subject the Case is
   *  about. Passed IN rather than queried here: this module must not reach into
   *  the Case store (§15.3(2) and the import-boundary standing check), and a
   *  policy that reads the database is a policy that cannot be replayed against
   *  a frozen corpus. */
  activeCases?: Array<{ caseId: string; subjectRef?: string; title?: string }>
  /** Initiatives already open in this domain, for the §7.1 tier-4 check. */
  activeInitiativeDedupeKeys?: Set<string>
  /** Domain-level hard denial (§20.1/§20.2). The caller owns the policy; this
   *  layer owns the ordering — a hard deny is checked BEFORE evidence, so a
   *  denied signal never has its content examined at all. */
  hardDenyReason?: string
}

/**
 * Qualify one signal. Pure: same input, same verdict, no clock, no database.
 */
export function qualifySignal(
  signal: ProactiveSignal,
  now: number,
  ctx: QualificationContext = {},
  policy: QualificationPolicy = DEFAULT_QUALIFICATION_POLICY,
): InitiativeQualificationResult {
  const reasons: string[] = []
  const materialityScore = MATERIALITY_SCORE[signal.estimatedMateriality] ?? 0
  const urgencyScore = URGENCY_SCORE[signal.estimatedUrgency] ?? 0
  const actionabilityScore = ACTIONABILITY_SCORE[signal.estimatedActionability] ?? 0

  const deadlineImminent = signal.candidateDeadline != null
    && signal.candidateDeadline - now <= policy.deadlineImminentSec
  const deadlinePassed = signal.candidateDeadline != null && signal.candidateDeadline <= now

  // Interruption cost rises with materiality and urgency and falls with
  // uncertainty: interrupting on a guess is the most expensive kind of
  // interruption, because it is the one that teaches the owner to stop reading.
  const interruptionScore = round(
    (0.5 * materialityScore + 0.3 * urgencyScore + 0.2 * actionabilityScore) * signal.confidence,
  )

  const verdict = (decision: InitiativeQualificationResult['decision'], matchedCaseId?: string): InitiativeQualificationResult => ({
    signalId: signal.signalId,
    decision,
    reasonCodes: reasons,
    matchedCaseId,
    materialityScore: round(materialityScore),
    urgencyScore: round(urgencyScore),
    actionabilityScore: round(actionabilityScore),
    interruptionScore,
    confidence: signal.confidence,
  })

  // 1. hard gate / domain policy. First, and unconditionally: a denied signal
  //    must not have its evidence weighed, matched against Cases, or scored.
  //    Anything this stage lets past has been through the domain's own policy.
  if (ctx.hardDenyReason) {
    reasons.push(`hard_gate:${ctx.hardDenyReason}`)
    return verdict('SUPPRESS')
  }

  // 2. evidence sufficiency. The store already refuses an uncited claim, so
  //    reaching here with none means the row predates the rule or was written
  //    around it — either way it is not evidence and is not promoted.
  if (!signal.evidenceClaims.length || !signal.sourceRefs.length) {
    reasons.push('evidence_sufficiency:no_grounded_claim')
    return verdict('SUPPRESS')
  }
  if (signal.confidence < policy.minConfidence) {
    // ANNOTATE, not SUPPRESS: the observation is kept and searchable, it simply
    // does not get to become an Initiative. §6.3's "low-value signal
    // suppression" is about attention, not about deleting what was seen.
    reasons.push('evidence_sufficiency:below_confidence_threshold')
    return verdict('ANNOTATE')
  }

  // 3. duplicate / novelty. Tier 4 of §7.1: an equivalent Initiative is already
  //    open, so this situation is represented and a second one would be the
  //    duplicate interruption V4-F7 fails on.
  if (ctx.activeInitiativeDedupeKeys?.has(signal.dedupeKey)) {
    reasons.push('duplicate_novelty:active_initiative_equivalent')
    return verdict('SUPPRESS')
  }

  // 4. materiality (§6.3). The deadline exception is narrow on purpose: a
  //    passed or imminent deadline is itself material, and a policy that
  //    suppressed it for a middling materiality estimate would fail V4-F1 while
  //    looking disciplined.
  const materialEnough = materialityScore >= policy.minMaterialityScore
  if (!materialEnough && !deadlineImminent) {
    reasons.push('materiality:below_threshold')
    return verdict('ANNOTATE')
  }
  if (!materialEnough && deadlineImminent) {
    reasons.push(deadlinePassed ? 'materiality:overridden_by_passed_deadline' : 'materiality:overridden_by_imminent_deadline')
  }

  // 5. urgency / deadline. Recorded rather than gating: a material obligation
  //    with no date is still an obligation, and dropping it for want of a
  //    deadline is how the OBLIGATION class of V4-F4 gets missed.
  if (deadlinePassed) reasons.push('urgency_deadline:passed')
  else if (deadlineImminent) reasons.push('urgency_deadline:imminent')
  else if (signal.candidateDeadline != null) reasons.push('urgency_deadline:scheduled')
  else reasons.push('urgency_deadline:none')

  // 6. actionability (§8.1): "the Case would not merely be an FYI notification".
  if (actionabilityScore < policy.minActionabilityScore) {
    reasons.push('actionability:informational_only')
    return verdict('ANNOTATE')
  }

  // 7. existing Case relevance (§8). Matching comes BEFORE promotion, not after,
  //    because §8's whole ordering is "find an existing Case first" — a
  //    promotion that looks for a Case afterwards has already decided to create
  //    one.
  const matched = matchExistingCase(signal, ctx)
  if (matched) reasons.push('existing_case_relevance:matched')
  else reasons.push('existing_case_relevance:none')

  // 8. interruption cost (§17). Scored and recorded; it does not block
  //    promotion, because an Initiative that is worth preparing internally is
  //    worth preparing whether or not it will ever be worth interrupting for.
  //    Those are two different budgets and merging them would spend the
  //    cheaper one on the more expensive one's behalf.
  reasons.push(interruptionScore >= policy.interruptionThreshold
    ? 'interruption_cost:above_threshold'
    : 'interruption_cost:below_threshold')

  // 9. promotion.
  reasons.push('promotion:qualified')
  return verdict('PROMOTE', matched)
}

/** §8: exact subject identity, then the Case the signal already names. No fuzzy
 *  title matching in this slice — a wrong match attaches an Initiative to
 *  somebody else's Case, and the failure is silent. §8's "semantic/subject
 *  match" tier arrives with the Reader extension of step 8, where there is an
 *  evidence packet to justify a match with. */
function matchExistingCase(signal: ProactiveSignal, ctx: QualificationContext): string | undefined {
  const cases = ctx.activeCases ?? []
  if (signal.candidateCaseId) {
    const named = cases.find(c => c.caseId === signal.candidateCaseId)
    if (named) return named.caseId
  }
  if (signal.subjectRef) {
    const bySubject = cases.find(c => c.subjectRef && c.subjectRef === signal.subjectRef)
    if (bySubject) return bySubject.caseId
  }
  return undefined
}

function round(n: number): number { return Math.round(n * 1000) / 1000 }

/** Whether this verdict may open a NEW Case (§8.1). Separate from the verdict
 *  itself: PROMOTE says the situation deserves an Initiative, which is a much
 *  weaker claim than "a new Case should exist". Most promotions should attach to
 *  something that already does. */
export function mayCreateNewCase(r: InitiativeQualificationResult, policy: QualificationPolicy = DEFAULT_QUALIFICATION_POLICY): boolean {
  return r.decision === 'PROMOTE'
    && !r.matchedCaseId
    && r.materialityScore >= policy.minMaterialityScore
    && r.actionabilityScore >= policy.minActionabilityScore
}
