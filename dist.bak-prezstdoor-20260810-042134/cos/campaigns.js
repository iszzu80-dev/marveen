// Personal Chief of Staff (COS) — campaigns + approvals (Slice 1 governance).
//
// The authorization layer over the Action Executor. Nothing autonomous is sent
// unless authorizeSend() says yes, and it enforces the two P0 rules the spec's
// review rounds set:
//   P0.4: approving a TEMPLATE does not authorize an arbitrary sent message. An
//         approval binds BOTH the template hash AND the specific rendered-payload
//         hash; autonomous send is allowed ONLY from a typed template
//         (allows_free_text = 0). Free-text campaigns can PREPARE, never
//         autonomously send.
//   P0.5: an approval is bound to the campaign version it was granted at. A
//         revoke/pause bumps the version, so a stale approval stops authorizing.
//         (An already-SENDING action is still governed by the executor's
//         readback — a revoke cannot guarantee a stop mid-send.)
//
// Pure DB logic — no send capability here (that is the executor + connector).
import { personalApprovals } from './approval-core.js';
export function createCampaign(db, c, now) {
    db.prepare(`INSERT INTO campaigns (campaign_id, case_id, campaign_type, template_id, template_hash,
        status, version, allows_free_text, autonomous_spend_limit, created_at, updated_at)
     VALUES (@campaignId, @caseId, @campaignType, @templateId, @templateHash, 'DRAFT', 1, @free, 0, @now, @now)`).run({
        campaignId: c.campaignId, caseId: c.caseId, campaignType: c.campaignType,
        templateId: c.templateId ?? null, templateHash: c.templateHash ?? null,
        free: c.allowsFreeText ? 1 : 0, now,
    });
    return getCampaign(db, c.campaignId);
}
export function getCampaign(db, campaignId) {
    return db.prepare(`SELECT * FROM campaigns WHERE campaign_id = ?`).get(campaignId);
}
/** Move DRAFT → APPROVED (the campaign itself is greenlit; individual sends
 *  still need a matching approval row via authorizeSend). */
export function approveCampaign(db, campaignId, now) {
    const info = db.prepare(`UPDATE campaigns SET status='APPROVED', updated_at=? WHERE campaign_id=? AND status='DRAFT'`).run(now, campaignId);
    if (info.changes === 0)
        throw new Error(`campaign not DRAFT (or missing): ${campaignId}`);
}
/** Revoke/pause bump the version → any approval bound to the old version stops
 *  authorizing (P0.5 revoke-race). Optimistic: caller passes the version it saw. */
export function revokeCampaign(db, campaignId, seenVersion, now) {
    return setCampaignStatusVersioned(db, campaignId, 'REVOKED', seenVersion, now);
}
export function pauseCampaign(db, campaignId, seenVersion, now) {
    return setCampaignStatusVersioned(db, campaignId, 'PAUSED', seenVersion, now);
}
function setCampaignStatusVersioned(db, campaignId, status, seenVersion, now) {
    const info = db.prepare(`UPDATE campaigns SET status=@status, version=version+1, updated_at=@now WHERE campaign_id=@id AND version=@seen`).run({ status, now, id: campaignId, seen: seenVersion });
    if (info.changes === 0)
        throw new Error(`campaign ${campaignId}: version ${seenVersion} is stale or campaign missing`);
    return seenVersion + 1;
}
/** Resume a PAUSED campaign back to APPROVED WITHOUT bumping the version — so an
 *  approval granted before the pause (bound to an earlier version) still does
 *  NOT authorize; only an approval at the current version does. */
export function resumeCampaign(db, campaignId, now) {
    const info = db.prepare(`UPDATE campaigns SET status='APPROVED', updated_at=? WHERE campaign_id=? AND status='PAUSED'`).run(now, campaignId);
    if (info.changes === 0)
        throw new Error(`campaign not PAUSED (or missing): ${campaignId}`);
}
/** Record an approval for a SPECIFIC rendered payload, bound to the campaign's
 *  current version, carrying the whole §3.2 envelope.
 *
 *  Delegates to the shared approval core: Personal and ZST must not drift again
 *  (2026-08-09 — ZST had a recipient allowlist, Personal did not). */
export function recordApproval(db, a, now) {
    personalApprovals.recordApproval(db, a, now);
}
/** §3.4 — trip a stop condition; every later authorizeSend refuses. */
export function tripStopCondition(db, approvalId, reason, now) {
    personalApprovals.tripStopCondition(db, approvalId, reason, now);
}
/**
 * The §3.2/§3.4 gate. See approval-core.ts for the full check list — campaign
 * state, version binding, free-text ban, expiry, recipient allowlist, channel,
 * forbidden/undeclared variables, per-kind and total quota, stop conditions.
 * Fail-closed everywhere.
 */
export function authorizeSend(db, q, now = Math.floor(Date.now() / 1000)) {
    return personalApprovals.authorizeSend(db, q, now);
}
