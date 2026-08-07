import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { parseBankStatementCsv, importBankStatement } from '../cos/zst-bank-import.js'
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
