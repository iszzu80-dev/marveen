// CostOps Phase 4 -- monthly portfolio review: reads CostOps only, agreement
// assertion against the dec9ae64 pattern.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { monthWindow } from '../costops/ledger.js'
import { buildMonthlyPortfolioReview, checkSourceTotalsAgreement } from '../costops/monthly-portfolio-review.js'
import type { CostOpsConfig } from '../costops/config.js'
import type { PackageInventoryEntry, ProvenancedNumber } from '../costops/package-inventory.js'
import type { FxEvidenceContext } from '../costops/portfolio-recommendation.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

function cfg(): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }
}

function seedRenderSource(db: ReturnType<typeof getDb>) {
  const win = monthWindow(NOW)
  db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
    VALUES ('render-hosting','Render hosting','render','hosting','HUF',1,?,?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at,actual_source)
    VALUES ('render-hosting',?,?,'hosting','Render hosting',12000,'HUF','actual_invoice',?,'render|9001|2026-07',?,'email_invoice')`)
    .run(win.start, win.end, NOW, NOW)
}

function num(over: Partial<ProvenancedNumber> = {}): ProvenancedNumber {
  return { value: 90, currency: 'EUR', provenance: 'invoice', as_of: '2026-07-01', source_note: null, ...over }
}

function pkg(over: Partial<PackageInventoryEntry> = {}): PackageInventoryEntry {
  return {
    id: 'anthropic-max-5x', kind: 'held', provider: 'anthropic', name: 'Claude Max 5x',
    price: num(),
    contract_granularity: 'monthly', renewal_date: '2026-08-01',
    quota_shape: 'session_and_weekly_pct', quota_limit: null,
    overage_available: false, overage_rate: null, usage_credit_available: false,
    enabled_for_routing: true,
    ...over,
  }
}

function fxCtx(over: Partial<FxEvidenceContext> = {}): FxEvidenceContext {
  return { fxRates: { USD: 360 }, fxRateRecords: [], ...over }
}

describe('checkSourceTotalsAgreement -- the load-bearing agreement guard', () => {
  it('a consistent summary (sources sum to the headline total) is ok', () => {
    const r = checkSourceTotalsAgreement({
      all_sources: [{ spend: 12000 } as never, { spend: 4000 } as never],
      current_spend: 16000,
    })
    expect(r.ok).toBe(true)
    expect(r.discrepancy).toBe(0)
  })

  it('a genuinely disagreeing summary is caught, not silently accepted', () => {
    const r = checkSourceTotalsAgreement({
      all_sources: [{ spend: 12000 } as never, { spend: 4000 } as never],
      current_spend: 30459.6, // the exact dec9ae64 wrong-figure shape
    })
    expect(r.ok).toBe(false)
    expect(r.discrepancy).not.toBe(0)
  })

  it('a null source spend (pending_permission) is excluded from the sum, not treated as 0-causing a false mismatch', () => {
    const r = checkSourceTotalsAgreement({
      all_sources: [{ spend: 12000 } as never, { spend: null } as never],
      current_spend: 12000,
    })
    expect(r.ok).toBe(true)
  })
})

describe('buildMonthlyPortfolioReview -- reads CostOps only', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('period_total_huf is CostOps\' own current_spend, and source_totals sums to it', () => {
    const db = getDb()
    seedRenderSource(db)
    const review = buildMonthlyPortfolioReview(db, cfg(), NOW, [], fxCtx())
    expect(review.period_total_huf).toBe(12000)
    const summed = review.source_totals.reduce((s, r) => s + (r.spend ?? 0), 0)
    expect(summed).toBe(review.period_total_huf)
    expect(review.agreement.ok).toBe(true)
  })

  it('package_recommendations has exactly one entry per input package, regardless of CostOps state', () => {
    const db = getDb()
    seedRenderSource(db)
    const packages = [pkg({ id: 'a' }), pkg({ id: 'b', price: num({ value: 30000, currency: 'HUF' }) })]
    const review = buildMonthlyPortfolioReview(db, cfg(), NOW, packages, fxCtx())
    expect(review.package_recommendations).toHaveLength(2)
  })

  it('an empty CostOps ledger produces a review with zero spend, not an error', () => {
    const db = getDb()
    const review = buildMonthlyPortfolioReview(db, cfg(), NOW, [], fxCtx())
    expect(review.period_total_huf).toBe(0)
    expect(review.source_totals).toEqual([])
    expect(review.agreement.ok).toBe(true)
  })

  it('deterministic: identical db state + inputs produce identical output on repeat calls', () => {
    const db = getDb()
    seedRenderSource(db)
    const packages = [pkg()]
    const a = buildMonthlyPortfolioReview(db, cfg(), NOW, packages, fxCtx())
    const b = buildMonthlyPortfolioReview(db, cfg(), NOW, packages, fxCtx())
    expect(a).toEqual(b)
  })
})

describe('structurally -- never a second ledger, no LLM/network call', () => {
  it('the monthly review source issues no SQL of its own (no db.prepare) -- it only calls getCostSummary', () => {
    const src = readFileSync(join(__dirname, '../costops/monthly-portfolio-review.ts'), 'utf-8')
    expect(src.includes('db.prepare(')).toBe(false)
    expect(src.includes('getCostSummary')).toBe(true)
  })

  it('the monthly review source contains no fetch/exec/spawn/http call of any kind', () => {
    const src = readFileSync(join(__dirname, '../costops/monthly-portfolio-review.ts'), 'utf-8')
    const forbidden = /\bfetch\s*\(|\bexeca?\s*\(|\bspawn\s*\(|\bhttp\.request\b|\baxios\b|child_process/i
    expect(forbidden.test(src)).toBe(false)
  })
})
