// CostOps Phase 4 -- package inventory validation.
import { describe, it, expect } from 'vitest'
import { validatePackageInventoryConfig } from '../costops/package-inventory.js'

function pkg(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', kind: 'held', provider: 'anthropic', name: 'Claude Max',
    price: { value: 90, currency: 'EUR', provenance: 'invoice', as_of: '2026-07-01', source_note: 'invoice' },
    contract_granularity: 'monthly', renewal_date: '2026-08-01',
    quota_shape: 'session_and_weekly_pct', quota_limit: null,
    overage_available: false, overage_rate: null, usage_credit_available: false,
    enabled_for_routing: true,
    ...over,
  }
}

describe('package inventory validation', () => {
  it('accepts a valid held entry', () => {
    const { config, errors } = validatePackageInventoryConfig({ version: 1, packages: [pkg()] })
    expect(errors).toEqual([])
    expect(config.packages).toHaveLength(1)
    expect(config.packages[0].price.value).toBe(90)
    expect(config.packages[0].price.currency).toBe('EUR')
  })

  it('never fabricates a price -- value:null stays null, currency stays null', () => {
    const { config } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ price: { value: null, currency: null, provenance: 'not_published', as_of: null, source_note: 'no invoice yet' } })],
    })
    expect(config.packages[0].price.value).toBeNull()
    expect(config.packages[0].price.currency).toBeNull()
    expect(config.packages[0].price.provenance).toBe('not_published')
  })

  it('rejects a negative price value, drops the entry (not silently zeroed)', () => {
    const { config, errors } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ price: { value: -5, currency: 'USD', provenance: 'manual', as_of: '2026-07-01', source_note: null } })],
    })
    expect(config.packages).toHaveLength(0)
    expect(errors.some(e => e.includes('non-negative'))).toBe(true)
  })

  it('requires currency when a price value is present', () => {
    const { errors } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ price: { value: 10, currency: null, provenance: 'manual', as_of: '2026-07-01', source_note: null } })],
    })
    expect(errors.some(e => e.includes('currency is required'))).toBe(true)
  })

  it('a malformed price.as_of date rejects the WHOLE entry, like a negative price value -- price is required, so any malformed sub-field on it is worse than absent', () => {
    const { config, errors } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ price: { value: 10, currency: 'USD', provenance: 'manual', as_of: '07/01/2026', source_note: null } })],
    })
    expect(config.packages).toHaveLength(0)
    expect(errors.some(e => e.includes('as_of'))).toBe(true)
  })

  it('a malformed quota_limit.as_of date (an OPTIONAL field) nulls just that field, keeps the rest of the entry', () => {
    const { config } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ quota_limit: { value: 500000, currency: null, provenance: 'manual', as_of: 'not-a-date', source_note: null } })],
    })
    expect(config.packages).toHaveLength(1)
    expect(config.packages[0].quota_limit?.as_of).toBeNull()
    // value survives -- only the malformed sub-field is corrected, the optional
    // field as a whole is not thrown away over one bad property.
    expect(config.packages[0].quota_limit?.value).toBe(500000)
  })

  // -- the structural guard: an external_market_reference can NEVER be enabled_for_routing --

  it('STRUCTURAL: external_market_reference is forced enabled_for_routing:false even if the config file says true', () => {
    const { config } = validatePackageInventoryConfig({
      version: 1,
      packages: [pkg({ kind: 'external_market_reference', id: 'market-ref', enabled_for_routing: true })],
    })
    expect(config.packages).toHaveLength(1)
    expect(config.packages[0].kind).toBe('external_market_reference')
    expect(config.packages[0].enabled_for_routing).toBe(false)
  })

  it('a held package DOES respect an explicit enabled_for_routing:true', () => {
    const { config } = validatePackageInventoryConfig({ version: 1, packages: [pkg({ enabled_for_routing: true })] })
    expect(config.packages[0].enabled_for_routing).toBe(true)
  })

  it('a held package defaults enabled_for_routing to false when omitted (never fabricated true)', () => {
    const raw = pkg() as Record<string, unknown>
    delete raw.enabled_for_routing
    const { config } = validatePackageInventoryConfig({ version: 1, packages: [raw] })
    expect(config.packages[0].enabled_for_routing).toBe(false)
  })

  it('drops an entry missing id/name/provider, keeps the rest of the array', () => {
    const good = pkg({ id: 'good' })
    const bad = pkg({ id: undefined })
    const { config, errors } = validatePackageInventoryConfig({ version: 1, packages: [good, bad] })
    expect(config.packages).toHaveLength(1)
    expect(config.packages[0].id).toBe('good')
    expect(errors.length).toBeGreaterThan(0)
  })
})
