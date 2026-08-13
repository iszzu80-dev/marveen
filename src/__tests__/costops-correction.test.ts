import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCorrection, getCorrectionChain } from '../costops/correction.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

function insertLine(db: import('better-sqlite3').Database, sourceId: string, amount: number, confidence = 'manual', actualSource = 'manual_entry'): number {
  const win = monthWindow(NOW)
  db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, 'other', 'usage', 'HUF', 1, ?, ?)`)
    .run(sourceId, sourceId, NOW, NOW)
  const info = db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, 'usage', ?, 'HUF', ?, ?, ?, ?, ?)
  `).run(sourceId, win.start, win.end, amount, confidence, NOW, NOW, `test|${sourceId}|${Math.random()}`, actualSource)
  return info.lastInsertRowid as number
}

describe('createCorrection (CostOps Phase 1, GAP-05/06/14 -- correction relationship)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('voids the original and inserts a linked correction row with the new amount', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'invoice was overstated' }, { now: NOW + 100 })
    expect(r.ok).toBe(true)
    expect(r.newLineId).toBeDefined()

    const original = db.prepare(`SELECT voided_at, void_reason, billed_cost, corrects_line_id FROM cost_line_items WHERE id = ?`).get(originalId) as any
    expect(original.voided_at).toBe(NOW + 100)
    expect(original.void_reason).toContain('invoice was overstated')
    expect(original.billed_cost).toBe(10000) // amount preserved, never erased
    expect(original.corrects_line_id).toBeNull() // the ORIGINAL doesn't point anywhere

    const corrected = db.prepare(`SELECT billed_cost, corrects_line_id, voided_at FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.billed_cost).toBe(8500)
    expect(corrected.corrects_line_id).toBe(originalId)
    expect(corrected.voided_at).toBeNull() // the correction itself is active
  })

  it('the corrected amount, not the original, is what the ledger reports going forward', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'fix' }, { now: NOW + 100 })
    const s = getCostSummary(db, cfg, NOW)
    const row = s.all_sources.find(x => x.source_id === 'render-hosting')!
    expect(row.spend).toBe(8500)
  })

  it('preserves source_id/period/currency/confidence/actual_source from the original', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000, 'provider_api', 'provider_api')
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 9000, reason: 'provider corrected their number' }, { now: NOW + 100 })
    const corrected = db.prepare(`SELECT source_id, currency, confidence, actual_source FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.source_id).toBe('render-hosting')
    expect(corrected.currency).toBe('HUF')
    expect(corrected.confidence).toBe('provider_api')
    expect(corrected.actual_source).toBe('provider_api')
  })

  it('404s on a nonexistent line id', () => {
    const db = getDb()
    const r = createCorrection(db, { originalLineId: 99999, newAmount: 100, reason: 'x' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('409s when correcting an already-voided line', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'first fix' }, { now: NOW + 100 })
    const r2 = createCorrection(db, { originalLineId: originalId, newAmount: 7000, reason: 'second attempt on the same original' }, { now: NOW + 200 })
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(409)
  })

  it('409s when the original already has a correction pointing at it (correct the newer link instead)', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const first = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'first fix' }, { now: NOW + 100 })
    // Attempting to correct the ORIGINAL again (not the new line) must fail --
    // it's already voided, so this hits the voided guard, same 409 class.
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 7000, reason: 'oops' }, { now: NOW + 200 })
    expect(r.ok).toBe(false)
    // But correcting the NEW line (the actual current link) works fine.
    const r2 = createCorrection(db, { originalLineId: first.newLineId!, newAmount: 7500, reason: 'second, correct fix' }, { now: NOW + 300 })
    expect(r2.ok).toBe(true)
  })

  it('rejects a missing reason -- correction must always be explainable', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: '' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('rejects a negative newAmount', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: -5, reason: 'x' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })
})

describe('getCorrectionChain', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns just the one row when there is no correction yet', () => {
    const db = getDb()
    const id = insertLine(db, 'render-hosting', 10000)
    const chain = getCorrectionChain(db, id)
    expect(chain).toHaveLength(1)
    expect(chain[0].id).toBe(id)
  })

  it('walks a multi-link chain oldest-first, regardless of which link id is passed in', () => {
    const db = getDb()
    const original = insertLine(db, 'render-hosting', 10000)
    const c1 = createCorrection(db, { originalLineId: original, newAmount: 8500, reason: 'fix 1' }, { now: NOW + 100 })
    const c2 = createCorrection(db, { originalLineId: c1.newLineId!, newAmount: 9200, reason: 'fix 2' }, { now: NOW + 200 })

    for (const queryId of [original, c1.newLineId!, c2.newLineId!]) {
      const chain = getCorrectionChain(db, queryId)
      expect(chain.map(c => c.id)).toEqual([original, c1.newLineId, c2.newLineId])
      expect(chain.map(c => c.billed_cost)).toEqual([10000, 8500, 9200])
      expect(chain[chain.length - 1].voided_at).toBeNull() // only the latest link is active
    }
  })
})

// 2026-08-12 review, COS-CORE-H3/C2: a correction inherits the original's
// confidence/actual_source/fx provenance by DEFAULT (same measurement
// channel, better number), but a caller whose replacement figure comes from
// a different channel -- the invoice door -- can override each explicitly.
describe('createCorrection -- provenance overrides (COS-CORE-H3/C2)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('applies confidence/actualSource overrides when the replacement comes from a different channel', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000) // manual / manual_entry
    const r = createCorrection(db, {
      originalLineId: originalId, newAmount: 11500, reason: 'invoice arrived',
      confidence: 'actual_invoice', actualSource: 'email_invoice',
    }, { now: NOW + 100 })
    expect(r.ok).toBe(true)
    const corrected = db.prepare(`SELECT confidence, actual_source FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.confidence).toBe('actual_invoice')
    expect(corrected.actual_source).toBe('email_invoice')
    // the voided original keeps ITS provenance untouched -- audit trail intact
    const original = db.prepare(`SELECT confidence, actual_source FROM cost_line_items WHERE id = ?`).get(originalId) as any
    expect(original.confidence).toBe('manual')
    expect(original.actual_source).toBe('manual_entry')
  })

  it('an fx override is taken wholesale -- explicit nulls wipe the original conversion rather than inheriting it', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('openai-api', 'openai-api', 'openai', 'usage', 'HUF', 1, ?, ?)`).run(NOW, NOW)
    const info = db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key,
        original_amount, original_currency, fx_rate, fx_date, fx_source, conversion_method)
      VALUES ('openai-api', ?, ?, 'usage', 3600, 'HUF', 'actual_invoice', ?, ?, 'usd-line',
        10, 'USD', 360, ?, 'manual', 'invoice_date_rate')
    `).run(win.start, win.end, NOW, NOW, NOW)
    const originalId = info.lastInsertRowid as number

    const r = createCorrection(db, {
      originalLineId: originalId, newAmount: 3500, reason: 'HUF re-statement',
      fx: { original_amount: null, original_currency: null, fx_rate: null, fx_date: null, fx_source: null, conversion_method: null },
    }, { now: NOW + 100 })
    const corrected = db.prepare(`SELECT original_amount, original_currency, fx_rate, fx_source, conversion_method FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.original_amount).toBeNull() // NOT the stale 10 USD @ 360
    expect(corrected.original_currency).toBeNull()
    expect(corrected.fx_rate).toBeNull()
    expect(corrected.fx_source).toBeNull()
    expect(corrected.conversion_method).toBeNull()
  })

  it('without an fx override the original conversion is carried forward whole, fx_source/conversion_method included', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('openai-api', 'openai-api', 'openai', 'usage', 'HUF', 1, ?, ?)`).run(NOW, NOW)
    const info = db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key,
        original_amount, original_currency, fx_rate, fx_date, fx_source, conversion_method)
      VALUES ('openai-api', ?, ?, 'usage', 3600, 'HUF', 'actual_invoice', ?, ?, 'usd-line-2',
        10, 'USD', 360, ?, 'manual', 'invoice_date_rate')
    `).run(win.start, win.end, NOW, NOW, NOW)
    const r = createCorrection(db, { originalLineId: info.lastInsertRowid as number, newAmount: 3610, reason: 'typo in the converted amount' }, { now: NOW + 100 })
    const corrected = db.prepare(`SELECT original_amount, original_currency, fx_rate, fx_source, conversion_method FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.original_amount).toBe(10)
    expect(corrected.original_currency).toBe('USD')
    expect(corrected.fx_rate).toBe(360)
    expect(corrected.fx_source).toBe('manual')
    expect(corrected.conversion_method).toBe('invoice_date_rate')
  })
})
