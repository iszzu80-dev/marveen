// CostOps v0.7 -- sanitized export (CSV/JSON).
//
// Read-only, no raw email body, no raw invoice ID, no account reference, no
// PII -- only provider/period/amount/confidence/source_type/service_name.

import type Database from 'better-sqlite3'
import { monthWindow } from './ledger.js'

export interface ExportRow {
  provider: string
  source_type: string
  service_name: string | null
  period: string
  amount: number
  currency: string
  confidence: string
  // Currency-retention (v0.7, additive): populated only when this line was
  // converted from a foreign-currency invoice ("if any" per spec) -- never
  // fabricated for an already-HUF line.
  original_amount: number | null
  original_currency: string | null
}

interface Row {
  provider: string
  source_type: string
  service_name: string | null
  charge_period_start: number
  billed_cost: number
  currency: string
  confidence: string
  original_amount: number | null
  original_currency: string | null
}

/**
 * Sanitized cost-line export for a single month, or a [fromMonth, toMonth]
 * inclusive range. No fabrication: months with zero rows simply contribute no
 * rows (the caller can see that from an empty result, not a synthesized 0).
 */
export function exportCostRows(
  db: Database.Database,
  now: number,
  opts: { month?: string; fromMonth?: string; toMonth?: string },
): ExportRow[] {
  let start: number, end: number
  if (opts.fromMonth && opts.toMonth) {
    start = monthWindow(now, opts.fromMonth).start
    end = monthWindow(now, opts.toMonth).end
  } else {
    const w = monthWindow(now, opts.month)
    start = w.start
    end = w.end
  }
  const rows = db.prepare(`
    SELECT cs.provider as provider, cs.source_type as source_type, cli.service_name as service_name,
           cli.charge_period_start as charge_period_start, cli.billed_cost as billed_cost,
           cli.currency as currency, cli.confidence as confidence,
           cli.original_amount as original_amount, cli.original_currency as original_currency
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.charge_period_start < @end AND cli.charge_period_end > @start AND cli.voided_at IS NULL
    ORDER BY cli.charge_period_start ASC, cs.provider ASC
  `).all({ start, end }) as Row[]

  return rows.map(r => ({
    provider: r.provider,
    source_type: r.source_type,
    service_name: r.service_name,
    period: monthWindow(r.charge_period_start).key,
    amount: r.billed_cost,
    currency: r.currency,
    confidence: r.confidence,
    original_amount: r.original_amount ?? null,
    original_currency: r.original_currency ?? null,
  }))
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function rowsToCsv(rows: ExportRow[]): string {
  const headers = ['provider', 'source_type', 'service_name', 'period', 'amount', 'currency', 'confidence', 'original_amount', 'original_currency']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape((r as unknown as Record<string, unknown>)[h])).join(','))
  }
  return lines.join('\n') + '\n'
}
