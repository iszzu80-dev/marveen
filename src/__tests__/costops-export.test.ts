import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncFixedCostsToLedger } from '../costops/ledger.js'
import { exportCostRows, rowsToCsv } from '../costops/export.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function cfg(): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [],
  }
}

describe('costops export', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('exports only sanitized fields -- no raw ids, no PII, no email/invoice-number leakage', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const rows = exportCostRows(db, NOW, { month: '2026-07' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      provider: 'anthropic', source_type: 'subscription', service_name: 'Claude Max',
      period: '2026-07', amount: 22000, currency: 'HUF', confidence: 'manual',
    })
    const keys = Object.keys(rows[0])
    expect(keys).not.toContain('account_ref')
    expect(keys).not.toContain('source_ref')
  })

  it('returns an empty array (not a fabricated row) for a month with no data', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const rows = exportCostRows(db, NOW, { month: '2026-01' })
    expect(rows).toEqual([])
  })

  it('supports a month range', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW, '2026-06')
    syncFixedCostsToLedger(db, cfg(), NOW, '2026-07')
    const rows = exportCostRows(db, NOW, { fromMonth: '2026-06', toMonth: '2026-07' })
    expect(rows.map(r => r.period).sort()).toEqual(['2026-06', '2026-07'])
  })

  it('CSV rendering escapes commas/quotes and has a header row', () => {
    const csv = rowsToCsv([{ provider: 'a,b', source_type: 's', service_name: 'Has "quotes"', period: '2026-07', amount: 100, currency: 'HUF', confidence: 'manual' }])
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('provider,source_type,service_name,period,amount,currency,confidence')
    expect(lines[1]).toContain('"a,b"')
    expect(lines[1]).toContain('"Has ""quotes"""')
  })
})
