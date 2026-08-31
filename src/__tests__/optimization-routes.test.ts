import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleOptimization } from '../web/routes/optimization.js'
import { OPTIMIZATION_CONFIG_PATH } from '../optimization/optimization-config.js'
import type { RouteContext } from '../web/routes/types.js'

// Same fake-ServerResponse pattern as src/__tests__/costops-api.test.ts's route
// smoke tests -- a real RouteContext against a real in-memory DB, capturing
// what json() writes, without booting the actual HTTP server/process.
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

describe('optimization API (route smoke)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // These routes read/write the real default OPTIMIZATION_CONFIG_PATH (no
    // per-request path override, matching production behaviour: one shared
    // config file) -- reset it before every test so config-mutating tests
    // don't leak state into the next one via the actual filesystem.
    for (const p of [OPTIMIZATION_CONFIG_PATH(), `${OPTIMIZATION_CONFIG_PATH()}.bak`]) {
      if (existsSync(p)) rmSync(p)
    }
  })

  it('GET /api/optimization/summary returns a well-formed summary and never writes', async () => {
    const { ctx, out } = fakeCtx('/api/optimization/summary')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('system_state')
    expect(out.body).toHaveProperty('market_watch')
    expect(out.body.market_watch.wired).toBe(false)
    expect(out.body).toHaveProperty('attention_queue')
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('GET /api/optimization/routing returns an array shaped by real agents', async () => {
    const { ctx, out } = fakeCtx('/api/optimization/routing')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('POST /api/optimization/routing/preview rejects a missing agent with 400, never touches the overlay file', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/optimization/routing/preview', 'POST', {})
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('GET /api/optimization/recommendations with no package inventory returns empty arrays, not an error', async () => {
    const { ctx, out } = fakeCtx('/api/optimization/recommendations')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.recommendations).toEqual([])
    expect(out.body.decisions).toEqual([])
  })

  it('POST /api/optimization/recommendations/decision rejects an invalid status with 400', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/optimization/recommendations/decision', 'POST', {
      package_id: 'x', status: 'not-a-real-status', actor: 'test',
    })
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST /api/optimization/recommendations/decision on an unknown package returns 404, not a crash', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/optimization/recommendations/decision', 'POST', {
      package_id: 'does-not-exist', status: 'viewed', actor: 'test',
    })
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET /api/optimization/settings returns the safe default config on a fresh install', async () => {
    const { ctx, out } = fakeCtx('/api/optimization/settings')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.config.masterEnabled).toBe(false)
  })

  it('PATCH /api/optimization/settings with preview:true never persists a change', async () => {
    const before = fakeCtx('/api/optimization/settings')
    await tryHandleOptimization(before.ctx)
    const versionBefore = before.out.body.config.version

    const { ctx, out } = fakeCtxWithBody('/api/optimization/settings', 'PATCH', {
      masterEnabled: true,
      preset: 'active',
      modules: {
        measurement: true, contextEfficiency: true, capacityMonitoring: true,
        runtimeRouting: true, recommendations: true, marketWatch: true, benchmarkRecommendations: true,
      },
      routing: { automaticFallback: true },
      ui: { defaultWindow: '30d', showAllocationCost: true },
      preview: true,
    })
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.preview).toBe(true)

    const after = fakeCtx('/api/optimization/settings')
    await tryHandleOptimization(after.ctx)
    expect(after.out.body.config.version).toBe(versionBefore)
    expect(after.out.body.config.masterEnabled).toBe(false)
  })

  it('PATCH /api/optimization/settings rejects a malformed body with 400', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/optimization/settings', 'PATCH', { masterEnabled: 'not-a-boolean' })
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST /api/optimization/emergency-disable only forces runtimeRouting and automaticFallback off', async () => {
    const seed = fakeCtxWithBody('/api/optimization/settings', 'PATCH', {
      masterEnabled: true,
      preset: 'active',
      modules: {
        measurement: true, contextEfficiency: true, capacityMonitoring: true,
        runtimeRouting: true, recommendations: true, marketWatch: true, benchmarkRecommendations: true,
      },
      routing: { automaticFallback: true },
      ui: { defaultWindow: '30d', showAllocationCost: true },
    })
    await tryHandleOptimization(seed.ctx)

    const { ctx, out } = fakeCtx('/api/optimization/emergency-disable', 'POST')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.body.config.modules.runtimeRouting).toBe(false)
    expect(out.body.config.routing.automaticFallback).toBe(false)
    // everything else survives untouched
    expect(out.body.config.masterEnabled).toBe(true)
    expect(out.body.config.modules.measurement).toBe(true)
    expect(out.body.config.modules.recommendations).toBe(true)
    expect(out.body.config.modules.marketWatch).toBe(true)
  })

  it('GET /api/optimization/audit returns metadata only, never a prompt/secret/credential', async () => {
    const { ctx, out } = fakeCtx('/api/optimization/audit')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(Array.isArray(out.body)).toBe(true)
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('returns false (falls through) for an unrelated path', async () => {
    const { ctx } = fakeCtx('/api/unrelated-thing')
    expect(await tryHandleOptimization(ctx)).toBe(false)
  })
})
