import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { CASE_STATUSES, CASE_SENSITIVITIES } from '../cos/schema.js';
// COS Slice 0 -- Personal Case Engine core schema. These tests prove the
// invariants the spec (v4.2.1) calls P0.2/P0.3/P0.5/P0.6, not just that the
// tables were created:
//   - personal_cases.version drives optimistic concurrency (P0.5)
//   - personal_case_events is append-only BY THE DB, not by convention
//   - case_claims fencing/UNIQUE gives an atomic single-holder claim (P0.2/P0.3)
//   - the status/sensitivity CHECK constraints actually reject bad values
// initDatabase(':memory:') runs the full initDatabase(), so this also proves
// initCosSchema is wired into the real init path (not just importable).
function nowSec() {
    // Deterministic-enough clock for row timestamps; the tests never assert on
    // wall-clock, only on relative ordering they set explicitly.
    return 1_700_000_000;
}
describe('COS Slice 0 schema', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    describe('table wiring (initCosSchema runs inside initDatabase)', () => {
        it('creates personal_cases, personal_case_events, case_claims', () => {
            const db = getDb();
            const names = db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
          ('personal_cases','personal_case_events','case_claims')`)
                .all()
                .map((r) => r.name)
                .sort();
            expect(names).toEqual(['case_claims', 'personal_case_events', 'personal_cases']);
        });
        it('is idempotent -- a second initDatabase does not throw', () => {
            expect(() => initDatabase(':memory:')).not.toThrow();
        });
    });
    function insertCase(db, over = {}) {
        const caseId = over.case_id ?? 'case-1';
        db.prepare(`INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, created_at, updated_at)
       VALUES (@case_id, @title, @case_type, @status, @sensitivity, @created_at, @updated_at)`).run({
            case_id: caseId,
            title: 'Ürömi ház tetőjavítás',
            case_type: 'HOME_REPAIR',
            status: 'NEW',
            sensitivity: 'PERSONAL',
            created_at: nowSec(),
            updated_at: nowSec(),
            ...over,
        });
        return caseId;
    }
    describe('personal_cases', () => {
        it('defaults version to 1 and status to a valid state', () => {
            const db = getDb();
            insertCase(db);
            const row = db.prepare(`SELECT version, status, scope, priority, owner FROM personal_cases WHERE case_id='case-1'`).get();
            expect(row.version).toBe(1);
            expect(CASE_STATUSES).toContain(row.status);
            expect(row.owner).toBe('marveen');
        });
        it('optimistic-concurrency UPDATE bumps version only when the seen version matches (P0.5)', () => {
            const db = getDb();
            insertCase(db);
            // Simulate two readers who both saw version 1.
            const bump = db.prepare(`UPDATE personal_cases SET status=@status, version=version+1, updated_at=@t
         WHERE case_id=@id AND version=@seen`);
            const first = bump.run({ id: 'case-1', status: 'TRIAGE', t: nowSec() + 1, seen: 1 });
            expect(first.changes).toBe(1); // first writer wins
            const second = bump.run({ id: 'case-1', status: 'BLOCKED', t: nowSec() + 2, seen: 1 });
            expect(second.changes).toBe(0); // stale writer's update is a no-op, not a clobber
            const row = db.prepare(`SELECT version, status FROM personal_cases WHERE case_id='case-1'`).get();
            expect(row.version).toBe(2);
            expect(row.status).toBe('TRIAGE');
        });
        it('rejects an out-of-set status (CHECK constraint, not app-code)', () => {
            const db = getDb();
            expect(() => insertCase(db, { case_id: 'bad-status', status: 'DONE' })).toThrow(/CHECK constraint/i);
        });
        it('rejects an out-of-set sensitivity class (P0.6)', () => {
            const db = getDb();
            expect(() => insertCase(db, { case_id: 'bad-sens', sensitivity: 'TOP_SECRET' })).toThrow(/CHECK constraint/i);
            // and every declared class is accepted
            for (const s of CASE_SENSITIVITIES) {
                expect(() => insertCase(db, { case_id: `sens-${s}`, sensitivity: s })).not.toThrow();
            }
        });
    });
    describe('personal_case_events (append-only)', () => {
        function addEvent(db) {
            insertCase(db);
            db.prepare(`INSERT INTO personal_case_events (case_id, case_version, actor, event_type, new_status, created_at)
         VALUES ('case-1', 1, 'marveen', 'CREATED', 'NEW', @t)`).run({ t: nowSec() });
            return db.prepare(`SELECT event_id FROM personal_case_events WHERE case_id='case-1'`).get();
        }
        it('accepts inserts', () => {
            const db = getDb();
            const ev = addEvent(db);
            expect(ev.event_id).toBeGreaterThan(0);
        });
        it('blocks UPDATE via trigger', () => {
            const db = getDb();
            const ev = addEvent(db);
            expect(() => db.prepare(`UPDATE personal_case_events SET reason='tampered' WHERE event_id=?`).run(ev.event_id)).toThrow(/append-only/i);
        });
        it('blocks DELETE via trigger', () => {
            const db = getDb();
            const ev = addEvent(db);
            expect(() => db.prepare(`DELETE FROM personal_case_events WHERE event_id=?`).run(ev.event_id)).toThrow(/append-only/i);
        });
    });
    describe('case_claims (P0.2 fencing / P0.3 UNIQUE / atomic upsert)', () => {
        // The one atomic acquire/takeover statement from docs/cos-slice0-schema.sql.
        // A worker "wins" iff its owner_run_id ends up on the row.
        const CLAIM_UPSERT = `
      INSERT INTO case_claims(claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
      VALUES (@key, @owner, 1, @now, @expires)
      ON CONFLICT(claim_key) DO UPDATE SET
        owner_run_id = excluded.owner_run_id,
        claim_fence  = case_claims.claim_fence + 1,
        claimed_at   = excluded.claimed_at,
        claim_expires_at = excluded.claim_expires_at
      WHERE case_claims.claim_expires_at < @now
    `;
        function claim(db, owner, now, ttl = 100) {
            db.prepare(CLAIM_UPSERT).run({ key: 'case-1', owner, now, expires: now + ttl });
            return db.prepare(`SELECT owner_run_id, claim_fence FROM case_claims WHERE claim_key='case-1'`).get();
        }
        it('first claimant acquires at fence 1', () => {
            const db = getDb();
            const row = claim(db, 'run-A', 1000);
            expect(row.owner_run_id).toBe('run-A');
            expect(row.claim_fence).toBe(1);
        });
        it('a second worker CANNOT steal a live (unexpired) claim', () => {
            const db = getDb();
            claim(db, 'run-A', 1000, 100); // expires at 1100
            const row = claim(db, 'run-B', 1050); // still before 1100 -> WHERE fails
            expect(row.owner_run_id).toBe('run-A');
            expect(row.claim_fence).toBe(1);
        });
        it('an expired claim can be taken over and the fence increments (P0.2)', () => {
            const db = getDb();
            claim(db, 'run-A', 1000, 100); // expires at 1100
            const row = claim(db, 'run-B', 1200); // 1200 > 1100 -> takeover
            expect(row.owner_run_id).toBe('run-B');
            expect(row.claim_fence).toBe(2); // monotonic fence proves the takeover
        });
        it('UNIQUE(claim_key) prevents a duplicate row even on a raw INSERT (P0.3)', () => {
            const db = getDb();
            claim(db, 'run-A', 1000);
            expect(() => db.prepare(`INSERT INTO case_claims(claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
           VALUES ('case-1','run-X',1,1,2)`).run()).toThrow(/UNIQUE constraint/i);
        });
    });
});
