import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase, transitionCase } from '../cos/case-store.js';
// §C DoD: "az auditlog normál UI-ból nem módosítható". The personal_case_events
// table is append-only, enforced by BEFORE UPDATE / BEFORE DELETE triggers — so
// even a direct SQL UPDATE/DELETE (the strongest "normal" write) is rejected. The
// history can only grow.
const NOW = 1_000_000;
describe('audit log immutability (personal_case_events)', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW);
        // a transition appends an audit event
        transitionCase(getDb(), { caseId: 'c1', seenVersion: 1, newStatus: 'TRIAGE', actor: 'm', reason: 'r' }, NOW + 1);
    });
    it('events accumulate on writes', () => {
        const n = getDb().prepare(`SELECT COUNT(*) c FROM personal_case_events WHERE case_id='c1'`).get().c;
        expect(n).toBeGreaterThanOrEqual(1);
    });
    it('a direct UPDATE of an event is rejected by the append-only trigger', () => {
        const db = getDb();
        expect(() => db.prepare(`UPDATE personal_case_events SET reason='TAMPERED' WHERE case_id='c1'`).run())
            .toThrow();
    });
    it('a direct DELETE of an event is rejected by the append-only trigger', () => {
        const db = getDb();
        expect(() => db.prepare(`DELETE FROM personal_case_events WHERE case_id='c1'`).run())
            .toThrow();
    });
    it('the event history survives a tamper attempt intact', () => {
        const db = getDb();
        const before = db.prepare(`SELECT COUNT(*) c FROM personal_case_events`).get().c;
        try {
            db.prepare(`DELETE FROM personal_case_events`).run();
        }
        catch { /* blocked */ }
        const after = db.prepare(`SELECT COUNT(*) c FROM personal_case_events`).get().c;
        expect(after).toBe(before);
    });
});
