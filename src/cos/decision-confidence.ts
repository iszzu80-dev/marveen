/**
 * P4 — confidence and risk, so Invariant E is an invariant.
 *
 * The spec sentence it exists to enforce:
 *
 *     Invariant E: Low-confidence high-risk action nem hajtható végre
 *     automatikusan.
 *
 * The audit's finding (§3.5) was not that this was violated -- it was that it
 * was **not enforceable**: personal cases carry neither a confidence nor a risk,
 * so the invariant lived as a sentence while the approval bind and the send
 * ceilings did the actual protecting. Real protections, and not this one.
 *
 * THE NAMES ARE `decision_*` ON PURPOSE. Two other `confidence` fields already
 * exist in this codebase and neither means what Invariant E means:
 *
 *   `answer-interpretation`  HIGH/LOW -- how unambiguous ISTVAN'S SENTENCE was
 *   `adjudication`           LOW/MEDIUM/HIGH -- how sure an origin GUESS is
 *
 * A third bare `confidence` would be the `next_wake_at` mistake again: one name,
 * three meanings, and a reader who cannot tell which one a number came from.
 * These are the ENGINE'S judgement about its OWN decision, and the column says so.
 *
 * DETERMINISTIC, and every input is a fact already on the row or already
 * computed by this run. No model call, no heuristic that varies between two
 * evaluations of the same state: a gate that can answer differently twice about
 * one case is not a gate, and §19's replay corpus could not exercise it.
 *
 * A THIRD GATE, NOT A REPLACEMENT. The approval bind and the send ceilings stay
 * exactly as they are. This one refuses EARLIER and for a different reason, and
 * the acceptance criterion is explicit that a test must be able to tell which of
 * the three fired -- so the refusal below carries its own code and names both
 * numbers.
 */

export const DECISION_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const
export type DecisionLevel = (typeof DECISION_LEVELS)[number]

/** What the engine knows about the decision it just made. Every field is a fact
 *  it already has -- nothing here requires a new source. */
export interface DecisionSignals {
  /** The side-effect class of the chosen action (capability-contract's). */
  sideEffect: 'READ_ONLY' | 'MUTATING' | 'HIGH_RISK'
  /** The capability verdict for it. DENY and WAIT are not merely blockers: they
   *  are evidence the engine does not have what the action needs. */
  capabilityVerdict: 'PROCEED' | 'WAIT_CAPABILITY' | 'DENY_UNDECLARED' | 'CONTRACT_GAP'
  /** Optional capabilities that were missing and proceeded without. */
  degradations: number
  /** Consecutive runs that moved nothing. A case the engine keeps failing to
   *  advance is a case it understands less well than it thinks. */
  noProgressRuns: number
  /** Times the case was interrupted / replanned. */
  interruptions: number
  /** Whether the case carries a real Definition of Done, verified per criterion.
   *  Deciding without one is deciding against an unstated target. */
  hasVerifiedDoD: boolean
  /** Money at stake, when the namespace records it (ZST does, personal does not). */
  financialExposure: number | null
  /** Legal exposure marker, same. */
  legalExposure: string | null
}

export interface DecisionAssessment {
  confidence: DecisionLevel
  risk: DecisionLevel
  /** Why, in short machine-readable tokens. On the run, so a later reader can
   *  see which signal moved the number rather than re-deriving it. */
  reasons: string[]
}

/**
 * Risk first, because it is the simpler of the two and the owner's sentence
 * leads with it.
 *
 * The side-effect class is the floor: anything that can reach outside is at
 * least MEDIUM, and money or legal exposure lifts it to HIGH regardless of what
 * kind of step it is. A READ_ONLY step with no exposure is LOW -- and it has to
 * be, or the gate would refuse ordinary reading and the whole engine would stop.
 */
export function assessRisk(s: DecisionSignals): { risk: DecisionLevel; reasons: string[] } {
  const reasons: string[] = []
  let risk: DecisionLevel = 'LOW'
  if (s.sideEffect === 'MUTATING') { risk = 'MEDIUM'; reasons.push('side-effect:MUTATING') }
  if (s.sideEffect === 'HIGH_RISK') { risk = 'HIGH'; reasons.push('side-effect:HIGH_RISK') }
  if (s.financialExposure !== null && s.financialExposure > 0) {
    risk = 'HIGH'; reasons.push(`financial-exposure:${s.financialExposure}`)
  }
  if (s.legalExposure) { risk = 'HIGH'; reasons.push(`legal-exposure:${s.legalExposure}`) }
  return { risk, reasons }
}

/**
 * Confidence starts HIGH and is spent by named doubts.
 *
 * STARTING HIGH IS THE ARGUABLE PART, so here is the argument: every signal
 * below is a reason to doubt, and there is no signal that is a reason to be
 * sure. Starting LOW and requiring evidence to climb would mean an ordinary
 * healthy case never rose above LOW, and Invariant E would then refuse
 * everything high-risk for ever -- a gate that always fires is as useless as one
 * that never does. So: HIGH until something specific says otherwise, and each
 * step down is named.
 */
export function assessConfidence(s: DecisionSignals): { confidence: DecisionLevel; reasons: string[] } {
  const reasons: string[] = []
  let score = 2   // 2 = HIGH, 1 = MEDIUM, 0 = LOW

  // The engine does not have what the action needs. Not a doubt -- a fact.
  if (s.capabilityVerdict === 'DENY_UNDECLARED') { score -= 2; reasons.push('capability:UNDECLARED') }
  else if (s.capabilityVerdict === 'WAIT_CAPABILITY') { score -= 2; reasons.push('capability:MISSING') }
  else if (s.capabilityVerdict === 'CONTRACT_GAP') { score -= 1; reasons.push('capability:CONTRACT_GAP') }

  if (s.degradations > 0) { score -= 1; reasons.push(`degraded:${s.degradations}`) }
  // Three is the point at which "it did not move" stops being noise. The same
  // number the recovery queue escalates at, deliberately: two thresholds that
  // mean "this is not working any more" should not disagree.
  if (s.noProgressRuns >= 3) { score -= 1; reasons.push(`no-progress:${s.noProgressRuns}`) }
  if (s.interruptions >= 3) { score -= 1; reasons.push(`interruptions:${s.interruptions}`) }
  if (!s.hasVerifiedDoD) { score -= 1; reasons.push('dod:unverified') }

  const confidence: DecisionLevel = score >= 2 ? 'HIGH' : score >= 1 ? 'MEDIUM' : 'LOW'
  return { confidence, reasons }
}

export function assessDecision(s: DecisionSignals): DecisionAssessment {
  const r = assessRisk(s)
  const c = assessConfidence(s)
  return { confidence: c.confidence, risk: r.risk, reasons: [...r.reasons, ...c.reasons] }
}

// ── Invariant E ─────────────────────────────────────────────────────────

export interface InvariantEResult {
  allowed: boolean
  /** Machine-readable and UNIQUE to this gate. The acceptance criterion requires
   *  a test to tell an Invariant E refusal apart from an approval-bind refusal
   *  and from a ladder refusal; a shared code would make all three read the same
   *  in the log, which is the one thing that must not happen. */
  code: 'ok' | 'invariant_e_low_confidence_high_risk'
  reason: string
}

/**
 * The gate. LOW confidence AND HIGH risk, exactly as the sentence says.
 *
 * NOT "medium or below" and not "medium risk too". Widening it here would be a
 * policy change wearing an invariant's name -- the sentence is the owner's, and
 * if it should be stricter that is his decision, made once, in the open. The
 * numbers are recorded on every decision either way, so the question "how often
 * would a wider gate have fired?" is answerable from data rather than from
 * argument.
 */
export function invariantE(a: { confidence: DecisionLevel; risk: DecisionLevel }): InvariantEResult {
  if (a.confidence === 'LOW' && a.risk === 'HIGH') {
    return {
      allowed: false,
      code: 'invariant_e_low_confidence_high_risk',
      reason: `Invariáns E: alacsony bizalmú (${a.confidence}) magas kockázatú (${a.risk}) `
        + 'művelet nem hajtható végre automatikusan',
    }
  }
  return { allowed: true, code: 'ok', reason: '' }
}
