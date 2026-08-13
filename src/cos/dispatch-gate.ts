// Personal Chief of Staff (COS) — dispatch gate (the single send choke point).
//
// Before ANY outbound action is planned/executed, it passes ONE gate that ANDs
// the three independent safety layers built in this slice set. All must pass;
// any veto blocks the send (fail-closed), and every veto reason is returned so
// the caller can surface exactly why. Gating at one choke point — rather than
// per-caller — is deliberate: a new send path cannot forget a check.
//
//   1. connector_health.isUsable(requireWrite): the connector can actually
//      write right now (not DOWN/DISABLED/READ_ONLY).
//   2. data-sensitivity: the content's effective tier is allowed for the target
//      model profile (fail-closed: unknown → HIGHLY_SENSITIVE).
//   3. campaigns.authorizeSend: an approval exists for this exact template +
//      rendered payload at the campaign's current version (P0.4/P0.5).

import type Database from 'better-sqlite3'
import { isUsable } from './connector-health.js'
import { effectiveSensitivity, isProfileAllowedForSensitivity } from './sensitivity.js'
import { authorizeSend } from './campaigns.js'
import { permits } from './autonomy-ladder.js'
import { routeModelForSensitivity, type RoutingStrategy } from './model-routing.js'
import { mintGatePermit } from './gate-permit.js'
import { evaluateEnvelope, type EnvelopeDecision, type Intent } from './delegation-envelope.js'
import type { CaseSensitivity } from './schema.js'

export interface DispatchRequest {
  connectorId: string
  /** A send needs write; default true. */
  requireWrite?: boolean
  /** Recipient of this send — required for the AC-4 allowlist check. */
  recipient: string
  /** Case type, for the §22 autonomy rung. Absent = treated as a new type,
   *  which starts at PREPARE and therefore cannot send. */
  caseType?: string
  /** The case's declared sensitivity (escalated against the content). */
  declaredSensitivity: unknown
  /** F-16: evaluation time. Absent falls back to wall time inside
   *  authorizeSend, which is only ever right in production. */
  now?: number
  /** N-2: which per-kind ceiling applies. */
  outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY'
  /** E13: the channel this send actually goes out on, checked against the
   *  approval's allowed_channels. Defaults to EMAIL, which is the only channel
   *  this gate has ever been asked about — but it is passed rather than assumed
   *  inside authorizeSend, because the day a second channel exists the default
   *  must be the thing that changes, not the check. */
  channel?: string
  /** E13: the template variables the rendered payload actually used, checked
   *  against the approval's forbidden_variables / allowed_variable_schema. */
  usedVariables?: string[]
  /** The rendered outbound content (classified for sensitivity). */
  content: string
  /** The model profile that would process/produce this send. */
  targetProfile: string
  /** How to pick the recommended profile for the tier (default 'capability'). */
  routingStrategy?: RoutingStrategy
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
  /** §21: which namespace's envelope applies. Defaults to 'personal' because
   *  this gate IS the personal path — the corporate gate is evaluateZstSendGate,
   *  which passes 'zst' explicitly. */
  envelopeDomain?: 'personal' | 'zst'
  /** §21: the intent classifier reads the letter, and it reads subject and body
   *  as separate fields because `content` is already their concatenation and a
   *  classifier that cannot tell them apart cannot tell a subject line naming a
   *  price from a body committing to one. Absent falls back to `content`, which
   *  is fail-closed: fewer positive matches, never more. */
  subject?: string
  body?: string
}

export interface DispatchDecision {
  allowed: boolean
  /** Veto reasons; empty iff allowed. */
  reasons: string[]
  /** The effective sensitivity tier the gate computed. */
  sensitivityTier: CaseSensitivity
  /** The sensitivity-appropriate model profile for this tier (#5a dynamic
   *  routing), null if none is allowed. When the target profile is vetoed, this
   *  is the profile the caller SHOULD use instead. Scoped to the COS gate — it
   *  does not change fleet-wide model resolution. */
  recommendedProfile: string | null
  /** F-2 / AC-21: the versions the send authorisation was granted at, carried
   *  out of the gate so the ledger row can record what allowed it. Undefined
   *  when the campaign check refused. */
  campaignVersion?: number
  approvalVersion?: number
  /** N-2: the envelope ceilings, so the caller can have them counted inside the
   *  same transaction as the SENDING write instead of only before it. */
  limits?: { maxTotal: number | null; maxPerKind: number | null; kind: string | null }
  approvalId?: string
  /** §21: set when this send is allowed by a STANDING DELEGATION rather than by
   *  a human approval. Absent means a human approved it — the two are never both
   *  present, because the envelope is only consulted when the approval refused. */
  delegationEnvelopeId?: string
  /** Which intent the deterministic classifier recognised. Recorded because "it
   *  went without asking" is only auditable if the reason it qualified is
   *  written down next to it. */
  delegatedIntent?: Intent
}

/** Evaluate the full send gate. Fail-closed: every layer must pass. */
export function evaluateDispatch(db: Database.Database, req: DispatchRequest): DispatchDecision {
  const reasons: string[] = []

  if (!isUsable(db, req.connectorId, req.requireWrite ?? true)) {
    reasons.push(`connector "${req.connectorId}" is not write-usable`)
  }

  const tier = effectiveSensitivity(req.declaredSensitivity, req.content)
  if (!isProfileAllowedForSensitivity(req.targetProfile, tier)) {
    reasons.push(`profile "${req.targetProfile}" is not allowed for sensitivity ${tier}`)
  }

  // §22: the rung decides whether a send may happen for this case type at all.
  // Checked alongside the others, not instead of them — a permissive rung never
  // substitutes for an approval, and an approval never substitutes for the rung.
  const rung = permits(db, req.caseType ?? 'UNKNOWN', 'SEND')
  if (!rung.allowed) reasons.push(`autonómia-fokozat: ${rung.reason}`)

  // F-16: `now` is threaded through. authorizeSend defaults it to wall time, and
  // the gate was letting it — so an approval's expiry was compared against the
  // real clock while every other timestamp in the send came from the caller.
  // Harmless while nothing ever set valid_until; the moment approvals got an
  // expiry it made every fixture-time approval look expired.
  // E13 (review 2026-08-13): `channel` and `usedVariables` are PASSED. They were
  // not, so three envelope checks authorizeSend implements —
  // channel_not_allowed, forbidden_variable, variable_not_in_schema — could
  // never fire on the personal path. approveSend dutifully stored
  // allowedChannels:['EMAIL'] on every approval and nothing on this side ever
  // looked at it; the ZST door passed the channel and the personal one did not,
  // which is the same asymmetry that hid AC-4 from the personal store in August.
  const auth = authorizeSend(db, {
    campaignId: req.campaignId, templateHash: req.templateHash,
    renderedPayloadHash: req.renderedPayloadHash, recipient: req.recipient,
    outboundKind: req.outboundKind,
    channel: req.channel ?? 'EMAIL',
    ...(req.usedVariables ? { usedVariables: req.usedVariables } : {}),
  }, req.now)

  // §21 / §22 — STANDING DELEGATION *OR* HUMAN APPROVAL.
  //
  // The spec's chokepoint has always read "standing delegation OR human
  // approval", and only the right-hand branch existed: `delegation_envelope_id`
  // travelled through the whole system and was NULL on every row, because no
  // caller ever set it. This is the left-hand branch.
  //
  // WHAT IT SUBSTITUTES FOR, AND WHAT IT DOES NOT. Only the campaign approval.
  // The connector check, the sensitivity/profile rule and the §22 rung are
  // evaluated above and are ANDed regardless — a standing delegation is
  // permission to skip the QUESTION, never permission to skip a safety layer.
  // That is why this sits at the bottom of the function and not at the top.
  //
  // ASKED ONLY WHEN THE APPROVAL PATH REFUSED. A send that already has a valid
  // approval must not consume envelope quota or be recorded as delegated: it was
  // authorised the ordinary way, and saying otherwise would overstate how much
  // the system does unsupervised.
  let delegation: EnvelopeDecision | null = null
  if (!auth.authorized) {
    delegation = evaluateEnvelope(db, {
      domain: req.envelopeDomain ?? 'personal',
      actionType: 'EMAIL_SEND',
      recipient: req.recipient,
      subject: req.subject ?? '',
      body: req.body ?? req.content,
      outboundKind: req.outboundKind ?? null,
      now: req.now ?? Math.floor(Date.now() / 1000),
    })
    if (!delegation.delegated) {
      // BOTH refusals are reported, not just the approval's. "No approval" and
      // "the delegation would not have covered it either" are different facts,
      // and a caller that sees only the first will go looking for an approval
      // when the real answer is that this letter needs a human to read it.
      reasons.push(`campaign not authorized: ${auth.reason}`)
      for (const r of delegation.reasons) reasons.push(`delegálás: ${r}`)
    }
  }

  const routed = routeModelForSensitivity(tier, { strategy: req.routingStrategy ?? 'capability' })
  // §22.2 (review #3 Ú-4): stamp the decision as gate-produced. issueAuthorization
  // refuses anything not minted here, so a caller can no longer write a ticket by
  // importing the module and calling the function.
  return mintGatePermit({
    allowed: reasons.length === 0, reasons, sensitivityTier: tier, recommendedProfile: routed.profile,
    campaignVersion: auth.campaignVersion, approvalVersion: auth.approvalVersion,
    limits: auth.limits, approvalId: auth.approvalId,
    // Carried out of the gate so the caller can bind it into the authorization
    // ticket. `delegation_envelope_id` counts towards policyEvaluationHash, so
    // once this is set the ticket is bound to the delegation that justified it —
    // and a send authorised by an envelope can no longer be replayed as if a
    // human had approved it.
    ...(delegation?.delegated
      ? { delegationEnvelopeId: delegation.envelopeId, delegatedIntent: delegation.intent }
      : {}),
  })
}
