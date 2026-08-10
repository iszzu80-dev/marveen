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
import { isUsable } from './connector-health.js';
import { effectiveSensitivity, isProfileAllowedForSensitivity } from './sensitivity.js';
import { authorizeSend } from './campaigns.js';
import { routeModelForSensitivity } from './model-routing.js';
/** Evaluate the full send gate. Fail-closed: every layer must pass. */
export function evaluateDispatch(db, req) {
    const reasons = [];
    if (!isUsable(db, req.connectorId, req.requireWrite ?? true)) {
        reasons.push(`connector "${req.connectorId}" is not write-usable`);
    }
    const tier = effectiveSensitivity(req.declaredSensitivity, req.content);
    if (!isProfileAllowedForSensitivity(req.targetProfile, tier)) {
        reasons.push(`profile "${req.targetProfile}" is not allowed for sensitivity ${tier}`);
    }
    const auth = authorizeSend(db, {
        campaignId: req.campaignId, templateHash: req.templateHash, renderedPayloadHash: req.renderedPayloadHash,
    });
    if (!auth.authorized)
        reasons.push(`campaign not authorized: ${auth.reason}`);
    const routed = routeModelForSensitivity(tier, { strategy: req.routingStrategy ?? 'capability' });
    return { allowed: reasons.length === 0, reasons, sensitivityTier: tier, recommendedProfile: routed.profile };
}
