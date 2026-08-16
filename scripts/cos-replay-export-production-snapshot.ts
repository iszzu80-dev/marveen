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
if (new Set([dbPath, productionOut, zstOut]).size !== 3) throw new Error('input and output paths must be distinct')

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

  writeFileSync(productionOut, JSON.stringify(production, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(zstOut, JSON.stringify(zstLegacy, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ queryOnly: true, personalCases: production.filter(x => x.domain === 'personal').length, zstCases: zstLegacy.length, productionOut, zstOut }, null, 2) + '\n')
} finally {
  db.close()
}
