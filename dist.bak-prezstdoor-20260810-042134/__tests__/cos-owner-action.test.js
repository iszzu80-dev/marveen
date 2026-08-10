/**
 * Owner-action endpoint tests (card 9193eedd + follow-up).
 *
 * Acceptance gates:
 *   (h) event-not-state: the endpoint inserts an event but does NOT change
 *       the case row or case_progression_state before the engine runs.
 *   (i) idempotency: same idempotencyKey → duplicate, one event row.
 *   (j) question staleness: sourceReference mismatch vs latest question run → 409;
 *       matching sourceReference is accepted even when case_version has moved.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { tryHandleCos } from '../web/routes/cos.js';
// ── fake request/response harness (same pattern as apg-ui-routes.test.ts) ──
function fakeCtx(path, method = 'GET') {
    const out = { status: 0, body: null };
    const res = {
        writeHead(status) { out.status = status; return res; },
        end(chunk) {
            if (chunk) {
                try {
                    out.body = JSON.parse(chunk);
                }
                catch {
                    out.body = chunk;
                }
            }
        },
    };
    const url = new URL(`http://localhost:3420${path}`);
    return { ctx: { req: {}, res, path: url.pathname, method, url }, out };
}
function fakeCtxWithBody(path, method, body) {
    const { ctx, out } = fakeCtx(path, method);
    ctx.req.on = ((event, cb) => {
        if (event === 'data')
            cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end')
            cb();
        return ctx.req;
    });
    return { ctx, out };
}
// ── Test seeds ──
const PRI_CASE = 'PRI-OWNER-TEST-001';
const ZST_CASE = 'ZST-OWNER-TEST-001';
const PROG_RUN_ID = 'run-test-aaaaaaaaaaa1';
function seedPersonalCase(db) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT OR IGNORE INTO personal_cases
    (case_id, title, case_type, status, priority, sensitivity, source_system, owner, created_at, updated_at)
    VALUES (?, 'Test case', 'OTHER', 'READY', 'P2', 'PERSONAL', 'test', 'istvan', ?, ?)`).run(PRI_CASE, now, now);
}
function seedZstCase(db) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT OR IGNORE INTO zst_cases
    (case_id, title, case_type, status, priority, sensitivity, workspace, scope, source_system, created_at, updated_at)
    VALUES (?, 'ZST Test case', 'OTHER', 'READY', 'P2', 'ZST_INTERNAL', 'OPERATIONS', 'ZST_OPERATIONS_CONFIRMED', 'test', ?, ?)`).run(ZST_CASE, now, now);
}
function seedProgressionState(db, domain, caseId, caseVersion) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT OR REPLACE INTO case_progression_state
    (domain, case_id, semantic_completion_status, progression_enabled, progression_mode,
     plan_version, case_version, goal_version, created_at, updated_at)
    VALUES (?, ?, 'IN_PROGRESS', 1, 'shadow', 3, ?, 0, ?, ?)`).run(domain, caseId, caseVersion, now, now);
}
function seedProgressionRun(db, domain, caseId, runId, decision, startedAt) {
    const t = startedAt ?? Math.floor(Date.now() / 1000);
    db.prepare(`INSERT OR IGNORE INTO case_progression_runs
    (progression_run_id, domain, case_id, trigger_type, decision, reason, status, started_at, completed_at,
     case_version_before, case_version_after, plan_version_before, plan_version_after)
    VALUES (?, ?, ?, 'MANUAL', ?, 'test reason', 'COMPLETED', ?, ?, 1, 2, 3, 3)`).run(runId, domain, caseId, decision, t, t);
}
describe('Owner-action endpoint (card 9193eedd)', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        const db = getDb();
        seedPersonalCase(db);
        seedZstCase(db);
        seedProgressionState(db, 'personal', PRI_CASE, 3);
        seedProgressionRun(db, 'personal', PRI_CASE, PROG_RUN_ID, 'REQUEST_DECISION');
        seedProgressionState(db, 'zst', ZST_CASE, 1);
        seedProgressionRun(db, 'zst', ZST_CASE, 'run-zst-aaaaaaaaaaa1', 'WAIT_EXTERNAL');
    });
    // ── Gate (h): event-not-state ──
    describe('event-not-state (gate h)', () => {
        it('inserts an event row but does NOT change the case row', async () => {
            const db = getDb();
            const caseBefore = db.prepare('SELECT status FROM personal_cases WHERE case_id = ?').get(PRI_CASE);
            const eventsBefore = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-h-1',
                decision: 'REQUEST_DECISION', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            expect(out.body.ok).toBe(true);
            // Event was inserted.
            const eventsAfter = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            expect(eventsAfter.c).toBe(eventsBefore.c + 1);
            // Case row status is unchanged (event-not-state: only events, cases untouched).
            const caseAfter = db.prepare('SELECT status FROM personal_cases WHERE case_id = ?').get(PRI_CASE);
            expect(caseAfter.status).toBe(caseBefore.status);
        });
        it('engine processes the event (progressionRan) and progression state updates', async () => {
            const db = getDb();
            const stateBefore = db.prepare(`SELECT case_version, plan_version
         FROM case_progression_state WHERE domain = ? AND case_id = ?`).get('personal', PRI_CASE);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'NO',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-h-2',
                decision: 'REQUEST_DECISION', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            expect(out.body.ok).toBe(true);
            expect(out.body.eventId).toBeGreaterThan(0);
            expect(out.body.progressionRan).toBe(true);
            const stateAfter = db.prepare(`SELECT case_version FROM case_progression_state WHERE domain = ? AND case_id = ?`).get('personal', PRI_CASE);
            expect(stateAfter.case_version).toBeGreaterThan(stateBefore.case_version);
            const caseAfter = db.prepare('SELECT status FROM personal_cases WHERE case_id = ?').get(PRI_CASE);
            expect(caseAfter.status).toBe('READY');
        });
        it('event row has correct actor, source_system, event_type', async () => {
            const db = getDb();
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-h-3',
                decision: 'REQUEST_DECISION', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            const event = db.prepare(`SELECT actor, source_system, event_type, source_reference, payload
         FROM personal_case_events WHERE case_id = ? AND event_type = 'OWNER_DECISION'
         ORDER BY event_id DESC LIMIT 1`).get(PRI_CASE);
            expect(event.actor).toBe('istvan');
            expect(event.source_system).toBe('mission_control');
            expect(event.event_type).toBe('OWNER_DECISION');
            expect(event.source_reference).toBe(PROG_RUN_ID);
            const p = JSON.parse(event.payload);
            expect(p.choice).toBe('YES');
            expect(p.idempotency_key).toBe('idem-h-3');
        });
    });
    // ── Gate (i): idempotency ──
    describe('idempotency (gate i)', () => {
        it('same idempotencyKey twice returns duplicate:true, only one event', async () => {
            const db = getDb();
            const eventsBefore = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            const body = {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-i-dup',
                decision: 'REQUEST_DECISION', nextBestAction: null,
            };
            const { ctx: ctx1, out: out1 } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', body);
            await tryHandleCos(ctx1);
            expect(out1.status).toBe(200);
            const { ctx: ctx2, out: out2 } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', body);
            await tryHandleCos(ctx2);
            expect(out2.status).toBe(200);
            expect(out2.body.duplicate).toBe(true);
            const eventsAfter = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            expect(eventsAfter.c).toBe(eventsBefore.c + 1);
        });
    });
    // ── Gate (j): question staleness (follow-up fix #2 — content-based) ──
    describe('question staleness (gate j)', () => {
        it('accepts answer after 2+ heartbeats on unchanged question', async () => {
            const db = getDb();
            // Simulate heartbeats: write ADDITIONAL REQUEST_DECISION runs (same
            // decision, same case), each with a different progression_run_id.
            // The question content (decision + next_best_action) is unchanged.
            const baseTime = Math.floor(Date.now() / 1000);
            seedProgressionRun(db, 'personal', PRI_CASE, 'run-hb-1', 'REQUEST_DECISION', baseTime + 60);
            seedProgressionRun(db, 'personal', PRI_CASE, 'run-hb-2', 'REQUEST_DECISION', baseTime + 120);
            // Answer references the ORIGINAL run ID but sends the correct content.
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, // old run — content is still current
                caseVersion: 3,
                idempotencyKey: 'idem-j-heartbeat',
                decision: 'REQUEST_DECISION',
                nextBestAction: null,
            });
            await tryHandleCos(ctx);
            // Must be accepted: same decision + same NBA → question unchanged.
            expect(out.status).toBe(200);
            expect(out.body.ok).toBe(true);
            expect(out.body.eventId).toBeGreaterThan(0);
        });
        it('409 when decision type changed (genuinely new question)', async () => {
            const db = getDb();
            // Seed a NEWER run with a DIFFERENT decision type. The engine genuinely
            // moved on — this is not just a heartbeat.
            const newRunId = 'run-newer-question-zzz';
            const baseTime = Math.floor(Date.now() / 1000);
            seedProgressionRun(db, 'personal', PRI_CASE, newRunId, 'ASK_INFORMATION', baseTime + 60);
            const eventsBefore = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, // old question — decision says REQUEST_DECISION
                caseVersion: 3,
                idempotencyKey: 'idem-j-different-decision',
                decision: 'REQUEST_DECISION',
                nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(409);
            expect(out.body.error).toBe('question_stale');
            expect(out.body.currentDecision).toBe('ASK_INFORMATION');
            // No event was inserted.
            const eventsAfter = db.prepare('SELECT count(*) c FROM personal_case_events WHERE case_id = ?').get(PRI_CASE);
            expect(eventsAfter.c).toBe(eventsBefore.c);
        });
        it('409 when next_best_action changed (different step)', async () => {
            const db = getDb();
            // Set the current NBA to something, then write a heartbeat run that
            // carries the same decision type. The answer's NBA doesn't match.
            const baseTime = Math.floor(Date.now() / 1000);
            const newRunId = 'run-new-step-zzz';
            seedProgressionRun(db, 'personal', PRI_CASE, newRunId, 'REQUEST_DECISION', baseTime + 60);
            db.prepare(`UPDATE case_progression_state
        SET next_best_action_json = ?
        WHERE domain = 'personal' AND case_id = ?`).run('{"action":"send_email","description":"Küldj emailt a partnernek"}', PRI_CASE);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID,
                caseVersion: 3,
                idempotencyKey: 'idem-j-different-nba',
                decision: 'REQUEST_DECISION',
                nextBestAction: '{"action":"draft_report","description":"Írd meg a jelentést"}',
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(409);
            expect(out.body.error).toBe('question_stale');
        });
        it('404 when no question-asking run exists at all', async () => {
            const db = getDb();
            // Delete all question runs so only CONTINUE_AUTONOMOUSLY remains.
            db.prepare('DELETE FROM case_progression_runs WHERE case_id = ?').run(PRI_CASE);
            const baseTime = Math.floor(Date.now() / 1000);
            seedProgressionRun(db, 'personal', PRI_CASE, 'run-auto-only', 'CONTINUE_AUTONOMOUSLY', baseTime);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID,
                caseVersion: 3,
                idempotencyKey: 'idem-j-no-q',
                decision: 'REQUEST_DECISION',
                nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(404);
            expect(out.body.error).toBe('no active question for this case');
        });
    });
    // ── Validation ──
    describe('validation', () => {
        it('rejects invalid eventType', async () => {
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'NOT_A_VALID_TYPE', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-v-1',
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(400);
        });
        it('rejects missing idempotencyKey', async () => {
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(400);
        });
        it('rejects invalid domain', async () => {
            const { ctx, out } = fakeCtxWithBody('/api/cos/cases/unknown/XYZ/owner-action', 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 1,
                idempotencyKey: 'idem-v-2',
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(400);
        });
        it('rejects non-existent case (404 — no question run)', async () => {
            const { ctx, out } = fakeCtxWithBody('/api/cos/cases/personal/NONEXISTENT/owner-action', 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 1,
                idempotencyKey: 'idem-v-3',
                decision: 'REQUEST_DECISION', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(404);
        });
    });
    // ── OWNER_CONFIRMATION for RECOVERY_REQUIRED ──
    describe('OWNER_CONFIRMATION event type', () => {
        it('accepts OWNER_CONFIRMATION for RECOVERY_REQUIRED decisions', async () => {
            const db = getDb();
            const baseTime = Math.floor(Date.now() / 1000);
            const runId = 'run-rec-aaaaaaaaaaa1';
            // Seed with later timestamp so it's the latest question run.
            seedProgressionRun(db, 'personal', PRI_CASE, runId, 'RECOVERY_REQUIRED', baseTime + 60);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_CONFIRMATION', choice: 'DONE',
                sourceReference: runId, caseVersion: 3,
                idempotencyKey: 'idem-confirm-1',
                decision: 'RECOVERY_REQUIRED', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            const event = db.prepare(`SELECT event_type, payload FROM personal_case_events
         WHERE case_id = ? AND event_type = 'OWNER_CONFIRMATION'
         ORDER BY event_id DESC LIMIT 1`).get(PRI_CASE);
            expect(event).toBeTruthy();
        });
    });
    // ── OWNER_INFORMATION for ASK_INFORMATION ──
    describe('OWNER_INFORMATION event type', () => {
        it('accepts OWNER_INFORMATION with text for ASK_INFORMATION decisions', async () => {
            const db = getDb();
            const baseTime = Math.floor(Date.now() / 1000);
            const runId = 'run-ask-aaaaaaaaaaa1';
            seedProgressionRun(db, 'personal', PRI_CASE, runId, 'ASK_INFORMATION', baseTime + 60);
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_INFORMATION', text: 'A válaszom: igen',
                sourceReference: runId, caseVersion: 3,
                idempotencyKey: 'idem-info-1',
                decision: 'ASK_INFORMATION', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            const event = db.prepare(`SELECT event_type, reason, payload FROM personal_case_events
         WHERE case_id = ? AND event_type = 'OWNER_INFORMATION'
         ORDER BY event_id DESC LIMIT 1`).get(PRI_CASE);
            expect(event).toBeTruthy();
            const p = JSON.parse(event.payload);
            expect(p.text).toBe('A válaszom: igen');
        });
    });
    // ── ZST namespace ──
    describe('ZST namespace', () => {
        it('writes to zst_case_events when domain is zst', async () => {
            const db = getDb();
            const zstRunId = 'run-zst-aaaaaaaaaaa1';
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/zst/${ZST_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_INFORMATION', text: 'Megjött',
                sourceReference: zstRunId, caseVersion: 1,
                idempotencyKey: 'idem-zst-1',
                decision: 'WAIT_EXTERNAL', nextBestAction: null,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            const event = db.prepare(`SELECT event_type, actor FROM zst_case_events WHERE case_id = ?`).get(ZST_CASE);
            expect(event).toBeTruthy();
            expect(event.actor).toBe('istvan');
        });
    });
    // ── externalEffectAck in payload ──
    describe('externalEffectAck', () => {
        it('stores external_effect_ack in payload when provided', async () => {
            const db = getDb();
            const { ctx, out } = fakeCtxWithBody(`/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
                eventType: 'OWNER_DECISION', choice: 'YES',
                sourceReference: PROG_RUN_ID, caseVersion: 3,
                idempotencyKey: 'idem-extack-1',
                decision: 'REQUEST_DECISION', nextBestAction: null,
                externalEffectAck: true,
            });
            await tryHandleCos(ctx);
            expect(out.status).toBe(200);
            const event = db.prepare(`SELECT payload FROM personal_case_events
         WHERE case_id = ? AND json_extract(payload, '$.idempotency_key') = 'idem-extack-1'`).get(PRI_CASE);
            expect(event).toBeTruthy();
            const p = JSON.parse(event.payload);
            expect(p.external_effect_ack).toBe(true);
        });
    });
});
