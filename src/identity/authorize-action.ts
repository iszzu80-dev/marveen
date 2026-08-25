// W10 §4.3 — the one place an action is authorised.
//
// THE SEQUENCE, as the contract writes it:
//
//   request -> resolve actor -> classify sensitivity -> resolve capability
//           -> policy decision -> allow | redact | require approval | deny
//           -> audit -> execution
//
// WHAT THIS REPLACES: nothing. The COS send path already has a real choke point
// (`src/cos/dispatch-gate.ts`) that ANDs connector health, sensitivity and send
// authorization, and it is fail-closed and tested. Rewriting it would be
// throwing away proven code to satisfy a diagram. Instead that gate -- and the
// fleet dispatch gate -- delegate the IDENTITY half of the decision here, which
// is the half neither of them has today.
//
// WHY A PURE FUNCTION. The decision must be testable exhaustively (§4.6 asks for
// the whole allowed/denied matrix, every actor type, every class). Anything that
// reaches for a database or a clock inside the decision makes that matrix
// expensive to assert, and an expensive test is a test that gets sampled. The
// caller passes the facts in and gets a decision plus an audit record out; the
// caller persists.
//
// FAIL-CLOSED IS STRUCTURAL, NOT A BRANCH. Missing identity yields an identity
// with an EMPTY capability scope, and every decision below is a capability
// check, so absence denies without any special case that could be forgotten.
import {
  type Capability, type ExecutionIdentity, LEGACY_UNKNOWN_IDENTITY,
  describeIdentity, effectiveScope,
} from './execution-identity.js'
import {
  type Classification, type SensitivityLevel, UNKNOWN_LEVEL,
  carriesNeverExternalTag, coerceLevel, levelRank,
} from './sensitivity-scale.js'

/** What the action wants to do. Maps 1:1 onto `Capability`. */
export type ActionKind =
  | 'READ'
  | 'WRITE_LOCAL'
  | 'EXTERNAL_EFFECT'
  | 'MODEL_EGRESS'
  | 'SECRET_READ'
  | 'ADMIN'

const ACTION_CAPABILITY: Record<ActionKind, Capability> = {
  READ: 'READ',
  WRITE_LOCAL: 'WRITE_LOCAL',
  EXTERNAL_EFFECT: 'EXTERNAL_EFFECT',
  MODEL_EGRESS: 'MODEL_EGRESS',
  SECRET_READ: 'SECRET_READ',
  ADMIN: 'ADMIN',
}

/** Does the action move data off this machine? */
const LEAVES_MACHINE: Record<ActionKind, boolean> = {
  READ: false, WRITE_LOCAL: false, SECRET_READ: false, ADMIN: false,
  EXTERNAL_EFFECT: true, MODEL_EGRESS: true,
}

export type PolicyVerdict = 'ALLOW' | 'REDACT' | 'REQUIRE_APPROVAL' | 'DENY'

export interface TargetDescriptor {
  /** Stable id of what receives the data: a model id, a provider, a recipient. */
  id: string
  /**
   * Is the receiver approved for this level? The caller answers, because the
   * answer differs per domain (provider trust, connector health, allowlists) and
   * those answers are already implemented and tested where they live. This
   * boundary decides POLICY, it does not re-derive provider trust.
   */
  trustedForLevel?: (level: SensitivityLevel) => boolean
}

export interface AuthorizeInput {
  action: ActionKind
  /** May be null/undefined; that is a resolution failure, not an escape hatch. */
  identity: ExecutionIdentity | null | undefined
  /** The principal the actor claims to act for, when there is one. */
  principal?: ExecutionIdentity | null
  classification: Classification
  target?: TargetDescriptor
  /** Free-form, recorded, never authority-bearing. */
  context?: Record<string, string | number | boolean | null>
}

export interface AuthorizeDecision {
  verdict: PolicyVerdict
  /** Every reason, so a refusal is diagnosable rather than merely final. */
  reasons: string[]
  /** The identity actually used -- LEGACY_UNKNOWN when resolution failed. */
  identity: ExecutionIdentity
  /** Scope after delegation narrowing. */
  effective: readonly Capability[]
  /** True when identity could not be resolved from the input. */
  identityResolutionFailed: boolean
  /** The audit record the caller must persist (§2.6). */
  audit: AuthorizationAudit
}

/** §2.6's required audit shape, filled from one decision. */
export interface AuthorizationAudit {
  actorId: string
  actorType: string
  onBehalfOf: string | null
  runId: string | null
  action: ActionKind
  targetId: string | null
  level: SensitivityLevel
  tags: readonly string[]
  classificationBasis: string
  verdict: PolicyVerdict
  reasons: string[]
  context?: Record<string, string | number | boolean | null>
}

/**
 * The §4.4 default policy, plus the two rules that are not about levels.
 *
 * Reading order matters: the DENY rules run before the capability check so that
 * a caller which somehow holds a wide scope still cannot push a credential out.
 * A capability is permission to try, not permission to succeed.
 */
export function authorizeAction(input: AuthorizeInput): AuthorizeDecision {
  const reasons: string[] = []
  const identityResolutionFailed = !input.identity
  const identity = input.identity ?? LEGACY_UNKNOWN_IDENTITY
  if (identityResolutionFailed) {
    reasons.push('identity could not be resolved; treated as LEGACY_UNKNOWN with empty scope')
  }
  if (identity.actorType === 'LEGACY_UNKNOWN') {
    reasons.push('LEGACY_UNKNOWN actor: no authority is ever granted (§4.8)')
  }

  const effective = effectiveScope(identity, input.principal ?? null)
  if (input.principal && effective.length < identity.capabilityScope.length) {
    reasons.push(
      `scope narrowed by principal ${input.principal.actorId}: `
      + `[${identity.capabilityScope.join(',')}] -> [${effective.join(',') || 'none'}]`)
  }

  // Defensive coercion, NOT a formality.
  //
  // `levelRank` of a string outside the scale is -1, so a malformed level would
  // read as LESS restricted than SECRET and slide straight past the fail-closed
  // check below. Trusting callers to coerce first is exactly the assumption that
  // fails on the one path where someone forgot. So the boundary re-derives the
  // level itself, and an unrecognised one becomes the ceiling here rather than
  // being merely documented as the caller's job.
  const rawLevel = input.classification.level as unknown
  const coerced = coerceLevel(rawLevel)
  const cls: Classification = coerced
    ? input.classification
    : {
        level: UNKNOWN_LEVEL,
        tags: input.classification.tags,
        basis: `${input.classification.basis} | UNRECOGNISED level ${JSON.stringify(rawLevel)} -> fail-closed ${UNKNOWN_LEVEL}`,
      }
  if (!coerced) {
    reasons.push(`classification level ${JSON.stringify(rawLevel)} is not on the scale; treated as ${UNKNOWN_LEVEL}`)
  }

  // An unrecognised ACTION is not authorisable at all: a typo must not become a
  // permissive default by falling out of the lookup as undefined.
  if (!(input.action in ACTION_CAPABILITY)) {
    reasons.push(`unknown action ${JSON.stringify(input.action)}; no capability can authorise it`)
    const a: AuthorizationAudit = {
      actorId: identity.actorId, actorType: identity.actorType, onBehalfOf: identity.onBehalfOf,
      runId: identity.runId, action: input.action, targetId: input.target?.id ?? null,
      level: UNKNOWN_LEVEL, tags: [], classificationBasis: 'unknown action',
      verdict: 'DENY', reasons: [...reasons], context: input.context,
    }
    return { verdict: 'DENY', reasons: [...reasons], identity, effective, identityResolutionFailed, audit: a }
  }

  const leaves = LEAVES_MACHINE[input.action]

  const audit = (verdict: PolicyVerdict): AuthorizationAudit => ({
    actorId: identity.actorId,
    actorType: identity.actorType,
    onBehalfOf: identity.onBehalfOf,
    runId: identity.runId,
    action: input.action,
    targetId: input.target?.id ?? null,
    level: cls.level,
    tags: cls.tags,
    classificationBasis: cls.basis,
    verdict,
    reasons: [...reasons],
    context: input.context,
  })

  const decide = (verdict: PolicyVerdict): AuthorizeDecision =>
    ({ verdict, reasons: [...reasons], identity, effective, identityResolutionFailed, audit: audit(verdict) })

  // 1. Never-external tags. Checked FIRST and independently of level, because a
  //    credential inside otherwise public text is still a credential.
  if (leaves && carriesNeverExternalTag(cls)) {
    reasons.push(
      `content carries a never-external tag (${cls.tags.filter(t => t === 'CREDENTIAL' || t === 'AUTH_TOKEN').join(',')}); `
      + 'external propagation is DENY by default (§4.4) and no capability overrides it')
    return decide('DENY')
  }

  // 2. Secret reads are their own capability and are never implied.
  if (input.action === 'SECRET_READ' && !effective.includes('SECRET_READ')) {
    reasons.push('SECRET_READ requires the SECRET_READ capability explicitly; it is never implied')
    return decide('DENY')
  }

  // 3. The capability check.
  const needed = ACTION_CAPABILITY[input.action]
  if (!effective.includes(needed)) {
    reasons.push(
      `${describeIdentity(identity)} lacks capability ${needed} for action ${input.action}`)
    return decide('DENY')
  }

  // 4. Unknown/ceiling sensitivity leaving the machine: fail closed.
  //    `UNKNOWN_LEVEL` is SECRET, so this also covers genuinely secret content.
  if (leaves && levelRank(cls.level) >= levelRank(UNKNOWN_LEVEL)) {
    reasons.push(
      `level ${cls.level} may not leave the machine (unknown or secret is fail-closed, §4.4/§2.1)`)
    return decide('DENY')
  }

  // 5. Target trust, where the caller supplied an answer. No answer means the
  //    caller could not establish trust, which is not the same as trusted.
  if (leaves && input.target) {
    if (!input.target.trustedForLevel) {
      reasons.push(
        `target ${input.target.id} supplied no trust predicate; unestablished trust is not trust`)
      return decide('DENY')
    }
    if (!input.target.trustedForLevel(cls.level)) {
      reasons.push(`target ${input.target.id} is not approved for level ${cls.level}`)
      return decide('DENY')
    }
  }

  // 6. A human's confidential data leaving the machine under an automation's own
  //    authority -- nobody in the loop -- is approval-gated rather than denied.
  //    Denying would stop legitimate scheduled work; allowing silently is how an
  //    automation ends up mailing someone's personal data at 3am.
  if (leaves
      && levelRank(cls.level) >= levelRank('CONFIDENTIAL')
      && identity.actorType === 'SYSTEM_AUTOMATION'
      && !identity.onBehalfOf) {
    reasons.push(
      `SYSTEM_AUTOMATION acting for nobody may not send ${cls.level} content without approval`)
    return decide('REQUIRE_APPROVAL')
  }

  // 7. PII leaving the machine is allowed but must be redacted by the caller.
  //    REDACT is a real outcome, not a softened ALLOW: a caller that ignores it
  //    and sends raw is violating the decision, and the audit says so.
  if (leaves && cls.tags.includes('PII')) {
    reasons.push('content carries PII; caller must apply redaction before egress')
    return decide('REDACT')
  }

  reasons.push(`allowed: ${describeIdentity(identity)} action=${input.action} level=${cls.level}`)
  return decide('ALLOW')
}

/** True when the decision permits execution to proceed as-is. */
export function permitsExecution(d: AuthorizeDecision): boolean {
  return d.verdict === 'ALLOW'
}
