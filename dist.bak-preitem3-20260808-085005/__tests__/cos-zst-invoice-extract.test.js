import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { extractInvoice, ingestZstInvoiceEmail } from '../cos/zst-invoice-extract.js';
import { ingestTriagedZstEmail } from '../cos/zst-intake.js';
const T0 = 1_700_000_000;
const INVOICE = {
    from: '"DMRV Zrt." <szamla@dmrvzrt.hu>',
    subject: 'Számla - 4102268904',
    body: 'Tisztelt Ügyfelünk!\nSzámlaszám: 4102268904\nTeljesítés dátuma: 2026-07-22\nFizetési határidő: 2026-08-06\nFizetendő összeg: 15 484 Ft\nKöszönjük.',
};
describe('ZST invoice extractor (v1 heuristic)', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('extracts gross, dates, invoice number, supplier from a real invoice email', () => {
        const ex = extractInvoice(INVOICE);
        expect(ex).not.toBeNull();
        expect(ex.grossAmount).toBe(15484);
        expect(ex.invoiceNumber).toBe('4102268904');
        expect(ex.issueDate).toBe('2026-07-22');
        expect(ex.dueDate).toBe('2026-08-06');
        expect(ex.supplierId).toBe('DMRV Zrt.');
        expect(ex.confidence).toBe('HIGH'); // gross + invoice number
    });
    it('returns null for a non-invoice email', () => {
        expect(extractInvoice({ from: 'a@b.hu', subject: 'Meeting reminder', body: 'See you at 10.' })).toBeNull();
    });
    it('registers the invoice (idempotent) and never marks it paid', () => {
        const db = getDb();
        const r1 = ingestZstInvoiceEmail(db, INVOICE, T0);
        expect(r1.duplicate).toBe(false);
        expect(r1.confidence).toBe('HIGH');
        const r2 = ingestZstInvoiceEmail(db, INVOICE, T0 + 5);
        expect(r2.duplicate).toBe(true); // dedup
        expect(db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get().n).toBe(1);
        const inv = db.prepare(`SELECT payment_status FROM zst_invoices WHERE invoice_id=?`).get(r1.invoiceId);
        expect(inv.payment_status).toBe('UNPAID'); // payment evidence comes from bank recon, never the email
    });
    it('does honest partial extraction — unparseable fields stay null', () => {
        const ex = extractInvoice({ from: 'x@y.hu', subject: 'Díjbekérő', body: 'Kérjük rendezze a díjbekérőt.' });
        expect(ex).not.toBeNull(); // "díjbekérő" cue
        expect(ex.grossAmount).toBeUndefined();
        expect(ex.invoiceNumber).toBeUndefined();
        expect(ex.confidence).toBe('LOW');
    });
    it('parses dotted and spaced HUF amounts', () => {
        const ex = extractInvoice({ from: 'a@b.hu', subject: 'Számla', body: 'Összeg: 1.234.567 Ft' });
        expect(ex.grossAmount).toBe(1234567);
    });
    it('end-to-end: a ZST invoice email through intake creates a case AND a zst_invoice', () => {
        const db = getDb();
        const r = ingestTriagedZstEmail(db, {
            accountId: 'zst', messageId: 'inv-msg-1', threadId: 'inv-t1',
            from: INVOICE.from, subject: INVOICE.subject, snippet: INVOICE.body,
            actionable: true, caseType: 'INVOICE_INCOMING',
        }, T0);
        expect(r.outcome).toBe('CASE_CREATED');
        const inv = db.prepare(`SELECT invoice_id, gross_amount, case_id FROM zst_invoices`).get();
        expect(inv.gross_amount).toBe(15484);
        expect(inv.case_id).toBe(r.caseId); // linked to the case
    });
});
