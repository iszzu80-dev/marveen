/**
 * CASE COMPLETION EXIT — the HTTP half.
 *
 * The domain half (cos-case-closure.test.ts) proves `closeCase` behaves. This
 * file proves the surface Mission Control actually talks to reaches it, with
 * the refusals carried as status codes a caller can route on.
 *
 * WHY BOTH HALVES EXIST. A domain function nobody can call from outside is the
 * exact defect this feature was opened for: `transitionCase` was correct,
 * guarded and version-checked for months, and 51 cases sat open because no
 * route reached it. Testing only the function would reproduce that mistake in
 * the test suite -- green on the mechanism, silent on the gap.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const { tryHandleCos } = await import('../web/routes/cos.js')

function fakeCtx(path: string, method = 'GET'): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method, url } as RouteContext, out }
}

function fakeCtxWithBody(path: string, method: string, body: unknown) {
  const { ctx, out } = fakeCtx(path, method)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

const NOW = Math.floor(Date.now() / 1000)

function seedPersonal(caseId: string, status = 'NEW'): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO personal_cases
     (case_id, version, title, case_type, status, priority, sensitivity,
      source_system, owner, created_at, updated_at)
     VALUES (?, 1, ?, 'ADMIN', ?, 'P2', 'PERSONAL', 'test', 'istvan', ?, ?)`,
  ).run(caseId, caseId, status, NOW - 100, NOW - 100)
}

function seedZst(caseId: string): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO zst_cases
     (case_id, version, title, case_type, status, priority, sensitivity,
      source_system, owner, created_at, updated_at)
     VALUES (?, 1, ?, 'GENERAL_OPERATION', 'NEW', 'P2', 'ZST_INTERNAL', 'test', 'istvan', ?, ?)`,
  ).run(caseId, caseId, NOW - 100, NOW - 100)
}

const goodBody = (version: number) => ({
  expectedVersion: version, intent: 'CLOSE_CASE',
  reason: 'a tulajdonos lezarta', provenance: 'mission-control:test', actor: 'istvan',
})

describe('GET .../close-preview — look without committing', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('reports the status, version and blockers, and CHANGES NOTHING', async () => {
    seedPersonal('P-PREVIEW')
    const { ctx, out } = fakeCtx('/api/cos/cases/personal/P-PREVIEW/close-preview')
    expect(await tryHandleCos(ctx)).toBe(true)

    expect(out.status).toBe(200)
    expect(out.body.status).toBe('NEW')
    expect(out.body.version).toBe(1)
    expect(out.body.alreadyClosed).toBe(false)
    expect(out.body.guard.allowed).toBe(true)   // asked as the owner
    expect(Array.isArray(out.body.blockers)).toBe(true)

    // The preview is a read. If it moved the case, the owner could not inspect
    // a close without performing one, and the button would be a trapdoor.
    const after = getDb().prepare(
      `SELECT status, version FROM personal_cases WHERE case_id = 'P-PREVIEW'`,
    ).get() as { status: string; version: number }
    expect(after.status).toBe('NEW')
    expect(after.version).toBe(1)
  })

  it('404s for a case that is not in the asked-for namespace', async () => {
    seedZst('Z-ONLY')
    const { ctx, out } = fakeCtx('/api/cos/cases/personal/Z-ONLY/close-preview')
    expect(await tryHandleCos(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })
})

describe('POST .../close — the exit', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('closes a personal case and returns the new version', async () => {
    seedPersonal('P-CLOSE')
    const { ctx, out } = fakeCtxWithBody('/api/cos/cases/personal/P-CLOSE/close', 'POST', goodBody(1))
    expect(await tryHandleCos(ctx)).toBe(true)

    expect(out.status).toBe(200)
    expect(out.body.outcome).toBe('CLOSED')
    expect(out.body.status).toBe('COMPLETED')

    const after = getDb().prepare(
      `SELECT status, completed_at FROM personal_cases WHERE case_id = 'P-CLOSE'`,
    ).get() as { status: string; completed_at: number | null }
    expect(after.status).toBe('COMPLETED')
    expect(after.completed_at).not.toBeNull()
  })

  it('closes a ZST case on the corporate route', async () => {
    seedZst('Z-CLOSE')
    const { ctx, out } = fakeCtxWithBody('/api/cos/cases/zst/Z-CLOSE/close', 'POST', goodBody(1))
    expect(await tryHandleCos(ctx)).toBe(true)
    expect(out.body.outcome).toBe('CLOSED')
    const after = getDb().prepare(
      `SELECT status FROM zst_cases WHERE case_id = 'Z-CLOSE'`,
    ).get() as { status: string }
    expect(after.status).toBe('COMPLETED')
  })

  it('409s on a stale version and leaves the case alone', async () => {
    seedPersonal('P-STALE')
    const { ctx, out } = fakeCtxWithBody('/api/cos/cases/personal/P-STALE/close', 'POST', goodBody(99))
    expect(await tryHandleCos(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('VERSION_CONFLICT')
    expect(out.body.currentVersion).toBe(1)
    const after = getDb().prepare(
      `SELECT status FROM personal_cases WHERE case_id = 'P-STALE'`,
    ).get() as { status: string }
    expect(after.status).toBe('NEW')
  })

  it('400s a body with no intent, no reason, or no version', async () => {
    seedPersonal('P-BAD')
    for (const body of [
      { ...goodBody(1), intent: undefined },
      { ...goodBody(1), reason: '  ' },
      { ...goodBody(1), provenance: '' },
      { ...goodBody(1), expectedVersion: undefined },
    ]) {
      const { ctx, out } = fakeCtxWithBody('/api/cos/cases/personal/P-BAD/close', 'POST', body)
      expect(await tryHandleCos(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.code).toBe('INVALID_INPUT')
    }
    // A missing expectedVersion in particular must NOT be read as 0 or as "any":
    // the case is still open after all four attempts.
    const after = getDb().prepare(
      `SELECT status FROM personal_cases WHERE case_id = 'P-BAD'`,
    ).get() as { status: string }
    expect(after.status).toBe('NEW')
  })

  it('422s an unacknowledged blocker, then closes once it is acknowledged', async () => {
    seedPersonal('P-BLOCK')
    getDb().prepare(
      `INSERT INTO case_escalations
       (escalation_id, domain, case_id, progression_run_id, trigger_reason,
        escalation_level, summary, resolution_status, created_at)
       VALUES ('esc-r','personal','P-BLOCK','run-r','L2_BLOCKED','L2_BLOCKED',
               'penzugyi kotelezettseg nyitva','OPEN', ?)`,
    ).run(NOW - 50)

    const first = fakeCtxWithBody('/api/cos/cases/personal/P-BLOCK/close', 'POST', goodBody(1))
    expect(await tryHandleCos(first.ctx)).toBe(true)
    expect(first.out.status).toBe(422)
    expect(first.out.body.code).toBe('BLOCKERS_NOT_ACKNOWLEDGED')
    expect(first.out.body.blockers[0].ref).toBe('esc-r')

    const second = fakeCtxWithBody('/api/cos/cases/personal/P-BLOCK/close', 'POST',
      { ...goodBody(1), acknowledgedBlockers: ['esc-r'] })
    expect(await tryHandleCos(second.ctx)).toBe(true)
    expect(second.out.body.outcome).toBe('CLOSED')
  })

  it('answers a repeat close with ALREADY_CLOSED, not an error', async () => {
    seedPersonal('P-TWICE')
    const first = fakeCtxWithBody('/api/cos/cases/personal/P-TWICE/close', 'POST', goodBody(1))
    await tryHandleCos(first.ctx)
    expect(first.out.body.outcome).toBe('CLOSED')

    const events = () => (getDb().prepare(
      `SELECT count(*) c FROM personal_case_events WHERE case_id = 'P-TWICE'`,
    ).get() as { c: number }).c
    const afterFirst = events()

    const second = fakeCtxWithBody('/api/cos/cases/personal/P-TWICE/close', 'POST', goodBody(1))
    await tryHandleCos(second.ctx)
    expect(second.out.status).toBe(200)
    expect(second.out.body.outcome).toBe('ALREADY_CLOSED')
    expect(events()).toBe(afterFirst)
  })

  it('cannot close a ZST case through the personal route', async () => {
    seedZst('Z-GUARDED')
    const { ctx, out } = fakeCtxWithBody('/api/cos/cases/personal/Z-GUARDED/close', 'POST', goodBody(1))
    expect(await tryHandleCos(ctx)).toBe(true)
    expect(out.status).toBe(404)
    const after = getDb().prepare(
      `SELECT status FROM zst_cases WHERE case_id = 'Z-GUARDED'`,
    ).get() as { status: string }
    expect(after.status).toBe('NEW')
  })

  it('a closed case reads back closed from the preview — one store, one answer', async () => {
    seedPersonal('P-READBACK')
    const close = fakeCtxWithBody('/api/cos/cases/personal/P-READBACK/close', 'POST', goodBody(1))
    await tryHandleCos(close.ctx)
    expect(close.out.body.outcome).toBe('CLOSED')

    // Mission Control's own read of the same case. If this disagreed with the
    // store, the board would show a case the engine considers finished -- the
    // "control surface reports success" failure, in the other direction.
    const { ctx, out } = fakeCtx('/api/cos/cases/personal/P-READBACK/close-preview')
    await tryHandleCos(ctx)
    expect(out.body.status).toBe('COMPLETED')
    expect(out.body.alreadyClosed).toBe(true)
    expect(out.body.completedAt).not.toBeNull()
  })
})
