import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, createApproval } from '../db.js'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleApg } from '../web/routes/apg.js'
import { reloadOverridesForTest, setOverride, OVERRIDES_PATH } from '../settings-store.js'
import type { RouteContext } from '../web/routes/types.js'

// Same fake-ServerResponse pattern as src/__tests__/optimization-routes.test.ts
// -- a real RouteContext against a real in-memory DB, capturing what json()
// writes, without booting the actual HTTP server/process (this repo's
// dashboard must never be live-booted in a sandbox: a known fleet-wide
// binary-pattern bug can SIGTERM the real production instance).
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

function fakeCtxWithBody(path: string, method: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const { ctx, out } = fakeCtx(path, method)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

const SCOPE_OVERRIDES_PATH = join(PROJECT_ROOT, 'store', 'apg-scope-overrides.json')
const IDEMPOTENCY_PATH = join(PROJECT_ROOT, 'store', 'apg-decision-idempotency.json')
const AUDIT_PATH = join(PROJECT_ROOT, 'store', 'apg-ui-audit.jsonl')

function resetApgFiles(): void {
  for (const p of [SCOPE_OVERRIDES_PATH, IDEMPOTENCY_PATH, AUDIT_PATH, OVERRIDES_PATH]) {
    if (existsSync(p)) rmSync(p)
  }
  reloadOverridesForTest()
}

describe('APG UI API (route smoke)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    resetApgFiles()
    // This machine has a REAL local APG kernel sidecar with real pilot data
    // at ~/marveen-local/apg-kernel/store/apg-kernel.db (openApgKernelReadonly's
    // default path). Point every test at a deliberately nonexistent path
    // instead, so "sidecar unavailable" tests stay deterministic and no test
    // in this suite ever reads real production APG data.
    process.env.APG_KERNEL_DB_PATH = '/nonexistent/apg-kernel-test-sandbox.db'
  })

  it('GET /api/apg/summary defaults to APG_MODE=off and never touches the (absent) sidecar', async () => {
    const { ctx, out } = fakeCtx('/api/apg/summary')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.mode).toBe('off')
    expect(out.body.enabled).toBe(false)
    expect(out.body.mode_source).toBe('global')
    expect(out.body.counts.active).toBe(0)
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('a global-off scope override cannot be raised by a card override (absolute master off)', async () => {
    const { ctx: putCtx } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: '0f75d35d', mode: 'enforced', actor: 'test', reason: 'probe',
    })
    expect(await tryHandleApg(putCtx)).toBe(true)

    const { ctx, out } = fakeCtx('/api/apg/summary?kanban_card_id=0f75d35d')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.body.mode).toBe('off')
    expect(out.body.mode_source).toBe('global')
  })

  it('once APG_MODE is not off, a card override raises/changes the effective mode for that card only', async () => {
    setOverride('APG_MODE', 'observe')
    const { ctx: putCtx, out: putOut } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: '0f75d35d', mode: 'enforced', actor: 'test', reason: 'probe',
    })
    expect(await tryHandleApg(putCtx)).toBe(true)
    expect(putOut.status).toBe(200)

    const { ctx: scoped, out: scopedOut } = fakeCtx('/api/apg/summary?kanban_card_id=0f75d35d')
    await tryHandleApg(scoped)
    expect(scopedOut.body.mode).toBe('enforced')
    expect(scopedOut.body.mode_source).toBe('card')

    const { ctx: unscoped, out: unscopedOut } = fakeCtx('/api/apg/summary')
    await tryHandleApg(unscoped)
    expect(unscopedOut.body.mode).toBe('observe')
    expect(unscopedOut.body.mode_source).toBe('global')
  })

  it('PUT /api/apg/scope-overrides rejects a downgrade from enforced with no reason', async () => {
    setOverride('APG_MODE', 'enforced')
    const { ctx, out } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'project', scope_id: 'lumaseat', mode: 'observe', actor: 'test', reason: '',
    })
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/reason/i)
  })

  it('GET /api/apg/work-items degrades to an empty list (not a 500) when the sidecar is unavailable', async () => {
    const { ctx, out } = fakeCtx('/api/apg/work-items')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.items).toEqual([])
    expect(out.body.total).toBe(0)
    expect(typeof out.body.error).toBe('string')
  })

  it('GET /api/apg/work-items/:id 404s when the sidecar has nothing for that id', async () => {
    const { ctx, out } = fakeCtx('/api/apg/work-items/does-not-exist')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(typeof out.body.error).toBe('string')
  })

  it('POST /api/apg/approvals/:id/decision: producer cannot silently double-decide, and replays the SAME response for a repeated idempotency_key', async () => {
    const approval = createApproval({
      id: 'approval-1', agent_id: 'buildfejleszto', category: 'test',
      action_description: 'do the thing', action_payload: null, timeout_at: null,
    })

    const first = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'accept', idempotency_key: 'k1',
    })
    expect(await tryHandleApg(first.ctx)).toBe(true)
    expect(first.out.status).toBe(200)
    expect(first.out.body.status).toBe('approved')
    expect(first.out.body.resolved_by).toBe('dashboard')

    // Same idempotency_key replayed -- spec 7.4: must return the SAME result,
    // not the generic "already resolved" 409 (that 409 is for a genuinely
    // conflicting SECOND decision, not a retry of the first one).
    const replay = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'accept', idempotency_key: 'k1',
    })
    expect(await tryHandleApg(replay.ctx)).toBe(true)
    expect(replay.out.status).toBe(200)
    expect(replay.out.body).toEqual(first.out.body)

    // A DIFFERENT idempotency_key against the now-resolved approval is a
    // genuine conflict -> 409, distinguishable from the replay case above.
    const conflict = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'block', idempotency_key: 'k2',
    })
    expect(await tryHandleApg(conflict.ctx)).toBe(true)
    expect(conflict.out.status).toBe(409)
    expect(conflict.out.body.status).toBe('approved')
  })

  it('POST decision rejects an invalid action with 400 and never calls resolveApproval', async () => {
    const approval = createApproval({
      id: 'approval-2', agent_id: 'buildfejleszto', category: 'test',
      action_description: 'do the thing', action_payload: null, timeout_at: null,
    })
    const { ctx, out } = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'not-a-real-action', idempotency_key: 'k1',
    })
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('GET /api/apg/scope-overrides returns [] before anything is written', async () => {
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.body.overrides).toEqual([])
  })
})
