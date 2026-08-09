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
    db.prepare(`INSERT INTO zst_bank_transactions (bank_transaction_id, amount, counterparty, reconciliation_status, currency, created_at, updated_at)
      VALUES ('t1', 5000, 'ACME Kft', 'UNMATCHED', 'HUF', ?, ?)`).run(T0, T0)
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
