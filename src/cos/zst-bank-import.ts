// ZST Slice 2/18 — bank statement importer (v1, CSV). Turns a ZST bank-statement
// export into zst_bank_transactions rows. This is the THIRD data extractor and it
// CLOSES the finance loop: the invoice extractor fills zst_invoices, this fills
// zst_bank_transactions, and the already-built read-only reconciliation
// (suggestBankMatches) then suggests invoice↔transaction matches. Nothing here is
// autonomous — importing a statement records observed transactions; a human still
// confirms every reconciliation (suggestBankMatches only ever sets
// MATCH_SUGGESTED, never MATCHED_VERIFIED).
//
// Format-agnostic by design: Hungarian bank CSV exports vary (OTP/K&H/Erste/Wise),
// so instead of hard-coding one layout we auto-detect the delimiter and map columns
// by header keyword. A column we cannot identify is left null (honest partial import)
// rather than mis-assigned. Idempotent per (account, booking date, amount, reference)
// so re-importing an overlapping statement never double-books a transaction.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export interface BankTxnRow {
  bookingDate?: string
  valueDate?: string
  counterparty?: string
  description?: string
  reference?: string
  amount?: number       // integer forint (or minor→major rounded); sign = direction
  currency?: string
  direction?: 'CREDIT' | 'DEBIT'
}

export interface BankImportResult {
  imported: number
  duplicates: number
  skipped: number
  rows: Array<{ bankTransactionId: string; duplicate: boolean }>
}

// Column roles we try to fill from the header. Each maps to a list of header
// substrings (lowercased, accent-insensitive) that identify that column.
const COLUMN_CUES: Record<keyof Omit<BankTxnRow, 'direction'>, string[]> = {
  bookingDate: ['konyveles', 'booking', 'tranzakcio datum', 'trans date', 'datum', 'date'],
  valueDate: ['erteknap', 'value date', 'value'],
  counterparty: ['partner', 'ellenoldal', 'kedvezmenyezett', 'counterparty', 'name', 'nev'],
  description: ['kozlemeny', 'megjegyzes', 'narrative', 'description', 'details', 'megnevezes'],
  reference: ['hivatkozas', 'bizonylat', 'reference', 'tranzakcio azonosito', 'transaction id'],
  amount: ['osszeg', 'amount', 'terheles', 'jovairas', 'value amount'],
  currency: ['devizanem', 'penznem', 'currency', 'deviza'],
}

function deaccent(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** Detect the delimiter of a CSV line: `;` (HU default), `\t`, or `,`. Picks the
 *  one that yields the most columns on the header line. */
function detectDelimiter(header: string): string {
  const cands = [';', '\t', ',']
  let best = ';', bestN = 0
  for (const d of cands) {
    const n = header.split(d).length
    if (n > bestN) { bestN = n; best = d }
  }
  return best
}

// Minimal CSV field splitter with double-quote support (handles quoted fields
// containing the delimiter). Not a full RFC-4180 parser — enough for bank exports.
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
    } else if (c === delim && !inQ) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out.map(s => s.trim())
}

// "1 234 567", "1.234.567,00", "-15 484", "15484,50", "(1 200)" → integer forint.
// Parentheses or a leading minus mean a debit (negative). Returns null if not a
// number.
function parseAmount(raw: string): number | null {
  if (!raw) return null
  let s = raw.trim()
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s)
  s = s.replace(/[()]/g, '').replace(/[^\d.,-]/g, '')
  if (!s) return null
  // Decide decimal separator: if both '.' and ',' present, the LAST one is decimal.
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.')
  let normalized: string
  if (lastComma > -1 && lastDot > -1) {
    const decIsComma = lastComma > lastDot
    normalized = decIsComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma > -1) {
    // Comma only: decimal if it has exactly 1-2 trailing digits, else thousands sep.
    normalized = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else {
    // Dot only: decimal if 1-2 trailing digits, else thousands sep.
    normalized = /\.\d{1,2}$/.test(s) ? s.replace(/(?<=\d)\.(?=\d{3}\b)/g, '') : s.replace(/\./g, '')
  }
  const n = parseFloat(normalized.replace(/-/g, ''))
  if (Number.isNaN(n)) return null
  const rounded = Math.round(n)
  return negative ? -rounded : rounded
}

// Any recognizable date → ISO. "2026.07.22", "2026-07-22", "2026/07/22", "22/07/2026".
function normalizeDate(raw: string): string | undefined {
  if (!raw) return undefined
  let m = /(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})/.exec(raw)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/.exec(raw) // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return undefined
}

/** Map header cells to column indices by cue matching. A role stays -1 (absent)
 *  if no header matches it. */
function mapColumns(headerCells: string[]): Record<keyof typeof COLUMN_CUES, number> {
  const idx = {} as Record<keyof typeof COLUMN_CUES, number>
  for (const role of Object.keys(COLUMN_CUES) as Array<keyof typeof COLUMN_CUES>) {
    idx[role] = -1
    for (let c = 0; c < headerCells.length; c++) {
      const h = deaccent(headerCells[c])
      if (COLUMN_CUES[role].some(cue => h.includes(cue))) { idx[role] = c; break }
    }
  }
  return idx
}

/** Parse a CSV bank statement into transaction rows. Returns [] if there is no
 *  usable header (needs at least a date-or-amount column). */
export function parseBankStatementCsv(csv: string): BankTxnRow[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const delim = detectDelimiter(lines[0])
  const header = splitCsvLine(lines[0], delim)
  const col = mapColumns(header)
  if (col.bookingDate < 0 && col.amount < 0) return [] // not a recognizable statement
  const out: BankTxnRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delim)
    const get = (r: keyof typeof COLUMN_CUES) => (col[r] >= 0 ? cells[col[r]] ?? '' : '')
    const amount = parseAmount(get('amount'))
    const bookingDate = normalizeDate(get('bookingDate'))
    if (amount == null && !bookingDate) continue // empty/garbage row
    const row: BankTxnRow = {
      bookingDate,
      valueDate: normalizeDate(get('valueDate')),
      counterparty: get('counterparty') || undefined,
      description: get('description') || undefined,
      reference: get('reference') || undefined,
      amount: amount ?? undefined,
      currency: (get('currency') || 'HUF').toUpperCase(),
    }
    if (amount != null) row.direction = amount < 0 ? 'DEBIT' : 'CREDIT'
    out.push(row)
  }
  return out
}

/** Fingerprint a transaction for dedup: account + booking date + amount +
 *  reference (or description). Two imports of the same line collide here. */
function txnHash(accountId: string, r: BankTxnRow): string {
  const key = [accountId, r.bookingDate ?? '', r.amount ?? '', r.reference ?? r.description ?? ''].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Import a CSV bank statement into zst_bank_transactions, idempotently. Rows land
 *  UNMATCHED so the existing read-only reconciliation (suggestBankMatches) can
 *  suggest invoice matches — this import NEVER reconciles or marks anything paid. */
export function importBankStatement(
  db: Database.Database,
  args: { accountId: string; statementId?: string; csv: string },
  now: number,
): BankImportResult {
  const rows = parseBankStatementCsv(args.csv)
  const result: BankImportResult = { imported: 0, duplicates: 0, skipped: 0, rows: [] }
  const insert = db.prepare(
    `INSERT INTO zst_bank_transactions
       (bank_transaction_id, account_id, statement_id, booking_date, value_date, counterparty,
        description, reference, amount, currency, direction, reconciliation_status, created_at, updated_at)
     VALUES (@id, @acc, @stmt, @booking, @value, @cp, @desc, @ref, @amount, @currency, @dir,
        'UNMATCHED', @now, @now)`
  )
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.amount == null && !r.bookingDate) { result.skipped++; continue }
      const h = txnHash(args.accountId, r)
      const id = `zst-btx-${h}`
      const exists = db.prepare(`SELECT 1 FROM zst_bank_transactions WHERE bank_transaction_id=?`).get(id)
      if (exists) { result.duplicates++; result.rows.push({ bankTransactionId: id, duplicate: true }); continue }
      insert.run({
        id, acc: args.accountId, stmt: args.statementId ?? null,
        booking: r.bookingDate ?? null, value: r.valueDate ?? null, cp: r.counterparty ?? null,
        desc: r.description ?? null, ref: r.reference ?? null, amount: r.amount ?? null,
        currency: r.currency ?? 'HUF', dir: r.direction ?? null, now,
      })
      result.imported++
      result.rows.push({ bankTransactionId: id, duplicate: false })
    }
  })
  tx()
  return result
}
