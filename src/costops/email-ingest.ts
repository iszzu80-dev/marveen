// CostOps -- email-sourced cost ingest.
//
// Invoices/receipts that land in the operator's mailbox are the most authoritative
// cost signal (an actual charged amount). An agent-side sweep reads Gmail (which
// is not reachable from this backend), extracts a structured entry per receipt,
// and POSTs them here. This module is the PURE, deterministic ingest: it upserts
// one cost_line_item per (email, month) with an idempotent dedup key, so a sweep
// can safely re-run and re-ingest the same month without duplicating. NO raw email
// body, subject, sender address or PII is ever stored -- only the extracted amount,
// provider/source labels, the billing month, and a HASH of the message ref.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { checkPeriodWritable } from './period-close.js'
import { resolveFxRate, roundHuf } from './fx.js'
import { isCostConfidence, COST_CONFIDENCE_VALUES } from './config.js'

export interface EmailCostEntry {
  source_id: string          // stable id, e.g. 'anthropic-max' or 'aws'
  name: string               // human label, e.g. 'Claude Max'
  provider: string           // e.g. 'anthropic'
  amount: number             // in `currency`
  currency: string           // 'HUF' | 'USD' | ...
  month: string              // 'YYYY-MM' billing month
  message_ref: string        // opaque per-email ref (Gmail message id); hashed here
  confidence?: string        // default 'actual_invoice'
  source_type?: string       // default 'subscription'
}

export interface IngestResult {
  ingested: number
  skipped: number
  errors: Array<{ source_id: string; reason: string }>
}

function monthWindow(month: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const y = parseInt(month.slice(0, 4)), m = parseInt(month.slice(5, 7)) - 1
  return { start: Math.floor(Date.UTC(y, m, 1) / 1000), end: Math.floor(Date.UTC(y, m + 1, 1) / 1000) }
}

/**
 * Convert an amount to HUF. HUF passes through; USD/EUR use their own fx rate; any other
 * currency -> flagged (null), not guessed. v0.8 (card 6f4d1332): EUR previously fell through to
 * "unconvertible" even though EUR-denominated email invoices are a real, expected case (the
 * requirements doc's own worked example is an EUR invoice) -- added the EUR branch alongside USD.
 *
 * v0.9 (card 23912ca4): delegates to fx.ts's resolveFxRate() instead of two hand-copied
 * per-currency `if` branches. The hand-copied version is WHY this bug existed: the EUR branch
 * carried a `> 0` guard and a comment explaining why a zero rate must never convert; the USD
 * branch was added first, never got the same guard, and nothing forced the two to be kept in
 * sync. Building both from ONE data-driven rate table removes the drift, not just this one
 * instance of it -- a THIRD currency added here now gets the guard automatically instead of by
 * whoever remembers to copy it.
 */
export function toHuf(amount: number, currency: string, fxUsdHuf: number, fxEurHuf = 0): number | null {
  const rate = resolveFxRate(currency || 'HUF', { USD: fxUsdHuf, EUR: fxEurHuf })
  if (rate == null) return null
  return roundHuf(amount * rate)
}

/** The fx rate actually used for a given currency, for retaining alongside the converted amount. */
export function fxRateFor(currency: string, fxUsdHuf: number, fxEurHuf: number): number | null {
  return resolveFxRate(currency || 'HUF', { USD: fxUsdHuf, EUR: fxEurHuf })
}

/**
 * Idempotently upsert email-sourced cost lines. Deterministic, no I/O beyond the
 * passed db. Dedup key = `email|<sha256(message_ref)[:32]>|<month>`, so the same
 * receipt for the same month is updated in place, never duplicated.
 */
export function ingestEmailCosts(
  db: Database.Database,
  entries: EmailCostEntry[],
  opts: { fxUsdHuf: number; fxEurHuf?: number; now: number; idSalt?: string },
): IngestResult {
  const salt = opts.idSalt ?? 'costops-email'
  const fxEurHuf = opts.fxEurHuf ?? 0
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, 'HUF', 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider,
      source_type=excluded.source_type, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at,
       original_amount, original_currency, fx_rate, fx_date, actual_source,
       fx_source, conversion_method)
    VALUES
      (@source_id, @start, @end, @charge_category, @name,
       NULL, NULL, NULL, @amount, NULL, 'HUF',
       @confidence, @now, @ref_hash, @dedup_key, @now,
       @original_amount, @original_currency, @fx_rate, @fx_date, 'email_invoice',
       @fx_source, @conversion_method)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, confidence=excluded.confidence,
      charge_category=excluded.charge_category,
      data_freshness=excluded.data_freshness, source_ref=excluded.source_ref,
      original_amount=excluded.original_amount, original_currency=excluded.original_currency,
      fx_rate=excluded.fx_rate, fx_date=excluded.fx_date, actual_source=excluded.actual_source,
      fx_source=excluded.fx_source, conversion_method=excluded.conversion_method
  `)
  const out: IngestResult = { ingested: 0, skipped: 0, errors: [] }
  const tx = db.transaction((list: EmailCostEntry[]) => {
    for (const e of list) {
      if (!e || typeof e.source_id !== 'string' || !e.source_id) { out.errors.push({ source_id: String(e?.source_id), reason: 'missing source_id' }); continue }
      const win = monthWindow(e.month)
      if (!win) { out.errors.push({ source_id: e.source_id, reason: `bad month '${e.month}'` }); continue }
      // Phase 2 (GAP-13): a closed month accepts no direct write (including an
      // ON CONFLICT DO UPDATE for a late/re-sent invoice) -- use a correction instead.
      const writable = checkPeriodWritable(db, e.month)
      if (!writable.writable) { out.errors.push({ source_id: e.source_id, reason: writable.reason! }); continue }
      // COS-CORE-M5: an arbitrary confidence string used to be stored verbatim
      // -- a typo ('actual-invoice') lands at priority 0 in every resolver and
      // silently demotes the real invoice below manual entries. Rejected as a
      // per-entry error (same reporting as every other bad field here), never
      // silently rewritten to a confidence the sender did not claim.
      const confidence = e.confidence || 'actual_invoice'
      if (!isCostConfidence(confidence)) {
        out.errors.push({ source_id: e.source_id, reason: `invalid confidence '${e.confidence}' -- must be one of: ${COST_CONFIDENCE_VALUES.join(', ')}` })
        continue
      }
      const amountHuf = toHuf(Number(e.amount), e.currency, opts.fxUsdHuf, fxEurHuf)
      if (amountHuf === null || !isFinite(amountHuf)) { out.errors.push({ source_id: e.source_id, reason: `uncconvertible currency '${e.currency}'` }); continue }
      const refHash = createHash('sha256').update(salt).update('|').update(String(e.message_ref)).digest('hex').slice(0, 32)
      const dedup = `email|${refHash}|${e.month}`
      const cur = (e.currency || 'HUF').toUpperCase()
      // Currency-retention (v0.7, additive): only a REAL conversion has an "original"
      // distinct from billed_cost -- an already-HUF entry has nothing to retain.
      const wasConverted = cur !== 'HUF'
      // v0.8 bugfix: this used to always retain opts.fxUsdHuf regardless of which currency was
      // actually converted -- harmless while only USD existed, but wrong the moment a second
      // currency (EUR) does. fxRateFor() picks the rate that was actually applied above.
      const appliedFxRate = fxRateFor(cur, opts.fxUsdHuf, fxEurHuf)
      const sourceType = e.source_type || 'subscription'
      upsertSource.run({ id: e.source_id, name: e.name || e.source_id, provider: e.provider || 'other', source_type: sourceType, now: opts.now })
      upsertLine.run({
        source_id: e.source_id, start: win.start, end: win.end, name: e.name || e.source_id,
        // COS-CORE-M4: this door used to hardcode charge_category 'invoice',
        // which is not in the ChargeCategory union at all ("this row came from
        // an invoice" is what actual_source='email_invoice' already says --
        // provenance, not a spend category). Derived from the entry's own
        // source_type instead: a metered 'usage' source is 'usage' (run-rate
        // forecast), every recurring kind (subscription/hosting/domain/saas)
        // is 'subscription' (full-amount forecast).
        charge_category: sourceType === 'usage' ? 'usage' : 'subscription',
        amount: amountHuf, confidence, now: opts.now,
        ref_hash: refHash, dedup_key: dedup,
        original_amount: wasConverted ? Number(e.amount) : null,
        original_currency: wasConverted ? cur : null,
        fx_rate: wasConverted ? appliedFxRate : null,
        fx_date: wasConverted ? opts.now : null,
        // Phase 1 (GAP-09): fx.ts's FxSource/ConversionMethod provenance,
        // alongside the pre-existing fx_rate/fx_date columns above. This is
        // an email-derived invoice -- 'invoice_date_rate' reflects that the
        // rate is tied to the invoice event, not a bare usage period.
        // v0.9 (card 23912ca4): fxUsdHuf/fxEurHuf come from the provider-neutral
        // store/costops-fx.json (see fx-config.ts) -- an operator-configured
        // rate, not an automated feed, hence 'manual'. Was 'render_pricing_config'
        // until the rate source moved out of the Render pricing file.
        fx_source: wasConverted ? 'manual' : null,
        conversion_method: wasConverted ? 'invoice_date_rate' : null,
      })
      out.ingested++
    }
  })
  tx(entries)
  return out
}
