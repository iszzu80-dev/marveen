// W10 — turn the dashboard's existing credential-class principal into an
// ExecutionIdentity, instead of inventing a second identity model for HTTP.
//
// WHY REUSE RATHER THAN REBUILD. `src/web/apg-principal.ts` already resolves,
// from `auth-gate.ts`, which CREDENTIAL authenticated a request -- and it is
// unusually honest about what that does and does not prove: 'operator' is not
// proof of a human, `humanAttestation` is named for what it measures, and the
// module says so in its own header. Building a parallel identity resolver for
// the same requests would create a second answer to one question, and the two
// would disagree the first time either changed.
//
// So this is a pure mapping. It adds no new authority and can only ever produce
// a scope narrower than or equal to what the credential already permits today.
//
// THE CAPABILITY ASSIGNMENT, and why each line is where it is:
//
//   operator (session / device key)
//     A credential minted for one human's login or device, which -- per
//     apg-principal.ts -- no dispatched agent in this fleet holds. Gets the
//     local capabilities plus ADMIN, because changing config from the dashboard
//     is exactly what an operator credential is for.
//
//   fleet (the shared bearer token)
//     Every dispatched agent is handed this token, so it identifies "someone
//     inside this fleet" and nothing narrower. It gets READ, WRITE_LOCAL and
//     MODEL_EGRESS -- the things an agent legitimately does over HTTP -- and
//     NOT EXTERNAL_EFFECT, NOT ADMIN, NOT SECRET_READ.
//
//     EXTERNAL_EFFECT is withheld deliberately: sends do not happen on an HTTP
//     route, they happen in the COS executor behind its own gate. A token that
//     can open a case should not, by the same act, be able to mail someone.
//
//   peer (federation)
//     READ only. A federated peer's requests are data, per the federation
//     policy in CLAUDE.md; anything that writes or leaves the machine is an
//     escalation to the owner, not a capability.
//
//   anonymous
//     Nothing. Reachable only on ungated paths and in hand-built test contexts.
import type { Capability, ExecutionIdentity } from './execution-identity.js'

/** The subset of ApgPrincipal this mapping reads. Kept structural so importing
 *  it does not drag the web layer into the identity leaf. */
export interface PrincipalLike {
  class: 'operator' | 'fleet' | 'peer' | 'anonymous'
  kind: 'token' | 'session' | 'device' | 'federation' | 'none'
  attribution: string
}

const SCOPES: Record<PrincipalLike['class'], readonly Capability[]> = {
  // EXTERNAL_EFFECT added 2026-08-25, deliberately and narrowly.
  //
  // The original scope withheld it from every HTTP principal on the reasoning
  // that "sends do not happen on an HTTP route, they happen in the COS executor
  // behind its own gate". That was true of the FLEET token and stays true of it.
  // It was never true of the operator: /api/cos/outbound/approve is the button
  // labelled "Elkuldom", and since 2026-08-10 that button sends. A human session
  // or device credential approving a specific rendered payload IS the authority
  // for that send -- refusing it would not be caution, it would be a dashboard
  // whose send button cannot send.
  //
  // What this does NOT widen: the shared fleet token below still has no
  // EXTERNAL_EFFECT, so no dispatched agent gains the ability to mail anyone by
  // holding it. And the capability is permission to TRY: the payload still has
  // to pass the dispatch gate, the per-payload approval and the broker.
  operator: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'ADMIN'] as Capability[]),
  fleet: Object.freeze(['READ', 'WRITE_LOCAL', 'MODEL_EGRESS'] as Capability[]),
  peer: Object.freeze(['READ'] as Capability[]),
  anonymous: Object.freeze([] as Capability[]),
}

/**
 * `kind` -> actor type.
 *
 * A session or a device key is the closest this server gets to a person, so it
 * maps to HUMAN_USER -- with the caveat apg-principal.ts already states in
 * writing: that is the CREDENTIAL class, not a proven human. The shared token is
 * an AGENT because that is who holds it in practice. Federation is a SERVICE.
 */
function actorTypeFor(p: PrincipalLike): ExecutionIdentity['actorType'] {
  switch (p.kind) {
    case 'session':
    case 'device':
      return 'HUMAN_USER'
    case 'token':
      return 'AGENT'
    case 'federation':
      return 'SERVICE'
    case 'none':
      return 'LEGACY_UNKNOWN'
  }
}

/**
 * Map a resolved dashboard principal to an execution identity.
 *
 * Returns null for an anonymous principal rather than an empty-scoped identity,
 * so the caller records an identity-resolution FAILURE. The two are different
 * facts: "nobody authenticated" should not look the same as "an authenticated
 * party with no permissions", and only the first means the request arrived
 * without a credential at all.
 */
export function identityFromPrincipal(
  p: PrincipalLike | null | undefined,
  runId: string | null = null,
): ExecutionIdentity | null {
  if (!p || p.class === 'anonymous') return null
  return {
    actorId: p.attribution,
    actorType: actorTypeFor(p),
    // The dashboard has no on-behalf-of concept: a request is made BY the
    // credential holder. Claiming otherwise would manufacture a delegation
    // relationship the server cannot see.
    onBehalfOf: null,
    runId,
    capabilityScope: SCOPES[p.class],
  }
}

/** The identity a scheduled task acts under.
 *
 *  SYSTEM_AUTOMATION with no principal is the strictest combination the boundary
 *  knows: it is what triggers REQUIRE_APPROVAL for confidential egress, which is
 *  the correct answer for an unattended 3am cycle. A scheduled task that
 *  genuinely acts for the owner must say so by passing `onBehalfOf`, and that is
 *  a deliberate, visible choice at the call site rather than a default. */
export function scheduledTaskIdentity(taskName: string, runId: string | null, onBehalfOf: string | null = null): ExecutionIdentity {
  return {
    actorId: `schedule:${taskName}`,
    actorType: 'SYSTEM_AUTOMATION',
    onBehalfOf,
    runId,
    capabilityScope: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
  }
}
