import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { getCase } from '../cos/case-store.js';
import { openBatch } from '../cos/email-ingest.js';
import { ingestEmail } from '../cos/intake.js';
import { IDEMPOTENCY_HEADER } from '../cos/adapters/gmail-send.js';
// COS email → case intake. Proves the inbound behavior: noise is excluded, an
// actionable email becomes a case with the escalated sensitivity, a message
// gets LOCAL_APPLIED with its case_id, and a second email on the same thread
// links to the existing case as a DUPLICATE.
const ACC = 'iszzu80', NOW = 1_000_000;
function discover(messageId, threadId) {
    openBatch(getDb(), { batchId: `b-${messageId}`, accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId, threadId }] }, NOW);
}
function msgStatus(messageId) {
    return getDb().prepare(`SELECT status, case_id FROM email_processing WHERE gmail_account_id=? AND message_id=?`).get(ACC, messageId);
}
describe('COS email intake', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('non-actionable email → EXCLUDED, no case', () => {
        discover('m1');
        const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm1', subject: 'Newsletter', from: 'promo@x.com', snippet: 'sale', actionable: false }, NOW);
        expect(r.outcome).toBe('EXCLUDED');
        expect(msgStatus('m1').status).toBe('EXCLUDED');
    });
    it('actionable email → case created, message LOCAL_APPLIED with case_id', () => {
        discover('m2', 't2');
        const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm2', threadId: 't2', subject: 'Ajánlatkérés', from: 'vendor@x.com', snippet: 'kérem az árat', actionable: true, caseType: 'QUOTE' }, NOW);
        expect(r.outcome).toBe('CASE_CREATED');
        const c = getCase(getDb(), r.caseId);
        expect(c.title).toBe('Ajánlatkérés');
        expect(c.case_type).toBe('QUOTE');
        expect(c.source_references).toBe('m2');
        const m = msgStatus('m2');
        expect(m.status).toBe('LOCAL_APPLIED');
        expect(m.case_id).toBe(r.caseId);
    });
    it('escalates sensitivity from the content (declared PERSONAL, content has a card → HIGHLY_SENSITIVE)', () => {
        discover('m3', 't3');
        const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm3', threadId: 't3', subject: 'Fizetés', from: 'x@y.z', snippet: 'a kártyaszám 4111 1111 1111 1111', actionable: true, declaredSensitivity: 'PERSONAL' }, NOW);
        expect(r.sensitivity).toBe('HIGHLY_SENSITIVE');
        expect(getCase(getDb(), r.caseId).sensitivity).toBe('HIGHLY_SENSITIVE');
    });
    it('a second email on the same thread links as DUPLICATE to the existing case', () => {
        const db = getDb();
        discover('m4', 'shared-thread');
        const first = ingestEmail(db, { accountId: ACC, messageId: 'm4', threadId: 'shared-thread', subject: 'Ügy', from: 'a@b.c', snippet: 'x', actionable: true }, NOW);
        discover('m5', 'shared-thread');
        const second = ingestEmail(db, { accountId: ACC, messageId: 'm5', threadId: 'shared-thread', subject: 'Re: Ügy', from: 'a@b.c', snippet: 'y', actionable: true }, NOW);
        expect(second.outcome).toBe('LINKED_DUPLICATE');
        expect(second.caseId).toBe(first.caseId);
        expect(msgStatus('m5').status).toBe('DUPLICATE');
        expect(msgStatus('m5').case_id).toBe(first.caseId);
    });
    it("self-event filter: the COS's own automated send (idempotency marker) is EXCLUDED, no case", () => {
        discover('m6');
        const r = ingestEmail(getDb(), {
            accountId: ACC, messageId: 'm6', subject: 'Quote request', from: 'me', snippet: 'x', actionable: true,
            headers: { [IDEMPOTENCY_HEADER]: 'mv-c1-EMAIL_SEND-1' }, // our own send
        }, NOW);
        expect(r.outcome).toBe('EXCLUDED_SELF_SEND');
        expect(msgStatus('m6').status).toBe('EXCLUDED');
        expect(msgStatus('m6').case_id ?? null).toBeNull();
    });
    it('OUTBOUND (email Istvan sent) → case in WAITING_EXTERNAL with a follow-up', () => {
        discover('m7', 't7');
        const r = ingestEmail(getDb(), {
            accountId: ACC, messageId: 'm7', threadId: 't7', subject: 'Ajánlatkérés a peremelemre', from: 'iszzu80@gmail.com',
            to: 'vendor@example.com', snippet: 'kérem az árat', actionable: true, direction: 'OUTBOUND', followUpAt: NOW + 259200,
        }, NOW);
        expect(r.outcome).toBe('CASE_CREATED');
        const c = getCase(getDb(), r.caseId);
        expect(c.status).toBe('WAITING_EXTERNAL'); // ball is with the recipient
        expect(c.description).toMatch(/Sent to: vendor@example.com/);
        expect(c.waiting_on).toMatch(/reply from vendor@example.com/);
        expect(c.follow_up_at).toBe(NOW + 259200);
    });
});
