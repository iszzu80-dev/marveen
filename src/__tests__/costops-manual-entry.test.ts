import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createManualCost, updateManualCost, deleteManualCost, createManualEntitlement, updateManualEntitlement, deleteManualEntitlement } from '../costops/manual-entry.js'
import { getCostSummary, monthWindow as ledgerMonthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

describe('costops manual cost entry (card a1552362, item 3)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creates a manual HUF entry, visible in all_sources as manual/manual_entry', () => {
    const db = getDb()
    const r = createManualCost(db, {
      source_id: 'notion', name: 'Notion', provider: 'notion', amount: 5000, currency: 'HUF', month: '2026-07',
    }, { fxUsdHuf: 360, now: NOW })
    expect(r.ok).toBe(true)
    const s = getCostSummary(db, cfg, NOW)
    const row = s.all_sources.find(x => x.source_id === 'notion')!
    expect(row.spend).toBe(5000)
    expect(row.confidence).toBe('manual')
    expect(row.actual_source).toBe('manual_entry')
    expect(row.fx_estimated).toBeNull() // already HUF, nothing converted
  })

  it('converts + retains original currency for a non-HUF manual entry, flags fx_estimated', () => {
    const db = getDb()
    createManualCost(db, {
      source_id: 'figma', name: 'Figma', provider: 'figma', amount: 15, currency: 'USD', month: '2026-07',
    }, { fxUsdHuf: 360, now: NOW })
    const s = getCostSummary(db, cfg, NOW)
    const row = s.all_sources.find(x => x.source_id === 'figma')!
    expect(row.spend).toBe(5400) // 15 * 360
    expect(row.original_amount).toBe(15)
    expect(row.original_currency).toBe('USD')
    expect(row.fx_estimated).toBe(true)
  })

  it('rejects a second POST for the same source/month (409) -- PATCH is required to change it', () => {
    const db = getDb()
    createManualCost(db, { source_id: 'notion', name: 'Notion', provider: 'notion', amount: 5000, currency: 'HUF', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    const r2 = createManualCost(db, { source_id: 'notion', name: 'Notion', provider: 'notion', amount: 6000, currency: 'HUF', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(409)
  })

  it('PATCH updates an existing manual entry in place (no duplicate line)', () => {
    const db = getDb()
    createManualCost(db, { source_id: 'notion', name: 'Notion', provider: 'notion', amount: 5000, currency: 'HUF', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    const r = updateManualCost(db, { source_id: 'notion', month: '2026-07', amount: 7500, currency: 'HUF' }, { fxUsdHuf: 360, now: NOW + 10 })
    expect(r.ok).toBe(true)
    const s = getCostSummary(db, cfg, NOW)
    const rows = s.all_sources.filter(x => x.source_id === 'notion')
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(7500)
  })

  it('PATCH 404s when there is nothing to update yet', () => {
    const db = getDb()
    const r = updateManualCost(db, { source_id: 'ghost', month: '2026-07', amount: 100, currency: 'HUF' }, { fxUsdHuf: 360, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('PATCH refuses to touch a non-manual (e.g. provider_api) line for the same key', () => {
    const db = getDb()
    const win = ledgerMonthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,?,?)`).run(NOW, NOW)
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
      VALUES ('render-hosting', @start, @end, 'usage', 1000, 'HUF', 'provider_api', @now, @now, 'manual|render-hosting|2026-07', 'provider_api')
    `).run({ start: win.start, end: win.end, now: NOW })
    const r = updateManualCost(db, { source_id: 'render-hosting', month: '2026-07', amount: 9999, currency: 'HUF' }, { fxUsdHuf: 360, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
  })

  it('rejects an unconvertible currency without a configured fx rate', () => {
    const db = getDb()
    const r = createManualCost(db, { source_id: 'random', name: 'Random', provider: 'random', amount: 10, currency: 'GBP', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('DELETE removes the manual cost_line_items row (card 73e8914a)', () => {
    const db = getDb()
    createManualCost(db, { source_id: 'notion', name: 'Notion', provider: 'notion', amount: 5000, currency: 'HUF', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    const r = deleteManualCost(db, { source_id: 'notion', month: '2026-07' })
    expect(r.ok).toBe(true)
    expect(db.prepare(`SELECT 1 FROM cost_line_items WHERE dedup_key = 'manual|notion|2026-07'`).get()).toBeUndefined()
    // The cost_sources catalog entry itself is untouched by design (createManualCost upserts it
    // separately from the line item) -- the source still shows up in all_sources, just back to
    // no_data spend, same as any other source with no billing data in the query window.
    const s = getCostSummary(db, cfg, NOW)
    const row = s.all_sources.find(x => x.source_id === 'notion')!
    expect(row.spend).toBe(0)
    expect(row.actual_source).toBe('no_data')
  })

  it('DELETE 404s when there is nothing to delete', () => {
    const db = getDb()
    const r = deleteManualCost(db, { source_id: 'ghost', month: '2026-07' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('DELETE refuses to touch a non-manual (e.g. provider_api) line for the same key', () => {
    const db = getDb()
    const win = ledgerMonthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,?,?)`).run(NOW, NOW)
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
      VALUES ('render-hosting', @start, @end, 'usage', 1000, 'HUF', 'provider_api', @now, @now, 'manual|render-hosting|2026-07', 'provider_api')
    `).run({ start: win.start, end: win.end, now: NOW })
    const r = deleteManualCost(db, { source_id: 'render-hosting', month: '2026-07' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
    const row = db.prepare(`SELECT 1 FROM cost_line_items WHERE dedup_key = 'manual|render-hosting|2026-07'`).get()
    expect(row).toBeTruthy() // still there -- the guard actually blocked the delete, not a no-op coincidence
  })
})

describe('costops manual entitlement entry (card a1552362, item 3)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creates a manual entitlement row', () => {
    const db = getDb()
    const r = createManualEntitlement(db, {
      provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats',
      included_limit: 10, included_unit: 'seats', remaining: 3, status: 'ok',
    }, NOW)
    expect(r.ok).toBe(true)
    const row = db.prepare(`SELECT * FROM entitlements WHERE dedup_key = 'manual|notion|notion-plus|seats|monthly'`).get() as any
    expect(row.remaining).toBe(3)
    expect(row.usage_source).toBe('manual')
    expect(row.status).toBe('ok')
  })

  it('rejects a duplicate create (409)', () => {
    const db = getDb()
    const input = { provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats', status: 'ok' as const }
    createManualEntitlement(db, input, NOW)
    const r2 = createManualEntitlement(db, input, NOW)
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(409)
  })

  it('PATCH updates an existing manual entitlement', () => {
    const db = getDb()
    createManualEntitlement(db, { provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats', remaining: 3, status: 'ok' }, NOW)
    const r = updateManualEntitlement(db, { provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats', remaining: 1, status: 'warning' }, NOW + 10)
    expect(r.ok).toBe(true)
    const row = db.prepare(`SELECT * FROM entitlements WHERE dedup_key = 'manual|notion|notion-plus|seats|monthly'`).get() as any
    expect(row.remaining).toBe(1)
    expect(row.status).toBe('warning')
  })

  it('PATCH 404s when there is nothing to update yet', () => {
    const db = getDb()
    const r = updateManualEntitlement(db, { provider: 'ghost', product: 'x', billing_period: 'monthly', entitlement_type: 'seats', status: 'ok' }, NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('DELETE removes a manual entitlement (card 73e8914a)', () => {
    const db = getDb()
    createManualEntitlement(db, { provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats', remaining: 3, status: 'ok' }, NOW)
    const r = deleteManualEntitlement(db, { provider: 'notion', product: 'notion-plus', billing_period: 'monthly', entitlement_type: 'seats' })
    expect(r.ok).toBe(true)
    const row = db.prepare(`SELECT 1 FROM entitlements WHERE dedup_key = 'manual|notion|notion-plus|seats|monthly'`).get()
    expect(row).toBeUndefined()
  })

  it('DELETE 404s when there is nothing to delete', () => {
    const db = getDb()
    const r = deleteManualEntitlement(db, { provider: 'ghost', product: 'x', billing_period: 'monthly', entitlement_type: 'seats' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })
})
