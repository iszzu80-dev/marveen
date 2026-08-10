import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { ingestEmailCosts, toHuf, fxRateFor } from '../costops/email-ingest.js';
const NOW = Math.floor(Date.UTC(2026, 6, 6) / 1000);
describe('toHuf', () => {
    it('passes HUF through, converts USD, flags others', () => {
        expect(toHuf(8990, 'HUF', 360)).toBe(8990);
        expect(toHuf(2, 'USD', 360)).toBe(720);
        expect(toHuf(5, 'EUR', 360)).toBeNull(); // not converted here
    });
    // Card 23912ca4: USD was NOT guarded against a zero rate the way EUR was --
    // toHuf(amount, 'USD', 0) used to return 0 (a fabricated conversion), while
    // toHuf(amount, 'EUR', 0) already correctly returned null. These pin the fix
    // and are written to fail loudly if the USD branch ever loses its guard again.
    it('USD is guarded against a zero rate EXACTLY like EUR -- unconvertible (null), never a fabricated 0', () => {
        expect(toHuf(100, 'USD', 0)).toBeNull();
        expect(toHuf(100, 'USD', 0)).not.toBe(0);
        expect(toHuf(100, 'EUR', 100, 0)).toBeNull(); // EUR behaviour unchanged by the fix
    });
    it('USD is guarded against a negative rate too', () => {
        expect(toHuf(100, 'USD', -1)).toBeNull();
    });
    it('a valid USD rate still converts -- the guard does not break the working path', () => {
        expect(toHuf(2, 'USD', 360)).toBe(720);
        expect(toHuf(2, 'usd', 360)).toBe(720); // case-insensitive, matching EUR/HUF
    });
    it('EUR still converts normally with a valid rate -- unaffected by the USD guard', () => {
        expect(toHuf(5, 'EUR', 360, 400)).toBe(2000);
    });
});
describe('fxRateFor', () => {
    it('mirrors toHuf: a zero USD rate is unconvertible (null), not a retained fake 0', () => {
        expect(fxRateFor('USD', 0, 0)).toBeNull();
        expect(fxRateFor('EUR', 0, 0)).toBeNull();
    });
    it('returns the real rate for a valid currency', () => {
        expect(fxRateFor('USD', 360, 0)).toBe(360);
        expect(fxRateFor('EUR', 0, 400)).toBe(400);
    });
});
describe('ingestEmailCosts', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('ingests receipts as actual_invoice lines, idempotent per (email, month)', () => {
        const db = getDb();
        const entries = [
            { source_id: 'anthropic-pro', name: 'Claude Pro', provider: 'anthropic', amount: 8990, currency: 'HUF', month: '2026-06', message_ref: 'gmail-abc' },
            { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-def' },
        ];
        const r1 = ingestEmailCosts(db, entries, { fxUsdHuf: 360, now: NOW });
        expect(r1.ingested).toBe(2);
        expect(r1.errors).toHaveLength(0);
        const pro = db.prepare("SELECT billed_cost, confidence, charge_category FROM cost_line_items WHERE source_id='anthropic-pro'").get();
        expect(pro.billed_cost).toBe(8990);
        expect(pro.confidence).toBe('actual_invoice');
        expect(pro.charge_category).toBe('invoice');
        const oa = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='openai-api'").get();
        expect(oa.billed_cost).toBe(3.5 * 360);
        // re-ingest the SAME receipts -> idempotent, no duplicates
        ingestEmailCosts(db, entries, { fxUsdHuf: 360, now: NOW + 100 });
        expect(db.prepare('SELECT COUNT(*) c FROM cost_line_items').get().c).toBe(2);
    });
    it('same provider, different months coexist (not deduped across months)', () => {
        const db = getDb();
        ingestEmailCosts(db, [{ source_id: 'render-hosting', name: 'Render', provider: 'render', amount: 40000, currency: 'HUF', month: '2026-06', message_ref: 'r-jun' }], { fxUsdHuf: 360, now: NOW });
        ingestEmailCosts(db, [{ source_id: 'render-hosting', name: 'Render', provider: 'render', amount: 41000, currency: 'HUF', month: '2026-07', message_ref: 'r-jul' }], { fxUsdHuf: 360, now: NOW });
        expect(db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='render-hosting'").get().c).toBe(2);
    });
    it('collects errors for bad month / unconvertible currency / missing id, ingests the rest', () => {
        const db = getDb();
        const r = ingestEmailCosts(db, [
            { source_id: 'ok', name: 'Ok', provider: 'x', amount: 100, currency: 'HUF', month: '2026-06', message_ref: 'm1' },
            { source_id: 'bad-month', name: 'B', provider: 'x', amount: 100, currency: 'HUF', month: 'June', message_ref: 'm2' },
            { source_id: 'bad-cur', name: 'C', provider: 'x', amount: 5, currency: 'EUR', month: '2026-06', message_ref: 'm3' },
            { source_id: '', name: 'D', provider: 'x', amount: 5, currency: 'HUF', month: '2026-06', message_ref: 'm4' },
        ], { fxUsdHuf: 360, now: NOW });
        expect(r.ingested).toBe(1);
        expect(r.errors.length).toBe(3);
    });
    it('Phase 1 (GAP-09): a converted (non-HUF) invoice line carries fx_source/conversion_method; an already-HUF one does not', () => {
        const db = getDb();
        ingestEmailCosts(db, [
            { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-usd' },
            { source_id: 'anthropic-pro', name: 'Claude Pro', provider: 'anthropic', amount: 8990, currency: 'HUF', month: '2026-06', message_ref: 'gmail-huf' },
        ], { fxUsdHuf: 360, now: NOW });
        const usd = db.prepare("SELECT fx_source, conversion_method FROM cost_line_items WHERE source_id='openai-api'").get();
        expect(usd.fx_source).toBe('manual'); // v0.9 (card 23912ca4): rate source moved off the Render pricing file
        expect(usd.conversion_method).toBe('invoice_date_rate');
        const huf = db.prepare("SELECT fx_source, conversion_method FROM cost_line_items WHERE source_id='anthropic-pro'").get();
        expect(huf.fx_source).toBeNull();
        expect(huf.conversion_method).toBeNull();
    });
    // Card 23912ca4: end-to-end proof at the ingest boundary, not just the pure
    // helper. Before the fix, this USD entry with fxUsdHuf=0 would have INGESTED
    // a cost_line_items row with billed_cost=0 and confidence='actual_invoice' --
    // a fabricated invoice line reading as "confirmed: this cost was zero".
    it('a USD entry with an UNSET (0) rate is REJECTED as unconvertible, never ingested as a fabricated 0', () => {
        const db = getDb();
        const r = ingestEmailCosts(db, [
            { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-zero-fx' },
        ], { fxUsdHuf: 0, now: NOW });
        expect(r.ingested).toBe(0);
        expect(r.errors).toEqual([{ source_id: 'openai-api', reason: "uncconvertible currency 'USD'" }]);
        expect(db.prepare('SELECT COUNT(*) c FROM cost_line_items').get().c).toBe(0);
    });
    it('the same USD entry ingests normally once a real rate is configured', () => {
        const db = getDb();
        const r = ingestEmailCosts(db, [
            { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-real-fx' },
        ], { fxUsdHuf: 360, now: NOW });
        expect(r.ingested).toBe(1);
        expect(db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='openai-api'").get().billed_cost).toBe(3.5 * 360);
    });
    it('stores no raw message ref -- only a hash in source_ref/dedup_key', () => {
        const db = getDb();
        ingestEmailCosts(db, [{ source_id: 's', name: 'S', provider: 'x', amount: 1, currency: 'HUF', month: '2026-06', message_ref: 'SENSITIVE-gmail-id-12345' }], { fxUsdHuf: 360, now: NOW });
        const dump = JSON.stringify(db.prepare('SELECT * FROM cost_line_items').all());
        expect(dump).not.toContain('SENSITIVE-gmail-id-12345');
    });
});
