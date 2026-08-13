// APG 1.9 §11.4 / §26.2 -- who is allowed to resolve an approval, and what the
// server is willing to CLAIM about that once it has.
//
// The 1.8 conformance audit's third security finding (§3.3) is the shape this
// module removes: "Az emberi jóváhagyás nem emberi." The generic approvals
// route took `resolved_by` out of the request body and stored it verbatim --
// the exact anti-pattern §11.4 names -- and the APG decision route, while
// better, stamped the string 'dashboard', which is a SURFACE, not a person.
//
// §11.4 asks for three things together:
//
//     authenticated human principal
//   + server-side resolved_by attribution
//   + human_required approval category
//
// Two of the three are buildable here and are built here. The first is not, and
// this module says so in the data rather than papering over it:
//
//   * server-side attribution: `resolved_by` is now always the principal string
//     apg-principal.ts derives from the CREDENTIAL. No request body can set it.
//   * human_required category: HUMAN_REQUIRED_CATEGORY below, enforced on both
//     resolution routes.
//   * authenticated human principal: DOES NOT EXIST in Marveen yet. The
//     strongest credential available is an mv_session cookie for a named user.
//     That is a real improvement -- no dispatched agent can produce one, which
//     is what makes §26.2 ("human-required gate-et agent principal ne oldhasson
//     fel") actually hold -- but it is not proof a human decided anything.
//
// So the question the task poses -- refuse, or mark unproven? -- is answered
// BOTH ways, split along the axis §25 already defines, because the two failures
// are different failures:
//
//   fleet token / anonymous, ANY mode  -> REFUSED, unconditionally.
//       §26's invariant 2 is not mode-scoped, and the shared bearer token is an
//       agent principal by construction (kanban.ts hands it to every dispatched
//       agent). Letting observe "fail open" here would not be degrading a
//       control-plane reading; it would be handing an agent the owner's vote.
//
//   operator principal, mode ENFORCED -> requires a NAMED session.
//       §25: enforced fails closed when a required control cannot be satisfied.
//       In enforced mode the required control is "name the human"; a device key
//       names a device, so it cannot satisfy it and the decision is refused.
//
//   operator principal, mode ASSISTED/OBSERVE -> allowed, marked UNPROVEN.
//       §25 again: assisted must not show a false PASS, observe fails open with
//       an explicit degraded state. The decision goes through, and the receipt
//       carries human_principal_proven:false plus the attestation that actually
//       occurred. Nothing anywhere is permitted to render it as "owner
//       authenticated" -- that is the false PASS §25 forbids.
//
// When the kernel's parallel execution-identity work lands a real human
// principal, the only change here is that `human_principal_proven` can start
// being true; every call site already reads it.

import type { ApgMode } from '../apg/ui-types.js'
import { type ApgPrincipal, isOperatorPrincipal } from './apg-principal.js'
import { writeApgAuditEvent } from './apg-scope-overrides.js'

/**
 * §11.4's approval category. An approval created with this category is an owner
 * decision class, not an ordinary agent-to-agent permission request.
 */
export const HUMAN_REQUIRED_CATEGORY = 'human_required'

export function isHumanRequiredCategory(category: string | null | undefined): boolean {
  return (category ?? '').trim().toLowerCase() === HUMAN_REQUIRED_CATEGORY
}

export interface HumanApprovalVerdict {
  allowed: boolean
  /** HTTP status for a refusal. */
  status?: number
  error?: string
  /**
   * Always false today. Kept as a field, not an omission, so every consumer is
   * already reading the flag on the day it can become true.
   */
  humanPrincipalProven: boolean
  /** Free-form marker for the audit trail and the API response. */
  attestationNote: string
}

/**
 * Decide whether `principal` may resolve an approval of `category` under `mode`.
 * Non-human_required approvals are unaffected: they still get server-stamped
 * attribution (the caller does that), but no principal-class gate.
 */
export function checkHumanApprovalAuthority(
  principal: ApgPrincipal,
  category: string | null | undefined,
  mode: ApgMode,
): HumanApprovalVerdict {
  if (!isHumanRequiredCategory(category)) {
    return {
      allowed: true,
      humanPrincipalProven: false,
      attestationNote: `not_human_required:${principal.humanAttestation}`,
    }
  }

  if (!isOperatorPrincipal(principal)) {
    return {
      allowed: false,
      status: 403,
      error:
        'APG 1.9 §26.2: a human_required approval cannot be resolved by an agent principal. '
        + 'The fleet-shared dashboard token is an agent principal; resolve this from a browser '
        + 'session or an enrolled device.',
      humanPrincipalProven: false,
      attestationNote: 'refused:agent_principal',
    }
  }

  if (mode === 'enforced' && principal.humanAttestation !== 'named_session') {
    return {
      allowed: false,
      status: 403,
      error:
        'APG 1.9 §25: enforced mode fails closed on a required control it cannot satisfy. '
        + 'A human_required approval needs a named login session; this request presented '
        + `a ${principal.kind} credential, which names a device, not a person.`,
      humanPrincipalProven: false,
      attestationNote: 'refused:unnamed_principal_under_enforced',
    }
  }

  return {
    allowed: true,
    // The honest constant. See the header note: a session cookie is not proof.
    humanPrincipalProven: false,
    attestationNote: `unproven_human:${principal.humanAttestation}`,
  }
}

/**
 * Append the §26.10 owner-decision receipt ("owner decision append-only audit
 * receiptet kap"). Best-effort by construction (writeApgAuditEvent swallows and
 * logs), because a receipt failure must not undo a decision that already
 * happened -- the decision, not the receipt, is the state transition.
 */
export function recordApprovalAttribution(detail: {
  approval_id: string
  category: string | null
  status: string
  principal: ApgPrincipal
  claimed_by: string | null
  mode: ApgMode
  verdict: HumanApprovalVerdict
  surface: 'apg_decision' | 'approvals_patch'
}): void {
  writeApgAuditEvent('approval_resolved', {
    approval_id: detail.approval_id,
    category: detail.category,
    status: detail.status,
    surface: detail.surface,
    mode: detail.mode,
    // The three §11.4 fields, side by side and never conflated.
    resolved_by: detail.principal.attribution,
    principal_class: detail.principal.class,
    human_attestation: detail.principal.humanAttestation,
    human_required: isHumanRequiredCategory(detail.category),
    human_principal_proven: detail.verdict.humanPrincipalProven,
    attestation_note: detail.verdict.attestationNote,
    // Kept ONLY as a claim, next to the attribution that was actually verified.
    claimed_by: detail.claimed_by,
  })
}
