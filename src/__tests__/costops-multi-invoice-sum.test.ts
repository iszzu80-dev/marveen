// Card dec9ae64: THREE CostOps surfaces reported THREE different numbers for
// one exactly-known cost. Ground truth: two DISTINCT Render invoices in one
// month (not two representations of one charge) -- operational.provider_breakdown
// picked only the newer one, all_sources picked only the older one, and only
// reconcile (which sums by construction, not by picking) was right.
//
// Root cause: two separate "pick one line per source" resolvers (resolveOperational's
// sourceBest reduce, and getCostSummary's own local bySource/resolved reduce)
// assumed multiple lines for one source are COMPETING REPRESENTATIONS of the
// same charge. That assumption is wrong when the lines are genuinely distinct
// charges -- which, by this codebase's own dedup_key scheme (provider+invoice_ref+
// period for actual_invoice), is exactly what two separate actual_invoice rows
// for one source+period always are.
//
// RED-ABILITY:
//  * mutate resolveSourceWinners to pick-one (e.g. return [rep] instead of the
//    filtered group) -> tests 1, 2, 3 all go red (every surface, not just one)
//  * remove the estimate-vs-invoice supersession (tier check) -> test 4 goes red
//  * break the render_plan provenance fields -> test 5 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getCostSummary, monthWindow, resolveOperational } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000) // 2026-07-30, mid-month invoices already landed

function cfg(): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }
}

function seedRenderTwoInvoices(db: ReturnType<typeof getDb>) {
  const win = monthWindow(NOW)
  db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
    VALUES ('render-hosting','Render hosting','render','hosting','HUF',1,?,?)`).run(NOW, NOW)
  // Receipt #2322-4910, 2026-07-04, 11.15 USD -> 4014.0 HUF
  db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at,actual_source)
    VALUES ('render-hosting',?,?,'hosting','Render hosting',4014.0,'HUF','actual_invoice',?,'render|2322-4910|2026-07',?,'email_invoice')`)
    .run(win.start, win.end, Math.floor(Date.UTC(2026, 6, 4, 11, 15) / 1000), NOW)
  // Receipt #2422-8296, 2026-07-20, 73.46 USD -> 26445.6 HUF
  db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at,actual_source)
    VALUES ('render-hosting',?,?,'hosting','Render hosting',26445.6,'HUF','actual_invoice',?,'render|2422-8296|2026-07',?,'email_invoice')`)
    .run(win.start, win.end, Math.floor(Date.UTC(2026, 6, 20, 0, 0) / 1000), NOW)
}

describe('card dec9ae64: distinct invoices for one source+period are SUMMED, not picked', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('1. resolveOperational sums two distinct actual_invoice receipts (operational.provider_breakdown)', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'render-hosting', provider: 'render', billed_cost: 4014.0, charge_category: 'hosting', confidence: 'actual_invoice', data_freshness: Math.floor(Date.UTC(2026, 6, 4) / 1000), source_type: 'hosting' },
      { source_id: 'render-hosting', provider: 'render', billed_cost: 26445.6, charge_category: 'hosting', confidence: 'actual_invoice', data_freshness: Math.floor(Date.UTC(2026, 6, 20) / 1000), source_type: 'hosting' },
    ], win, NOW)
    const render = r.provider_breakdown.find(p => p.provider === 'render')!
    expect(render.spend).toBe(30459.6)
    expect(r.operational_spend).toBe(30459.6)
  })

  it('2. getCostSummary.all_sources sums both receipts (not just the older one)', () => {
    const db = getDb()
    seedRenderTwoInvoices(db)
    const s = getCostSummary(db, cfg(), NOW)
    const row = s.all_sources.find(x => x.source_id === 'render-hosting')!
    expect(row.spend).toBe(30459.6)
    expect(s.current_spend).toBe(30459.6)
  })

  it('3. reconcile still sums (unchanged) AND now agrees with all_sources and operational -- the class of bug this card found', () => {
    const db = getDb()
    seedRenderTwoInvoices(db)
    const s = getCostSummary(db, cfg(), NOW)
    const allSourcesSpend = s.all_sources.find(x => x.source_id === 'render-hosting')!.spend
    const reconcileActual = s.reconcile.find(r => r.source_id === 'render-hosting')!.actual
    const operationalSpend = s.operational.provider_breakdown.find(p => p.provider === 'render')!.spend
    // The agreement assertion itself -- this is the one that would have
    // caught the original bug (26445.6 vs 4014 vs 30459.6, three answers).
    expect(allSourcesSpend).toBe(reconcileActual)
    expect(allSourcesSpend).toBe(operationalSpend)
    expect(allSourcesSpend).toBe(30459.6)
  })

  it('4. an estimate line plus an invoice line -> the invoice still wins, NOT summed (card 097d8355/aed5307 regression)', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
      VALUES ('render-hosting','Render hosting','render','hosting','HUF',1,?,?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items
        (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at,actual_source)
      VALUES ('render-hosting',?,?,'hosting','Render hosting',3000,'HUF','estimate',?,'render|manual-guess|2026-07',?,'manual_entry')`)
      .run(win.start, win.end, NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items
        (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at,actual_source)
      VALUES ('render-hosting',?,?,'hosting','Render hosting',4014.0,'HUF','actual_invoice',?,'render|2322-4910|2026-07',?,'email_invoice')`)
      .run(win.start, win.end, NOW, NOW)
    const s = getCostSummary(db, cfg(), NOW)
    const row = s.all_sources.find(x => x.source_id === 'render-hosting')!
    expect(row.spend).toBe(4014.0)          // NOT 3000 + 4014 = 7014
    expect(row.confidence).toBe('actual_invoice')
  })

  it('5. render_plan carries the REAL provenance -- an invoice is never labelled a guess', () => {
    const db = getDb()
    seedRenderTwoInvoices(db)
    // an advisory plan-estimate line so render_plan is populated at all
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
      VALUES ('render-plan','Render plan','render','usage','HUF',1,?,?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items
        (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('render-plan',?,?,'usage','Render plan',22000,'HUF','provider_plan_estimate',?,'render-plan|2026-07',?)`)
      .run(win.start, win.end, NOW, NOW)
    const s = getCostSummary(db, cfg(), NOW)
    expect(s.render_plan).not.toBeNull()
    expect(s.render_plan!.manual_estimate).toBe(30459.6)
    // The load-bearing check: a real invoice is not presented as a manual guess.
    expect(s.render_plan!.manual_estimate_actual_source).toBe('email_invoice')
    expect(s.render_plan!.manual_estimate_confidence).toBe('actual_invoice')
  })
})
