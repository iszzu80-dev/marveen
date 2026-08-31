// OPT-M3 (CostOps + lean optimization full review, 2026-08-12): the dashboard
// spec's acceptance says every config change is audited, and yet PATCH
// /api/optimization/settings and POST /api/optimization/emergency-disable
// wrote store/optimization-config.json with no audit record at all. Each
// config write now leaves exactly one append-only row in
// optimization_config_audit (surface, version from->to, masterEnabled
// from->to, human-readable flag delta), parallel in shape and seam to
// optimization_decision_events.
//
// Same harness as optimization-routes.test.ts: a real RouteContext against a
// real in-memory DB, with the real default OPTIMIZATION_CONFIG_PATH() reset
// around every test.

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleOptimization } from '../web/routes/optimization.js'
import {
  OPTIMIZATION_CONFIG_PATH,
  DEFAULT_OPTIMIZATION_CONFIG,
} from '../optimization/optimization-config.js'
import {
  initOptimizationConfigAuditSchema,
  listOptimizationConfigAudit,
  summarizeConfigDelta,
} from '../optimization/optimization-config-audit.js'
import type { RouteContext } from '../web/routes/types.js'

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

const VALID_ACTIVE_BODY = {
  masterEnabled: true,
  preset: 'active',
  modules: {
    measurement: true, contextEfficiency: true, capacityMonitoring: true,
    runtimeRouting: true, recommendations: true, marketWatch: true, benchmarkRecommendations: true,
  },
  routing: { automaticFallback: true },
  ui: { defaultWindow: '30d', showAllocationCost: true },
}

describe('OPT-M3: optimization config writes are audited', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    for (const p of [OPTIMIZATION_CONFIG_PATH(), `${OPTIMIZATION_CONFIG_PATH()}.bak`]) {
      if (existsSync(p)) rmSync(p)
    }
  })

  it('a settings PATCH leaves exactly one settings-surface audit row with the version step and the flag delta', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/optimization/settings', 'PATCH', VALID_ACTIVE_BODY)
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.status).toBe(200)

    const rows = listOptimizationConfigAudit(getDb()).filter(r => r.surface === 'settings')
    expect(rows).toHaveLength(1)
    expect(rows[0].version_from).toBe(1) // the on-disk-absent default
    expect(rows[0].version_to).toBe(out.body.config.version)
    expect(rows[0].master_enabled_from).toBe(0)
    expect(rows[0].master_enabled_to).toBe(1)
    expect(rows[0].delta_summary).toContain('masterEnabled false->true')
    expect(rows[0].delta_summary).toContain('modules.runtimeRouting false->true')
    expect(rows[0].delta_summary).toContain('routing.automaticFallback false->true')
  })

  it('an emergency-disable leaves exactly one emergency-surface audit row recording what it forced off', async () => {
    const seed = fakeCtxWithBody('/api/optimization/settings', 'PATCH', VALID_ACTIVE_BODY)
    await tryHandleOptimization(seed.ctx)

    const { ctx, out } = fakeCtx('/api/optimization/emergency-disable', 'POST')
    expect(await tryHandleOptimization(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)

    const rows = listOptimizationConfigAudit(getDb()).filter(r => r.surface === 'emergency')
    expect(rows).toHaveLength(1)
    expect(rows[0].delta_summary).toContain('modules.runtimeRouting true->false')
    expect(rows[0].delta_summary).toContain('routing.automaticFallback true->false')
    // The kill switch touches only its two flags; the master survives and the
    // delta says so by NOT mentioning it.
    expect(rows[0].master_enabled_from).toBe(1)
    expect(rows[0].master_enabled_to).toBe(1)
    expect(rows[0].delta_summary).not.toContain('masterEnabled')
  })

  it('a REJECTED write (preview / validation error) leaves no audit row -- audit records changes, not attempts', async () => {
    const preview = fakeCtxWithBody('/api/optimization/settings', 'PATCH', { ...VALID_ACTIVE_BODY, preview: true })
    await tryHandleOptimization(preview.ctx)
    const bad = fakeCtxWithBody('/api/optimization/settings', 'PATCH', { masterEnabled: 'nope' })
    await tryHandleOptimization(bad.ctx)

    expect(listOptimizationConfigAudit(getDb())).toHaveLength(0)
  })

  it("the audit rows are metadata only: no secret-shaped content, matching /api/optimization/audit's invariant", async () => {
    const { ctx } = fakeCtxWithBody('/api/optimization/settings', 'PATCH', VALID_ACTIVE_BODY)
    await tryHandleOptimization(ctx)
    const blob = JSON.stringify(listOptimizationConfigAudit(getDb()))
    expect(blob).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('summarizeConfigDelta says "no flag changes" for an identical config instead of an ambiguous empty string', () => {
    initOptimizationConfigAuditSchema(getDb())
    expect(summarizeConfigDelta(DEFAULT_OPTIMIZATION_CONFIG, DEFAULT_OPTIMIZATION_CONFIG)).toBe('no flag changes')
  })
})
