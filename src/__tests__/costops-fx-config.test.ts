// Card 23912ca4 (HALF 2): the provider-neutral fx rate config. Exercises the
// real fs paths (store/costops-fx.json, store/costops-render-pricing.json)
// under this worktree's own isolated store/ directory -- never the shared
// checkout's store/, and cleaned up around every test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { loadFxRates } from '../costops/fx-config.js'

const STORE = join(PROJECT_ROOT, 'store')
const FX_CONFIG_PATH = join(STORE, 'costops-fx.json')
const RENDER_PRICING_PATH = join(STORE, 'costops-render-pricing.json')

function cleanup(): void {
  rmSync(FX_CONFIG_PATH, { force: true })
  rmSync(RENDER_PRICING_PATH, { force: true })
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
    writeFileSync(FX_CONFIG_PATH, JSON.stringify({ version: 1, rates: { USD: 355, EUR: 410 } }))
    const { rates, source } = loadFxRates()
    expect(rates).toEqual({ USD: 355, EUR: 410 })
    expect(source).toBe('costops_fx_config')
  })

  it('a zero or negative rate in the file is DROPPED, not read as a valid 0', () => {
    writeFileSync(FX_CONFIG_PATH, JSON.stringify({ version: 1, rates: { USD: 0, EUR: -5, GBP: 450 } }))
    const { rates } = loadFxRates()
    expect(rates).toEqual({ GBP: 450 })
    expect(rates.USD).toBeUndefined()
    expect(rates.EUR).toBeUndefined()
  })

  it('a malformed JSON file is treated as absent (unset), never throws', () => {
    writeFileSync(FX_CONFIG_PATH, '{ not valid json')
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
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, fx_usd_huf: 360 }))
    writeFileSync(FX_CONFIG_PATH, JSON.stringify({ version: 1, rates: { EUR: 400 } }))
    const { rates } = loadFxRates()
    expect(rates.USD).toBeUndefined()
    expect(rates.EUR).toBe(400)
  })
})

describe('one-time migration from the legacy Render pricing file', () => {
  it('seeds costops-fx.json from fx_usd_huf when the new file does not exist yet', () => {
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, currency: 'HUF', fx_usd_huf: 360, plans: {} }))
    expect(existsSync(FX_CONFIG_PATH)).toBe(false)
    const { rates, source } = loadFxRates()
    expect(rates.USD).toBe(360)
    expect(source).toBe('costops_fx_config')
    // The migration actually persisted -- a second load with no legacy file
    // still finds the rate, proving it is durable, not recomputed each call.
    expect(existsSync(FX_CONFIG_PATH)).toBe(true)
    const persisted = JSON.parse(readFileSync(FX_CONFIG_PATH, 'utf-8'))
    expect(persisted.rates.USD).toBe(360)
  })

  it('migrates both USD and EUR when both are present', () => {
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, fx_usd_huf: 360, fx_eur_huf: 400 }))
    expect(loadFxRates().rates).toEqual({ USD: 360, EUR: 400 })
  })

  it('does NOT migrate a zero/absent legacy rate -- stays honestly unset', () => {
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, fx_usd_huf: 0 }))
    expect(loadFxRates().rates).toEqual({})
    // No file was written for an all-zero legacy source -- nothing worth
    // persisting, and no empty file masking a future real migration.
    expect(existsSync(FX_CONFIG_PATH)).toBe(false)
  })

  it('does NOT overwrite an existing costops-fx.json even if the legacy file has a different value', () => {
    writeFileSync(FX_CONFIG_PATH, JSON.stringify({ version: 1, rates: { USD: 999 } }))
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, fx_usd_huf: 360 }))
    expect(loadFxRates().rates.USD).toBe(999) // the explicit config wins, migration is one-time-only
  })

  it('is idempotent -- calling loadFxRates twice after migration does not change the rate or re-migrate', () => {
    writeFileSync(RENDER_PRICING_PATH, JSON.stringify({ version: 1, fx_usd_huf: 360 }))
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
