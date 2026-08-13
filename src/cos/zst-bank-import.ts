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

/** Column roles we try to fill from the header, each with SPECIFIC cues and
 *  GENERIC ones.
 *
 *  The split is the fix for two real mis-assignments (2026-08-13), both of which
 *  contradicted this file's own header promise that an unidentified column is
 *  left null "rather than mis-assigned":
 *
 *  1. Roles used to be resolved one at a time, left to right, so bookingDate's
 *     generic `datum`/`date` claimed whatever date column came FIRST. In an
 *     export that puts "Értéknap" before "Könyvelés dátuma" — several Hungarian
 *     banks do — the booking date silently became the value date, and every
 *     downstream period filter was off by the settlement lag.
 *  2. `terheles`/`jovairas` were cues for `amount`, so a statement with SEPARATE
 *     debit and credit columns bound amount to whichever appeared first and
 *     imported every row of the other direction with a NULL amount. Half the
 *     statement lost its amounts and the import still reported success.
 *
 *  So: debit and credit are their own roles (with a weight above `amount`, so a
 *  "Terhelés összege" header does not get taken by the amount role), and every
 *  role competes for every column in one pass — the most specific cue wins the
 *  column, whatever order the columns happen to be in. */
interface ColumnCues { specific: string[]; generic?: string[] }
type ColumnRole = keyof Omit<BankTxnRow, 'direction'> | 'debit' | 'credit'

const COLUMN_CUES: Record<ColumnRole, ColumnCues> = {
  bookingDate: {
    specific: ['konyveles', 'konyvelesi', 'booking', 'tranzakcio datum', 'trans date', 'trans. datum'],
    generic: ['datum', 'date'],
  },
  valueDate: { specific: ['erteknap', 'ertek nap', 'value date'], generic: ['value'] },
  counterparty: {
    specific: ['partner', 'ellenoldal', 'kedvezmenyezett', 'counterparty', 'ellenszamla'],
    generic: ['name', 'nev'],
  },
  description: {
    specific: ['kozlemeny', 'megjegyzes', 'narrative', 'description', 'details'],
    generic: ['megnevezes'],
  },
  reference: { specific: ['hivatkozas', 'bizonylat', 'reference', 'tranzakcio azonosito', 'transaction id'] },
  amount: { specific: ['osszeg', 'amount'], generic: ['value amount'] },
  debit: { specific: ['terheles', 'tartozik', 'debit'] },
  credit: { specific: ['jovairas', 'kovetel', 'credit'] },
  currency: { specific: ['devizanem', 'penznem', 'currency'], generic: ['deviza'] },
}

/** Weights, not a rank order of roles: a specific cue beats a generic one no
 *  matter which role each belongs to. debit/credit sit above `amount` so a
 *  "Terhelés összege" column is read as the debit column and not as THE amount. */
const CUE_WEIGHT = { debitCredit: 12, specific: 10, generic: 1 } as const

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
  return negative ? -n : n
}

/** Currencies with no minor unit. HUF is the only one this company sees in
 *  practice; the others are here so the rule reads as a rule and not as a
 *  special case for forint. */
const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'KRW', 'ISK', 'CLP', 'VND'])

/** Round only where rounding is lossless.
 *
 *  Every amount used to be Math.round()ed regardless of currency — fine for the
 *  forint, wrong for the EUR/USD lines this importer explicitly names Wise as a
 *  source of: 100.50 became 101, the cents were gone from the store, and
 *  reconciliation (which matches on exact equality) then failed or, worse,
 *  matched the neighbouring invoice.
 *
 *  Deliberately NOT switched to minor units: the column already holds major
 *  units for every row ever imported, and reinterpreting those rows as cents
 *  would divide the company's whole bank history by a hundred. That change needs
 *  a migration, and this file cannot ship one. SQLite's INTEGER affinity stores a
 *  non-integral value as REAL unchanged, so the cents survive here without any
 *  schema change and without touching a single existing row. */
function roundForCurrency(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount)
  return Math.round(amount * 100) / 100
}

// Any recognizable date → ISO. "2026.07.22", "2026-07-22", "2026/07/22", "22/07/2026".
//
// Validated, because it used to validate nothing: a US-ordered export of
// 07/22/2026 produced the string "2026-22-07", which is not a date. Nothing
// rejected it, it went into booking_date, and every SQLite date() comparison
// downstream (the due-item runner, the period roll-up) silently stopped matching
// that row. When the month is impossible and the day is not, the two are swapped
// — that is a mm/dd export, and the swap is the only reading of it that produces
// a real date. When neither reading works the field stays undefined, which is
// what this module does with everything it cannot parse.
function isoIfValid(year: string, month: string, day: string): string | undefined {
  const y = Number(year), mo = Number(month), d = Number(day)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  // Reject a day the month does not have (31 April, 30 February).
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function normalizeDate(raw: string): string | undefined {
  if (!raw) return undefined
  let m = /(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})/.exec(raw)
  if (m) return isoIfValid(m[1], m[2], m[3]) ?? isoIfValid(m[1], m[3], m[2])
  m = /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/.exec(raw) // dd/mm/yyyy, or mm/dd/yyyy
  if (m) return isoIfValid(m[3], m[2], m[1]) ?? isoIfValid(m[3], m[1], m[2])
  return undefined
}

/** Map header cells to column indices by cue matching, scored across the WHOLE
 *  header before anything is assigned. A role stays -1 (absent) if no header
 *  matches it, and a column is claimed by at most one role — the one whose cue
 *  was the most specific. */
function mapColumns(headerCells: string[]): Record<ColumnRole, number> {
  const idx = {} as Record<ColumnRole, number>
  const roles = Object.keys(COLUMN_CUES) as ColumnRole[]
  for (const role of roles) idx[role] = -1

  const candidates: Array<{ role: ColumnRole; col: number; score: number }> = []
  for (const role of roles) {
    const cues = COLUMN_CUES[role]
    const specificWeight = role === 'debit' || role === 'credit' ? CUE_WEIGHT.debitCredit : CUE_WEIGHT.specific
    for (let c = 0; c < headerCells.length; c++) {
      const h = deaccent(headerCells[c])
      if (cues.specific.some(cue => h.includes(cue))) candidates.push({ role, col: c, score: specificWeight })
      else if (cues.generic?.some(cue => h.includes(cue))) candidates.push({ role, col: c, score: CUE_WEIGHT.generic })
    }
  }
  // Highest score first; ties keep the leftmost column, which is the old
  // behaviour and the only sensible arbitrary rule.
  candidates.sort((a, b) => b.score - a.score || a.col - b.col)
  const takenColumns = new Set<number>()
  for (const cand of candidates) {
    if (idx[cand.role] >= 0 || takenColumns.has(cand.col)) continue
    idx[cand.role] = cand.col
    takenColumns.add(cand.col)
  }
  return idx
}

/** Decode a statement file that may not be UTF-8.
 *
 *  Hungarian netbank exports are still commonly ISO-8859-2 or Windows-1250. Read
 *  as UTF-8, those files turn every accented character into U+FFFD, which is
 *  exactly the input `deaccent` cannot recover: "Könyvelés dátuma" becomes
 *  "K?nyvel?s d?tuma", the specific cues stop matching, the mapping falls back to
 *  the generic ones (feeding the mis-assignment this file just fixed) or the
 *  dry-run rejects a perfectly good statement.
 *
 *  U+FFFD is the signal: it cannot appear in a correctly decoded UTF-8 file
 *  unless the source really contains it. Windows-1250 is tried before
 *  ISO-8859-2 because it is what Windows netbank exports actually produce, and
 *  the two differ on the letters Hungarian needs most (ő, ű).
 *
 *  Returns the decoded text plus the encoding used, so the caller can SAY which
 *  one it picked — a silent guess about character encoding is how a statement
 *  gets imported with the wrong vendor names. */
export function decodeStatementBuffer(
  buf: Uint8Array, explicitEncoding?: string,
): { text: string; encoding: string } {
  if (explicitEncoding) {
    return { text: new TextDecoder(explicitEncoding).decode(buf), encoding: explicitEncoding }
  }
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' }
  for (const enc of ['windows-1250', 'iso-8859-2']) {
    try {
      const text = new TextDecoder(enc).decode(buf)
      if (!text.includes('�')) return { text, encoding: enc }
    } catch { /* this build has no such decoder; try the next */ }
  }
  // Nothing decoded cleanly. The UTF-8 reading is returned rather than a
  // half-guess, and it still carries U+FFFD — so the caller's own "unrecognised
  // statement" check fires instead of a mangled import proceeding quietly.
  return { text: utf8, encoding: 'utf-8' }
}

/** Parse a CSV bank statement into transaction rows. Returns [] if there is no
 *  usable header (needs at least a date-or-amount column). */
export function parseBankStatementCsv(csv: string): BankTxnRow[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const delim = detectDelimiter(lines[0])
  const header = splitCsvLine(lines[0], delim)
  const col = mapColumns(header)
  const hasAmountColumn = col.amount >= 0 || col.debit >= 0 || col.credit >= 0
  if (col.bookingDate < 0 && !hasAmountColumn) return [] // not a recognizable statement
  const out: BankTxnRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delim)
    const get = (r: ColumnRole) => (col[r] >= 0 ? cells[col[r]] ?? '' : '')
    const currency = (get('currency') || 'HUF').toUpperCase()
    // A K&H-style statement has no single amount column: it has Terhelés and
    // Jóváírás, and each row fills exactly one of them. The signed amount is
    // synthesised here — before this, whichever of the two columns came first
    // WAS the amount, and every row of the other direction imported as NULL.
    let raw = parseAmount(get('amount'))
    if (raw == null) {
      const debit = parseAmount(get('debit'))
      const credit = parseAmount(get('credit'))
      if (debit != null && debit !== 0) raw = -Math.abs(debit)
      else if (credit != null && credit !== 0) raw = Math.abs(credit)
    }
    const amount = raw == null ? null : roundForCurrency(raw, currency)
    const bookingDate = normalizeDate(get('bookingDate'))
    if (amount == null && !bookingDate) continue // empty/garbage row
    const row: BankTxnRow = {
      bookingDate,
      valueDate: normalizeDate(get('valueDate')),
      counterparty: get('counterparty') || undefined,
      description: get('description') || undefined,
      reference: get('reference') || undefined,
      amount: amount ?? undefined,
      currency,
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
  // How many times this exact fingerprint has already appeared IN THIS
  // STATEMENT. Two genuinely distinct transactions can be identical on every
  // field the hash uses — two identical card charges on the same day, two
  // reference-free transfers to the same vendor — and the second one used to be
  // counted as a duplicate and never inserted. That is not a re-import guard
  // doing its job, it is the books undercounting real money movements, with a
  // CLI counter as the only trace.
  //
  // The occurrence index makes the second line its own row. Re-importing the
  // same statement still books nothing new: the same lines produce the same
  // sequence of ids, so every one of them is found and counted as a duplicate.
  const occurrence = new Map<string, number>()
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.amount == null && !r.bookingDate) { result.skipped++; continue }
      const h = txnHash(args.accountId, r)
      const n = (occurrence.get(h) ?? 0) + 1
      occurrence.set(h, n)
      const id = n === 1 ? `zst-btx-${h}` : `zst-btx-${h}-${n}`
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
