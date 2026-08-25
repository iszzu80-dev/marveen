// W10 — who is acting, in what capacity, on whose behalf, with what scope.
//
// WHY THIS DID NOT EXIST. The system has had an `actor` for a long time, and it
// reads convincingly: case events carry `marveen`, `cos-wake`,
// `marveen-baseline-import`. But `actor` is a free-form string. Nothing records
// whether it was a person, an agent or a cron tick; nothing records on whose
// behalf it acted; nothing records what it was allowed to do. A label that any
// caller can write is useful for reading history and is not an identity, and the
// distance between those two is exactly where an autonomous system gets to do
// something nobody authorised.
//
// WHAT THIS IS NOT. It is not authentication. The inter-agent bus has no sender
// authentication (CLAUDE.md card 06f062e4: any holder of the shared token can
// send as any `from`), and this module does not change that. It makes the claim
// STRUCTURED and RECORDED so a policy can be stated about it and an audit can
// show what was claimed. Turning a claim into a proof is a separate piece of
// work, and pretending otherwise here would be the more dangerous move: a
// convincing identity object that is actually unverified invites callers to
// trust it.
//
// Zero imports on purpose. The policy layer, the store layer and the format
// layer all need this vocabulary, and a shared leaf is what stops a second copy
// of a CLOSED vocabulary from being spelled somewhere else and drifting.

/**
 * §4.2's actor types, exactly. Closed, because an actor kind that can be spelled
 * freely is a kind that can be spelled whatever gets past the policy.
 */
export type ActorType =
  /** A person acting directly. Today: Istvan via a channel. */
  | 'HUMAN_USER'
  /** An LLM agent taking its own turn. */
  | 'AGENT'
  /** A non-agent program acting under its own identity (collector, importer). */
  | 'SERVICE'
  /** A scheduler/cron tick with no human in the loop at the moment of action. */
  | 'SYSTEM_AUTOMATION'
  /** §4.8: a record that predates identity capture. NEVER granted authority. */
  | 'LEGACY_UNKNOWN'

export const ACTOR_TYPES: readonly ActorType[] = [
  'HUMAN_USER', 'AGENT', 'SERVICE', 'SYSTEM_AUTOMATION', 'LEGACY_UNKNOWN',
]

/** Narrow an untrusted string to an actor type, or null. Never guesses. */
export function coerceActorType(v: unknown): ActorType | null {
  return typeof v === 'string' && (ACTOR_TYPES as readonly string[]).includes(v)
    ? (v as ActorType)
    : null
}

/**
 * What an actor is permitted to do, as a closed set of coarse capabilities.
 *
 * Coarse on purpose. A fine-grained permission list that nobody maintains
 * degrades into "grant everything" within a release or two; these are the
 * distinctions that actually change whether an action is safe, and each one is
 * a boundary that already exists somewhere in this codebase.
 */
export type Capability =
  /** Read stored/own data. The floor: everything may read its own scope. */
  | 'READ'
  /** Write to the local store (cases, events, memories). No outside effect. */
  | 'WRITE_LOCAL'
  /** Cause an effect outside this machine: send mail, write a calendar, call a
   *  third-party API with content. The line that matters most. */
  | 'EXTERNAL_EFFECT'
  /** Send content to a model/provider for inference. Separate from
   *  EXTERNAL_EFFECT because it is egress of DATA, not an action on the world. */
  | 'MODEL_EGRESS'
  /** Read a secret from the secret store. Never implied by any other. */
  | 'SECRET_READ'
  /** Change policy, config or the gate's own mode. */
  | 'ADMIN'

export const CAPABILITIES: readonly Capability[] = [
  'READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS', 'SECRET_READ', 'ADMIN',
]

export function coerceCapability(v: unknown): Capability | null {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v)
    ? (v as Capability)
    : null
}

/**
 * The identity every action carries at the boundary.
 *
 * `onBehalfOf` is the field that makes delegation auditable. An agent acting for
 * Istvan and an agent acting for itself are the same actor with different
 * authority, and §4.6 asks for a negative test on exactly that ("agent szélesebb
 * scope-pal mint user"). Without this field that test cannot even be written.
 */
export interface ExecutionIdentity {
  /** Stable identifier of the actor. For an agent, its fleet name. */
  actorId: string
  actorType: ActorType
  /**
   * The identity this actor is acting FOR, if any. An agent running Istvan's
   * heartbeat acts on behalf of Istvan; an agent running its own idea does not.
   * Null means "for itself", which is the weaker claim, not the stronger one.
   */
  onBehalfOf: string | null
  /** The run/session this action belongs to. Ties an action to its cycle. */
  runId: string | null
  /** What this actor may do. An empty set is legal and means: nothing. */
  capabilityScope: readonly Capability[]
  /**
   * Free-form context the policy layer may read (channel, tool name, campaign).
   * Deliberately NOT used for authority decisions -- it is evidence, and letting
   * a caller-supplied bag grant permission would undo the closed sets above.
   */
  policyContext?: Record<string, string | number | boolean | null>
}

/**
 * The identity used when a record or a call site genuinely has none.
 *
 * §4.8: legacy records must not have to be back-filled, and must not silently
 * acquire authority either. This identity holds NO capabilities, so every
 * policy decision about it fails closed without any special-casing in the
 * policy code -- the empty scope does the work.
 */
export const LEGACY_UNKNOWN_IDENTITY: ExecutionIdentity = Object.freeze({
  actorId: 'LEGACY_UNKNOWN',
  actorType: 'LEGACY_UNKNOWN',
  onBehalfOf: null,
  runId: null,
  capabilityScope: Object.freeze([]) as readonly Capability[],
})

export class IdentityResolutionError extends Error {
  readonly code = 'IDENTITY_RESOLUTION_FAILED'
  constructor(reason: string) {
    super(`IDENTITY_RESOLUTION_FAILED: ${reason}`)
    this.name = 'IdentityResolutionError'
  }
}

/**
 * Build an identity from untrusted input, or fail.
 *
 * Returns `null` rather than a partially-filled object: a half-resolved identity
 * is the thing that gets waved through, because it looks like an identity at
 * every call site that only checks for presence.
 */
export function resolveIdentity(input: unknown): ExecutionIdentity | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const actorId = typeof o.actorId === 'string' ? o.actorId.trim() : ''
  const actorType = coerceActorType(o.actorType)
  if (!actorId || !actorType) return null

  const rawScope = Array.isArray(o.capabilityScope) ? o.capabilityScope : []
  const scope: Capability[] = []
  for (const c of rawScope) {
    const cap = coerceCapability(c)
    // An unrecognised capability is dropped, never mapped to a neighbour. The
    // caller ends up with LESS authority than it asked for, which is the safe
    // direction to be wrong in.
    if (cap && !scope.includes(cap)) scope.push(cap)
  }

  return {
    actorId,
    actorType,
    onBehalfOf: typeof o.onBehalfOf === 'string' && o.onBehalfOf.trim() ? o.onBehalfOf.trim() : null,
    runId: typeof o.runId === 'string' && o.runId.trim() ? o.runId.trim() : null,
    capabilityScope: Object.freeze(scope),
    policyContext: o.policyContext && typeof o.policyContext === 'object'
      ? (o.policyContext as ExecutionIdentity['policyContext'])
      : undefined,
  }
}

/** Does this identity hold the capability outright? */
export function hasCapability(id: ExecutionIdentity, cap: Capability): boolean {
  return id.capabilityScope.includes(cap)
}

/**
 * The delegation rule: a delegate may never exceed the delegator.
 *
 * §4.6 names "agent szélesebb scope-pal mint user" as a required negative test,
 * and this is the predicate that test asserts against. Note the direction: the
 * question is not whether the agent was CONFIGURED with a wide scope, but
 * whether the scope it is USING exceeds the one it is acting for. An agent may
 * hold EXTERNAL_EFFECT in general and still not have it while acting for a
 * principal who does not.
 */
export function effectiveScope(
  actor: ExecutionIdentity,
  principal: ExecutionIdentity | null,
): readonly Capability[] {
  if (!principal) return actor.capabilityScope
  return Object.freeze(actor.capabilityScope.filter(c => principal.capabilityScope.includes(c)))
}

/** A short, log-safe rendering. Never includes policyContext, which is
 *  caller-supplied and may carry anything. */
export function describeIdentity(id: ExecutionIdentity): string {
  const parts = [`${id.actorType}:${id.actorId}`]
  if (id.onBehalfOf) parts.push(`for=${id.onBehalfOf}`)
  if (id.runId) parts.push(`run=${id.runId}`)
  parts.push(`scope=[${id.capabilityScope.join(',') || 'none'}]`)
  return parts.join(' ')
}
