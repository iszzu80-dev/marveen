// CostOps Phase 4 -- recommendation engine core, including the load-bearing
// FX-evidence guard and the portfolio non-omission guard.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkFxEvidence, evaluatePackage, buildPortfolioReport,
  type FxEvidenceContext,
} from '../costops/portfolio-recommendation.js'
import type { PackageInventoryEntry, ProvenancedNumber } from '../costops/package-inventory.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)
const WINDOW = { from: Math.floor(Date.UTC(2026, 6, 1) / 1000), to: NOW }

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

function ctx(over: Partial<FxEvidenceContext> = {}): FxEvidenceContext {
  return { fxRates: { USD: 360 }, fxRateRecords: [], ...over }
}

describe('checkFxEvidence -- the load-bearing guard', () => {
  it('HUF needs no conversion, always ok', () => {
    const r = checkFxEvidence(num({ value: 30000, currency: 'HUF' }), NOW, ctx())
    expect(r.ok).toBe(true)
    expect(r.huf_value).toBe(30000)
    expect(r.blocker).toBeNull()
  })

  it('a currency with NO rate at all is refused, not fabricated', () => {
    const r = checkFxEvidence(num({ value: 90, currency: 'EUR' }), NOW, ctx({ fxRates: {} }))
    expect(r.ok).toBe(false)
    expect(r.huf_value).toBeNull()
    expect(r.blocker).toMatch(/no FX rate configured for EUR/)
  })

  it('a currency with ONLY a flat static rate (no cost-arising-day record) is ALSO refused -- this is the exact load-bearing case', () => {
    const r = checkFxEvidence(num({ value: 90, currency: 'EUR' }), NOW, ctx({ fxRates: { EUR: 390 }, fxRateRecords: [] }))
    expect(r.ok).toBe(false)
    expect(r.huf_value).toBeNull()
    expect(r.blocker).toMatch(/flat static rate/)
    expect(r.blocker).toMatch(/97accbce/)
  })

  it('a currency WITH a genuine cost-arising-day rate on record converts correctly', () => {
    const r = checkFxEvidence(num({ value: 90, currency: 'EUR' }), NOW, ctx({
      fxRateRecords: [{ currency: 'EUR', rate: 385.5, fx_source: 'ecb', effective_date: WINDOW.from }],
    }))
    expect(r.ok).toBe(true)
    expect(r.huf_value).toBe(34695) // 90 * 385.5
    expect(r.blocker).toBeNull()
  })

  it('a null price value is refused (no value to convert)', () => {
    const r = checkFxEvidence(num({ value: null, currency: null, provenance: 'not_published' }), NOW, ctx())
    expect(r.ok).toBe(false)
    expect(r.blocker).toMatch(/no price published/)
  })
})

describe('evaluatePackage', () => {
  it('INSUFFICIENT_EVIDENCE for the Anthropic Max 5x EUR case (unconvertible today)', () => {
    const r = evaluatePackage(pkg(), WINDOW, ctx())
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE')
    expect(r.confidence).toBe('unknown')
    expect(r.blocker).not.toBeNull()
    expect(r.evidence).toHaveLength(1)
    expect(r.evidence[0].confidence).toBe('unknown')
  })

  it('a HUF-priced package with a genuine rate produces a decision verdict, not INSUFFICIENT_EVIDENCE', () => {
    const r = evaluatePackage(pkg({ price: num({ value: 30000, currency: 'HUF' }) }), WINDOW, ctx())
    expect(r.verdict).not.toBe('INSUFFICIENT_EVIDENCE')
    expect(r.evidence[0].value).toBe(30000)
  })

  it('every verdict carries evidence, confidence and window -- never undefined', () => {
    for (const p of [pkg(), pkg({ price: num({ value: 30000, currency: 'HUF' }) })]) {
      const r = evaluatePackage(p, WINDOW, ctx())
      expect(r.evidence).toBeDefined()
      expect(r.evidence.length).toBeGreaterThan(0)
      expect(r.confidence).toBeDefined()
      expect(r.window).toEqual(WINDOW)
      expect(r.generated_at).toBeDefined()
    }
  })

  it('confidence follows the WEAKEST evidence figure (estimated price -> estimated confidence, not measured)', () => {
    const r = evaluatePackage(pkg({ price: num({ value: 30000, currency: 'HUF', provenance: 'manual' }) }), WINDOW, ctx())
    expect(r.confidence).toBe('estimated')
    expect(r.blocker).not.toBeNull()
  })

  it('deterministic: identical inputs produce identical output on repeat calls', () => {
    const p = pkg({ price: num({ value: 30000, currency: 'HUF' }) })
    const r1 = evaluatePackage(p, WINDOW, ctx())
    const r2 = evaluatePackage(p, WINDOW, ctx())
    expect(r1).toEqual(r2)
  })
})

describe('buildPortfolioReport -- the non-omission guard', () => {
  it('a portfolio with an unconvertible package still includes it, with INSUFFICIENT_EVIDENCE -- never silently dropped', () => {
    const packages = [
      pkg({ id: 'anthropic-max-5x' }), // EUR, unconvertible today
      pkg({ id: 'huf-package', price: num({ value: 30000, currency: 'HUF' }) }),
    ]
    const report = buildPortfolioReport(packages, WINDOW, ctx())
    expect(report).toHaveLength(2) // load-bearing: same length as input, always
    const eurEntry = report.find(r => r.package_id === 'anthropic-max-5x')!
    expect(eurEntry.verdict).toBe('INSUFFICIENT_EVIDENCE')
    const hufEntry = report.find(r => r.package_id === 'huf-package')!
    expect(hufEntry.verdict).not.toBe('INSUFFICIENT_EVIDENCE')
  })

  it('report length always equals input length, for any mix of packages', () => {
    const packages = [pkg({ id: 'a' }), pkg({ id: 'b' }), pkg({ id: 'c', price: num({ value: null, currency: null, provenance: 'not_published' }) })]
    const report = buildPortfolioReport(packages, WINDOW, ctx())
    expect(report).toHaveLength(packages.length)
  })
})

describe('advisory-only, structurally', () => {
  it('the recommendation engine source contains no network/exec call that could change a plan', () => {
    const src = readFileSync(join(__dirname, '../costops/portfolio-recommendation.ts'), 'utf-8')
    const forbidden = /\bfetch\s*\(|\bexeca?\s*\(|\bspawn\s*\(|\bhttp\.request\b|\baxios\b|child_process/i
    expect(forbidden.test(src)).toBe(false)
  })
})
