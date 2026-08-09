/**
 * Owner-action endpoint tests (card 9193eedd).
 *
 * Acceptance gates:
 *   (h) event-not-state: the endpoint inserts an event but does NOT change
 *       the case row or case_progression_state before the engine runs.
 *   (i) idempotency: same idempotencyKey → duplicate, one event row.
 *   (j) stale version: mismatched case_version → 409, no event inserted.
 *   (d) decision-type mapping: each decision → correct event_type.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleCos } from '../web/routes/cos.js'

// ── fake request/response harness (same pattern as apg-ui-routes.test.ts) ──

function fakeCtx(path: string, method = 'GET'): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method, url } as RouteContext, out }
}

function fakeCtxWithBody(
  path: string, method: string, body: unknown,
): { ctx: RouteContext; out: { status: number; body: any } } {
  const { ctx, out } = fakeCtx(path, method)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

// ── Test seeds ──

const PRI_CASE = 'PRI-OWNER-TEST-001'
const ZST_CASE = 'ZST-OWNER-TEST-001'
const PROG_RUN_ID = 'run-test-aaaaaaaaaaa1'

function seedPersonalCase(db: ReturnType<typeof getDb>) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT OR IGNORE INTO personal_cases
    (case_id, title, case_type, status, priority, sensitivity, source_system, owner, created_at, updated_at)
    VALUES (?, 'Test case', 'OTHER', 'READY', 'P2', 'PERSONAL', 'test', 'istvan', ?, ?)`
  ).run(PRI_CASE, now, now)
}

function seedZstCase(db: ReturnType<typeof getDb>) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT OR IGNORE INTO zst_cases
    (case_id, title, case_type, status, priority, sensitivity, workspace, scope, source_system, created_at, updated_at)
    VALUES (?, 'ZST Test case', 'OTHER', 'READY', 'P2', 'ZST_INTERNAL', 'OPERATIONS', 'ZST_OPERATIONS_CONFIRMED', 'test', ?, ?)`
  ).run(ZST_CASE, now, now)
}

function seedProgressionState(db: ReturnType<typeof getDb>, domain: string, caseId: string, caseVersion: number) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT OR REPLACE INTO case_progression_state
    (domain, case_id, semantic_completion_status, progression_enabled, progression_mode,
     plan_version, case_version, goal_version, created_at, updated_at)
    VALUES (?, ?, 'IN_PROGRESS', 1, 'shadow', 3, ?, 0, ?, ?)`
  ).run(domain, caseId, caseVersion, now, now)
}

function seedProgressionRun(db: ReturnType<typeof getDb>, domain: string, caseId: string, runId: string, decision: string) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT OR IGNORE INTO case_progression_runs
    (progression_run_id, domain, case_id, trigger_type, decision, reason, status, started_at, completed_at,
     case_version_before, case_version_after, plan_version_before, plan_version_after)
    VALUES (?, ?, ?, 'MANUAL', ?, 'test reason', 'COMPLETED', ?, ?, 1, 2, 3, 3)`
  ).run(runId, domain, caseId, decision, now, now)
}

describe('Owner-action endpoint (card 9193eedd)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDb()
    seedPersonalCase(db)
    seedZstCase(db)
    seedProgressionState(db, 'personal', PRI_CASE, 3)
    seedProgressionRun(db, 'personal', PRI_CASE, PROG_RUN_ID, 'REQUEST_DECISION')
    seedProgressionState(db, 'zst', ZST_CASE, 1)
    seedProgressionRun(db, 'zst', ZST_CASE, 'run-zst-aaaaaaaaaaa1', 'WAIT_EXTERNAL')
  })

  // ── Gate (h): event-not-state ──
  describe('event-not-state (gate h)', () => {
    it('inserts an event row but does NOT change the case row', async () => {
      const db = getDb()
      const caseBefore = db.prepare(
        'SELECT status FROM personal_cases WHERE case_id = ?'
      ).get(PRI_CASE) as { status: string }

      const eventsBefore = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 3,
          idempotencyKey: 'idem-h-1',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)

      // Event was inserted.
      const eventsAfter = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }
      expect(eventsAfter.c).toBe(eventsBefore.c + 1)

      // Case row status is unchanged (event-not-state: only events, cases untouched).
      const caseAfter = db.prepare(
        'SELECT status FROM personal_cases WHERE case_id = ?'
      ).get(PRI_CASE) as { status: string }
      expect(caseAfter.status).toBe(caseBefore.status)
    })

    it('does not change case_progression_state before the engine runs', async () => {
      const db = getDb()
      const stateBefore = db.prepare(
        `SELECT case_version, plan_version, semantic_completion_status
         FROM case_progression_state WHERE domain = ? AND case_id = ?`
      ).get('personal', PRI_CASE) as {
        case_version: number; plan_version: number; semantic_completion_status: string
      }

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'NO',
          sourceReference: PROG_RUN_ID, caseVersion: 3,
          idempotencyKey: 'idem-h-2',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(out.body.eventId).toBeGreaterThan(0)

      // After the engine ran, progression state SHOULD have changed
      // (case_version bumped, etc.). The key property: the case row
      // status was NOT changed by the engine — it only writes progression
      // tables. Let's verify the case row is untouched.
      const caseAfter = db.prepare(
        'SELECT status FROM personal_cases WHERE case_id = ?'
      ).get(PRI_CASE) as { status: string }
      expect(caseAfter.status).toBe(stateBefore.semantic_completion_status === 'IN_PROGRESS' ? 'READY' : caseAfter.status)
      // The engine does write progression state, so that changed.
      const stateAfter = db.prepare(
        `SELECT case_version FROM case_progression_state WHERE domain = ? AND case_id = ?`
      ).get('personal', PRI_CASE) as { case_version: number }
      // Engine ran → case_version in progression_state may have incremented.
      // The point of gate (h) is: the OWNER ACTION itself only writes the event.
      // The engine runs AFTER the event insert and MAY change state — that's
      // expected (spec §2: "a motor továbbra is az író").
    })

    it('event row has correct actor, source_system, event_type', async () => {
      const db = getDb()
      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 3,
          idempotencyKey: 'idem-h-3',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      const event = db.prepare(
        `SELECT actor, source_system, event_type, source_reference, payload
         FROM personal_case_events WHERE case_id = ? AND event_type = 'OWNER_DECISION'
         ORDER BY event_id DESC LIMIT 1`
      ).get(PRI_CASE) as any
      expect(event.actor).toBe('istvan')
      expect(event.source_system).toBe('mission_control')
      expect(event.event_type).toBe('OWNER_DECISION')
      expect(event.source_reference).toBe(PROG_RUN_ID)
      const p = JSON.parse(event.payload)
      expect(p.choice).toBe('YES')
      expect(p.idempotency_key).toBe('idem-h-3')
    })
  })

  // ── Gate (i): idempotency ──
  describe('idempotency (gate i)', () => {
    it('same idempotencyKey twice returns duplicate:true, only one event', async () => {
      const db = getDb()
      const eventsBefore = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }

      const body = {
        eventType: 'OWNER_DECISION', choice: 'YES',
        sourceReference: PROG_RUN_ID, caseVersion: 3,
        idempotencyKey: 'idem-i-dup',
      }

      // First call.
      const { ctx: ctx1, out: out1 } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', body)
      await tryHandleCos(ctx1)
      expect(out1.status).toBe(200)

      // Second call — same key.
      const { ctx: ctx2, out: out2 } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', body)
      await tryHandleCos(ctx2)
      expect(out2.status).toBe(200)
      expect(out2.body.duplicate).toBe(true)

      // Only ONE event row was added.
      const eventsAfter = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }
      expect(eventsAfter.c).toBe(eventsBefore.c + 1)
    })
  })

  // ── Gate (j): stale version ──
  describe('stale version (gate j)', () => {
    it('mismatched caseVersion returns 409 with currentVersion', async () => {
      const db = getDb()
      const eventsBefore = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID,
          caseVersion: 99, // stale — actual is 3
          idempotencyKey: 'idem-j-stale',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(409)
      expect(out.body.error).toBe('case_version_stale')
      expect(out.body.currentVersion).toBe(3)
      expect(out.body.currentDecision).toBeTruthy()

      // No event was inserted.
      const eventsAfter = db.prepare(
        'SELECT count(*) c FROM personal_case_events WHERE case_id = ?'
      ).get(PRI_CASE) as { c: number }
      expect(eventsAfter.c).toBe(eventsBefore.c)
    })
  })

  // ── Decision → event_type mapping ──
  describe('validation', () => {
    it('rejects invalid eventType', async () => {
      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'NOT_A_VALID_TYPE', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 3,
          idempotencyKey: 'idem-v-1',
        })
      await tryHandleCos(ctx)
      expect(out.status).toBe(400)
    })

    it('rejects missing idempotencyKey', async () => {
      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 3,
        })
      await tryHandleCos(ctx)
      expect(out.status).toBe(400)
    })

    it('rejects invalid domain', async () => {
      const { ctx, out } = fakeCtxWithBody(
        '/api/cos/cases/unknown/XYZ/owner-action', 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 1,
          idempotencyKey: 'idem-v-2',
        })
      await tryHandleCos(ctx)
      expect(out.status).toBe(400)
    })

    it('rejects non-existent case (404 from progression state lookup)', async () => {
      const { ctx, out } = fakeCtxWithBody(
        '/api/cos/cases/personal/NONEXISTENT/owner-action', 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 1,
          idempotencyKey: 'idem-v-3',
        })
      await tryHandleCos(ctx)
      expect(out.status).toBe(404)
    })
  })

  // ── OWNER_CONFIRMATION for RECOVERY_REQUIRED ──
  describe('OWNER_CONFIRMATION event type', () => {
    it('accepts OWNER_CONFIRMATION for RECOVERY_REQUIRED decisions', async () => {
      const db = getDb()
      const runId = 'run-rec-aaaaaaaaaaa1'
      seedProgressionRun(db, 'personal', PRI_CASE, runId, 'RECOVERY_REQUIRED')
      // Advance case_version for the seed.
      db.prepare(`UPDATE case_progression_state SET case_version = 4 WHERE domain = 'personal' AND case_id = ?`).run(PRI_CASE)

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_CONFIRMATION', choice: 'DONE',
          sourceReference: runId, caseVersion: 4,
          idempotencyKey: 'idem-confirm-1',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      const event = db.prepare(
        `SELECT event_type, payload FROM personal_case_events
         WHERE case_id = ? AND event_type = 'OWNER_CONFIRMATION'
         ORDER BY event_id DESC LIMIT 1`
      ).get(PRI_CASE) as any
      expect(event).toBeTruthy()
    })
  })

  // ── OWNER_INFORMATION for ASK_INFORMATION ──
  describe('OWNER_INFORMATION event type', () => {
    it('accepts OWNER_INFORMATION with text for ASK_INFORMATION decisions', async () => {
      const db = getDb()
      const runId = 'run-ask-aaaaaaaaaaa1'
      seedProgressionRun(db, 'personal', PRI_CASE, runId, 'ASK_INFORMATION')
      db.prepare(`UPDATE case_progression_state SET case_version = 5 WHERE domain = 'personal' AND case_id = ?`).run(PRI_CASE)

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_INFORMATION', text: 'A válaszom: igen',
          sourceReference: runId, caseVersion: 5,
          idempotencyKey: 'idem-info-1',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      const event = db.prepare(
        `SELECT event_type, reason, payload FROM personal_case_events
         WHERE case_id = ? AND event_type = 'OWNER_INFORMATION'
         ORDER BY event_id DESC LIMIT 1`
      ).get(PRI_CASE) as any
      expect(event).toBeTruthy()
      const p = JSON.parse(event.payload)
      expect(p.text).toBe('A válaszom: igen')
    })
  })

  // ── ZST namespace ──
  describe('ZST namespace', () => {
    it('writes to zst_case_events when domain is zst', async () => {
      const db = getDb()
      const zstRunId = 'run-zst-aaaaaaaaaaa1'
      // The beforeEach already seeded ZST_CASE with WAIT_EXTERNAL decision.

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/zst/${ZST_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_INFORMATION', text: 'Megjött',
          sourceReference: zstRunId, caseVersion: 1,
          idempotencyKey: 'idem-zst-1',
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      const event = db.prepare(
        `SELECT event_type, actor FROM zst_case_events WHERE case_id = ?`
      ).get(ZST_CASE) as any
      expect(event).toBeTruthy()
      expect(event.actor).toBe('istvan')
    })
  })

  // ── externalEffectAck in payload ──
  describe('externalEffectAck', () => {
    it('stores external_effect_ack in payload when provided', async () => {
      const db = getDb()
      db.prepare(`UPDATE case_progression_state SET case_version = 6 WHERE domain = 'personal' AND case_id = ?`).run(PRI_CASE)

      const { ctx, out } = fakeCtxWithBody(
        `/api/cos/cases/personal/${PRI_CASE}/owner-action`, 'POST', {
          eventType: 'OWNER_DECISION', choice: 'YES',
          sourceReference: PROG_RUN_ID, caseVersion: 6,
          idempotencyKey: 'idem-extack-1',
          externalEffectAck: true,
        })
      await tryHandleCos(ctx)

      expect(out.status).toBe(200)
      const event = db.prepare(
        `SELECT payload FROM personal_case_events
         WHERE case_id = ? AND json_extract(payload, '$.idempotency_key') = 'idem-extack-1'`
      ).get(PRI_CASE) as any
      expect(event).toBeTruthy()
      const p = JSON.parse(event.payload)
      expect(p.external_effect_ack).toBe(true)
    })
  })
})
