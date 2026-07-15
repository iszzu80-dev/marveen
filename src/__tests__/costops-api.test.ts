import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { tryHandleCostOps } from '../web/routes/costs.js'
import { monthWindow } from '../costops/ledger.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal fake ServerResponse capturing what json() writes. A non-JSON body
// (e.g. a CSV export) falls back to the raw string in `out.body` instead of
// throwing -- `out.raw` also always carries the untouched chunk for CSV
// assertions.
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any; raw: string | undefined } } {
  const out: { status: number; body: any; raw: string | undefined } = { status: 0, body: null, raw: undefined }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      out.raw = chunk
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

// Same as fakeCtx but with a JSON body, for POST routes that call readBody().
function fakeCtxWithBody(path: string, method: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const { ctx, out } = fakeCtx(path, method)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
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

  // Phase 3 (GAP-12): alerts routes.
  it('GET /api/costs/alerts returns an empty list before any candidate is persisted', async () => {
    const { ctx, out } = fakeCtx('/api/costs/alerts')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.body.alerts).toEqual([])
  })

  it('acknowledge/resolve routes 404 on an unknown dedup_key', async () => {
    const { ctx, out } = fakeCtxWithBody('/api/costs/alerts/acknowledge', 'POST', { dedup_key: 'ghost', actor: 'x' })
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  // Phase 2 (GAP-13): period-close routes.
  it('GET /api/costs/period-close returns open status + readiness for an untouched month', async () => {
    const win = monthWindow(Math.floor(Date.now() / 1000))
    const { ctx, out } = fakeCtx(`/api/costs/period-close?month=${win.key}`)
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.body.status).toBe('open')
    expect(out.body.readiness.ready).toBe(true)
    expect(out.body.snapshot).toBeNull()
  })

  it('GET /api/costs/period-close without ?month= is a 400', async () => {
    const { ctx, out } = fakeCtx('/api/costs/period-close')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST .../close then GET reflects closed status + a snapshot; POST .../reopen reverts it', async () => {
    const win = monthWindow(Math.floor(Date.now() / 1000))
    const { ctx: closeCtx, out: closeOut } = fakeCtxWithBody('/api/costs/period-close/close', 'POST', { month: win.key, actor: 'istvan', reason: 'month end' })
    expect(await tryHandleCostOps(closeCtx)).toBe(true)
    expect(closeOut.body.ok).toBe(true)

    const { ctx: statusCtx, out: statusOut } = fakeCtx(`/api/costs/period-close?month=${win.key}`)
    expect(await tryHandleCostOps(statusCtx)).toBe(true)
    expect(statusOut.body.status).toBe('closed')
    expect(statusOut.body.snapshot).not.toBeNull()
    expect(statusOut.body.history).toHaveLength(1)

    const { ctx: reopenCtx, out: reopenOut } = fakeCtxWithBody('/api/costs/period-close/reopen', 'POST', { month: win.key, actor: 'istvan', reason: 'found an error' })
    expect(await tryHandleCostOps(reopenCtx)).toBe(true)
    expect(reopenOut.body.ok).toBe(true)

    const { ctx: afterCtx, out: afterOut } = fakeCtx(`/api/costs/period-close?month=${win.key}`)
    expect(await tryHandleCostOps(afterCtx)).toBe(true)
    expect(afterOut.body.status).toBe('reopened')
  })

  it('POST .../close 409s on an already-closed month', async () => {
    const win = monthWindow(Math.floor(Date.now() / 1000))
    const { ctx: c1 } = fakeCtxWithBody('/api/costs/period-close/close', 'POST', { month: win.key, actor: 'istvan', reason: 'x' })
    await tryHandleCostOps(c1)
    const { ctx: c2, out: o2 } = fakeCtxWithBody('/api/costs/period-close/close', 'POST', { month: win.key, actor: 'istvan', reason: 'y' })
    expect(await tryHandleCostOps(c2)).toBe(true)
    expect(o2.status).toBe(409)
  })

  // Phase 1 (GAP-18): normalized export routes.
  it('GET /api/costs/export/source-inventory returns JSON by default, CSV with ?format=csv', async () => {
    getDb().prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,1,1)`).run()
    const { ctx: jsonCtx, out: jsonOut } = fakeCtx('/api/costs/export/source-inventory')
    expect(await tryHandleCostOps(jsonCtx)).toBe(true)
    expect(jsonOut.body.meta.scope).toBe('source_inventory')
    expect(Array.isArray(jsonOut.body.sources)).toBe(true)

    const { ctx: csvCtx, out: csvOut } = fakeCtx('/api/costs/export/source-inventory?format=csv')
    expect(await tryHandleCostOps(csvCtx)).toBe(true)
    expect(csvOut.status).toBe(200)
    expect(csvOut.raw).toContain('source_id') // a real CSV header row, not JSON
  })

  it('GET /api/costs/export/monthly-snapshot includes the real period_status (JSON-only, no CSV variant)', async () => {
    const { ctx, out } = fakeCtx('/api/costs/export/monthly-snapshot')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.body.period_status).toBe('open')
    expect(out.body).toHaveProperty('reconciliation')
  })

  it('GET /api/costs/export/alerts reflects the alerts store', async () => {
    const { reconcileAndPersist } = await import('../costops/alerts-store.js')
    reconcileAndPersist(getDb(), [{ type: 'budget_threshold', severity: 'warning', evidence: {}, dedup_key: 'a' }], Math.floor(Date.now() / 1000))
    const { ctx, out } = fakeCtx('/api/costs/export/alerts')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.body.alerts).toHaveLength(1)
  })

  it('GET /api/costs/export/unknown-kind is a 404', async () => {
    const { ctx, out } = fakeCtx('/api/costs/export/unknown-kind')
    expect(await tryHandleCostOps(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  // Phase 3 (GAP-11): budget CRUD + history routes. Each test cleans up its
  // own budget id at the end -- loadCostopsConfig() reads the real on-disk
  // store/costops-config.json (same convention as every other CostOps config
  // route), so leaving an id behind would leak into unrelated test runs.
  describe('budget CRUD + history routes (GAP-11)', () => {
    const BID = 'route-test-budget'

    it('POST /api/costs/budgets creates a budget, GET reflects its live status', async () => {
      const { ctx: postCtx, out: postOut } = fakeCtxWithBody('/api/costs/budgets', 'POST', {
        id: BID, scope: 'global', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0, actor: 'istvan',
      })
      expect(await tryHandleCostOps(postCtx)).toBe(true)
      expect(postOut.body.ok).toBe(true)
      expect(postOut.body.budget.id).toBe(BID)

      const { ctx: getCtx, out: getOut } = fakeCtx('/api/costs/budgets')
      expect(await tryHandleCostOps(getCtx)).toBe(true)
      const found = (getOut.body as any[]).find(b => b.id === BID)
      expect(found).toBeTruthy()
      expect(found.scope).toBe('global')
      expect(found).toHaveProperty('current_spend')
      expect(found).toHaveProperty('status')

      const { ctx: delCtx, out: delOut } = fakeCtxWithBody('/api/costs/budgets', 'DELETE', { id: BID, actor: 'istvan' })
      expect(await tryHandleCostOps(delCtx)).toBe(true)
      expect(delOut.body.ok).toBe(true)
    })

    it('PATCH updates an existing budget in place (no duplicate entry)', async () => {
      const { ctx: c1 } = fakeCtxWithBody('/api/costs/budgets', 'POST', { id: BID, amount: 10000, actor: 'istvan' })
      await tryHandleCostOps(c1)
      const { ctx: c2, out: o2 } = fakeCtxWithBody('/api/costs/budgets', 'PATCH', { id: BID, amount: 15000, actor: 'istvan' })
      expect(await tryHandleCostOps(c2)).toBe(true)
      expect(o2.body.budget.amount).toBe(15000)

      const { ctx: getCtx, out: getOut } = fakeCtx('/api/costs/budgets')
      await tryHandleCostOps(getCtx)
      expect((getOut.body as any[]).filter(b => b.id === BID)).toHaveLength(1)

      const { ctx: delCtx } = fakeCtxWithBody('/api/costs/budgets', 'DELETE', { id: BID, actor: 'istvan' })
      await tryHandleCostOps(delCtx)
    })

    it('POST without an actor is a 400 (audit trail requires who made the change)', async () => {
      const { ctx, out } = fakeCtxWithBody('/api/costs/budgets', 'POST', { id: BID, amount: 1000 })
      expect(await tryHandleCostOps(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('DELETE on an unknown id is a 404', async () => {
      const { ctx, out } = fakeCtxWithBody('/api/costs/budgets', 'DELETE', { id: 'ghost-budget-id', actor: 'istvan' })
      expect(await tryHandleCostOps(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('GET /api/costs/budgets/history returns the audited before/after trail, filterable by id', async () => {
      const { ctx: c1 } = fakeCtxWithBody('/api/costs/budgets', 'POST', { id: BID, amount: 10000, actor: 'istvan' })
      await tryHandleCostOps(c1)
      const { ctx: c2 } = fakeCtxWithBody('/api/costs/budgets', 'PATCH', { id: BID, amount: 20000, actor: 'istvan' })
      await tryHandleCostOps(c2)

      const { ctx, out } = fakeCtx(`/api/costs/budgets/history?id=${BID}`)
      expect(await tryHandleCostOps(ctx)).toBe(true)
      expect(out.body).toHaveLength(2)
      expect(out.body[0].action).toBe('created')
      expect(out.body[1].action).toBe('updated')
      expect(out.body[1].before.amount).toBe(10000)
      expect(out.body[1].after.amount).toBe(20000)

      const { ctx: delCtx } = fakeCtxWithBody('/api/costs/budgets', 'DELETE', { id: BID, actor: 'istvan' })
      await tryHandleCostOps(delCtx)
    })
  })

  // Phase 4 (GAP-17): optimization advisor recommendation routes.
  describe('recommendation list/accept/dismiss routes (GAP-17)', () => {
    it('GET /api/costs/recommendations defaults to open, POST accept/dismiss change status', async () => {
      const { reconcileAndPersistRecommendations } = await import('../costops/recommendations-store.js')
      const now = Math.floor(Date.now() / 1000)
      reconcileAndPersistRecommendations(getDb(), [{
        type: 'unused_domain_or_storage', dedup_key: 'unused_domain_or_storage|old-domain.com',
        evidence: { source_id: 'old-domain.com' }, current_monthly_cost: 500, estimated_monthly_saving: 500,
        estimated_annual_saving: 6000, switching_cost: 0, risk: 'low', confidence: 'medium',
        human_decision_required: 'Confirm safe to release', rollback_note: 'Can re-register later.',
      }], now)

      const { ctx: getCtx, out: getOut } = fakeCtx('/api/costs/recommendations')
      expect(await tryHandleCostOps(getCtx)).toBe(true)
      expect(getOut.body.recommendations).toHaveLength(1)
      expect(getOut.body.recommendations[0].dedup_key).toBe('unused_domain_or_storage|old-domain.com')

      const { ctx: acceptCtx, out: acceptOut } = fakeCtxWithBody('/api/costs/recommendations/accept', 'POST', {
        dedup_key: 'unused_domain_or_storage|old-domain.com', actor: 'istvan',
      })
      expect(await tryHandleCostOps(acceptCtx)).toBe(true)
      expect(acceptOut.body.ok).toBe(true)
      expect(acceptOut.body.recommendation.status).toBe('accepted')

      const { ctx: openCtx, out: openOut } = fakeCtx('/api/costs/recommendations')
      await tryHandleCostOps(openCtx)
      expect(openOut.body.recommendations).toHaveLength(0) // accepted, no longer 'open'

      const { ctx: allCtx, out: allOut } = fakeCtx('/api/costs/recommendations?status=all')
      await tryHandleCostOps(allCtx)
      expect(allOut.body.recommendations).toHaveLength(1)
    })

    it('accept without an actor is a 400; accept/dismiss on an unknown dedup_key is a 404', async () => {
      const { ctx: noActorCtx, out: noActorOut } = fakeCtxWithBody('/api/costs/recommendations/accept', 'POST', { dedup_key: 'ghost' })
      expect(await tryHandleCostOps(noActorCtx)).toBe(true)
      expect(noActorOut.status).toBe(400)

      const { ctx: ghostCtx, out: ghostOut } = fakeCtxWithBody('/api/costs/recommendations/dismiss', 'POST', { dedup_key: 'ghost', actor: 'istvan' })
      expect(await tryHandleCostOps(ghostCtx)).toBe(true)
      expect(ghostOut.status).toBe(404)
    })
  })
})
