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
  /** The rendered outbound content (classified for sensitivity). */
  content: string
  /** The model profile that would process/produce this send. */
  targetProfile: string
  /** How to pick the recommended profile for the tier (default 'capability'). */
  routingStrategy?: RoutingStrategy
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
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

  const auth = authorizeSend(db, {
    campaignId: req.campaignId, templateHash: req.templateHash,
    renderedPayloadHash: req.renderedPayloadHash, recipient: req.recipient,
  })
  if (!auth.authorized) reasons.push(`campaign not authorized: ${auth.reason}`)

  const routed = routeModelForSensitivity(tier, { strategy: req.routingStrategy ?? 'capability' })
  return {
    allowed: reasons.length === 0, reasons, sensitivityTier: tier, recommendedProfile: routed.profile,
    campaignVersion: auth.campaignVersion, approvalVersion: auth.approvalVersion,
  }
}
