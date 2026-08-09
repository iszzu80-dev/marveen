// ZST Slice 2 — invoice extractor (v1, heuristic). Turns a ZST invoice email into
// structured zst_invoices fields. This is the FIRST data extractor: it fills the
// business tables the engine was built to hold. Deliberately conservative — it
// extracts only what it can parse with high confidence (amounts, dates, invoice
// number, supplier from the sender), leaves the rest null, and NEVER guesses a
// paid status (payment evidence comes from bank reconciliation, not the email).
// Coverage expands per real invoice format; unparseable fields stay null (honest
// partial extraction) rather than fabricated.

import type Database from 'better-sqlite3'
import { upsertZstInvoice, type ZstInvoiceInput } from './zst-finance.js'

export interface InvoiceEmailSource {
  caseId?: string
  from: string
  subject: string
  body: string
}

export interface ExtractedInvoice extends ZstInvoiceInput {
  confidence: 'HIGH' | 'PARTIAL' | 'LOW'
  extracted: string[]  // which fields were parsed
}

// "1 234 567 Ft", "1.234.567 Ft", "15 484 HUF", "15484Ft" → 1234567 (forint int).
const HUF_AMOUNT = /(\d{1,3}(?:[ . ]\d{3})+|\d{3,})\s?(?:Ft|HUF|forint)\b/gi
function parseHufAmounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(HUF_AMOUNT)) {
    const n = parseInt(m[1].replace(/[ . ]/g, ''), 10)
    if (!Number.isNaN(n)) out.push(n)
  }
  return out
}

// ISO or hu date "2026-07-22", "2026.07.22", "2026. 07. 22." → ISO.
const DATE_RE = /\b(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})\b/g
function parseDates(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DATE_RE)) {
    out.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`)
  }
  return out
}

// Invoice number: "számlaszám: X", "invoice no. X", "bizonylatszám X".
const INV_NO_RE = /(?:számlaszám|bizonylatszám|invoice\s*(?:no\.?|number)|sorszám)\s*[:#]?\s*([A-Za-z0-9\-/]{4,})/i
// Supplier: the sender's display name or domain.
function supplierFromSender(from: string): string | null {
  const disp = /"?([^"<]+?)"?\s*</.exec(from)
  if (disp && disp[1].trim()) return disp[1].trim()
  const dom = /@([\w.-]+)/.exec(from)
  return dom ? dom[1] : null
}

/** Extract invoice fields from an email. Returns null if it does not look like an
 *  invoice at all (no amount and no invoice-number cue). */
export function extractInvoice(src: InvoiceEmailSource): ExtractedInvoice | null {
  const text = `${src.subject}\n${src.body}`
  const amounts = parseHufAmounts(text)
  const invNoMatch = INV_NO_RE.exec(text)
  const looksLikeInvoice = amounts.length > 0 || invNoMatch != null ||
    /\b(számla|invoice|díjbekérő|bizonylat)\b/i.test(text)
  if (!looksLikeInvoice) return null

  const extracted: string[] = []
  const gross = amounts.length ? Math.max(...amounts) : undefined  // gross is usually the largest figure
  if (gross != null) extracted.push('gross_amount')
  const dates = parseDates(text)
  const issueDate = dates[0]
  if (issueDate) extracted.push('issue_date')
  const dueDate = dates.length > 1 ? dates[dates.length - 1] : undefined
  if (dueDate && dueDate !== issueDate) extracted.push('due_date')
  const invoiceNumber = invNoMatch?.[1]
  if (invoiceNumber) extracted.push('invoice_number')
  const supplierId = supplierFromSender(src.from) ?? undefined
  if (supplierId) extracted.push('supplier_id')

  const confidence: ExtractedInvoice['confidence'] =
    gross != null && invoiceNumber ? 'HIGH' : gross != null || invoiceNumber ? 'PARTIAL' : 'LOW'

  return {
    caseId: src.caseId, invoiceType: 'INCOMING', supplierId, invoiceNumber,
    issueDate, dueDate, grossAmount: gross, currency: 'HUF', confidence, extracted,
  }
}

/** Extract + register an invoice from an email, if it is one. Idempotent via the
 *  finance dedup (supplier+number+gross+date). Returns the invoice id + confidence,
 *  or null if the email is not an invoice. Never marks paid — payment evidence is
 *  the bank reconciliation's job. */
export function ingestZstInvoiceEmail(db: Database.Database, src: InvoiceEmailSource, now: number): { invoiceId: string; duplicate: boolean; confidence: string; extracted: string[] } | null {
  const ex = extractInvoice(src)
  if (!ex) return null
  const { invoiceId, duplicate } = upsertZstInvoice(db, ex, now)
  return { invoiceId, duplicate, confidence: ex.confidence, extracted: ex.extracted }
}
