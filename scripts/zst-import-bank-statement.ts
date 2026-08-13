// Import a ZST bank-statement CSV into zst_bank_transactions.
//
// This is the door for zst-bank-import.ts, which was written, tested, and never
// imported by anything outside its own test file. A bank importer with no entry
// point does not import bank statements -- it is a module that would, if asked,
// and nothing was in a position to ask.
//
// A CLI rather than an HTTP route on purpose. A statement is a file Istvan
// exports from netbank and drops on disk; making him upload it through a
// dashboard endpoint would add a form to build and nothing to gain. Scripts are
// production here (the acceptance gate counts scripts/ as production for exactly
// this reason: a scheduled task's entry point IS the caller).
//
// Nothing autonomous happens. Importing records observed transactions;
// suggestBankMatches only ever proposes MATCH_SUGGESTED, and a human confirms
// every reconciliation.
//
//   npx tsx scripts/zst-import-bank-statement.ts <statement.csv> [--account OTP-HUF] [--encoding windows-1250] [--apply]
//
// Without --apply it parses and reports, and writes nothing -- so a statement
// with an unrecognised layout is discovered before it lands in the store.

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { parseBankStatementCsv, importBankStatement, decodeStatementBuffer } from '../src/cos/zst-bank-import.js'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}

function main(): void {
  const csvPath = process.argv[2]
  if (!csvPath || csvPath.startsWith('--')) {
    console.error('usage: zst-import-bank-statement.ts <statement.csv> [--account ID] [--db PATH] [--encoding ENC] [--apply]')
    process.exit(2)
  }
  const apply = process.argv.includes('--apply')
  const accountId = arg('account', 'ZST-MAIN')!
  const dbPath = arg('db', 'store/claudeclaw.db')!
  // NOT readFileSync(..., 'utf8'). Hungarian netbank exports are commonly
  // ISO-8859-2 / Windows-1250, and reading one of those as UTF-8 turns every
  // accented header into U+FFFD -- which deaccent cannot recover, so the column
  // mapping degrades to its generic cues or the check below rejects a good
  // statement. Detected, and the choice is printed: an encoding guessed in
  // silence is how vendor names get imported as mojibake.
  const { text: csv, encoding } = decodeStatementBuffer(readFileSync(resolve(csvPath)), arg('encoding'))
  if (encoding !== 'utf-8') console.log(`kódolás: ${encoding} (nem UTF-8)`)

  const parsed = parseBankStatementCsv(csv)
  // A statement whose layout we did not recognise parses to nothing, or to rows
  // with no amount. Saying "0 imported" and exiting 0 would read as a clean
  // import of an empty month.
  const usable = parsed.filter(r => r.amount != null || r.bookingDate)
  console.log(`${basename(csvPath)}: ${parsed.length} sor, ebből ${usable.length} használható`)
  if (usable.length === 0) {
    console.error('FELISMERHETETLEN KIVONAT: egyetlen sorban sem találtam összeget vagy könyvelési dátumot. '
      + 'Nem üres hónap ez, hanem ismeretlen oszlopelrendezés.')
    process.exit(1)
  }
  for (const r of usable.slice(0, 5)) {
    console.log(`  ${r.bookingDate ?? '?'.padEnd(10)}  ${String(r.amount ?? '?').padStart(12)} ${r.currency ?? ''}  ${(r.counterparty ?? r.description ?? '').slice(0, 40)}`)
  }
  if (usable.length > 5) console.log(`  … és még ${usable.length - 5}`)

  if (!apply) {
    console.log('\nDRY RUN — semmi nem íródott. --apply a betöltéshez.')
    return
  }

  const db = new Database(resolve(dbPath))
  db.pragma('journal_mode = WAL')
  const r = importBankStatement(db, { accountId, statementId: basename(csvPath), csv }, Math.floor(Date.now() / 1000))
  console.log(`\nbetöltve ${r.imported}, duplikátum ${r.duplicates}, kihagyva ${r.skipped}`)
  const total = (db.prepare('SELECT COUNT(*) AS n FROM zst_bank_transactions').get() as { n: number }).n
  console.log(`zst_bank_transactions összesen: ${total}`)
  db.close()
}

main()
