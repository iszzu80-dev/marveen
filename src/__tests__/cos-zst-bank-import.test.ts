import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { parseBankStatementCsv, importBankStatement, decodeStatementBuffer } from '../cos/zst-bank-import.js'
import { upsertZstInvoice, suggestBankMatches } from '../cos/zst-finance.js'

const T0 = 1_700_000_000

// A Hungarian-style bank export: semicolon delimiter, accented headers, HU numbers.
const CSV = [
  'Könyvelés dátuma;Értéknap;Partner neve;Közlemény;Összeg;Devizanem',
  '2026.07.22;2026.07.22;DMRV Zrt.;Vizdij szamla 4102268904;-15 484;HUF',
  '2026.07.23;2026.07.23;NAV;Adoelolegek;-120 000;HUF',
  '2026.07.24;2026.07.24;Ugyfel Kft.;Bejovo utalas;1.250.000,00;HUF',
].join('\n')

describe('ZST bank statement importer (v1 CSV)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('auto-detects delimiter and columns, parses HU amounts and dates with sign', () => {
    const rows = parseBankStatementCsv(CSV)
    expect(rows).toHaveLength(3)
    expect(rows[0].counterparty).toBe('DMRV Zrt.')
    expect(rows[0].amount).toBe(-15484)
    expect(rows[0].direction).toBe('DEBIT')
    expect(rows[0].bookingDate).toBe('2026-07-22')
    expect(rows[2].amount).toBe(1250000) // "1.250.000,00" → 1250000
    expect(rows[2].direction).toBe('CREDIT')
  })

  it('returns [] for text that is not a recognizable statement', () => {
    expect(parseBankStatementCsv('hello world\nno columns here')).toEqual([])
  })

  it('imports rows UNMATCHED and is idempotent on re-import', () => {
    const db = getDb()
    const r1 = importBankStatement(db, { accountId: 'zst-main', statementId: 's1', csv: CSV }, T0)
    expect(r1.imported).toBe(3)
    expect(r1.duplicates).toBe(0)
    const r2 = importBankStatement(db, { accountId: 'zst-main', statementId: 's1', csv: CSV }, T0 + 10)
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(3) // dedup, no double-booking
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_bank_transactions`).get() as any).n).toBe(3)
    const st: any = db.prepare(`SELECT reconciliation_status FROM zst_bank_transactions LIMIT 1`).get()
    expect(st.reconciliation_status).toBe('UNMATCHED') // never auto-reconciled
  })

  it('closes the finance loop: imported txn is matchable to an invoice by amount', () => {
    const db = getDb()
    // An invoice from DMRV for the same gross as the debit line.
    upsertZstInvoice(db, { supplierId: 'DMRV Zrt.', invoiceNumber: '4102268904', grossAmount: 15484, issueDate: '2026-07-22' }, T0)
    importBankStatement(db, { accountId: 'zst-main', csv: CSV }, T0)
    const suggestions = suggestBankMatches(db, T0 + 5)
    const dmrv = suggestions.find(s => s.confidence === 1.0)
    expect(dmrv).toBeTruthy() // amount match + counterparty contains supplier → 1.0
  })

  it('handles comma-decimal amounts and parenthesised negatives', () => {
    const rows = parseBankStatementCsv([
      'Dátum;Összeg', '2026-01-05;15484,50', '2026-01-06;(1 200)',
    ].join('\n'))
    expect(rows[0].amount).toBe(15485) // rounded
    expect(rows[1].amount).toBe(-1200) // parentheses = debit
  })
})

// ── The statements this importer met in the wild ─────────────────────────────
//
// Every case below was silently wrong before 2026-08-13, and every one of them
// is money: an amount that never landed, an amount rounded away, a transaction
// counted as a duplicate of a different transaction, a date that no SQLite
// date() comparison could ever match.
describe('ZST bank importer — layouts and amounts that used to be lost', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('binds the booking date even when the value date column comes first', () => {
    // Roles were resolved left to right, and bookingDate's generic `datum`/`date`
    // cue grabbed whatever date column appeared first — so this layout filed
    // every transaction under its value date.
    // "Value date" contains the generic cue `date`, so under the old scan it won
    // the bookingDate role simply by standing further left.
    const rows = parseBankStatementCsv([
      'Value date;Booking date;Amount', '2026-07-20;2026-07-22;-15 484',
    ].join('\n'))
    expect(rows[0].bookingDate).toBe('2026-07-22')
    expect(rows[0].valueDate).toBe('2026-07-20')
    // The Hungarian equivalent maps the same way round.
    const hu = parseBankStatementCsv([
      'Értéknap;Könyvelés dátuma;Összeg', '2026-07-20;2026-07-22;-15 484',
    ].join('\n'))
    expect(hu[0].bookingDate).toBe('2026-07-22')
    expect(hu[0].valueDate).toBe('2026-07-20')
  })

  it('reads a separate Terhelés / Jóváírás pair as one signed amount', () => {
    // K&H-style. `terheles` and `jovairas` were both cues for `amount`, so the
    // first of the two columns became THE amount and every row of the other
    // direction imported with amount = NULL — half the statement, silently.
    const rows = parseBankStatementCsv([
      'Könyvelés dátuma;Partner;Terhelés;Jóváírás',
      '2026-07-22;DMRV Zrt.;15 484;',
      '2026-07-24;Ugyfel Kft.;;1 250 000',
    ].join('\n'))
    expect(rows).toHaveLength(2)
    expect(rows[0].amount).toBe(-15484)
    expect(rows[0].direction).toBe('DEBIT')
    expect(rows[1].amount).toBe(1250000)
    expect(rows[1].direction).toBe('CREDIT')
  })

  it('keeps the cents of a foreign-currency line, and still rounds forint', () => {
    // Math.round() was applied to every amount whatever the currency — this
    // module's own header names Wise as a source, and 100.50 EUR became 101.
    // Reconciliation matches on exact equality, so the cents are the match.
    const rows = parseBankStatementCsv([
      'Dátum;Összeg;Devizanem', '2026-01-05;100.50;EUR', '2026-01-06;15484,50;HUF',
    ].join('\n'))
    expect(rows[0].amount).toBe(100.5)
    expect(rows[1].amount).toBe(15485) // HUF has no minor unit; rounding is lossless
  })

  it('books two identical charges on the same day as two transactions', () => {
    // The fingerprint is account + date + amount + (reference || description),
    // so two genuinely distinct card charges collided and the SECOND one was
    // counted as a duplicate and never inserted — inside ONE statement, not
    // across re-imports.
    const db = getDb()
    const csv = [
      'Könyvelés dátuma;Partner;Közlemény;Összeg',
      '2026-07-22;Benzinkut;Kartyas vasarlas;-9 990',
      '2026-07-22;Benzinkut;Kartyas vasarlas;-9 990',
    ].join('\n')
    const r1 = importBankStatement(db, { accountId: 'zst-main', statementId: 's1', csv }, T0)
    expect(r1.imported).toBe(2)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_bank_transactions`).get() as { n: number }).n).toBe(2)
    // …and re-importing the same statement still books nothing new.
    const r2 = importBankStatement(db, { accountId: 'zst-main', statementId: 's1', csv }, T0 + 10)
    expect(r2.imported).toBe(0)
    expect(r2.duplicates).toBe(2)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_bank_transactions`).get() as { n: number }).n).toBe(2)
  })

  it('does not invent the date 2026-22-07 out of a US-ordered export', () => {
    // normalizeDate validated nothing: 07/22/2026 produced "2026-22-07", which
    // is not a date, and every date() comparison downstream stopped matching
    // that row while the import reported success.
    const rows = parseBankStatementCsv([
      'Booking date;Amount', '07/22/2026;-15484',
    ].join('\n'))
    expect(rows[0].bookingDate).toBe('2026-07-22')
    // A date that is impossible in BOTH readings stays absent, not fabricated.
    const bad = parseBankStatementCsv(['Booking date;Amount', '2026.13.32;-1'].join('\n'))
    expect(bad[0].bookingDate).toBeUndefined()
  })
})

describe('ZST bank importer — the file is not always UTF-8', () => {
  // A statement exported from a Hungarian netbank on Windows is Windows-1250 or
  // ISO-8859-2 far more often than not. Read as UTF-8 it loses every accent to
  // U+FFFD, deaccent cannot recover the header, and the import either degrades
  // to the generic column cues or is rejected as an unrecognised layout.
  const HEADER = 'Könyvelés dátuma;Értéknap;Partner neve;Összeg;Devizanem'
  const ROW = '2026.07.22;2026.07.22;DMRV Zrt.;-15 484;HUF'

  /** The same text as a Windows-1250 byte stream (what netbank actually writes). */
  function cp1250(text: string): Uint8Array {
    const MAP: Record<string, number> = {
      'ö': 0xF6, 'ó': 0xF3, 'ő': 0xF5, 'ü': 0xFC, 'ű': 0xFB, 'ú': 0xFA,
      'á': 0xE1, 'é': 0xE9, 'í': 0xED, 'Ö': 0xD6, 'Á': 0xC1, 'É': 0xC9,
    }
    return Uint8Array.from([...text].map(ch => MAP[ch] ?? ch.charCodeAt(0)))
  }

  it('decodes a Windows-1250 statement instead of mangling its headers', () => {
    const { text, encoding } = decodeStatementBuffer(cp1250(`${HEADER}\n${ROW}`))
    expect(encoding).toBe('windows-1250')
    expect(text.split('\n')[0]).toBe(HEADER)
    const rows = parseBankStatementCsv(text)
    expect(rows).toHaveLength(1)
    expect(rows[0].bookingDate).toBe('2026-07-22')
    expect(rows[0].counterparty).toBe('DMRV Zrt.')
    expect(rows[0].amount).toBe(-15484)
  })

  it('leaves a genuine UTF-8 statement alone, and honours an explicit encoding', () => {
    const utf8 = new TextEncoder().encode(`${HEADER}\n${ROW}`)
    expect(decodeStatementBuffer(utf8).encoding).toBe('utf-8')
    expect(decodeStatementBuffer(cp1250(HEADER), 'windows-1250').text).toBe(HEADER)
  })

  it('the same statement read as UTF-8 is the failure this prevents', () => {
    // Not a claim about the fix — a record of what the bytes do without it, so
    // the test above is visibly about something real.
    const raw = new TextDecoder('utf-8').decode(cp1250(HEADER))
    expect(raw).toContain('\uFFFD')
    expect(parseBankStatementCsv(`${raw}\n${ROW}`)).toEqual([])
  })
})
