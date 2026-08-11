import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { draftSend, renderedPayloadHash } from '../cos/send-flow.js';
import { setLadder, pauseAll } from '../cos/autonomy-ladder.js';
import { approveOutbound } from '../web/routes/cos.js';
// The approval door.
//
// The send flow was written and tested months ago and had no production caller:
// there was no way in. That is why "where do I click?" had no answer. These
// tests are about what the door refuses, because a door that only opens is a
// hole.
const NOW = 1_800_000_000;
const EMAIL = { to: 'reklamacio@ecipo.hu', subject: 'HOFF visszaküldés', body: 'Kedves eCipő!' };
function seed(rung = 'EXECUTE_WITH_APPROVAL') {
    initDatabase(':memory:');
    const db = getDb();
    createCase(db, { caseId: 'c1', title: 'HOFF reklamáció', caseType: 'ADMIN' }, NOW - 1000);
    setLadder(db, 'ADMIN', { rung }, NOW - 1000);
    const d = draftSend(db, {
        caseId: 'c1', connectorId: 'gmail', templateId: 'hoff-return', email: EMAIL,
    }, NOW - 100);
    return { db, draft: d };
}
describe('outbound approval door', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('approves a planned send whose text the owner actually saw', () => {
        const { db, draft } = seed();
        const r = approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW);
        expect(r.reason).toBe('jóváhagyva');
        expect(r.ok).toBe(true);
    });
    it('refuses when the draft changed between display and click', () => {
        // Approving a message means approving THAT text. A hash mismatch is not a
        // technicality — it means the thing on screen is not the thing being sent.
        const { db, draft } = seed();
        const r = approveOutbound(db, draft.ledgerId, 'a-regi-hash', 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/megváltozott/);
    });
    it('refuses a case type still on PREPARE, even with a valid hash', () => {
        const { db, draft } = seed('PREPARE');
        const r = approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/fokozat/);
    });
    it('the master switch stops approval too — not just autonomous sending', () => {
        const { db, draft } = seed();
        pauseAll(db, true, 'szünet', NOW);
        const r = approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/szünetel/);
    });
    it('cannot be approved twice — the second click is refused, not silently repeated', () => {
        const { db, draft } = seed();
        expect(approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW).ok).toBe(true);
        db.prepare(`UPDATE outbound_ledger SET status='SENDING' WHERE ledger_id=?`).run(draft.ledgerId);
        const again = approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW + 1);
        expect(again.ok).toBe(false);
        expect(again.reason).toMatch(/SENDING/);
    });
    it('refuses an unknown ledger row by name', () => {
        const { db } = seed();
        const r = approveOutbound(db, 'nincs-ilyen', undefined, 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('nincs-ilyen');
    });
    it('refuses a draft with no recipient rather than sending to nowhere', () => {
        const { db, draft } = seed();
        db.prepare(`UPDATE outbound_ledger SET payload=? WHERE ledger_id=?`)
            .run(JSON.stringify({ subject: 'x', body: 'y' }), draft.ledgerId);
        const r = approveOutbound(db, draft.ledgerId, undefined, 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/címzett/);
    });
    it('refuses unreadable payload rather than guessing', () => {
        const { db, draft } = seed();
        db.prepare(`UPDATE outbound_ledger SET payload='{ nem json' WHERE ledger_id=?`).run(draft.ledgerId);
        const r = approveOutbound(db, draft.ledgerId, undefined, 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/nem olvasható/);
    });
    it('approving records an approval bound to the campaign version', () => {
        const { db, draft } = seed();
        approveOutbound(db, draft.ledgerId, renderedPayloadHash(EMAIL), 'istvan', NOW);
        const a = db.prepare(`SELECT campaign_id, campaign_version, status, allowed_recipients FROM campaign_approvals`).get();
        expect(a.status).toBe('APPROVED');
        expect(a.campaign_version).toBeGreaterThan(0);
        // and the allowlist is exactly this recipient, not "anyone"
        expect(JSON.parse(a.allowed_recipients)).toEqual([EMAIL.to]);
    });
});
