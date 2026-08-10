import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { registerConnector, setMode, recordSuccess } from '../cos/connector-health.js';
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js';
import { draftSend, approveSend, rejectSend, dispatchApprovedSend, renderedPayloadHash } from '../cos/send-flow.js';
// #4: the COS can send an email — but ONLY after the owner's explicit per-payload
// approval AND only through the full dispatch gate. These tests PROVE the
// invariant: nothing leaves without approval, a payload edited after approval is
// rejected, and a read-only/vetoed connector blocks the send.
const NOW = 1_000_000;
const EMAIL = { to: 'vendor@example.com', subject: 'Ajánlatkérés', body: 'Kérek egy árajánlatot.' };
function setup() {
    initDatabase(':memory:');
    const db = getDb();
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X', sensitivity: 'PERSONAL' }, NOW);
    // gmail connector write-usable (Istvan consented to gmail.send)
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', NOW);
    recordSuccess(db, 'gmail', NOW);
    return db;
}
function draftArgs() {
    return { caseId: 'c1', connectorId: 'gmail', templateId: 'quote-request', email: EMAIL, declaredSensitivity: 'PERSONAL' };
}
function dispatchArgs(d) {
    return {
        ledgerId: d.ledgerId, campaignId: d.campaignId, connectorId: 'gmail', email: EMAIL,
        templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
        declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning',
    };
}
describe('COS approval-gated send flow (#4)', () => {
    beforeEach(() => { setup(); });
    it('a drafted send CANNOT be dispatched before approval (payload not authorized)', async () => {
        const db = getDb();
        const d = draftSend(db, draftArgs(), NOW);
        expect(d.status).toBe('AWAITING_APPROVAL');
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 1);
        expect(r.sent).toBe(false);
        expect(r.decision.reasons.join()).toMatch(/campaign not authorized/i);
        expect(t.sent.size).toBe(0); // <-- nothing left the building
    });
    it('draft → approve → dispatch SENDS exactly once (through the gate)', async () => {
        const db = getDb();
        const d = draftSend(db, draftArgs(), NOW);
        approveSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan' }, NOW + 1);
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 2);
        expect(r.decision.allowed).toBe(true);
        expect(r.sent).toBe(true);
        expect(r.action?.status).toBe('VERIFIED');
        expect(t.sent.size).toBe(1);
    });
    it('a payload EDITED after approval is rejected (rendered-hash mismatch)', async () => {
        const db = getDb();
        const d = draftSend(db, draftArgs(), NOW);
        approveSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan' }, NOW + 1);
        // attacker/typo edits the body → a different rendered hash than what was approved
        const tampered = { ...EMAIL, body: EMAIL.body + ' (utólag módosítva)' };
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
            ...dispatchArgs(d), email: tampered, renderedPayloadHash: renderedPayloadHash(tampered),
        }, NOW + 2);
        expect(r.sent).toBe(false);
        expect(r.decision.reasons.join()).toMatch(/not authorized|no APPROVED approval/i);
        expect(t.sent.size).toBe(0);
    });
    it('rejectSend cancels the planned row → a later dispatch is a no-op', async () => {
        const db = getDb();
        const d = draftSend(db, draftArgs(), NOW);
        approveSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan' }, NOW + 1);
        const cancelled = rejectSend(db, d.ledgerId, 'Istvan meggondolta magát', NOW + 2);
        expect(cancelled.status).toBe('CANCELLED');
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 3);
        expect(r.action?.status).toBe('CANCELLED'); // terminal, never sent
        expect(t.sent.size).toBe(0);
    });
    it('a READ_ONLY connector blocks the send even with a valid approval', async () => {
        const db = getDb();
        const d = draftSend(db, draftArgs(), NOW);
        approveSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan' }, NOW + 1);
        setMode(db, 'gmail', 'READ_ONLY', NOW + 2); // connector downgraded
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 3);
        expect(r.sent).toBe(false);
        expect(r.decision.reasons.join()).toMatch(/not write-usable/i);
        expect(t.sent.size).toBe(0);
    });
    it('highly-sensitive content to a low profile is blocked (sensitivity gate)', async () => {
        const db = getDb();
        const sensitive = { to: 'x@y.z', subject: 'kártyaadatok', body: 'a kártyaszám 4111 1111 1111 1111' };
        const d = draftSend(db, { ...draftArgs(), email: sensitive }, NOW);
        approveSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan' }, NOW + 1);
        const t = new DryRunTransport();
        const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
            ...dispatchArgs(d), email: sensitive, renderedPayloadHash: d.renderedPayloadHash, targetProfile: 'routine_lowcost',
        }, NOW + 2);
        expect(r.sent).toBe(false);
        expect(r.decision.reasons.join()).toMatch(/not allowed for sensitivity/i);
        expect(t.sent.size).toBe(0);
    });
});
