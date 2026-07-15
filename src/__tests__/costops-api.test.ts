import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { tryHandleCostOps } from '../web/routes/costs.js'
import { monthWindow } from '../costops/ledger.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal fake ServerResponse capturing what json() writes.
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('costops API (route smoke)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GET /api/costs/summary returns a well-formed read-only summary', async () => {
    // seed a current-month token_usage row -> proves volume is reported but NOT priced
    const now = Math.floor(Date.now() / 1000)
    const w = monthWindow(now)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES ('marveen','s',?,1234,5678,0,0)").run(w.start + 100)

    const { ctx, out } = fakeCtx('/api/costs/summary')
    const handled = await tryHandleCostOps(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // shape
    expect(out.body).toHaveProperty('month')
    expect(out.body).toHaveProperty('current_spend')
    expect(out.body).toHaveProperty('forecast_month_end')
    expect(out.body).toHaveProperty('top_sources')
    expect(out.body).toHaveProperty('confidence_breakdown')
    expect(out.body).toHaveProperty('breakdown')
    expect(out.body).toHaveProperty('budget')
    expect(out.body).toHaveProperty('token_usage')
    // token usage reported as VOLUME
    expect(out.body.token_usage.input_tokens).toBe(1234)
    expect(out.body.token_usage.output_tokens).toBe(5678)
    expect(out.body.token_usage.note).toContain('not priced')
    // money never derived from tokens (config amounts are 0 placeholders)
    expect(typeof out.body.current_spend).toBe('number')
    // no secret / account id leaks into the response
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
  })

  it('GET /api/costs/sources returns an array', async () => {
    const { ctx, out } = fakeCtx('/api/costs/sources')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('falls through (returns false) for unrelated paths', async () => {
    const { ctx } = fakeCtx('/api/kanban')
    expect(await tryHandleCostOps(ctx)).toBe(false)
  })

  // Phase 0 (GAP-03/GAP-04): source inventory route.
  it('GET /api/costs/source-inventory returns the full inventory, additive to /summary', async () => {
    getDb().prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,1,1)`).run()
    const { ctx, out } = fakeCtx('/api/costs/source-inventory')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.sources)).toBe(true)
    const domain = out.body.sources.find((s: any) => s.source_id === 'domain')
    expect(domain).toBeTruthy()
    expect(domain).toHaveProperty('lifecycle')
    expect(domain).toHaveProperty('provenance')
    expect(domain).toHaveProperty('owner')
    expect(domain).toHaveProperty('sync_cadence')
    expect(domain).toHaveProperty('manual_fallback')
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password/i)
  })

  // Phase 0 (P0.5): 7-day reliability observation window.
  it('POST then GET /api/costs/reliability-snapshots captures and lists a snapshot', async () => {
    const { ctx: postCtx, out: postOut } = fakeCtx('/api/costs/reliability-snapshots', 'POST')
    expect(await tryHandleCostOps(postCtx)).toBe(true)
    expect(postOut.status).toBe(200)
    expect(typeof postOut.body.captured_at).toBe('number')

    const { ctx: listCtx, out: listOut } = fakeCtx('/api/costs/reliability-snapshots')
    expect(await tryHandleCostOps(listCtx)).toBe(true)
    expect(listOut.body.snapshots).toHaveLength(1)

    const { ctx: latestCtx, out: latestOut } = fakeCtx('/api/costs/reliability-snapshots?latest=1')
    expect(await tryHandleCostOps(latestCtx)).toBe(true)
    expect(Array.isArray(latestOut.body.inventory)).toBe(true)
  })

  // Phase 1 (GAP-10): forecast snapshots route.
  it('GET /api/costs/forecast-snapshots returns an empty list before any capture, populated after', async () => {
    const { ctx: emptyCtx, out: emptyOut } = fakeCtx('/api/costs/forecast-snapshots')
    expect(await tryHandleCostOps(emptyCtx)).toBe(true)
    expect(emptyOut.body.snapshots).toEqual([])

    const { captureForecastSnapshots } = await import('../costops/forecast-capture.js')
    getDb().prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,1,1)`).run()
    captureForecastSnapshots(getDb(), Math.floor(Date.now() / 1000))

    const { ctx, out } = fakeCtx('/api/costs/forecast-snapshots')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.body.snapshots.length).toBeGreaterThan(0)
    expect(out.body.snapshots[0]).toHaveProperty('method')
    expect(out.body.snapshots[0]).toHaveProperty('confidence')
  })

  // Phase 1 (GAP-06): reconciliation route.
  it('GET /api/costs/reconciliation returns a per-source reconciliation view', async () => {
    getDb().prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,1,1)`).run()
    const { ctx, out } = fakeCtx('/api/costs/reconciliation')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(Array.isArray(out.body.reconciliation)).toBe(true)
    const domain = out.body.reconciliation.find((r: any) => r.source_id === 'domain')
    expect(domain).toHaveProperty('status')
    expect(domain).toHaveProperty('variance')
  })

  // Phase 1 (GAP-05/06/14): correction chain drill-down route.
  it('GET /api/costs/corrections?chain= walks the correction chain via the route', async () => {
    const { monthWindow } = await import('../costops/ledger.js')
    const win = monthWindow(Math.floor(Date.now() / 1000))
    getDb().prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,1,1)`).run()
    const info = getDb().prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
      VALUES ('render-hosting', ?, ?, 'usage', 10000, 'HUF', 'provider_api', 1, 1, 'x', 'provider_api')
    `).run(win.start, win.end)
    const originalId = info.lastInsertRowid as number

    // Drive the correction directly (the route is a thin JSON-body pass-through
    // over createCorrection(), already fully unit-tested in
    // costops-correction.test.ts) -- this test verifies the GET route wiring.
    const { createCorrection } = await import('../costops/correction.js')
    createCorrection(getDb(), { originalLineId: originalId, newAmount: 8500, reason: 'fix' }, { now: Math.floor(Date.now() / 1000) })

    const { ctx: chainCtx, out: chainOut } = fakeCtx(`/api/costs/corrections?chain=${originalId}`)
    expect(await tryHandleCostOps(chainCtx)).toBe(true)
    expect(chainOut.body.chain).toHaveLength(2)
    expect(chainOut.body.chain[1].billed_cost).toBe(8500)
  })

  it('GET /api/costs/corrections without ?chain= is a 400', async () => {
    const { ctx, out } = fakeCtx('/api/costs/corrections')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })
})
