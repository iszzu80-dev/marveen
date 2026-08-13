import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  monthWindow,
  hashRef,
  confidenceBucket,
  syncFixedCostsToLedger,
  getCostSummary,
} from '../costops/ledger.js'
import { validateConfig } from '../costops/config.js'
import type { CostOpsConfig } from '../costops/config.js'
import { createCorrection } from '../costops/correction.js'
import { recordInvoice } from '../costops/invoice.js'

// 2026-07-15T12:00:00Z -> mid-July, deterministic "now" for all summary tests.
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
      { source_id: 'openai', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 8000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, warning_threshold: 0.8, hard_threshold: 1.0, currency: 'HUF' },
    ],
    ...over,
  }
}

describe('costops month math', () => {
  it('computes UTC month window + days', () => {
    const w = monthWindow(NOW)
    expect(w.key).toBe('2026-07')
    expect(w.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000))
    expect(w.end).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000))
    expect(w.daysInMonth).toBe(31)
    // 14.5 days elapsed of 31
    expect(w.fractionElapsed).toBeCloseTo(14.5 / 31, 4)
  })
  it('honours an explicit month key', () => {
    expect(monthWindow(NOW, '2026-02').daysInMonth).toBe(28)
    expect(monthWindow(NOW, '2026-02').key).toBe('2026-02')
  })
})

describe('costops hashRef', () => {
  it('is deterministic and salt-sensitive and non-reversible', () => {
    expect(hashRef('salt', 'acct-123')).toBe(hashRef('salt', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toBe(hashRef('salt2', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toContain('acct-123')
    expect(hashRef('salt', 'acct-123')).toHaveLength(32)
  })
})

describe('costops confidenceBucket', () => {
  it('maps confidence tiers to buckets', () => {
    expect(confidenceBucket('manual')).toBe('fixed_manual')
    expect(confidenceBucket('actual_invoice')).toBe('provider')
    expect(confidenceBucket('provider_api')).toBe('provider')
    expect(confidenceBucket('estimate')).toBe('estimate')
    expect(confidenceBucket('local_usage')).toBe('estimate')
  })
})

describe('costops config validation', () => {
  it('accepts a valid config and applies defaults', () => {
    const r = validateConfig({ currency: 'HUF', fixed_costs: [{ source_id: 'x', amount: 100 }], budgets: [{ id: 'b', amount: 500 }] })
    expect(r.errors).toEqual([])
    expect(r.config.fixed_costs[0].confidence).toBe('manual')
    expect(r.config.fixed_costs[0].provider).toBe('other')
    expect(r.config.budgets[0].warning_threshold).toBe(0.8)
  })
  it('drops invalid entries with error notes, keeps valid ones', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'ok', amount: 100 }, { amount: 5 }, { source_id: 'neg', amount: -1 }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0].source_id).toBe('ok')
    expect(r.errors.length).toBe(2)
  })
  it('rejects non-monthly periods in v0.1', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'y', amount: 1, period: 'yearly' }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain('monthly')
  })
})

describe('costops ledger + summary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('syncs fixed costs idempotently (no duplicates on re-run)', () => {
    const db = getDb()
    const c = cfg()
    expect(syncFixedCostsToLedger(db, c, NOW)).toBe(2)
    syncFixedCostsToLedger(db, c, NOW)
    syncFixedCostsToLedger(db, c, NOW)
    const rows = db.prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }
    expect(rows.n).toBe(2) // still 2, not 6
    const sources = db.prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }
    expect(sources.n).toBe(2)
  })

  it('reflects updated config amounts on re-sync (upsert, not insert)', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const c2 = cfg({ fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 30000, period: 'monthly', confidence: 'manual', currency: 'HUF' }] })
    syncFixedCostsToLedger(db, c2, NOW)
    const row = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number }
    expect(row.billed_cost).toBe(30000)
  })

  it('computes a deterministic monthly summary (golden values)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.month).toBe('2026-07')
    expect(s.current_spend).toBe(30000)            // 22000 + 8000
    expect(s.forecast_month_end).toBe(30000)       // fixed = whole-month, no proration
    expect(s.breakdown.fixed_manual).toBe(30000)
    expect(s.breakdown.provider).toBe(0)
    expect(s.confidence_breakdown.manual).toBe(30000)
    expect(s.top_sources[0]).toEqual({ source_id: 'anthropic-max', name: 'Claude Max', spend: 22000 })
    expect(s.top_sources[1].source_id).toBe('openai')
    expect(s.budget?.amount).toBe(60000)
    expect(s.budget?.used_pct).toBe(0.5)
    expect(s.budget?.status).toBe('ok')
  })

  it('all_sources lists every configured source (not capped like top_sources)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.all_sources).toHaveLength(2) // both, even at 0 or any spend
    const ids = s.all_sources.map(x => x.source_id).sort()
    expect(ids).toEqual(['anthropic-max', 'openai'])
    const anthropic = s.all_sources.find(x => x.source_id === 'anthropic-max')!
    expect(anthropic.provider).toBe('anthropic')
    expect(anthropic.source_type).toBe('subscription')
    expect(anthropic.confidence).toBe('manual')
    expect(anthropic.spend).toBe(22000)
    expect(anthropic).toHaveProperty('name')
    // Card a1552362 (item 2): no fx conversion happened for this HUF-native line -> null, not false.
    expect(anthropic.fx_estimated).toBeNull()
  })

  // Card a1552362 (item 2): original_currency/fx_rate exist on the schema but had no derived
  // "is this rate an estimate" flag -- every fx_rate today comes from the static Render-pricing
  // config, never a rate embedded in the source document itself, so it's honestly always an
  // estimate once a conversion happened at all.
  it('fx_estimated is true once a real fx conversion is on the line, null when there is none', () => {
    const db = getDb()
    const c = cfg({ fixed_costs: [], budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('aws-usd','AWS','aws','usage','HUF',1,@now,@now)`).run({ now: NOW })
    const win = monthWindow(NOW)
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, actual_source, original_amount, original_currency, fx_rate, fx_date)
      VALUES ('aws-usd', @start, @end, 'invoice', 3600, 'HUF', 'actual_invoice', @now, @now, 'email_invoice', 10, 'USD', 360, @now)
    `).run({ start: win.start, end: win.end, now: NOW })
    const s = getCostSummary(db, c, NOW)
    const aws = s.all_sources.find(x => x.source_id === 'aws-usd')!
    expect(aws.fx_estimated).toBe(true)
  })

  it('classifies budget status at thresholds (display-only, no action)', () => {
    const db = getDb()
    // amount tuned so current_spend hits exactly 80% then 100% of a 10000 budget
    const warnCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 8000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db, warnCfg, NOW)
    expect(getCostSummary(db, warnCfg, NOW).budget?.status).toBe('warning') // 0.8 -> warning

    initDatabase(':memory:')
    const db2 = getDb()
    const hardCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 10000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db2, hardCfg, NOW)
    expect(getCostSummary(db2, hardCfg, NOW).budget?.status).toBe('hard') // 1.0 -> hard

    initDatabase(':memory:')
    const db3 = getDb()
    const okCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 7999, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db3, okCfg, NOW)
    expect(getCostSummary(db3, okCfg, NOW).budget?.status).toBe('ok') // 0.7999 -> ok
  })

  it('prorates usage-type line items to month-end for forecast', () => {
    const db = getDb()
    // insert a usage line directly (source + line) representing partial-month usage
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('u','U','other','usage','HUF',1,?,?)").run(NOW, NOW)
    const w = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('u',?,?,'usage','U',1450,'HUF','estimate',?,'u|2026-07',?)`).run(w.start, w.end, NOW, NOW)
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.current_spend).toBe(1450)
    // forecast = 1450 / fractionElapsed (14.5/31) ~= 3100
    expect(s.forecast_month_end).toBeGreaterThan(3000)
    expect(s.breakdown.estimate).toBe(1450)
  })

  it('reports token_usage as VOLUME only, never priced', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    const ins = db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,?,?,?)")
    ins.run('marveen', 's1', w.start + 100, 1000, 5000, 200, 50)
    ins.run('qa', 's2', w.start + 200, 500, 2000, 0, 0)
    ins.run('marveen', 's3', w.end + 100, 999, 999, 0, 0) // next month, excluded
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.token_usage.calls).toBe(2)
    expect(s.token_usage.agents).toBe(2)
    expect(s.token_usage.input_tokens).toBe(1500)
    expect(s.token_usage.output_tokens).toBe(7000)
    expect(s.token_usage.note).toContain('not priced')
    // token usage must NOT contribute to money
    expect(s.current_spend).toBe(0)
  })
})

// 2026-08-12 review, COS-CORE-C1: the invoice->correction->sync interplay.
// syncFixedCostsToLedger runs as a side effect of every GET /api/costs/summary
// read, and correction.ts frees the voided row's dedup_key slot -- so before
// the fix, the very next dashboard READ re-inserted the config amount next to
// the corrected figure and the month stayed double-booked forever.
describe('syncFixedCostsToLedger vs corrections (COS-CORE-C1)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a re-sync never resurrects a fixed line a correction superseded (spend stable across repeated summary reads)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const fixedLine = db.prepare(`SELECT id FROM cost_line_items WHERE dedup_key = ?`).get(`fixed|anthropic-max|2026-07`) as { id: number }
    // the invoice arrives: 22000 was the estimate, 23500 is the real charge
    const corr = createCorrection(db, { originalLineId: fixedLine.id, newAmount: 23500, reason: 'invoice arrived' }, { now: NOW + 100 })
    expect(corr.ok).toBe(true)

    // next dashboard read: sync + summary. The freed dedup slot must NOT be refilled.
    syncFixedCostsToLedger(db, c, NOW + 200)
    const s1 = getCostSummary(db, c, NOW + 200)
    expect(s1.current_spend).toBe(31500) // 23500 corrected + 8000 openai -- NOT 45500

    // and the read after that (the original repro's failure point)
    syncFixedCostsToLedger(db, c, NOW + 300)
    const s2 = getCostSummary(db, c, NOW + 300)
    expect(s2.current_spend).toBe(31500)
    const active = db.prepare(`SELECT COUNT(*) as n FROM cost_line_items WHERE source_id = 'anthropic-max' AND voided_at IS NULL`).get() as { n: number }
    expect(active.n).toBe(1) // only the correction; the config line stayed out
  })

  it('full review repro: fixed cost -> recorded invoice corrects it -> two more summary reads keep the invoice amount', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const r = recordInvoice(db, {
      source_id: 'anthropic-max', provider: 'anthropic', invoice_ref: 'INV-2026-07',
      billing_period_start: monthWindow(NOW).start, billing_period_end: monthWindow(NOW).end,
      currency: 'HUF', gross_amount: 23500,
    }, { now: NOW + 100, salt: 'test-salt' })
    expect(r.ok).toBe(true)

    for (const at of [NOW + 200, NOW + 300]) {
      syncFixedCostsToLedger(db, c, at)
      const s = getCostSummary(db, c, at)
      expect(s.current_spend).toBe(31500) // invoice 23500 + openai 8000
      expect(s.all_sources.find(x => x.source_id === 'anthropic-max')?.spend).toBe(23500)
    }
  })

  it('the skip is per source+month: sibling sources still sync, and the next month gets a fresh fixed line', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const fixedLine = db.prepare(`SELECT id FROM cost_line_items WHERE dedup_key = ?`).get(`fixed|anthropic-max|2026-07`) as { id: number }
    createCorrection(db, { originalLineId: fixedLine.id, newAmount: 23500, reason: 'invoice arrived' }, { now: NOW + 100 })

    // July re-sync: openai upserts (count 1), anthropic-max is skipped
    expect(syncFixedCostsToLedger(db, c, NOW + 200)).toBe(1)

    // August is a fresh dedup slot -- the config figure applies again
    const augNow = NOW + 32 * 86400
    expect(syncFixedCostsToLedger(db, c, augNow)).toBe(2)
    const augLine = db.prepare(`SELECT billed_cost FROM cost_line_items WHERE dedup_key = ?`).get(`fixed|anthropic-max|2026-08`) as { billed_cost: number }
    expect(augLine.billed_cost).toBe(22000)
  })

  it('config amount changes still flow to an UNcorrected fixed line', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const fixedLine = db.prepare(`SELECT id FROM cost_line_items WHERE dedup_key = ?`).get(`fixed|anthropic-max|2026-07`) as { id: number }
    createCorrection(db, { originalLineId: fixedLine.id, newAmount: 23500, reason: 'invoice arrived' }, { now: NOW + 100 })
    const c2 = cfg({ fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 25000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
      { source_id: 'openai', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 9000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ] })
    syncFixedCostsToLedger(db, c2, NOW + 200)
    // corrected source keeps the corrected amount; uncorrected sibling takes the new config amount
    expect((db.prepare(`SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max' AND voided_at IS NULL`).get() as { billed_cost: number }).billed_cost).toBe(23500)
    expect((db.prepare(`SELECT billed_cost FROM cost_line_items WHERE dedup_key = 'fixed|openai|2026-07'`).get() as { billed_cost: number }).billed_cost).toBe(9000)
  })
})

// 2026-08-12 review, COS-CORE-H1 (GAP-13 freeze bypass): the summary route's
// read-time sync wrote into closed months -- a config edit after close
// rewrote the closed month's rows on the next mere VIEW of it.
describe('syncFixedCostsToLedger into a closed month (COS-CORE-H1)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('no-ops for a closed month: config change + summary read leave the closed month untouched', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO period_status (month, status, updated_at) VALUES ('2026-07', 'closed', ?)`).run(NOW + 100)

    const c2 = cfg({ fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 30000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ] })
    expect(syncFixedCostsToLedger(db, c2, NOW + 200)).toBe(0)
    const row = db.prepare(`SELECT billed_cost, data_freshness FROM cost_line_items WHERE dedup_key = 'fixed|anthropic-max|2026-07'`).get() as { billed_cost: number; data_freshness: number }
    expect(row.billed_cost).toBe(22000) // frozen at the close-time amount
    expect(row.data_freshness).toBe(NOW) // not even touched
    // the read path itself still works and reports the frozen numbers
    expect(getCostSummary(db, c2, NOW + 200).current_spend).toBe(30000) // 22000 + 8000, unchanged
  })

  it('provisional and reopened months keep open-month write rules', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO period_status (month, status, updated_at) VALUES ('2026-07', 'closed', ?)`).run(NOW + 100)
    expect(syncFixedCostsToLedger(db, c, NOW + 200)).toBe(0)
    db.prepare(`UPDATE period_status SET status = 'reopened', updated_at = ? WHERE month = '2026-07'`).run(NOW + 300)
    expect(syncFixedCostsToLedger(db, c, NOW + 400)).toBe(2)
    db.prepare(`UPDATE period_status SET status = 'provisional', updated_at = ? WHERE month = '2026-07'`).run(NOW + 500)
    expect(syncFixedCostsToLedger(db, c, NOW + 600)).toBe(2)
  })
})

describe('provider_sync status vocabulary (COS-OPS-H3 / COS-CORE-M2)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function insRun(provider: string, collector: string, startedAt: number, status: string, opts: { imported?: number; errorCode?: string | null } = {}) {
    getDb().prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(provider, collector, startedAt, startedAt, status, opts.imported ?? 0, opts.errorCode ?? null)
  }
  const psFor = (provider: string) => getCostSummary(getDb(), cfg({ fixed_costs: [] }), NOW).provider_sync.find(p => p.provider === provider)

  it('a benign latest run (skipped/locked/dry_run) is NOT failed; with a prior ok the provider stays ok', () => {
    for (const [i, status] of (['skipped', 'locked', 'dry_run'] as const).entries()) {
      const provider = `p${i}`
      insRun(provider, `${provider}-costs`, NOW - 7200, 'ok', { imported: 2 })
      insRun(provider, `${provider}-costs`, NOW - 60, status)
      const ps = psFor(provider)!
      expect(ps.status).toBe('ok')
      // detail fields come from the health-bearing ok run, not the benign tick
      expect(ps.imported_count).toBe(2)
    }
  })

  it('a provider with ONLY benign history reports no_data -- neither failed nor a fabricated ok', () => {
    insRun('anthropic', 'anthropic-usage-snapshot', NOW - 60, 'skipped')
    const ps = psFor('anthropic')!
    expect(ps.status).toBe('no_data')
    expect(ps.last_failed).toBeNull() // the (formerly nonexistent-'failed'-filtering) lastFail lookup sees no failure
  })

  it('an error latest run is still failed (existing behavior preserved), and last_failed uses the REAL failure statuses', () => {
    insRun('openai', 'openai-costs', NOW - 3600, 'error', { errorCode: 'ETIMEDOUT' })
    const ps = psFor('openai')!
    expect(ps.status).toBe('failed')
    expect(ps.error_code).toBe('ETIMEDOUT')
    expect(ps.last_failed).toBe(NOW - 3600)
  })

  it('error -> skipped stays failed: a benign tick must not mask an earlier real failure', () => {
    insRun('openai', 'openai-costs', NOW - 3600, 'error', { errorCode: '401' })
    insRun('openai', 'openai-costs', NOW - 60, 'skipped')
    const ps = psFor('openai')!
    expect(ps.status).toBe('failed')
    expect(ps.error_code).toBe('401')
  })

  it('two collectors on one provider do not flap: daily ok cost report + hourly skipped snapshot -> stable ok', () => {
    insRun('anthropic', 'anthropic-cost-report', NOW - 20 * 3600, 'ok', { imported: 3 })
    for (let h = 19; h >= 1; h--) insRun('anthropic', 'anthropic-usage-snapshot', NOW - h * 3600, 'skipped')
    const ps = psFor('anthropic')!
    expect(ps.status).toBe('ok')
    expect(ps.collector_name).toBe('anthropic-cost-report') // health row represents the provider, not the benign tick
    expect(ps.imported_count).toBe(3)
    // last_sync still reflects the newest ATTEMPT of any status (the loop is alive)
    expect(ps.last_sync).toBe(NOW - 3600)
  })

  it('a sibling collector\'s later ok does not mask another collector\'s standing failure', () => {
    insRun('anthropic', 'anthropic-cost-report', NOW - 7200, 'error', { errorCode: 'rate_limited' })
    insRun('anthropic', 'anthropic-usage-snapshot', NOW - 60, 'ok', { imported: 1 })
    const ps = psFor('anthropic')!
    expect(ps.status).toBe('failed')
    expect(ps.collector_name).toBe('anthropic-cost-report')
    expect(ps.error_code).toBe('rate_limited')
  })
})
