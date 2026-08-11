// Personal Chief of Staff (COS) — approval-gated send flow (spec item #4).
//
// The safe orchestration that lets the COS actually SEND an email — but only
// after Istvan's explicit per-payload approval, and only through the full
// dispatch gate. It composes the pieces already built and proven:
//   draftSend()            PREPARE: compose the email, greenlight the campaign,
//                          plan the outbound_ledger row. Sends NOTHING and does
//                          NOT approve the payload — authorizeSend is FALSE after.
//   approveSend()          the owner's explicit YES to THIS exact rendered payload
//                          (records a P0.4 campaign_approval at the current version).
//   rejectSend()           the owner's NO / an abort → the planned row is CANCELLED.
//   dispatchApprovedSend() actually send, but ONLY if evaluateDispatch passes
//                          (connector write-usable AND sensitivity-allowed AND the
//                          exact payload approved). Any veto → nothing is sent.
//
// Nothing here sends autonomously: dispatch is called explicitly (on approval),
// the gate re-checks everything at send time, and a payload edited after approval
// fails the rendered-payload-hash match. The real Gmail send only happens if the
// caller passes the live GmailApiTransport AND the gmail connector is READ_WRITE
// — otherwise the gate vetoes, so the flow is inert until deliberately activated.
import { sha256Hex } from './attachments.js';
import { createCampaign, getCampaign, approveCampaign, recordApproval } from './campaigns.js';
import { planAction, executeAction, cancelAction } from './executor.js';
import { evaluateDispatch } from './dispatch-gate.js';
/** Deterministic hash of the EXACT rendered payload — what the owner approves and
 *  what the send gate re-checks. Any edit changes it → a stale approval no longer
 *  authorizes. */
export function renderedPayloadHash(email) {
    return sha256Hex(JSON.stringify({ to: email.to, subject: email.subject, body: email.body }));
}
/** Hash identifying the typed template a send is built from (free text is never
 *  autonomously sendable — authorizeSend rejects a free-text campaign). */
export function templateHashFor(templateId) {
    return sha256Hex(`template:${templateId}`);
}
/** PREPARE. Creates/greenlights the case's EMAIL_SEND campaign (typed, no free
 *  text) and plans the outbound row. Sends nothing; the payload is NOT yet
 *  approved, so a dispatch now would be vetoed. */
export function draftSend(db, input, now) {
    const templateHash = templateHashFor(input.templateId);
    const rHash = renderedPayloadHash(input.email);
    const campaignId = input.campaignId ?? `camp-${input.caseId}-EMAIL_SEND`;
    if (!getCampaign(db, campaignId)) {
        createCampaign(db, {
            campaignId, caseId: input.caseId, campaignType: 'EMAIL_SEND',
            templateId: input.templateId, templateHash, allowsFreeText: false,
        }, now);
        approveCampaign(db, campaignId, now); // campaign greenlit; per-send approval still required
    }
    const seq = (db.prepare(`SELECT COUNT(*) AS n FROM outbound_ledger WHERE case_id=? AND action_type='EMAIL_SEND'`).get(input.caseId).n) + 1;
    const planned = planAction(db, { caseId: input.caseId, actionType: 'EMAIL_SEND', sequenceNumber: seq, payload: input.email }, now);
    // Fill the columns §6.2 / A.5 added: which campaign, to whom, what kind. The
    // quota has nothing to count without them, and the approval door cannot find
    // the campaign whose template it must bind to — a ledger row that does not say
    // which campaign it belongs to is unauditable by AC-21.
    db.prepare(`UPDATE outbound_ledger SET campaign_id=@c, recipient=@r, channel='EMAIL',
       outbound_kind=COALESCE(outbound_kind, @k), first_attempt_at=COALESCE(first_attempt_at, @now)
     WHERE ledger_id=@id`).run({ c: campaignId, r: input.email.to, k: seq === 1 ? 'INITIAL' : 'FOLLOW_UP', now, id: planned.ledgerId });
    return {
        campaignId, ledgerId: planned.ledgerId, sequenceNumber: seq,
        templateHash, renderedPayloadHash: rHash, email: input.email, status: 'AWAITING_APPROVAL',
    };
}
/** The owner's explicit YES to THIS exact rendered payload. After this,
 *  authorizeSend passes for the matching payload at the current campaign version. */
export function approveSend(db, input, now) {
    recordApproval(db, {
        approvalId: input.approvalId ?? `appr-${input.campaignId}-${input.renderedPayloadHash.slice(0, 16)}`,
        campaignId: input.campaignId, approvedBy: input.approvedBy,
        templateHash: input.templateHash, renderedPayloadHash: input.renderedPayloadHash,
        allowedChannels: ['EMAIL'],
        ...input.envelope,
        allowedRecipients: [input.recipient],
    }, now);
}
/** The owner's NO / an abort. Cancels the planned (not-yet-sent) row. */
export function rejectSend(db, ledgerId, reason, now) {
    return cancelAction(db, ledgerId, reason, now);
}
/** Actually send — but ONLY through the full gate. evaluateDispatch must pass
 *  (connector write-usable AND content's sensitivity allowed for the profile AND
 *  the exact payload approved at the current version). Any veto → sent:false,
 *  nothing leaves. On pass, the crash-safe executor performs the send. */
/** The case type behind a ledger row, from the store. Returns undefined when it
 *  cannot be determined — and undefined means the gate treats it as a new type,
 *  which cannot send. Fail-closed. */
function caseTypeOf(db, ledgerId) {
    const r = db.prepare(`SELECT c.case_type AS t FROM outbound_ledger l
     JOIN personal_cases c ON c.case_id = l.case_id WHERE l.ledger_id = ?`).get(ledgerId);
    return r?.t;
}
export async function dispatchApprovedSend(db, adapter, input, now, opts = {}) {
    const decision = evaluateDispatch(db, {
        connectorId: input.connectorId, requireWrite: true,
        declaredSensitivity: input.declaredSensitivity,
        content: `${input.email.subject}\n${input.email.body}`,
        targetProfile: input.targetProfile,
        campaignId: input.campaignId, templateHash: input.templateHash, renderedPayloadHash: input.renderedPayloadHash,
        // The address on the envelope we are about to put in the post, not a stored
        // intention: the allowlist must be checked against what actually goes out.
        recipient: input.email.to,
        // §22: the case's OWN type decides the rung, read from the store rather than
        // taken from the caller. A caller-asserted type would let the same code path
        // pick a more permissive rung by claiming to be a different kind of case.
        caseType: caseTypeOf(db, input.ledgerId),
    });
    if (!decision.allowed)
        return { sent: false, decision };
    const action = await executeAction(db, adapter, input.ledgerId, now, opts);
    return { sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED', decision, action };
}
