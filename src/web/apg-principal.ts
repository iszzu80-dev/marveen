// APG 1.9 §11 -- who is actually asking, as far as this server can honestly tell.
//
// §11.1 states the problem this module exists to bound: the Marveen agent bus
// is NOT a cryptographic authority boundary. A `from_agent` field or a shared
// bearer token proves neither that the named agent made the request, nor that
// the request came from a human. The 1.8 conformance audit (§3.2, §3.3) found
// both anti-patterns live: the scope-override endpoint trusted a free-text
// `actor`, and the approvals route stored the request body's `resolved_by`
// verbatim as the approver.
//
// The one real distinction this server already has -- and had all along, in
// auth-gate.ts -- is WHICH CREDENTIAL authenticated the request:
//
//   token       the single dashboard bearer in store/.dashboard-token. EVERY
//               dispatched agent is handed it (kanban.ts writes the `cat
//               .dashboard-token` curl into the dispatch message itself), so it
//               identifies "someone inside this fleet" and nothing narrower.
//               This is the credential §11.1 is talking about.
//   device      a per-device key minted by an operator through Bridge pairing
//               (auth-device-keys.ts). Individually issued, individually
//               revocable, and never given to a dispatched agent.
//   session     an mv_session cookie from an interactive browser login by a
//               NAMED user (auth-sessions.ts). Also never given to an agent.
//   federation  a scoped peer token, valid only on the two wire endpoints.
//
// So the honest principal model is a two-value class plus an attestation level:
//
//   class 'operator'  -- session or device: a credential minted for ONE human's
//                        device or login, which no agent in this fleet holds.
//   class 'fleet'     -- the shared token: an agent principal, per §11.1.
//   class 'peer'      -- a federation peer.
//   class 'anonymous' -- no credential (only reachable on ungated paths, and in
//                        unit tests that build a RouteContext by hand).
//
// WHAT THIS IS NOT, stated before anything relies on it:
//
//   * 'operator' is not proof of a human. A stolen session cookie, a shell on
//     the operator's laptop, or a script driving a device key all present as
//     'operator'. §11.4's "authenticated human principal" is a Marveen-upstream
//     capability that does not exist yet.
//   * Therefore `humanAttestation` is named for what it measures: WHICH
//     credential class attested, not whether a human was present. A
//     human_required decision made under 'named_session' is still recorded as
//     `human_principal_proven: false` -- see apg-human-approval.ts.
//   * What the model DOES buy is the property §24.0.5 and §26.2 actually need:
//     an agent holding the shared token can no longer perform an action
//     reserved for an operator, because the agent cannot produce a session
//     cookie or a device key. That closes the self-downgrade and
//     agent-resolves-human-gate holes even though "human" stays unproven.

import type { RouteContext } from './routes/types.js'

export type ApgPrincipalClass = 'operator' | 'fleet' | 'peer' | 'anonymous'

/**
 * Which credential class attested this request. Deliberately NOT called
 * `human` / `is_human`: see the header note. 'named_session' is the strongest
 * available and still only means "an interactive login for this username was
 * presented", never "this human pressed the button".
 */
export type ApgHumanAttestation = 'named_session' | 'device_key' | 'none'

export interface ApgPrincipal {
  class: ApgPrincipalClass
  /** The credential kind auth-gate.ts resolved, verbatim. */
  kind: 'token' | 'session' | 'device' | 'federation' | 'none'
  /**
   * SERVER-STAMPED attribution string. This is the value that lands in an
   * audit trail or an approval's `resolved_by`; it names the PRINCIPAL, not
   * the surface (§11.4 rejects both `resolved_by: "owner"` from a body and
   * -- less obviously -- a surface name like 'dashboard', which says where a
   * click arrived, not who made it). Namespaced so a username and a device
   * name can never collide.
   */
  attribution: string
  humanAttestation: ApgHumanAttestation
}

export const FLEET_TOKEN_ATTRIBUTION = 'fleet_token:shared'
export const UNAUTHENTICATED_ATTRIBUTION = 'unauthenticated'

/**
 * Classify a request's credential. Total: an absent/unknown `auth` degrades to
 * the LEAST privileged class, never to a permissive default -- an unrecognised
 * credential kind must not be able to acquire operator authority by being
 * unrecognised.
 */
export function resolveApgPrincipal(auth: RouteContext['auth']): ApgPrincipal {
  if (auth === undefined) {
    return {
      class: 'anonymous',
      kind: 'none',
      attribution: UNAUTHENTICATED_ATTRIBUTION,
      humanAttestation: 'none',
    }
  }
  switch (auth.kind) {
    case 'session': {
      // A blank username would produce the attribution string `session:`, which
      // reads as an identity while naming nobody. Degrade to the unnamed form.
      const user = (auth.user ?? '').trim()
      return {
        class: 'operator',
        kind: 'session',
        attribution: user ? `session:${user}` : 'session:unnamed',
        humanAttestation: user ? 'named_session' : 'device_key',
      }
    }
    case 'device': {
      const device = (auth.device ?? '').trim()
      return {
        class: 'operator',
        kind: 'device',
        attribution: device ? `device:${device}` : 'device:unnamed',
        humanAttestation: 'device_key',
      }
    }
    case 'token':
      return {
        class: 'fleet',
        kind: 'token',
        attribution: FLEET_TOKEN_ATTRIBUTION,
        humanAttestation: 'none',
      }
    case 'federation': {
      const peer = (auth.peer ?? '').trim()
      return {
        class: 'peer',
        kind: 'federation',
        attribution: peer ? `federation:${peer}` : 'federation:unnamed',
        humanAttestation: 'none',
      }
    }
    default:
      return {
        class: 'anonymous',
        kind: 'none',
        attribution: UNAUTHENTICATED_ATTRIBUTION,
        humanAttestation: 'none',
      }
  }
}

/** True for the credential classes no dispatched agent can obtain. */
export function isOperatorPrincipal(principal: ApgPrincipal): boolean {
  return principal.class === 'operator'
}
