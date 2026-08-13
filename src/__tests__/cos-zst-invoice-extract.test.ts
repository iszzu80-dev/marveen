import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { extractInvoice, ingestZstInvoiceEmail } from '../cos/zst-invoice-extract.js'
import { ingestTriagedZstEmail } from '../cos/zst-intake.js'

const T0 = 1_700_000_000

const INVOICE = {
  from: '"DMRV Zrt." <szamla@dmrvzrt.hu>',
  subject: 'Számla - 4102268904',
  body: 'Tisztelt Ügyfelünk!\nSzámlaszám: 4102268904\nTeljesítés dátuma: 2026-07-22\nFizetési határidő: 2026-08-06\nFizetendő összeg: 15 484 Ft\nKöszönjük.',
}

describe('ZST invoice extractor (v1 heuristic)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('extracts gross, dates, invoice number, supplier from a real invoice email', () => {
    const ex = extractInvoice(INVOICE)!
    expect(ex).not.toBeNull()
    expect(ex.grossAmount).toBe(15484)
    expect(ex.invoiceNumber).toBe('4102268904')
    expect(ex.issueDate).toBe('2026-07-22')
    expect(ex.dueDate).toBe('2026-08-06')
    expect(ex.supplierId).toBe('DMRV Zrt.')
    expect(ex.confidence).toBe('HIGH') // gross + invoice number
  })

  it('returns null for a non-invoice email', () => {
    expect(extractInvoice({ from: 'a@b.hu', subject: 'Meeting reminder', body: 'See you at 10.' })).toBeNull()
  })

  it('registers the invoice (idempotent) and never marks it paid', () => {
    const db = getDb()
    const r1 = ingestZstInvoiceEmail(db, INVOICE, T0)!
    expect(r1.duplicate).toBe(false)
    expect(r1.confidence).toBe('HIGH')
    const r2 = ingestZstInvoiceEmail(db, INVOICE, T0 + 5)!
    expect(r2.duplicate).toBe(true) // dedup
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get() as any).n).toBe(1)
    const inv: any = db.prepare(`SELECT payment_status FROM zst_invoices WHERE invoice_id=?`).get(r1.invoiceId)
    expect(inv.payment_status).toBe('UNPAID') // payment evidence comes from bank recon, never the email
  })

  it('does honest partial extraction — unparseable fields stay null', () => {
    const ex = extractInvoice({ from: 'x@y.hu', subject: 'Díjbekérő', body: 'Kérjük rendezze a díjbekérőt.' })!
    expect(ex).not.toBeNull() // "díjbekérő" cue
    expect(ex.grossAmount).toBeUndefined()
    expect(ex.invoiceNumber).toBeUndefined()
    expect(ex.confidence).toBe('LOW')
  })

  it('parses dotted and spaced HUF amounts', () => {
    const ex = extractInvoice({ from: 'a@b.hu', subject: 'Számla', body: 'Összeg: 1.234.567 Ft' })!
    expect(ex.grossAmount).toBe(1234567)
  })

  it('end-to-end: a ZST invoice email through intake creates a case AND a zst_invoice', () => {
    const db = getDb()
    const r = ingestTriagedZstEmail(db, {
      accountId: 'zst', messageId: 'inv-msg-1', threadId: 'inv-t1',
      from: INVOICE.from, subject: INVOICE.subject, snippet: INVOICE.body,
      actionable: true, caseType: 'INVOICE_INCOMING',
    }, T0)
    expect(r.outcome).toBe('CASE_CREATED')
    const inv: any = db.prepare(`SELECT invoice_id, gross_amount, case_id FROM zst_invoices`).get()
    expect(inv.gross_amount).toBe(15484)
    expect(inv.case_id).toBe(r.caseId) // linked to the case
  })
})

// ── The two ways a real invoice email broke the extractor ────────────────────
//
// Both were found in the same review (2026-08-13) and both corrupt the SAME
// row: gross_amount and invoice_number are two of the four fields the duplicate
// hash is built from, so a wrong value here does not just mis-report an invoice,
// it makes the same invoice ingest twice.
describe('ZST invoice extractor — the formats a real mailbox actually contains', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const NBSP = ' '
  const NNBSP = ' '

  it('reads an NBSP-grouped amount as the whole number, not its last group', () => {
    // Gmail snippets and HTML-derived bodies use U+00A0 as the thousands
    // separator. The fallback alternative `\d{3,}` then matched only "567"
    // while `\s?` happily matched the NBSP before "Ft" — so a 1 234 567 Ft
    // invoice was booked as 567, and gross = Math.max(...) meant one such
    // figure was enough to corrupt the row.
    const ex = extractInvoice({
      from: '"Teszt Kft." <a@teszt.hu>',
      subject: 'Számla',
      body: `Fizetendő összeg: 1${NBSP}234${NBSP}567 Ft\nSzámlaszám: SZ-2026/0042`,
    })!
    expect(ex.grossAmount).toBe(1234567)
  })

  it('reads a NARROW no-break space the same way', () => {
    const ex = extractInvoice({
      from: 'a@teszt.hu', subject: 'Számla',
      body: `Végösszeg: 2${NNBSP}500${NNBSP}000 Ft`,
    })!
    expect(ex.grossAmount).toBe(2500000)
  })

  it('does NOT take the bank account number for an invoice number', () => {
    // "Bankszámlaszám" contains "számlaszám". Most Hungarian invoice emails
    // carry the payment details, so this was not an edge case: the bank account
    // was stored as invoice_number at HIGH confidence, the dedup hash was keyed
    // on it, and the genuine number later opened a SECOND row for the same
    // invoice.
    const ex = extractInvoice({
      from: '"DMRV Zrt." <szamla@dmrvzrt.hu>',
      subject: 'Számla',
      body: 'Bankszámlaszám: 11711003-20003983\nSzámlaszám: SZ-2026/0042\nFizetendő: 15 484 Ft',
    })!
    expect(ex.invoiceNumber).toBe('SZ-2026/0042')
  })

  it('an invoice email that carries ONLY a bank account has no invoice number', () => {
    // Better nothing than a number that is not one: a null invoice_number is a
    // visibly partial extraction, a bank account in that column is not.
    const ex = extractInvoice({
      from: 'a@teszt.hu', subject: 'Számla',
      body: 'Bankszámlaszám: 11711003-20003983\nFizetendő: 15 484 Ft',
    })!
    expect(ex.invoiceNumber).toBeUndefined()
    expect(ex.confidence).toBe('PARTIAL')
  })

  it('the same invoice ingested twice is still one row when the bank line moves', () => {
    // The end the two fixes serve (AT-ZF01): the identity of an invoice must not
    // depend on which lines of the email the parser happened to grab.
    const db = getDb()
    const a = ingestZstInvoiceEmail(db, {
      from: '"DMRV Zrt." <szamla@dmrvzrt.hu>', subject: 'Számla',
      body: `Bankszámlaszám: 11711003-20003983\nSzámlaszám: SZ-2026/0042\nKelt: 2026-07-22\nFizetendő: 1${NBSP}234${NBSP}567 Ft`,
    }, T0)!
    const b = ingestZstInvoiceEmail(db, {
      from: '"DMRV Zrt." <szamla@dmrvzrt.hu>', subject: 'Számla',
      body: `Számlaszám: SZ-2026/0042\nKelt: 2026-07-22\nFizetendő: 1${NBSP}234${NBSP}567 Ft\nBankszámlaszám: 11711003-20003983`,
    }, T0 + 60)!
    expect(b.duplicate).toBe(true)
    expect(b.invoiceId).toBe(a.invoiceId)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get() as { n: number }).n).toBe(1)
  })
})
