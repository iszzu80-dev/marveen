// Reader–Policy–Kernel arbitration (§13.1).
//
// WHY THIS EXISTS BEFORE THE WIRING. The Reader produces a candidateDecision.
// §13.1 is explicit that this is a SUGGESTION, not authority, and names the
// precedence:
//
//   HARD GATE > deterministic domain/scope policy > delegation/approval
//   > kernel state invariants > validated evidence + confidence > reader candidate
//
// Without this module there is no place where that ordering is enforced, and the
// only two options at the call site would be to ignore the Reader (making the
// call pointless) or to follow it (making the model the authority). So the
// arbitration is written first and the Reader is wired to it, not to the engine.
//
// EVERY conflict is audited with the four fields §13.1 names — reader_candidate,
// policy_result, conflict_reason, safe_fallback_decision — because a suggestion
// that was silently overruled and a suggestion that was silently followed look
// identical afterwards, and the difference is the whole safety argument.
import { axisConflicts } from './contradiction-axes.js'
import type { ProgressionDecision } from './reader.js'

/** Decisions that can cause something to happen OUTSIDE this system. §13.1's
 *  fail-safe applies to these: low confidence must produce no external effect. */
const EXTERNAL_EFFECT_DECISIONS: ReadonlySet<ProgressionDecision> = new Set([
  'CONTINUE_AUTONOMOUSLY', 'CALL_REQUIRED',
])

/**
 * Per-decision-class confidence thresholds.
 *
 * §13.1: "A threshold decision/action class szerint konfigurálható; ne legyen
 * egyetlen globális szám." One number would mean the threshold for closing a
 * case is the threshold for asking a question — and being wrong about those
 * costs very different amounts. Anything not listed needs no confidence floor:
 * asking, waiting and escalating are safe when we know little, and are in fact
 * the correct output of knowing little.
 */
export const CONFIDENCE_THRESHOLDS: Partial<Record<ProgressionDecision, number>> = {
  // Closing a case on a bad reading loses the case. §13.1 states outright that
  // COMPLETE is not acceptable at low confidence.
  COMPLETE: 0.85,
  // Acting without asking anyone.
  CONTINUE_AUTONOMOUSLY: 0.7,
  CALL_REQUIRED: 0.7,
}

export interface ArbitrationInput {
  readerCandidate: ProgressionDecision
  confidence: number
  /** The deterministic engine's decision for this case — the policy result. */
  policyDecision: string
  /** A hard gate that is currently CLOSED, e.g. the kill switch. Null = open. */
  hardGateRefusal?: string | null
  /** Did the packet pass schema + provenance validation? An invalid packet has
   *  no standing at all; it is not a weak opinion, it is not an opinion. */
  packetValid?: boolean
}

export interface ArbitrationResult {
  /** What the system will act on. Never simply the Reader's candidate. */
  finalDecision: string
  readerCandidate: ProgressionDecision | null
  policyResult: string
  /** True when the Reader proposed something the ordering above did not allow. */
  conflict: boolean
  conflictReason: string | null
  /** What we fall back to when the candidate is refused. Recorded even when it
   *  equals finalDecision, so the audit row answers "what would have happened"
   *  without re-deriving it. */
  safeFallbackDecision: string
  /** Which rung of §13.1's ladder decided this. */
  decidedBy: 'HARD_GATE' | 'POLICY' | 'POLICY_CROSS_AXIS' | 'CONFIDENCE' | 'INVALID_PACKET' | 'READER_AGREES'
}

/**
 * Decide what the system does, given a Reader suggestion and the deterministic
 * policy result.
 *
 * The rungs are checked in §13.1's order and the FIRST one that binds wins. The
 * Reader is only ever consulted on the last rung, and even there it only gets to
 * agree — a candidate that differs from policy is a conflict, and POLICY WINS.
 */
export function arbitrate(input: ArbitrationInput): ArbitrationResult {
  const {
    readerCandidate, confidence, policyDecision,
    hardGateRefusal = null, packetValid = true,
  } = input

  const base: Omit<ArbitrationResult, 'finalDecision' | 'conflict' | 'conflictReason' | 'decidedBy' | 'safeFallbackDecision'> = {
    readerCandidate: packetValid ? readerCandidate : null,
    policyResult: policyDecision,
  }

  // Rung 1 — HARD GATE. Confidence cannot overrule it; §13.1 says so in one
  // sentence, and it is the sentence that stops a very sure model from sending
  // mail while the kill switch is engaged.
  if (hardGateRefusal) {
    return {
      ...base,
      finalDecision: 'RECOVERY_REQUIRED',
      conflict: true,
      conflictReason: `hard gate closed: ${hardGateRefusal}`,
      safeFallbackDecision: 'RECOVERY_REQUIRED',
      decidedBy: 'HARD_GATE',
    }
  }

  // An unvalidated packet is not a weaker opinion — it is not evidence. The
  // policy result stands alone, and the fact that a reading was discarded is
  // still recorded rather than looking like "the Reader had nothing to say".
  if (!packetValid) {
    return {
      ...base,
      finalDecision: policyDecision,
      conflict: false,
      conflictReason: 'packet failed validation; no reader input considered',
      safeFallbackDecision: policyDecision,
      decidedBy: 'INVALID_PACKET',
    }
  }

  // Rung 2 — deterministic policy. Any disagreement ends here: POLICY WINS.
  //
  // But "disagreement" is now the owner's definition (2026-08-31): two claims on
  // the SAME decision axis. A reader asking for a person and a policy saying the
  // engine can keep working internally are not opposites, and recording them as
  // contradictory evidence refused every outward action on 106 of 133 cases for
  // a reason that did not hold. Policy still wins the DECISION either way -- what
  // changed is whether the difference is also called a contradiction.
  if (readerCandidate !== policyDecision) {
    const axes = axisConflicts(readerCandidate, policyDecision)
    if (axes.length === 0) {
      return {
        ...base,
        finalDecision: policyDecision,
        conflict: false,
        conflictReason: null,
        safeFallbackDecision: policyDecision,
        // Recorded as its own outcome rather than as a note nobody can query:
        // `decided_by` is persisted, and a later reader must be able to tell
        // "these two spoke about different things" from "they never differed".
        decidedBy: 'POLICY_CROSS_AXIS',
      }
    }
    return {
      ...base,
      finalDecision: policyDecision,
      conflict: true,
      conflictReason: `reader proposed ${readerCandidate}, deterministic policy decided ${policyDecision}`
        + ` — ${axes.map(a => a.reason).join('; ')}`,
      safeFallbackDecision: policyDecision,
      decidedBy: 'POLICY',
    }
  }

  // Rung 3 — evidence and confidence. Reader and policy AGREE at this point, so
  // this rung is not about who is right; it is about whether we are sure enough
  // to do the agreed thing when the agreed thing reaches outside or closes a
  // case. Agreement is not certainty: both can be reading the same thin context.
  const floor = CONFIDENCE_THRESHOLDS[readerCandidate]
  if (floor !== undefined && confidence < floor) {
    const fallback = fallbackFor(readerCandidate)
    return {
      ...base,
      finalDecision: fallback,
      conflict: true,
      conflictReason:
        `confidence ${confidence} below the ${floor} floor for ${readerCandidate}`,
      safeFallbackDecision: fallback,
      decidedBy: 'CONFIDENCE',
    }
  }

  return {
    ...base,
    finalDecision: policyDecision,
    conflict: false,
    conflictReason: null,
    safeFallbackDecision: policyDecision,
    decidedBy: 'READER_AGREES',
  }
}

/**
 * Where a refused decision lands.
 *
 * §13.1's fail-safe list is: no external side effect → try to resolve further →
 * otherwise ASK_INFORMATION / REQUEST_DECISION / REQUEST_APPROVAL /
 * RECOVERY_REQUIRED. Closing wrongly and acting wrongly fail differently, so
 * they fall back differently: an uncertain COMPLETE becomes a question to the
 * owner, an uncertain action becomes a request for the missing information.
 */
export function fallbackFor(candidate: ProgressionDecision): string {
  if (candidate === 'COMPLETE') return 'REQUEST_DECISION'
  if (EXTERNAL_EFFECT_DECISIONS.has(candidate)) return 'ASK_INFORMATION'
  return 'ASK_INFORMATION'
}

/** True when a decision may cause an effect outside this system. Exported so a
 *  caller can assert the fail-safe held without re-listing the decisions. */
export function hasExternalEffect(decision: string): boolean {
  return EXTERNAL_EFFECT_DECISIONS.has(decision as ProgressionDecision)
}

/**
 * IS THIS PACKET CONTRADICTORY? One definition, because there were three.
 *
 * `arbitrate` returns a `conflict` boolean and it is not persisted -- the packet
 * table keeps `conflict_reason` and `decided_by` and drops the flag. So every
 * consumer re-derived the answer as `conflict_reason IS NOT NULL`, and that
 * predicate is wrong for exactly one branch: an invalid packet fills the reason
 * with an explanatory note while explicitly setting `conflict: false`, because
 * a reading that failed validation is not a disagreement -- there is no second
 * opinion to disagree with.
 *
 * Measured on the live store, 2026-08-31: 152 of 181 active cases counted as
 * contradicted (0.84), of which 15 were INVALID_PACKET. The real contradiction
 * count is 137 (0.76). That number gates Phase 2, and it was inflated by a
 * predicate that read the note instead of the verdict.
 *
 * `decided_by` survives into the table and separates the branches exactly, so
 * this needs no migration and no backfill -- and it is exported so the metric,
 * the invariant and any future reader share ONE answer rather than three copies
 * that can drift.
 *
 * NOT A LOOSENING. An invalid packet must still stop a non-read-only action;
 * it just must not be called a contradiction while doing so. See Invariant E,
 * where the single check became two and both still FAIL.
 */
export const NON_CONFLICT_DECIDED_BY = 'INVALID_PACKET'

export function packetIsContradictory(
  p: { conflictReason: string | null | undefined; decidedBy: string | null | undefined },
): boolean {
  if (!p.conflictReason) return false
  return p.decidedBy !== NON_CONFLICT_DECIDED_BY
}

/** The same predicate for SQL. `alias` is the packet table's alias. */
export const contradictorySql = (alias: string): string =>
  `(${alias}.conflict_reason IS NOT NULL AND COALESCE(${alias}.decided_by, '') <> '${NON_CONFLICT_DECIDED_BY}')`
