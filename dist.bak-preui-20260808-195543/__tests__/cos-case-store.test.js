import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase, getCase, transitionCase, appendCaseEvent, acquireClaim, releaseClaim, CaseConcurrencyError, } from '../cos/case-store.js';
// COS Slice 0 -- domain-command layer. These tests prove the commands enforce
// the spec invariants, not merely that they run: optimistic-concurrency lost
// updates throw (never clobber), create+transition write a matching audit
// event, the event stream's case_version tracks the row, and claims are
// fence-safe.
const T0 = 1_700_000_000;
describe('COS case-store commands', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    function events(caseId) {
        return getDb().prepare(`SELECT event_type, previous_status, new_status, case_version FROM personal_case_events
       WHERE case_id = ? ORDER BY event_id`).all(caseId);
    }
    describe('createCase', () => {
        it('inserts at version 1 and writes a CREATED event atomically', () => {
            const db = getDb();
            const row = createCase(db, { caseId: 'c1', title: 'Kati fogorvos', caseType: 'CALL' }, T0);
            expect(row.version).toBe(1);
            expect(row.status).toBe('NEW');
            const evs = events('c1');
            expect(evs).toHaveLength(1);
            expect(evs[0]).toMatchObject({ event_type: 'CREATED', new_status: 'NEW', case_version: 1 });
        });
        it('honours explicit status/sensitivity/owner', () => {
            const db = getDb();
            const row = createCase(db, {
                caseId: 'c2', title: 'NAV irat', caseType: 'ADMIN',
                status: 'TRIAGE', sensitivity: 'HIGHLY_SENSITIVE', owner: 'marveen',
            }, T0);
            expect(row.status).toBe('TRIAGE');
            expect(row.sensitivity).toBe('HIGHLY_SENSITIVE');
        });
    });
    describe('transitionCase (optimistic concurrency P0.5)', () => {
        it('bumps version, records the event with prev/new status, and applies a patch', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 't', caseType: 'X' }, T0);
            const v = transitionCase(db, {
                caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'marveen',
                reason: 'sent quote request', patch: { waiting_on: 'vendor reply', follow_up_at: T0 + 86400 },
            }, T0 + 10);
            expect(v).toBe(2);
            const row = getCase(db, 'c1');
            expect(row.status).toBe('WAITING_EXTERNAL');
            expect(row.waiting_on).toBe('vendor reply');
            expect(row.follow_up_at).toBe(T0 + 86400);
            const evs = events('c1');
            expect(evs[1]).toMatchObject({
                event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', case_version: 2,
            });
        });
        it('a stale writer throws CaseConcurrencyError and does NOT clobber (no phantom event)', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 't', caseType: 'X' }, T0);
            // Writer A wins with seenVersion 1 -> row now at version 2.
            transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'TRIAGE', actor: 'A' }, T0 + 1);
            // Writer B also saw version 1 -> must lose.
            expect(() => transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'BLOCKED', actor: 'B' }, T0 + 2)).toThrow(CaseConcurrencyError);
            const row = getCase(db, 'c1');
            expect(row.status).toBe('TRIAGE'); // A's write stands
            expect(row.version).toBe(2);
            // The losing transition rolled back -- only CREATED + A's STATUS_CHANGED exist.
            expect(events('c1').map((e) => e.event_type)).toEqual(['CREATED', 'STATUS_CHANGED']);
        });
        it('sets completed_at when transitioning to COMPLETED', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 't', caseType: 'X' }, T0);
            transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'COMPLETED', actor: 'marveen' }, T0 + 5);
            const row = getCase(db, 'c1');
            expect(row.completed_at).toBe(T0 + 5);
        });
        it('throws a plain Error for a nonexistent case', () => {
            const db = getDb();
            expect(() => transitionCase(db, { caseId: 'ghost', seenVersion: 1, newStatus: 'TRIAGE', actor: 'x' }, T0)).toThrow(/does not exist/);
        });
        it('rejects an out-of-set status at the DB CHECK even through the command', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 't', caseType: 'X' }, T0);
            expect(() => transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'DONE', actor: 'x' }, T0)).toThrow(/CHECK constraint/i);
        });
    });
    describe('appendCaseEvent', () => {
        it('JSON-encodes the payload and is append-only (trigger blocks tampering)', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 't', caseType: 'X' }, T0);
            const id = appendCaseEvent(db, {
                caseId: 'c1', caseVersion: 1, actor: 'marveen', eventType: 'NOTE', payload: { k: 'v', n: 3 },
            }, T0 + 1);
            const row = db.prepare(`SELECT payload FROM personal_case_events WHERE event_id = ?`).get(id);
            expect(JSON.parse(row.payload)).toEqual({ k: 'v', n: 3 });
            expect(() => db.prepare(`UPDATE personal_case_events SET reason='x' WHERE event_id=?`).run(id)).toThrow(/append-only/i);
        });
    });
    describe('claims (P0.2 fence / P0.3 single-holder)', () => {
        it('first acquire succeeds at fence 1; a live claim cannot be stolen', () => {
            const db = getDb();
            const a = acquireClaim(db, { claimKey: 'c1', ownerRunId: 'A', ttlSeconds: 100 }, 1000);
            expect(a).toMatchObject({ acquired: true, ownerRunId: 'A', fence: 1 });
            const b = acquireClaim(db, { claimKey: 'c1', ownerRunId: 'B', ttlSeconds: 100 }, 1050); // before expiry
            expect(b).toMatchObject({ acquired: false, ownerRunId: 'A', fence: 1 });
        });
        it('an expired claim is taken over and the fence increments', () => {
            const db = getDb();
            acquireClaim(db, { claimKey: 'c1', ownerRunId: 'A', ttlSeconds: 100 }, 1000); // expires 1100
            const b = acquireClaim(db, { claimKey: 'c1', ownerRunId: 'B', ttlSeconds: 100 }, 1200);
            expect(b).toMatchObject({ acquired: true, ownerRunId: 'B', fence: 2 });
        });
        it('release is fence-safe: a superseded worker cannot release the current holder', () => {
            const db = getDb();
            acquireClaim(db, { claimKey: 'c1', ownerRunId: 'A', ttlSeconds: 100 }, 1000);
            acquireClaim(db, { claimKey: 'c1', ownerRunId: 'B', ttlSeconds: 100 }, 1200); // B holds at fence 2
            expect(releaseClaim(db, { claimKey: 'c1', ownerRunId: 'A', fence: 1 })).toBe(false); // stale A cannot
            expect(releaseClaim(db, { claimKey: 'c1', ownerRunId: 'B', fence: 2 })).toBe(true); // B can
            expect(db.prepare(`SELECT COUNT(*) c FROM case_claims WHERE claim_key='c1'`).get()).toMatchObject({ c: 0 });
        });
    });
});
