import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  upsertZstInvoice, markInvoicePaid, suggestBankMatches, ensureAccountingPackage, invoiceDuplicateHash,
} from '../cos/zst-finance.js'

const T0 = 1_700_000_000

describe('ZST Slice 2 finance', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('all ZST business tables exist after initCosSchema (schema smoke)', () => {
    const db = getDb()
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'zst_%'`).all() as any[]).map(r => r.name))
    for (const t of ['zst_invoices', 'zst_accounting_packages', 'zst_bank_transactions', 'zst_reconciliation_items',
      'zst_contracts', 'zst_obligations', 'zst_vendors', 'zst_licenses', 'zst_procurement_radar_items',
      'zst_procurement_radar_offers', 'zst_partners', 'zst_opportunities', 'zst_products',
      'zst_product_milestones', 'zst_product_escalations']) {
      expect(tables.has(t), `missing ${t}`).toBe(true)
    }
  })

  it('AT-ZF01: a duplicate invoice is detected (no second row)', () => {
    const db = getDb()
    const inv = { supplierId: 'DMRV', invoiceNumber: '4102268904', grossAmount: 15484, issueDate: '2026-07-22', accountingPeriod: '2026-07' }
    const a = upsertZstInvoice(db, inv, T0)
    const b = upsertZstInvoice(db, inv, T0 + 5)
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(true)
    expect(b.invoiceId).toBe(a.invoiceId)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get() as any).n).toBe(1)
  })

  it('AT-ZF02: an invoice cannot be marked paid without evidence', () => {
    const db = getDb()
    const { invoiceId } = upsertZstInvoice(db, { supplierId: 'X', invoiceNumber: '1', grossAmount: 100 }, T0)
    expect(() => markInvoicePaid(db, invoiceId, '', T0)).toThrow(/evidence/)
    // the DB CHECK also blocks a direct paid-without-btx update
    expect(() => db.prepare(`UPDATE zst_invoices SET payment_status='PAID' WHERE invoice_id=?`).run(invoiceId)).toThrow()
    // with evidence it works
    markInvoicePaid(db, invoiceId, 'btx-1', T0 + 1)
    expect((db.prepare(`SELECT payment_status, bank_transaction_id FROM zst_invoices WHERE invoice_id=?`).get(invoiceId) as any))
      .toMatchObject({ payment_status: 'PAID', bank_transaction_id: 'btx-1' })
  })

  it('AT-ZF03/ZF04: bank match is read-only SUGGESTED, one txn not two invoices', () => {
    const db = getDb()
    upsertZstInvoice(db, { invoiceId: 'inv-a', supplierId: 'ACME', invoiceNumber: 'A', grossAmount: 5000 }, T0)
    upsertZstInvoice(db, { invoiceId: 'inv-b', supplierId: 'ACME', invoiceNumber: 'B', grossAmount: 5000 }, T0)
    // CHANGED 2026-08-13: a payment of a supplier invoice is money OUT. The
    // amount used to be +5000 with no direction, which is an incoming payment
    // being matched to an invoice we owe — it passed only because the matcher
    // looked at nothing but the absolute amount.
    db.prepare(`INSERT INTO zst_bank_transactions (bank_transaction_id, amount, counterparty, direction, reconciliation_status, currency, created_at, updated_at)
      VALUES ('t1', -5000, 'ACME Kft', 'DEBIT', 'UNMATCHED', 'HUF', ?, ?)`).run(T0, T0)
    const sugg = suggestBankMatches(db, T0 + 10)
    expect(sugg).toHaveLength(1)
    // status is only SUGGESTED, never auto-verified
    const t: any = db.prepare(`SELECT reconciliation_status, matched_invoice_id, match_confidence FROM zst_bank_transactions WHERE bank_transaction_id='t1'`).get()
    expect(t.reconciliation_status).toBe('MATCH_SUGGESTED')
    expect(t.matched_invoice_id).toBe(sugg[0].invoiceId)
    // counterparty contains supplier -> high confidence
    expect(t.confidence ?? t.match_confidence).toBeGreaterThanOrEqual(0.7)
    // AT-ZF04: only ONE invoice consumed even though two matched the amount
    const recon = db.prepare(`SELECT COUNT(*) n FROM zst_reconciliation_items`).get() as any
    expect(recon.n).toBe(1)
  })

  it('accounting package rolls up counts for a period (read-only assembly)', () => {
    const db = getDb()
    upsertZstInvoice(db, { supplierId: 'S', invoiceNumber: '1', grossAmount: 100, accountingPeriod: '2026-07', invoiceType: 'INCOMING' }, T0)
    upsertZstInvoice(db, { supplierId: 'S', invoiceNumber: '2', grossAmount: 200, accountingPeriod: '2026-07', invoiceType: 'OUTGOING', documentId: 'doc-1' }, T0)
    const { packageId } = ensureAccountingPackage(db, '2026-07', T0)
    const p: any = db.prepare(`SELECT * FROM zst_accounting_packages WHERE package_id=?`).get(packageId)
    expect(p.incoming_invoice_count).toBe(1)
    expect(p.outgoing_invoice_count).toBe(1)
    expect(p.missing_document_count).toBe(1) // the incoming one has no document_id
    // idempotent per period
    ensureAccountingPackage(db, '2026-07', T0 + 5)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_accounting_packages`).get() as any).n).toBe(1)
  })

  it('duplicate hash is stable and field-sensitive', () => {
    const base = { supplierId: 'S', invoiceNumber: 'N', grossAmount: 100, issueDate: '2026-01-01' }
    expect(invoiceDuplicateHash(base)).toBe(invoiceDuplicateHash({ ...base }))
    expect(invoiceDuplicateHash(base)).not.toBe(invoiceDuplicateHash({ ...base, grossAmount: 101 }))
  })
})

// ── What "a match" is allowed to mean ────────────────────────────────────────
//
// Every test below is about money being attached to the wrong row. A wrong
// suggestion is not a harmless proposal: the invoice it names enters
// usedInvoices, so it also blocks the correct match for the rest of the pass,
// and the transaction it names leaves UNMATCHED — which is the state the
// accounting package counts.
describe('ZST bank matching — amount alone is not a match', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const txn = (id: string, amount: number, over: { currency?: string; direction?: string; booking?: string; cp?: string } = {}) => {
    getDb().prepare(
      `INSERT INTO zst_bank_transactions (bank_transaction_id, amount, counterparty, direction, booking_date,
         reconciliation_status, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UNMATCHED', ?, ?, ?)`,
    ).run(id, amount, over.cp ?? null, over.direction ?? (amount < 0 ? 'DEBIT' : 'CREDIT'),
      over.booking ?? '2026-07-15', over.currency ?? 'HUF', T0, T0)
  }

  it('a 100 EUR debit is not a 100 HUF invoice', () => {
    const db = getDb()
    upsertZstInvoice(db, { invoiceId: 'inv-huf', supplierId: 'S', invoiceNumber: 'H1', grossAmount: 100, currency: 'HUF' }, T0)
    txn('t-eur', -100, { currency: 'EUR' })
    expect(suggestBankMatches(db, T0 + 10)).toHaveLength(0)
  })

  it('a cross-currency near-miss does not consume the invoice the right transaction needs', () => {
    // The compounding failure: the EUR line used to grab the HUF invoice, and the
    // HUF payment that actually settles it then found nothing left to match.
    const db = getDb()
    upsertZstInvoice(db, { invoiceId: 'inv-huf', supplierId: 'S', invoiceNumber: 'H1', grossAmount: 100, currency: 'HUF' }, T0)
    txn('t-eur', -100, { currency: 'EUR' })
    txn('t-huf', -100, { currency: 'HUF' })
    const s = suggestBankMatches(db, T0 + 10)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ bankTransactionId: 't-huf', invoiceId: 'inv-huf' })
  })

  it('money coming IN is not offered against an invoice we owe', () => {
    const db = getDb()
    upsertZstInvoice(db, { invoiceId: 'inv-in', supplierId: 'S', invoiceNumber: 'I1', grossAmount: 7000, invoiceType: 'INCOMING' }, T0)
    txn('t-credit', 7000)
    expect(suggestBankMatches(db, T0 + 10)).toHaveLength(0)
    // …and the same amount arriving for an invoice we ISSUED does match.
    upsertZstInvoice(db, { invoiceId: 'inv-out', customerId: 'C', invoiceNumber: 'O1', grossAmount: 7000, invoiceType: 'OUTGOING' }, T0)
    const s = suggestBankMatches(db, T0 + 11)
    expect(s).toHaveLength(1)
    expect(s[0].invoiceId).toBe('inv-out')
  })

  it('a REJECTED suggestion does not abort the next pass — nor come back unchanged', () => {
    // recon_id was `rec-${txn}-${inv}` with a plain INSERT. A REJECTED item left
    // the invoice available again, the next pass picked the same pair, and the
    // PRIMARY KEY violation aborted the WHOLE suggestion run — every other
    // transaction in the batch included.
    const db = getDb()
    upsertZstInvoice(db, { invoiceId: 'inv-1', supplierId: 'ACME', invoiceNumber: 'A1', grossAmount: 5000 }, T0)
    upsertZstInvoice(db, { invoiceId: 'inv-2', supplierId: 'MASIK', invoiceNumber: 'B1', grossAmount: 9000 }, T0)
    txn('t1', -5000, { cp: 'ACME Kft' })
    expect(suggestBankMatches(db, T0 + 10)).toHaveLength(1)
    // A human rejects it: the item is REJECTED and the transaction goes back.
    db.prepare(`UPDATE zst_reconciliation_items SET status='REJECTED'`).run()
    db.prepare(`UPDATE zst_bank_transactions SET reconciliation_status='UNMATCHED', matched_invoice_id=NULL WHERE bank_transaction_id='t1'`).run()
    txn('t2', -9000, { cp: 'Masik Kft' })

    const second = suggestBankMatches(db, T0 + 20) // must not throw
    // The rejected pair is not re-proposed, and the unrelated transaction is.
    expect(second.map(s => s.bankTransactionId)).toEqual(['t2'])
  })

  it('the package counts the period\'s unmatched transactions, not the world\'s', () => {
    // A global COUNT(*) meant a closed January package reopened whenever an
    // unrelated July transaction landed.
    const db = getDb()
    txn('t-july', -1000, { booking: '2026-07-15' })
    txn('t-august', -2000, { booking: '2026-08-15' })
    const { packageId } = ensureAccountingPackage(db, '2026-07', T0)
    const p = db.prepare(`SELECT unmatched_transaction_count AS n FROM zst_accounting_packages WHERE package_id=?`)
      .get(packageId) as { n: number }
    expect(p.n).toBe(1)
  })
})
