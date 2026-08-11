import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { getCase } from '../cos/case-store.js';
import { ingestTriagedEmail } from '../cos/triage-bridge.js';
import { IDEMPOTENCY_HEADER } from '../cos/adapters/gmail-send.js';
// COS email-triage → intake bridge. Proves it turns a triaged candidate into a
// case (inbound + outgoing), filters the system's own sends, and is idempotent
// (a re-fed message is ALREADY_PROCESSED — no duplicate case, no clobber).
const ACC = 'iszzu80', NOW = 1_000_000;
describe('COS triage bridge', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('an actionable inbound candidate becomes a case', () => {
        const db = getDb();
        const r = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm1', threadId: 't1', subject: 'Ajánlatkérés', from: 'vendor@x.com', snippet: 'ár?', actionable: true, caseType: 'QUOTE' }, NOW);
        expect(r.outcome).toBe('CASE_CREATED');
        expect(getCase(db, r.caseId).status).toBe('NEW');
    });
    it('an actionable OUTGOING (his sent) candidate becomes a WAITING_EXTERNAL case', () => {
        const db = getDb();
        const r = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm2', threadId: 't2', subject: 'Ajánlatkérés a peremelemre', from: 'iszzu80@gmail.com', to: 'vendor@x.com', snippet: 'kérem az árat', actionable: true, direction: 'OUTBOUND' }, NOW);
        expect(r.outcome).toBe('CASE_CREATED');
        expect(getCase(db, r.caseId).status).toBe('WAITING_EXTERNAL');
    });
    it('noise is EXCLUDED, no case', () => {
        const db = getDb();
        const r = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm3', subject: 'Newsletter', from: 'promo@x.com', snippet: 'sale', actionable: false }, NOW);
        expect(r.outcome).toBe('EXCLUDED');
    });
    it("the system's own send (idempotency marker) is filtered", () => {
        const db = getDb();
        const r = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm4', subject: 'Quote', from: 'me', snippet: 'x', actionable: true, headers: { [IDEMPOTENCY_HEADER]: 'mv-c1-EMAIL_SEND-1' } }, NOW);
        expect(r.outcome).toBe('EXCLUDED_SELF_SEND');
    });
    it('is idempotent: re-feeding the same message is ALREADY_PROCESSED', () => {
        const db = getDb();
        const first = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm5', threadId: 't5', subject: 'Ügy', from: 'a@b.c', snippet: 'x', actionable: true }, NOW);
        expect(first.outcome).toBe('CASE_CREATED');
        const again = ingestTriagedEmail(db, { accountId: ACC, messageId: 'm5', threadId: 't5', subject: 'Ügy', from: 'a@b.c', snippet: 'x', actionable: true }, NOW + 100);
        expect(again.outcome).toBe('ALREADY_PROCESSED');
        // still exactly one case for this message
        expect(db.prepare(`SELECT COUNT(*) n FROM personal_cases WHERE source_references='m5'`).get().n).toBe(1);
    });
});
