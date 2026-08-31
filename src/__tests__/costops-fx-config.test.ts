// Card 23912ca4 (HALF 2): the provider-neutral fx rate config. Exercises the
// real fs paths (store/costops-fx.json, store/costops-render-pricing.json)
// under this worktree's own isolated store/ directory -- never the shared
// checkout's store/, and cleaned up around every test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, storePath } from '../config.js'
import { loadFxRates } from '../costops/fx-config.js'
import { initDatabase, getDb } from '../db.js'
import { syncAnthropicCostReport } from '../costops/collectors/anthropic.js'
import { syncGitHubCollector } from '../costops/collectors/github.js'
import { syncDeepSeekBalance } from '../costops/collectors/deepseek.js'

const STORE = join(PROJECT_ROOT, 'store')
const FX_CONFIG_PATH = () => storePath('costops-fx.json')
const RENDER_PRICING_PATH = () => storePath('costops-render-pricing.json')

function cleanup(): void {
  rmSync(FX_CONFIG_PATH(), { force: true })
  rmSync(RENDER_PRICING_PATH(), { force: true })
}

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  cleanup()
})
afterEach(cleanup)

describe('loadFxRates -- the loud-unset requirement (card 23912ca4)', () => {
  it('no config anywhere -> every currency is UNSET, not a fabricated 0', () => {
    const { rates, source } = loadFxRates()
    expect(rates).toEqual({})
    expect(source).toBe('unset')
    expect(rates.USD).toBeUndefined() // NOT 0 -- genuinely absent
  })

  it('a real store/costops-fx.json is the source of truth', () => {
    writeFileSync(FX_CONFIG_PATH(), JSON.stringify({ version: 1, rates: { USD: 355, EUR: 410 } }))
    const { rates, source } = loadFxRates()
    expect(rates).toEqual({ USD: 355, EUR: 410 })
    expect(source).toBe('costops_fx_config')
  })

  it('a zero or negative rate in the file is DROPPED, not read as a valid 0', () => {
    writeFileSync(FX_CONFIG_PATH(), JSON.stringify({ version: 1, rates: { USD: 0, EUR: -5, GBP: 450 } }))
    const { rates } = loadFxRates()
    expect(rates).toEqual({ GBP: 450 })
    expect(rates.USD).toBeUndefined()
    expect(rates.EUR).toBeUndefined()
  })

  it('a malformed JSON file is treated as absent (unset), never throws', () => {
    writeFileSync(FX_CONFIG_PATH(), '{ not valid json')
    expect(() => loadFxRates()).not.toThrow()
    expect(loadFxRates().rates).toEqual({})
  })

  // Card 23912ca4's exact scenario: Istvan deletes the Render account and a
  // reasonable cleanup deletes costops-render-pricing.json. Before this file
  // existed, that silently zeroed every USD conversion in CostOps.
  it('deleting the legacy render-pricing file produces a LOUD unset state, never a silent zero', () => {
    // No costops-fx.json, no render-pricing file (the post-cleanup state).
    const { rates, source } = loadFxRates()
    expect(rates.USD).toBeUndefined()
    expect(source).toBe('unset')
    // Explicitly not the old failure mode: rates.USD is undefined, not 0.
    expect(rates.USD === 0).toBe(false)
  })

  it('renaming/moving the fx source file (simulated: config never migrated) is also a loud unset, not a zero', () => {
    // A render-pricing file that HAS an fx_usd_huf, but costops-fx.json already
    // exists (so no migration fires) and does not carry USD -- e.g. an operator
    // hand-edited it and dropped the key by mistake.
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, fx_usd_huf: 360 }))
    writeFileSync(FX_CONFIG_PATH(), JSON.stringify({ version: 1, rates: { EUR: 400 } }))
    const { rates } = loadFxRates()
    expect(rates.USD).toBeUndefined()
    expect(rates.EUR).toBe(400)
  })
})

describe('one-time migration from the legacy Render pricing file', () => {
  it('seeds costops-fx.json from fx_usd_huf when the new file does not exist yet', () => {
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, currency: 'HUF', fx_usd_huf: 360, plans: {} }))
    expect(existsSync(FX_CONFIG_PATH())).toBe(false)
    const { rates, source } = loadFxRates()
    expect(rates.USD).toBe(360)
    expect(source).toBe('costops_fx_config')
    // The migration actually persisted -- a second load with no legacy file
    // still finds the rate, proving it is durable, not recomputed each call.
    expect(existsSync(FX_CONFIG_PATH())).toBe(true)
    const persisted = JSON.parse(readFileSync(FX_CONFIG_PATH(), 'utf-8'))
    expect(persisted.rates.USD).toBe(360)
  })

  it('migrates both USD and EUR when both are present', () => {
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, fx_usd_huf: 360, fx_eur_huf: 400 }))
    expect(loadFxRates().rates).toEqual({ USD: 360, EUR: 400 })
  })

  it('does NOT migrate a zero/absent legacy rate -- stays honestly unset', () => {
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, fx_usd_huf: 0 }))
    expect(loadFxRates().rates).toEqual({})
    // No file was written for an all-zero legacy source -- nothing worth
    // persisting, and no empty file masking a future real migration.
    expect(existsSync(FX_CONFIG_PATH())).toBe(false)
  })

  it('does NOT overwrite an existing costops-fx.json even if the legacy file has a different value', () => {
    writeFileSync(FX_CONFIG_PATH(), JSON.stringify({ version: 1, rates: { USD: 999 } }))
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, fx_usd_huf: 360 }))
    expect(loadFxRates().rates.USD).toBe(999) // the explicit config wins, migration is one-time-only
  })

  it('is idempotent -- calling loadFxRates twice after migration does not change the rate or re-migrate', () => {
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, fx_usd_huf: 360 }))
    const first = loadFxRates()
    const second = loadFxRates()
    expect(first.rates).toEqual(second.rates)
    expect(second.rates.USD).toBe(360)
  })

  it('is safe when the legacy file is missing entirely (fresh install, nothing to migrate)', () => {
    expect(() => loadFxRates()).not.toThrow()
    expect(loadFxRates().rates).toEqual({})
  })
})

// COS-OPS-M6: the collectors' OWN default rate lookup, exercised through the
// real files rather than the injected `fxUsdHuf` dep every other collector test
// uses -- the injected dep is exactly what hid this: anthropic/github/deepseek
// still read the Render plan-pricing file's fx_usd_huf while openai read
// costops-fx.json, and no test ever ran the un-injected path. Lives in THIS
// file because it is the one suite that owns (and cleans up) these two store
// paths; a second file racing on them would be flaky.
//
// Scenario under test is the dangerous one from COS-OPS-H4: the Render account
// is gone and costops-render-pricing.json has been emptied/zeroed. With the old
// wiring that silently zeroed three collectors' fx.
describe('COS-OPS-M6: every collector reads its USD rate from store/costops-fx.json', () => {
  const NOW = Math.floor(Date.UTC(2026, 6, 10) / 1000)
  const FX = 355  // deliberately NOT the 360 the legacy file usually carries

  function withFxConfigAndZeroedRenderPricing(): void {
    writeFileSync(FX_CONFIG_PATH(), JSON.stringify({ version: 1, rates: { USD: FX } }))
    // The post-cleanup Render file: still present, but carrying no fx fact.
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, currency: 'HUF', fx_usd_huf: 0, fx_eur_huf: 0, plans: {} }))
  }

  beforeEach(() => { initDatabase(':memory:') })

  const anthropicFixture = {
    data: [
      { starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [{ amount: 12.5, currency: 'USD', cost_type: 'tokens' }] },
      { starting_at: '2026-07-02T00:00:00Z', ending_at: '2026-07-03T00:00:00Z', results: [{ amount: 7.5, currency: 'USD', cost_type: 'tokens' }] },
    ],
    has_more: false,
  }

  const githubReport = { usageItems: [{ date: '2026-07-01', product: 'actions', sku: 'x', quantity: 1, unitType: 'min', netAmount: 5 }] }
  const deepseekBalance = (v: string) => async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: v }] })

  it('anthropic converts at the costops-fx.json rate even with a zeroed render-pricing file', async () => {
    withFxConfigAndZeroedRenderPricing()
    const db = getDb()
    // No fxUsdHuf dep -> the collector's own lookup decides.
    const res = await syncAnthropicCostReport(db, NOW, { apiKey: 'fixture-key', httpGetJson: async () => anthropicFixture })
    expect(res.ok).toBe(true)
    const line = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-api'").get() as { billed_cost: number }
    expect(line.billed_cost).toBe(20 * FX)  // (12.5 + 7.5) USD, NOT 20 * 0
  })

  it('github converts at the costops-fx.json rate even with a zeroed render-pricing file', async () => {
    withFxConfigAndZeroedRenderPricing()
    const db = getDb()
    const res = await syncGitHubCollector(db, NOW, { apiKey: 'ghp-stub', billingUser: 'istvan', httpGetJson: async () => githubReport })
    expect(res.ok).toBe(true)
    const line = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='github'").get() as { billed_cost: number }
    expect(line.billed_cost).toBe(5 * FX)
  })

  it('deepseek converts at the costops-fx.json rate even with a zeroed render-pricing file', async () => {
    withFxConfigAndZeroedRenderPricing()
    const db = getDb()
    // Two snapshots: the derived MTD spend (the drop) is what gets converted.
    await syncDeepSeekBalance(db, NOW, { apiKey: 'k', httpGetJson: deepseekBalance('5.00') })
    await syncDeepSeekBalance(db, NOW + 86400, { apiKey: 'k', httpGetJson: deepseekBalance('3.20') })
    const line = db.prepare("SELECT billed_cost, fx_rate FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number; fx_rate: number | null }
    expect(line.billed_cost).toBeCloseTo(1.8 * FX, 2)  // 1.80 USD spent, NOT 0
    expect(line.fx_rate).toBe(FX)
  })

  it('an fx rate configured ONLY in the legacy render-pricing file still works -- it seeds costops-fx.json first', async () => {
    // The upgrade path: an operator who never touched the new file. The rate is
    // not lost, and it lands in the new canonical home rather than being read
    // from the Render config a second time.
    writeFileSync(RENDER_PRICING_PATH(), JSON.stringify({ version: 1, currency: 'HUF', fx_usd_huf: 360, fx_eur_huf: 0, plans: {} }))
    expect(existsSync(FX_CONFIG_PATH())).toBe(false)
    const db = getDb()
    const res = await syncGitHubCollector(db, NOW, { apiKey: 'ghp-stub', billingUser: 'istvan', httpGetJson: async () => githubReport })
    expect(res.ok).toBe(true)
    const line = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='github'").get() as { billed_cost: number }
    expect(line.billed_cost).toBe(5 * 360)
    expect(existsSync(FX_CONFIG_PATH())).toBe(true)
  })

  // The other half of the guarantee: with NOTHING configured the collectors
  // must still refuse loudly. This is the fx=0 guard, now driven by an unset
  // costops-fx.json instead of an injected 0.
  it('no costops-fx.json (and no legacy file) is a loud blocker naming the real source, for anthropic and github', async () => {
    const db = getDb()
    const a = await syncAnthropicCostReport(db, NOW, { apiKey: 'fixture-key', httpGetJson: async () => anthropicFixture })
    expect(a.ok).toBe(false)
    expect(a.status).toBe('error')
    expect(a.error).toContain('store/costops-fx.json')
    expect(a.error).not.toContain('costops-render-pricing.json')

    const g = await syncGitHubCollector(db, NOW, { apiKey: 'ghp-stub', billingUser: 'istvan', httpGetJson: async () => githubReport })
    expect(g.ok).toBe(false)
    expect(g.status).toBe('error')
    expect(g.error).toContain('store/costops-fx.json')
    expect(g.error).not.toContain('costops-render-pricing.json')

    expect((db.prepare('SELECT COUNT(*) c FROM cost_line_items').get() as { c: number }).c).toBe(0)
  })

  it('no costops-fx.json means deepseek books no fabricated HUF amount and retains no fx provenance', async () => {
    const db = getDb()
    await syncDeepSeekBalance(db, NOW, { apiKey: 'k', httpGetJson: deepseekBalance('5.00') })
    await syncDeepSeekBalance(db, NOW + 86400, { apiKey: 'k', httpGetJson: deepseekBalance('3.20') })
    const line = db.prepare("SELECT billed_cost, fx_rate, original_amount FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number; fx_rate: number | null; original_amount: number | null }
    // Unchanged pre-existing behaviour (deepseek has no hard fx blocker): the
    // HUF amount is 0, but nothing claims a conversion happened.
    expect(line.billed_cost).toBe(0)
    expect(line.fx_rate).toBeNull()
    expect(line.original_amount).toBeNull()
  })
})
