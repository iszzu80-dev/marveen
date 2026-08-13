import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { resolveBudgetStatus, getAllBudgetStatuses, upsertBudget, deleteBudget, getBudgetAuditHistory } from '../costops/budgets.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

// upsertBudget/deleteBudget call the real saveCostopsConfig(), which writes
// store/costops-config.json on disk -- mocked here so these unit tests never
// touch that real file (a prior version of this file didn't mock this and
// left 'a'/'b' budget entries behind in the actual config, which would have
// shown up as fake budgets on a real dashboard -- flagged by Marveen 2026-07-15).
vi.mock('../costops/config.js', async () => {
  const actual = await vi.importActual<typeof import('../costops/config.js')>('../costops/config.js')
  return { ...actual, saveCostopsConfig: vi.fn() }
})

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const MONTH = monthWindow(NOW).key

function baseConfig(overrides: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [], ...overrides }
}

function insertLine(sourceId: string, provider: string, sourceType: string, amount: number, opts: { confidence?: string; actualSource?: string } = {}) {
  const db = getDb()
  const win = monthWindow(NOW)
  db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'HUF', 1, ?, ?)`)
    .run(sourceId, sourceId, provider, sourceType, NOW, NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, 'subscription', ?, 'HUF', ?, ?, ?, ?, ?)
  `).run(sourceId, win.start, win.end, amount, opts.confidence ?? 'manual', NOW, NOW, `test|${sourceId}|${Math.random()}`, opts.actualSource ?? 'manual_entry')
}

describe('resolveBudgetStatus / getAllBudgetStatuses (CostOps Phase 3, GAP-11)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  // COS-CORE-M3: the global scope is measured on the SAME headline all_sources
  // basis as every other scope (it used to read operational_spend, a different
  // resolution -- see the invariant suite below).
  it('a global budget resolves against the headline all_sources basis, matching the summary table', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'global-monthly', scope: 'global', amount: 50000, warning_threshold: 0.8, hard_threshold: 1.0 }] })
    const summary = getCostSummary(db, config, NOW)
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.scope).toBe('global')
    expect(status.spend_basis).toBe('all_sources_headline')
    expect(status.current_spend).toBe(summary.all_sources.reduce((s, r) => s + (r.spend ?? 0), 0))
    expect(status.forecast).toBe(summary.all_sources.reduce((s, r) => s + (r.forecast_month_end ?? 0), 0))
  })

  it('a provider budget only sums that provider\'s sources', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    insertLine('openai-api', 'openai', 'usage', 5000)
    const config = baseConfig({ budgets: [{ id: 'render-budget', scope: 'provider', scope_ref: 'render', amount: 20000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(10000) // render only, not openai
  })

  it('a category budget sums by source_type across providers', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    insertLine('aws-s3', 'aws', 'hosting', 3000)
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    const config = baseConfig({ budgets: [{ id: 'hosting-budget', scope: 'category', scope_ref: 'hosting', amount: 20000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(13000) // render + aws hosting only
  })

  it('a source-scoped budget resolves to just that one source', () => {
    const db = getDb()
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'claude-max-budget', scope: 'source', scope_ref: 'anthropic-max', amount: 25000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(22000)
  })

  it('product/agent scopes explicitly resolve to zero -- GAP-11 excludes them, never fabricated', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'weird-budget', scope: 'product', scope_ref: 'whatever', amount: 5000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(0)
    expect(status.forecast).toBe(0)
  })

  it('status escalates ok -> warning -> hard by used_pct vs thresholds', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 8500)
    const config = baseConfig({ budgets: [{ id: 'b', scope: 'global', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.used_pct).toBeCloseTo(0.85, 2)
    expect(status.status).toBe('warning')
  })

  it('variance is forecast minus amount -- positive means a projected overage', () => {
    const db = getDb()
    // A subscription line forecasts at its full amount, so forecast == 1500.
    insertLine('render-hosting', 'render', 'hosting', 1500)
    const summary = getCostSummary(db, baseConfig(), NOW)
    const status = resolveBudgetStatus({ id: 'b', scope: 'global', amount: 1000 }, summary)
    expect(status.forecast).toBe(1500)
    expect(status.variance).toBe(500)
  })

  it('owner defaults to operator when not configured on the budget entry', () => {
    const db = getDb()
    const config = baseConfig({ budgets: [{ id: 'b', scope: 'global', amount: 1000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.owner).toBe('operator')
  })
})

// COS-CORE-M3 (owner decision 2026-08-13): one canonical basis for every scope.
//
// The fixture below is the exact shape the finding is about: ONE provider with
// both a manual source and a provider-derived (provider_api) source. The
// operational resolution drops that provider's manual source once it has
// provider data -- so while 'global' read operational_spend and every other
// scope summed all_sources, the anthropic provider budget saw 30 000 and the
// global budget saw 8 000 for the same month.
//
// RED-ABILITY: put summary.operational_spend back into spendForScope's global
// branch and every test in this suite goes red.
describe('COS-CORE-M3: one canonical spend basis across budget scopes', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function mixedProviderFixture(): void {
    // anthropic: a manual subscription AND a provider_api usage source.
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    insertLine('anthropic-api', 'anthropic', 'usage', 8000, { confidence: 'provider_api', actualSource: 'provider_api' })
    // a second provider, so "sum of the parts" is a real sum
    insertLine('render-hosting', 'render', 'hosting', 10000)
  }

  it('the sum of the per-provider budgets equals the global budget -- parts sum to the whole', () => {
    const db = getDb()
    mixedProviderFixture()
    const config = baseConfig({ budgets: [
      { id: 'global-monthly', scope: 'global', amount: 100000 },
      { id: 'anthropic-budget', scope: 'provider', scope_ref: 'anthropic', amount: 100000 },
      { id: 'render-budget', scope: 'provider', scope_ref: 'render', amount: 100000 },
    ] })
    const [global, anthropic, render] = getAllBudgetStatuses(db, config, NOW)
    // Both anthropic sources count -- the manual one is NOT dropped for having
    // a provider-derived sibling, because the headline table does not drop it.
    expect(anthropic.current_spend).toBe(30000)
    expect(render.current_spend).toBe(10000)
    expect(global.current_spend).toBe(40000)
    expect(anthropic.current_spend + render.current_spend).toBe(global.current_spend)
    expect(anthropic.forecast + render.forecast).toBe(global.forecast)
  })

  it('the same holds for category scopes -- every category slice sums back to global', () => {
    const db = getDb()
    mixedProviderFixture()
    const config = baseConfig({ budgets: [
      { id: 'global-monthly', scope: 'global', amount: 100000 },
      { id: 'subs', scope: 'category', scope_ref: 'subscription', amount: 100000 },
      { id: 'usage', scope: 'category', scope_ref: 'usage', amount: 100000 },
      { id: 'hosting', scope: 'category', scope_ref: 'hosting', amount: 100000 },
    ] })
    const [global, subs, usage, hosting] = getAllBudgetStatuses(db, config, NOW)
    expect(subs.current_spend + usage.current_spend + hosting.current_spend).toBe(global.current_spend)
  })

  it('global reconciles with the headline figure shown next to it on the dashboard', () => {
    const db = getDb()
    mixedProviderFixture()
    const config = baseConfig({ budgets: [{ id: 'global-monthly', scope: 'global', amount: 100000 }] })
    const summary = getCostSummary(db, config, NOW)
    const [global] = getAllBudgetStatuses(db, config, NOW)
    expect(global.current_spend).toBe(summary.all_sources.reduce((s, r) => s + (r.spend ?? 0), 0))
    // And it is demonstrably NOT the operational figure any more -- these two
    // differ by exactly the manual anthropic source operational excludes.
    expect(summary.operational_spend).toBe(18000)
    expect(global.current_spend - summary.operational_spend).toBe(22000)
  })

  it('a budget that used to read warning on the provider scope and ok on global now agrees', () => {
    const db = getDb()
    // anthropic alone: 22 000 manual + 8 000 provider_api = 30 000 headline,
    // but only 8 000 operational. Against a 30 000 budget the old code said
    // 'hard' (provider scope) and 'ok' (global scope) for the same month.
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    insertLine('anthropic-api', 'anthropic', 'usage', 8000, { confidence: 'provider_api', actualSource: 'provider_api' })
    const config = baseConfig({ budgets: [
      { id: 'global-monthly', scope: 'global', amount: 30000, warning_threshold: 0.8, hard_threshold: 1.0 },
      { id: 'anthropic-budget', scope: 'provider', scope_ref: 'anthropic', amount: 30000, warning_threshold: 0.8, hard_threshold: 1.0 },
    ] })
    const [global, anthropic] = getAllBudgetStatuses(db, config, NOW)
    expect(global.current_spend).toBe(anthropic.current_spend)
    expect(global.used_pct).toBe(anthropic.used_pct)
    expect(global.status).toBe(anthropic.status)
    expect(global.status).toBe('hard')
  })

  it('every resolved scope names its basis; product/agent say so instead of implying one', () => {
    const db = getDb()
    mixedProviderFixture()
    const config = baseConfig({ budgets: [
      { id: 'g', scope: 'global', amount: 100000 },
      { id: 'p', scope: 'provider', scope_ref: 'anthropic', amount: 100000 },
      { id: 'c', scope: 'category', scope_ref: 'usage', amount: 100000 },
      { id: 's', scope: 'source', scope_ref: 'anthropic-api', amount: 100000 },
      { id: 'prod', scope: 'product', scope_ref: 'marveen', amount: 100000 },
    ] })
    const statuses = getAllBudgetStatuses(db, config, NOW)
    expect(statuses.slice(0, 4).map(s => s.spend_basis)).toEqual(Array(4).fill('all_sources_headline'))
    const product = statuses[4]
    expect(product.spend_basis).toBe('not_resolved')
    expect(product.current_spend).toBe(0)
  })

  it('a pending_permission source contributes nothing to any scope (null spend is not a 0 measurement)', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    insertLine('aws-unknown', 'aws', 'hosting', 0, { confidence: 'pending_permission', actualSource: 'pending_permission' })
    const config = baseConfig({ budgets: [
      { id: 'g', scope: 'global', amount: 100000 },
      { id: 'aws', scope: 'provider', scope_ref: 'aws', amount: 100000 },
    ] })
    const [global, aws] = getAllBudgetStatuses(db, config, NOW)
    expect(aws.current_spend).toBe(0)
    expect(global.current_spend).toBe(10000)
  })
})

describe('upsertBudget / deleteBudget audit trail (CostOps Phase 3, GAP-11)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creating a new budget records a "created" audit entry', () => {
    const db = getDb()
    const config = baseConfig()
    const r = upsertBudget(db, config, { id: 'global-monthly', scope: 'global', amount: 50000 }, 'istvan', NOW)
    expect(r.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'global-monthly')
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('created')
    expect(history[0].before).toBeNull()
    expect(history[0].after!.amount).toBe(50000)
  })

  it('updating an existing budget records an "updated" entry with before/after', () => {
    const db = getDb()
    let config = baseConfig()
    upsertBudget(db, config, { id: 'b', scope: 'global', amount: 50000 }, 'istvan', NOW)
    config = { ...config, budgets: [{ id: 'b', scope: 'global', amount: 50000 }] } // simulate a reload
    const r2 = upsertBudget(db, config, { id: 'b', scope: 'global', amount: 70000 }, 'istvan', NOW + 10)
    expect(r2.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'b')
    expect(history).toHaveLength(2)
    expect(history[1].action).toBe('updated')
    expect(history[1].before!.amount).toBe(50000)
    expect(history[1].after!.amount).toBe(70000)
  })

  it('deleting a budget records a "deleted" entry with before only', () => {
    const db = getDb()
    let config = baseConfig()
    upsertBudget(db, config, { id: 'b', scope: 'global', amount: 50000 }, 'istvan', NOW)
    config = { ...config, budgets: [{ id: 'b', scope: 'global', amount: 50000 }] }
    const r = deleteBudget(db, config, 'b', 'istvan', NOW + 10)
    expect(r.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'b')
    expect(history[1].action).toBe('deleted')
    expect(history[1].before!.amount).toBe(50000)
    expect(history[1].after).toBeNull()
  })

  it('requires an actor for both upsert and delete', () => {
    const db = getDb()
    const config = baseConfig()
    expect(upsertBudget(db, config, { id: 'b', amount: 1000 }, '', NOW).status).toBe(400)
    expect(deleteBudget(db, config, 'b', '', NOW).status).toBe(400)
  })

  it('rejects a negative or non-numeric amount', () => {
    const db = getDb()
    const config = baseConfig()
    expect(upsertBudget(db, config, { id: 'b', amount: -5 }, 'istvan', NOW).status).toBe(400)
  })

  it('deleteBudget 404s on an unknown id', () => {
    const db = getDb()
    const config = baseConfig()
    const r = deleteBudget(db, config, 'ghost', 'istvan', NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('getBudgetAuditHistory with no id returns every budget\'s history', () => {
    const db = getDb()
    const config = baseConfig()
    upsertBudget(db, config, { id: 'a', amount: 1000 }, 'istvan', NOW)
    upsertBudget(db, config, { id: 'b', amount: 2000 }, 'istvan', NOW + 1)
    expect(getBudgetAuditHistory(db)).toHaveLength(2)
  })
})
