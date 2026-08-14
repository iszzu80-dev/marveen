// APG 1.9 §12.4 -- the risk-to-verifier-count cost policy. MODELLED, NOT
// RESOLVED, and the distinction is the entire point of this file.
//
// WHAT §12.4 SAYS. A semantic verifier is not the automatic cost of every
// change. The verifier count is a FUNCTION OF RISK:
//
//   LOW            deterministic executors, no semantic verifier
//   MEDIUM         deterministic executors + at most 1 semantic verifier,
//                  and only when the acceptance is semantic (§18.2)
//   HIGH/CRITICAL  deterministic executors + 1 FRESH semantic verifier,
//                  plus an owner gate where needed
//
// WHAT THIS REPOSITORY CANNOT DO WITH IT, stated here rather than discovered
// later: **nothing anywhere produces a risk class.** §18 (Risk Profile
// rendszer) is unbuilt in both repos -- there is no risk input, no classifier,
// no stored risk column, and `apg/ui-projection.ts:992` hardcodes
// `risk: 'unknown'` for every card it projects. So the policy above can be
// expressed and tested, and it cannot be APPLIED to a real change yet.
//
// THE ONE RULE THAT KEEPS THAT HONEST. Unresolved risk yields
// `verifierCount: null` and the reason code RISK_PROFILE_UNRESOLVED -- never
// zero, never one, never "MEDIUM as a safe middle". A default here would be
// the most expensive kind of lie this codebase can tell: it would make a
// change look policy-governed while the governing input was a guess, and both
// possible guesses are wrong in a costly direction (0 skips the verifier a
// CRITICAL change needs; 1 pays for a verifier LOW risk explicitly refuses).
// §3.7's rule -- uncertainty is a first-class state, not a falsy value -- is
// the same rule the kernel applies to PRODUCT_ID_UNKNOWN and
// CONTEXT_PACKET_HASH_UNKNOWN.
//
// Pure and dependency-free: no clock, no store, no model, no I/O. The risk
// vocabulary is `ApgRisk` from apg/ui-types.ts -- the one that already exists
// and already carries §18's four classes plus 'unknown' -- imported rather
// than re-spelled.

import type { ApgRisk } from './apg/ui-types.js'

/** §18's four risk classes. 'unknown' is deliberately NOT in here: it is the
 *  absence of a class, and treating it as a fifth one is how it would acquire
 *  a policy of its own. */
export type ResolvedRisk = Exclude<ApgRisk, 'unknown'>

export const RESOLVED_RISKS: readonly ResolvedRisk[] = ['low', 'medium', 'high', 'critical']

export type VerifierPolicyReason =
  /** No risk class exists for this change. §18 is unbuilt. */
  | 'RISK_PROFILE_UNRESOLVED'
  /** §12.4 LOW: deterministic executors only. */
  | 'LOW_NO_SEMANTIC_VERIFIER'
  /** §12.4 MEDIUM: at most one, and only if the acceptance is semantic. */
  | 'MEDIUM_AT_MOST_ONE_VERIFIER'
  /** §12.4 HIGH/CRITICAL: one FRESH semantic verifier. */
  | 'HIGH_FRESH_VERIFIER_REQUIRED'

/**
 * What §12.4 says about one change.
 *
 * Every numeric field is `number | null` and every boolean is
 * `boolean | null`, for one reason: a policy decision that could not be made
 * must not be readable as a policy decision that was made. `resolved` is the
 * field a caller branches on; the nulls are there so that a caller which
 * forgets to is stopped by the type rather than silently handed a 0.
 */
export interface VerifierPolicyDecision {
  /** False exactly when the risk class is unknown. */
  resolved: boolean
  /** The risk the decision was made under. 'unknown' when unresolved. */
  risk: ApgRisk
  /**
   * How many SEMANTIC verifiers §12.4 admits for this change. Null when
   * unresolved -- this is the field the whole module exists to refuse to
   * fabricate.
   */
  maxSemanticVerifiers: number | null
  /** Whether a verifier, if run, must be a FRESH one (§12.3). Null when
   *  unresolved. */
  freshVerifierRequired: boolean | null
  /** Whether §12.4 admits an owner gate on top. Null when unresolved.
   *  "Admits", not "requires": §19 is explicit that the goal is fewer owner
   *  interactions, so this is a permission the runner may use, not a step. */
  ownerGateAdmitted: boolean | null
  reasonCode: VerifierPolicyReason
  /** Human-readable, and on the unresolved path it names WHAT IS MISSING. */
  detail: string
}

/** What §18 would have to supply for `resolveVerifierPolicy` to ever return a
 *  resolved decision. Exported so the gap is a value a report can print, not a
 *  sentence in a comment somebody has to keep true (the same reason the
 *  kernel's execution_identity.field_sources() is a function). */
export const RISK_PROFILE_MISSING_INPUTS: readonly string[] = [
  'a risk class per change, from §18\'s inputs (production side effect, auth/security, PII, ' +
  'destructive DB, billing, tenant isolation, user-facing legal, rollback difficulty, blast ' +
  'radius, dependency upgrade, unknown system state)',
  'a stored risk column on the work item, so the class is auditable rather than recomputed per read',
  'an acceptance-semantics flag, which §18.2 needs to decide whether MEDIUM pays for its one verifier',
]

export const RISK_PROFILE_UNRESOLVED_DETAIL =
  '§12.4 cannot be applied: no risk class exists for this change. §18 (Risk Profile) is unbuilt in ' +
  'both repositories and apg/ui-projection.ts reports risk=unknown for every card, so the verifier ' +
  'count is UNKNOWN -- deliberately not defaulted, because 0 would skip a verifier a CRITICAL change ' +
  'needs and 1 would buy one LOW risk explicitly refuses.'

/**
 * Resolve §12.4 for one change.
 *
 * `acceptanceIsSemantic` only matters at MEDIUM, where §18.2 says a semantic
 * verifier runs "csak ha acceptance szemantikai" -- if the acceptance criteria
 * are fully deterministic, MEDIUM buys nothing by paying for a reader. It is
 * an explicit caller assertion with no default, following the same pattern as
 * the kernel's `product_specific=False` escape hatch: a caller that gets it
 * wrong has written the claim down.
 */
export function resolveVerifierPolicy(
  risk: ApgRisk | null | undefined,
  opts: { acceptanceIsSemantic?: boolean } = {},
): VerifierPolicyDecision {
  const unresolved: VerifierPolicyDecision = {
    resolved: false,
    risk: 'unknown',
    maxSemanticVerifiers: null,
    freshVerifierRequired: null,
    ownerGateAdmitted: null,
    reasonCode: 'RISK_PROFILE_UNRESOLVED',
    detail: RISK_PROFILE_UNRESOLVED_DETAIL,
  }
  if (!risk || !(RESOLVED_RISKS as readonly string[]).includes(risk)) return unresolved

  switch (risk as ResolvedRisk) {
    case 'low':
      return {
        resolved: true, risk: 'low',
        maxSemanticVerifiers: 0,
        freshVerifierRequired: false,
        ownerGateAdmitted: false,
        reasonCode: 'LOW_NO_SEMANTIC_VERIFIER',
        detail: '§12.4 LOW: deterministic executors, no semantic verifier, no owner gate (§18.1).',
      }
    case 'medium':
      return {
        resolved: true, risk: 'medium',
        // "maximum 1", and zero when the acceptance is not semantic -- the cap
        // is a ceiling, not a quota to fill.
        maxSemanticVerifiers: opts.acceptanceIsSemantic ? 1 : 0,
        // §12.4 asks for freshness at HIGH/CRITICAL. At MEDIUM the one verifier
        // is admitted but not required to be fresh, and saying otherwise would
        // quietly move MEDIUM's cost onto HIGH's budget.
        freshVerifierRequired: false,
        ownerGateAdmitted: true,
        reasonCode: 'MEDIUM_AT_MOST_ONE_VERIFIER',
        detail: opts.acceptanceIsSemantic
          ? '§12.4 MEDIUM: deterministic executors + at most 1 semantic verifier (acceptance is semantic, §18.2).'
          : '§12.4 MEDIUM: deterministic executors only -- the caller declares the acceptance fully ' +
            'deterministic, and §18.2 buys a semantic verifier only when it is not.',
      }
    case 'high':
    case 'critical':
      return {
        resolved: true, risk,
        maxSemanticVerifiers: 1,
        freshVerifierRequired: true,
        ownerGateAdmitted: true,
        reasonCode: 'HIGH_FRESH_VERIFIER_REQUIRED',
        detail: risk === 'critical'
          ? '§12.4 CRITICAL: deterministic executors + 1 fresh semantic verifier + owner gate; §18.4 ' +
            'additionally expects explicit rollback, a negative control and runtime verification, none ' +
            'of which this module decides.'
          : '§12.4 HIGH: deterministic executors + 1 fresh semantic verifier, owner gate as needed (§18.3).',
      }
  }
}

/**
 * May a fresh verifier be dispatched for this change, per §12.4?
 *
 * Returns a decision rather than a bool for §3.7's standing reason. An
 * UNRESOLVED risk answers `allowed: false` with the unresolved reason code --
 * which is a REFUSAL TO DECIDE, not a decision that no verifier is needed. A
 * caller that wants to run a verifier under unknown risk must say so out loud
 * (`policyOverride`), and that assertion is returned in the decision so it
 * lands in whatever the caller records.
 */
export function mayDispatchFreshVerifier(
  risk: ApgRisk | null | undefined,
  opts: { acceptanceIsSemantic?: boolean; policyOverride?: string | null } = {},
): { allowed: boolean; policy: VerifierPolicyDecision; overrideReason: string | null; detail: string } {
  const policy = resolveVerifierPolicy(risk, opts)
  const overrideReason = (opts.policyOverride ?? null) || null
  if (!policy.resolved) {
    return overrideReason
      ? {
          allowed: true, policy, overrideReason,
          detail: 'risk is UNRESOLVED; the caller dispatched a verifier under an explicit override: ' + overrideReason,
        }
      : {
          allowed: false, policy, overrideReason: null,
          detail: policy.detail,
        }
  }
  return {
    allowed: (policy.maxSemanticVerifiers ?? 0) > 0,
    policy,
    overrideReason,
    detail: policy.detail,
  }
}
