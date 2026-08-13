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
import { parseHufAmounts, parseDates, nameFromSender, normaliseExtractionText } from './zst-extract-common.js'

export interface InvoiceEmailSource {
  caseId?: string
  from: string
  subject: string
  body: string
  /** How much of the mail `body` actually is. The intake used to pass the
   *  300-character Gmail SNIPPET here and the module advertised that the invoice
   *  would be "re-extracted later" — nothing re-extracts, so an amount or an
   *  invoice number past character 300 was simply lost, and a truncated amount
   *  list made Math.max pick a non-gross figure. The full body is passed now
   *  when the caller has it; when it does not, the row says so instead of
   *  looking like a complete extraction. */
  extractionSource?: 'FULL_BODY' | 'SNIPPET'
}

/** Marker written to zst_invoices.notes so a partial extraction is visible in
 *  the store. Machine-readable on purpose: it is a data marker, not a message. */
export const SNIPPET_EXTRACTION_NOTE = 'extraction_source=SNIPPET'

export interface ExtractedInvoice extends ZstInvoiceInput {
  confidence: 'HIGH' | 'PARTIAL' | 'LOW'
  extracted: string[]  // which fields were parsed
}

// Amounts, dates and the supplier name come from the shared extractor helpers
// (zst-extract-common.ts) — the same functions the contract extractor uses. They
// used to be a copy each, and the copies had already drifted on the one detail
// that matters most here: whether a NO-BREAK SPACE counts as a thousands
// separator. It does; an HTML-derived body is full of them.

// Invoice number: "számlaszám: X", "invoice no. X", "bizonylatszám X".
//
// The lookbehind is the whole point of this line. Without it the cue
// `számlaszám` also matched INSIDE "Bankszámlaszám", and most real Hungarian
// invoice emails carry the payment details — so the extractor stored the
// supplier's BANK ACCOUNT as the invoice number, at HIGH confidence, and keyed
// the dedup hash (supplier + number + gross + date) on it. A later ingest
// carrying the genuine number then hashed differently and opened a SECOND row
// for the same invoice: AT-ZF01 defeated silently, by an invoice we had already
// booked.
//
// \p{L} rather than \b: \b is ASCII-only here, so "folyószámlaszám" (an accented
// letter before the cue) would still have counted as a word boundary. The regex
// is global so the FIRST cue that is not part of a longer word wins — a mail
// whose bank line precedes its invoice line still yields the invoice number.
const INV_NO_RE = /(?<!\p{L})(?:számlaszám|bizonylatszám|invoice\s*(?:no\.?|number)|sorszám)\s*[:#]?\s*([A-Za-z0-9\-/]{4,})/giu

/** Extract invoice fields from an email. Returns null if it does not look like an
 *  invoice at all (no amount and no invoice-number cue). */
export function extractInvoice(src: InvoiceEmailSource): ExtractedInvoice | null {
  // Normalised once here too: INV_NO_RE and the cue tests below run on the same
  // text the amount parser sees, so a NO-BREAK SPACE cannot make one of them
  // disagree with the others about where a word ends.
  const text = normaliseExtractionText(`${src.subject}\n${src.body}`)
  const amounts = parseHufAmounts(text)
  // A global regex carries lastIndex between calls; exec from a fresh position.
  INV_NO_RE.lastIndex = 0
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
  const supplierId = nameFromSender(src.from) ?? undefined
  if (supplierId) extracted.push('supplier_id')

  // A snippet-only read cannot be HIGH, whatever it happened to find: the fields
  // it did not find may simply be past character 300.
  const full = gross != null && invoiceNumber
  const confidence: ExtractedInvoice['confidence'] =
    full && src.extractionSource !== 'SNIPPET' ? 'HIGH'
      : gross != null || invoiceNumber ? 'PARTIAL' : 'LOW'

  return {
    caseId: src.caseId, invoiceType: 'INCOMING', supplierId, invoiceNumber,
    issueDate, dueDate, grossAmount: gross, currency: 'HUF', confidence, extracted,
    ...(src.extractionSource === 'SNIPPET' ? { notes: SNIPPET_EXTRACTION_NOTE } : {}),
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
