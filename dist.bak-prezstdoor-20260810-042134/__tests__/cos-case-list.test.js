import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase, transitionCase, listActiveCases, listTodayCases } from '../cos/case-store.js';
import { endOfTodaySec } from '../web/routes/cos.js';
// COS Slice 0 — Mission Control read layer. Proves the "Ügyek" (active) and
// "Ma" (today) queries filter and order correctly.
const T0 = 1_700_000_000;
const HORIZON = T0 + 3600; // "end of today" for the test
describe('listActiveCases ("Ügyek")', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('returns non-terminal, non-archived cases, urgent-first', () => {
        const db = getDb();
        createCase(db, { caseId: 'a', title: 'A', caseType: 'X', priority: 'P2' }, T0);
        createCase(db, { caseId: 'b', title: 'B', caseType: 'X', priority: 'P0' }, T0);
        createCase(db, { caseId: 'done', title: 'D', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'done', seenVersion: 1, newStatus: 'COMPLETED', actor: 'm' }, T0 + 1);
        const list = listActiveCases(db);
        expect(list.map((c) => c.case_id)).toEqual(['b', 'a']); // P0 before P2, 'done' excluded
    });
    it('excludes CANCELLED and ARCHIVED', () => {
        const db = getDb();
        createCase(db, { caseId: 'x', title: 'X', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'x', seenVersion: 1, newStatus: 'CANCELLED', actor: 'm' }, T0 + 1);
        expect(listActiveCases(db)).toEqual([]);
    });
});
describe('listTodayCases ("Ma")', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('includes cases due/follow-up at or before the horizon', () => {
        const db = getDb();
        createCase(db, { caseId: 'due-today', title: 'Due', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'due-today', seenVersion: 1, newStatus: 'READY', actor: 'm', patch: { due_at: HORIZON - 10 } }, T0 + 1);
        createCase(db, { caseId: 'due-tomorrow', title: 'Later', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'due-tomorrow', seenVersion: 1, newStatus: 'READY', actor: 'm', patch: { due_at: HORIZON + 100000 } }, T0 + 1);
        const ids = listTodayCases(db, HORIZON).map((c) => c.case_id);
        expect(ids).toContain('due-today');
        expect(ids).not.toContain('due-tomorrow');
    });
    it('includes attention statuses regardless of dates, excludes plain READY with no date', () => {
        const db = getDb();
        createCase(db, { caseId: 'call', title: 'Call', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'call', seenVersion: 1, newStatus: 'CALL_REQUIRED', actor: 'm' }, T0 + 1);
        createCase(db, { caseId: 'idle', title: 'Idle', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'idle', seenVersion: 1, newStatus: 'READY', actor: 'm' }, T0 + 1); // no date, not attention
        const ids = listTodayCases(db, HORIZON).map((c) => c.case_id);
        expect(ids).toContain('call');
        expect(ids).not.toContain('idle');
    });
    it('excludes terminal cases even if dated in the past', () => {
        const db = getDb();
        createCase(db, { caseId: 'olddone', title: 'Old', caseType: 'X' }, T0);
        transitionCase(db, { caseId: 'olddone', seenVersion: 1, newStatus: 'RECOVERY_REQUIRED', actor: 'm', patch: { due_at: HORIZON - 5 } }, T0 + 1);
        transitionCase(db, { caseId: 'olddone', seenVersion: 2, newStatus: 'COMPLETED', actor: 'm' }, T0 + 2);
        expect(listTodayCases(db, HORIZON).map((c) => c.case_id)).not.toContain('olddone');
    });
});
describe('endOfTodaySec', () => {
    it('returns a horizon later than now and within the next 24h', () => {
        const now = new Date('2026-08-04T14:30:00Z');
        const h = endOfTodaySec(now);
        const nowSec = Math.floor(now.getTime() / 1000);
        expect(h).toBeGreaterThan(nowSec);
        expect(h - nowSec).toBeLessThanOrEqual(86400);
    });
});
