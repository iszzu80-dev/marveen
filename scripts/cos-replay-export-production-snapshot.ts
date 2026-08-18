#!/usr/bin/env npx tsx
// Clean Replay v1.0 — READ-ONLY / read-only Marveen SQLite snapshot exporter.
//
// Run this on the Marveen host against the live DB path or, preferably, a
// filesystem snapshot/copy. better-sqlite3 is opened readonly+fileMustExist and
// PRAGMA query_only=ON is asserted before any SELECT. There is no initDatabase,
// migration, CREATE, UPDATE or repair path in this program.

import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProductionCaseSnapshot, ZstLegacyCaseInput } from '../src/cos/replay/types.js'
import { normaliseSourceReference } from '../src/cos/replay/source-reference.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function required(name: string): string {
  const v = arg(name)
  if (!v) throw new Error(`missing required ${name}`)
  return resolve(v)
}

const dbPath = required('--db')
const productionOut = required('--production-out')
const zstOut = required('--zst-out')
// Stage 2H: the extractor-parity surface compares the structured rows production
// actually holds. Without them the comparison has nothing on the production side
// and would report agreement out of its own silence -- the exact defect the
// 2026-08-17 attachment-parity audit named.
const financeOut = required('--finance-out')
if (new Set([dbPath, productionOut, zstOut, financeOut]).size !== 4) throw new Error('input and output paths must be distinct')

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  db.pragma('query_only = ON')
  const queryOnly = Number(db.pragma('query_only', { simple: true }))
  if (queryOnly !== 1) throw new Error('SQLite query_only could not be asserted; refusing snapshot export')

  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  for (const t of ['personal_cases', 'zst_cases']) if (!tableExists(t)) throw new Error(`required table missing: ${t}`)

  function columns(table: string): Set<string> {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(x => x.name))
  }
  function col(c: Set<string>, name: string, fallback = 'NULL'): string { return c.has(name) ? name : `${fallback} AS ${name}` }

  function readCases(domain: 'personal' | 'zst'): ProductionCaseSnapshot[] {
    const table = domain === 'personal' ? 'personal_cases' : 'zst_cases'
    const c = columns(table)
    const fields = [
      'case_id', 'title', col(c, 'case_type'), 'status', col(c, 'next_action'), col(c, 'next_action_owner'),
      col(c, 'waiting_on'), col(c, 'due_at'), col(c, 'follow_up_at'), col(c, 'next_wake_at'),
      col(c, 'closure_reason'), col(c, 'gmail_thread_ids', "'[]'"),
      // The column is `source_references` (plural) in both case tables. Reading
      // the singular name would fall back to NULL for every row and quietly
      // make every parity target "not equivalent" instead of measured.
      c.has('source_references') ? 'source_references' : col(c, 'source_reference', 'NULL') + ' AS source_references',
    ]
    const rows = db.prepare(`SELECT ${fields.join(', ')} FROM ${table} ORDER BY case_id`).all() as Array<Record<string, unknown>>
    const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
    const ledger = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
    const haveEvents = tableExists(events)
    const haveLedger = tableExists(ledger)
    const humanStmt = haveEvents ? db.prepare(`SELECT 1 FROM ${events} WHERE case_id=? AND (actor='owner' OR event_type LIKE 'OWNER_%' OR source_system IN ('mission_control','telegram')) LIMIT 1`) : null
    const receiptCols = haveLedger ? columns(ledger) : new Set<string>()
    const receiptStmt = haveLedger && receiptCols.has('case_id')
      ? db.prepare(`SELECT 1 FROM ${ledger} WHERE case_id=? AND (${receiptCols.has('provider_message_id') ? 'provider_message_id IS NOT NULL' : '1=0'} OR ${receiptCols.has('external_marker') ? 'external_marker IS NOT NULL' : '1=0'}) LIMIT 1`)
      : null

    return rows.map(r => {
      let threadIds: string[] = []
      try {
        const parsed = JSON.parse(String(r.gmail_thread_ids ?? '[]'))
        threadIds = Array.isArray(parsed) ? parsed.map(String) : []
      } catch { /* malformed stored projection becomes no identity; reconcile reports it */ }
      return {
        caseId: String(r.case_id), domain, threadIds, title: String(r.title ?? ''),
        caseType: r.case_type == null ? null : String(r.case_type), status: String(r.status),
        nextAction: r.next_action == null ? null : String(r.next_action),
        nextActionOwner: r.next_action_owner == null ? null : String(r.next_action_owner),
        waitingOn: r.waiting_on == null ? null : String(r.waiting_on),
        dueAt: r.due_at == null ? null : Number(r.due_at), followUpAt: r.follow_up_at == null ? null : Number(r.follow_up_at),
        nextWakeAt: r.next_wake_at == null ? null : Number(r.next_wake_at),
        closureReason: r.closure_reason == null ? null : String(r.closure_reason),
        sourceReference: normaliseSourceReference(r.source_references),
        hasHumanAuthorityEvent: !!humanStmt?.get(r.case_id), hasExternalReceipt: !!receiptStmt?.get(r.case_id),
      }
    })
  }

  const production = [...readCases('personal'), ...readCases('zst')]
  const zstCols = columns('zst_cases')
  const zstRows = db.prepare(`SELECT case_id, status, ${col(zstCols,'case_type')}, ${col(zstCols,'next_action')}, ${col(zstCols,'next_action_owner')}, ${col(zstCols,'waiting_on')}, ${col(zstCols,'due_at')}, ${col(zstCols,'follow_up_at')}, ${col(zstCols,'next_wake_at')}, ${col(zstCols,'parent_case_id')} FROM zst_cases ORDER BY case_id`).all() as Array<Record<string, unknown>>
  const zstLegacy: ZstLegacyCaseInput[] = zstRows.map(r => ({
    caseId: String(r.case_id), status: String(r.status), caseType: r.case_type == null ? null : String(r.case_type),
    nextAction: r.next_action == null ? null : String(r.next_action), nextActionOwner: r.next_action_owner == null ? null : String(r.next_action_owner),
    waitingOn: r.waiting_on == null ? null : String(r.waiting_on), dueAt: r.due_at == null ? null : Number(r.due_at),
    followUpAt: r.follow_up_at == null ? null : Number(r.follow_up_at), nextWakeAt: r.next_wake_at == null ? null : Number(r.next_wake_at),
    parentCaseId: r.parent_case_id == null ? null : String(r.parent_case_id),
  }))

  // zst_invoices / zst_contracts: the production side of the extractor parity.
  // A missing table is reported as an empty list with an explicit marker, never
  // as a silent zero that a later report could read as "production had none".
  const financeTables = { invoices: tableExists('zst_invoices'), contracts: tableExists('zst_contracts') }
  const invoices = financeTables.invoices
    ? (db.prepare(`SELECT case_id, invoice_number, supplier_id, gross_amount, currency, issue_date, due_date, notes FROM zst_invoices ORDER BY invoice_id`).all() as Array<Record<string, unknown>>).map(r => ({
      caseId: r.case_id == null ? null : String(r.case_id),
      invoiceNumber: r.invoice_number == null ? null : String(r.invoice_number),
      supplierId: r.supplier_id == null ? null : String(r.supplier_id),
      grossAmount: r.gross_amount == null ? null : Number(r.gross_amount),
      currency: r.currency == null ? null : String(r.currency),
      issueDate: r.issue_date == null ? null : String(r.issue_date),
      dueDate: r.due_date == null ? null : String(r.due_date),
      notes: r.notes == null ? null : String(r.notes),
    }))
    : []
  const contracts = financeTables.contracts
    ? (db.prepare(`SELECT case_id, title, contract_type, counterparty_id, effective_date, expiry_date, renewal_type, notice_period_days, termination_deadline, financial_commitment, currency FROM zst_contracts ORDER BY contract_id`).all() as Array<Record<string, unknown>>).map(r => ({
      caseId: r.case_id == null ? null : String(r.case_id),
      title: r.title == null ? null : String(r.title),
      contractType: r.contract_type == null ? null : String(r.contract_type),
      counterpartyId: r.counterparty_id == null ? null : String(r.counterparty_id),
      effectiveDate: r.effective_date == null ? null : String(r.effective_date),
      expiryDate: r.expiry_date == null ? null : String(r.expiry_date),
      renewalType: r.renewal_type == null ? null : String(r.renewal_type),
      noticePeriodDays: r.notice_period_days == null ? null : Number(r.notice_period_days),
      terminationDeadline: r.termination_deadline == null ? null : String(r.termination_deadline),
      financialCommitment: r.financial_commitment == null ? null : Number(r.financial_commitment),
      currency: r.currency == null ? null : String(r.currency),
    }))
    : []

  writeFileSync(financeOut, JSON.stringify({
    invoicesTable: financeTables.invoices ? 'PRESENT' : 'TABLE_ABSENT',
    contractsTable: financeTables.contracts ? 'PRESENT' : 'TABLE_ABSENT',
    invoices, contracts,
  }, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(productionOut, JSON.stringify(production, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(zstOut, JSON.stringify(zstLegacy, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({
    queryOnly: true, personalCases: production.filter(x => x.domain === 'personal').length,
    zstCases: zstLegacy.length,
    casesWithSourceReference: production.filter(x => x.sourceReference != null).length,
    invoices: invoices.length, contracts: contracts.length,
    invoicesTable: financeTables.invoices ? 'PRESENT' : 'TABLE_ABSENT',
    contractsTable: financeTables.contracts ? 'PRESENT' : 'TABLE_ABSENT',
    productionOut, zstOut, financeOut,
  }, null, 2) + '\n')
} finally {
  db.close()
}
