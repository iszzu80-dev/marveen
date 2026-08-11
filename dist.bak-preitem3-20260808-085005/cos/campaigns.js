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
 *  current version. Status starts APPROVED (this models the owner's explicit
 *  yes to this exact content). */
export function recordApproval(db, a, now) {
    const c = getCampaign(db, a.campaignId);
    if (!c)
        throw new Error(`campaign not found: ${a.campaignId}`);
    db.prepare(`INSERT INTO campaign_approvals (approval_id, campaign_id, campaign_version, approved_by,
        template_hash, rendered_payload_hash, status, created_at, updated_at)
     VALUES (@approvalId, @campaignId, @version, @approvedBy, @templateHash, @renderedPayloadHash, 'APPROVED', @now, @now)`).run({ ...a, version: c.version, now });
}
/**
 * The P0.4/P0.5 gate: may this EXACT rendered payload be sent autonomously right
 * now? Requires, all at once:
 *   - campaign is APPROVED (not DRAFT/PAUSED/REVOKED/COMPLETED),
 *   - campaign does NOT allow free text (autonomous only from typed templates),
 *   - an APPROVED campaign_approval exists whose template_hash AND
 *     rendered_payload_hash match the request AND whose campaign_version equals
 *     the campaign's CURRENT version (a revoke/pause bumped it → stale approval
 *     no longer authorizes).
 * Fail-closed: any miss → not authorized, with a reason.
 */
export function authorizeSend(db, q) {
    const c = getCampaign(db, q.campaignId);
    if (!c)
        return { authorized: false, reason: 'campaign not found' };
    if (c.status !== 'APPROVED')
        return { authorized: false, reason: `campaign status ${c.status} (not APPROVED)` };
    if (c.allows_free_text)
        return { authorized: false, reason: 'campaign allows free text → autonomous send not allowed (PREPARE only)' };
    const appr = db.prepare(`SELECT COUNT(*) AS n FROM campaign_approvals
     WHERE campaign_id=@id AND status='APPROVED' AND campaign_version=@version
       AND template_hash=@th AND rendered_payload_hash=@rh`).get({ id: q.campaignId, version: c.version, th: q.templateHash, rh: q.renderedPayloadHash });
    if (appr.n === 0) {
        return { authorized: false, reason: 'no APPROVED approval matching this template + rendered payload at the current campaign version' };
    }
    return { authorized: true, reason: 'ok' };
}
