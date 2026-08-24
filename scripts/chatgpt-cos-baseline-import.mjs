// One-off ChatGPT-CoS baseline import into the Marveen COS (Istvan FINAL GO, 2026-08-24).
//
// WHAT THIS IS NOT. It is not a sync. It runs once against a FROZEN snapshot, and
// after it the two systems are deliberately let go of each other so the parallel
// comparison measures two independent assistants rather than one echoing the other.
// A continuing state-sync would make every "Marveen found it" unfalsifiable.
//
// THE RULE THAT SHAPES EVERYTHING BELOW. A Sheet row is EXTERNAL STATE, not a
// judgement Marveen made. So:
//   - no imported case gets a triage receipt. Inventing one would manufacture
//     exactly the evidence Stage 2G exists to make trustworthy;
//   - origin is recorded as CHATGPT_DRIVE_BASELINE / EXTERNAL_STATE_IMPORT, always;
//   - a fuzzy title match NEVER merges. It is reported for a human to decide,
//     because "medence" appears in two unrelated matters and a wrong merge is
//     much harder to notice than a duplicate.
//
// Writes go through case-store (createCase / transitionCase / appendCaseEvent) so
// they are version-safe and leave audit events; personal_case_events is
// append-only by trigger and must not be worked around.
import Database from '/home/iszzu/marveen/node_modules/better-sqlite3/lib/index.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createCase, getCase, transitionCase, appendCaseEvent } from '/home/iszzu/marveen/dist/cos/case-store.js'
import { createZstCase, getZstCase, transitionZstCase, appendZstCaseEvent } from '/home/iszzu/marveen/dist/cos/zst-case-store.js'

// The two namespaces have SEPARATE stores, and the separation is the point:
// connector identity is the scope boundary and the two must never mix. The first
// run of this importer wrote 21 ZST cases into personal_cases because it picked
// the table name by string but called the personal store's functions -- the table
// name looked like the decision and was not. Binding both together here means a
// scope can no longer be half-chosen.
const STORES = {
  personal: { table: 'personal_cases', create: createCase, get: getCase, transition: transitionCase, appendEvent: appendCaseEvent },
  zst:      { table: 'zst_cases',      create: createZstCase, get: getZstCase, transition: transitionZstCase, appendEvent: appendZstCaseEvent },
}

const DB_PATH = '/home/iszzu/marveen/store/claudeclaw.db'
const SNAP_DIR = '/home/iszzu/marveen/store/chatgpt-baseline-2026-08-24'
const APPLY = process.argv.includes('--apply')
const RUN_ID = process.argv.find(a => a.startsWith('--run='))?.slice(6) ?? 'baseline-2026-08-24'

const SOURCE_SYSTEM = 'CHATGPT_DRIVE_BASELINE'
const ORIGIN = 'EXTERNAL_STATE_IMPORT'
const ACTOR = 'marveen-baseline-import'

// Sheet status -> COS status, PER STORE.
//
// One shared map was the first version, and the CHECK constraint caught it: the
// two engines do not share a status vocabulary (personal has INFO_REQUIRED and
// TRIAGE, ZST has INFORMATION_REQUIRED and TRIAGE_REQUIRED). The guard below used
// to ask "does a mapping exist" -- which a personal-valid value answered yes to
// right before the ZST insert rejected it. It now asks the only question that
// matters: is this status valid IN THE STORE BEING WRITTEN. Anything unmapped is
// a hard skip, never a guess: a mis-mapped status silently changes what a case
// claims about itself.
const PERSONAL_STATUSES = new Set([
  'NEW', 'TRIAGE', 'INFO_REQUIRED', 'READY', 'PLANNING', 'AWAITING_APPROVAL',
  'EXECUTING', 'WAITING_EXTERNAL', 'FOLLOW_UP_DUE', 'CALL_REQUIRED',
  'AWAITING_SELECTION', 'SCHEDULED', 'BLOCKED', 'RECOVERY_REQUIRED',
  'COMPLETED', 'CANCELLED', 'ARCHIVED',
])
const ZST_STATUSES = new Set([
  'NEW', 'TRIAGE_REQUIRED', 'INFORMATION_REQUIRED', 'READY', 'PLANNING',
  'AWAITING_INTERNAL_INPUT', 'AWAITING_APPROVAL', 'EXECUTING', 'WAITING_EXTERNAL',
  'FOLLOW_UP_DUE', 'CALL_REQUIRED', 'REVIEW_REQUIRED', 'AWAITING_SELECTION',
  'SCHEDULED', 'BLOCKED', 'RECOVERY_REQUIRED', 'FAILED_RECOVERABLE',
  'FAILED_TERMINAL', 'COMPLETED', 'CANCELLED', 'ARCHIVED',
])
const STATUS_MAP = {
  personal: {
    'Tisztázandó': 'INFO_REQUIRED',
    'Következő lépés': 'READY',
    'Várakozik másra': 'WAITING_EXTERNAL',
    'Lezárásra vár': 'FOLLOW_UP_DUE',
    'Folyamatban': 'EXECUTING',
    'Döntésre vár': 'AWAITING_SELECTION',
    'Kész': 'COMPLETED',
    'Megfigyelés alatt': 'FOLLOW_UP_DUE',
    'Átvételre vár': 'WAITING_EXTERNAL',
    'Ütemezve': 'SCHEDULED',
    'Lezárt': 'COMPLETED',
    'Egyeztetendő': 'INFO_REQUIRED',
    'Blokkolt': 'BLOCKED',
  },
  zst: {
    'Tisztázandó': 'INFORMATION_REQUIRED',
    'Következő lépés': 'READY',
    'Várakozik másra': 'WAITING_EXTERNAL',
    'Lezárásra vár': 'FOLLOW_UP_DUE',
    'Folyamatban': 'EXECUTING',
    'Döntésre vár': 'AWAITING_SELECTION',
    'Kész': 'COMPLETED',
    'Blokkolt': 'BLOCKED',
    'Lezárt': 'COMPLETED',
  },
}
const ALLOWED_STATUSES = { personal: PERSONAL_STATUSES, zst: ZST_STATUSES }

const PRIORITY_MAP = { P1: 'P1', P2: 'P2', P3: 'P3' }

function sha(s) { return createHash('sha256').update(s).digest('hex') }
function rowHash(row) { return sha(JSON.stringify(row)) }
function toEpoch(s) {
  if (!s || !String(s).trim()) return null
  const d = new Date(String(s).trim().length === 10 ? String(s).trim() + 'T12:00:00Z' : String(s).trim())
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000)
}

function initLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_external_import_ledger (
      import_id      TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      sheet_name     TEXT NOT NULL,
      stable_row_id  TEXT NOT NULL,
      row_hash       TEXT NOT NULL,
      target_kind    TEXT NOT NULL,
      target_id      TEXT,
      outcome        TEXT NOT NULL,
      match_basis    TEXT,
      detail         TEXT,
      imported_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ext_import_run ON cos_external_import_ledger(run_id, outcome);
  `)
}

/** Idempotency key per Istvan: spreadsheet + sheet + stable row id. The row_hash
 *  is stored ALONGSIDE rather than inside the key on purpose: keeping the key
 *  stable is what lets a re-run recognise a CHANGED row as the same row, instead
 *  of importing it a second time under a new identity. */
function importId(sid, sheet, rowId) { return sha([sid, sheet, rowId].join('|')).slice(0, 32) }

function headerIndex(rows) {
  const h = rows[0] || []
  const ix = {}
  h.forEach((name, i) => { ix[name] = i })
  return ix
}
function realRows(rows) { return rows.slice(1).filter(r => r && (r[0] || '').trim()) }
function cell(row, ix, name) { return (row[ix[name]] ?? '').toString().trim() }

// --- matching -------------------------------------------------------------
// Order is Istvan's, and the order is the safety property: each step is a
// stronger claim than the one after it, so the first hit wins and the weak
// steps never get a chance to overrule a strong one.

function buildThreadIndex(db, table) {
  const idx = new Map()
  for (const r of db.prepare(`SELECT case_id, gmail_thread_ids, source_references FROM ${table}`).all()) {
    for (const field of [r.gmail_thread_ids, r.source_references]) {
      if (!field) continue
      for (const tok of String(field).split(/[^A-Za-z0-9_-]+/)) {
        if (tok.length >= 12) {
          if (!idx.has(tok)) idx.set(tok, new Set())
          idx.get(tok).add(r.case_id)
        }
      }
    }
  }
  return idx
}

function titleTokens(t) {
  return new Set(String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 4))
}
function titleOverlap(a, b) {
  const A = titleTokens(a), B = titleTokens(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.min(A.size, B.size)
}

function matchCase(db, table, sheetCaseId, sourceRefs, title, threadIdx, titleIndex) {
  // 1. exact existing case_id
  const exact = db.prepare(`SELECT case_id FROM ${table} WHERE case_id = ?`).get(sheetCaseId)
  if (exact) return { caseId: exact.case_id, basis: 'EXACT_CASE_ID' }

  // 2. Gmail thread / source_reference overlap
  for (const ref of sourceRefs) {
    const hit = threadIdx.get(ref)
    if (hit && hit.size === 1) return { caseId: [...hit][0], basis: 'SOURCE_REFERENCE_OVERLAP' }
    if (hit && hit.size > 1) {
      return { caseId: null, basis: 'AMBIGUOUS_SOURCE_REFERENCE', candidates: [...hit] }
    }
  }

  // 3/4. title similarity -- REPORTED, never applied. A merge that is wrong here
  // is invisible afterwards: two matters become one and nothing records that a
  // guess was made.
  const near = titleIndex
    .map(c => ({ caseId: c.case_id, score: titleOverlap(title, c.title) }))
    .filter(c => c.score >= 0.6)
    .sort((a, b) => b.score - a.score)
  if (near.length) return { caseId: null, basis: 'FUZZY_TITLE_REVIEW', candidates: near.slice(0, 3) }

  return { caseId: null, basis: 'NO_MATCH' }
}

// --- the import -----------------------------------------------------------

function importCases(db, snap, opts, report) {
  const { store, sheetName, spreadsheetId, scopeLabel, isStale } = opts
  const { table, create, get, transition, appendEvent } = STORES[store]
  const rows = snap.data[sheetName]
  if (!rows || rows.length < 2) { report.push({ scope: scopeLabel, kind: 'CASE', outcome: 'SKIPPED', detail: `${sheetName}: header only` }); return }
  const ix = headerIndex(rows)
  const data = realRows(rows)

  const threadIdx = buildThreadIndex(db, table)
  const titleIndex = db.prepare(`SELECT case_id, title FROM ${table} WHERE archived_at IS NULL`).all()
  const links = snap.data['Forráskapcsolatok']
  const refsByCase = new Map()
  if (links && links.length > 1) {
    const lix = headerIndex(links)
    for (const r of realRows(links)) {
      const cid = cell(r, lix, 'case_id')
      if (!cid) continue
      if (!refsByCase.has(cid)) refsByCase.set(cid, [])
      for (const k of ['object_id', 'parent_object_id']) {
        const v = cell(r, lix, k)
        if (v) refsByCase.get(cid).push(v)
      }
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const insLedger = db.prepare(`INSERT OR REPLACE INTO cos_external_import_ledger
    (import_id, run_id, spreadsheet_id, sheet_name, stable_row_id, row_hash, target_kind, target_id, outcome, match_basis, detail, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const prev = db.prepare('SELECT row_hash, outcome, target_id FROM cos_external_import_ledger WHERE import_id = ?')

  for (const row of data) {
    const sheetCaseId = cell(row, ix, 'case_id')
    const title = cell(row, ix, 'title')
    const rh = rowHash(row)
    const iid = importId(spreadsheetId, sheetName, sheetCaseId)
    const before = prev.get(iid)

    const record = (outcome, targetId, basis, detail) => {
      if (APPLY) insLedger.run(iid, RUN_ID, spreadsheetId, sheetName, sheetCaseId, rh, 'CASE', targetId, outcome, basis, detail, now)
      report.push({ scope: scopeLabel, kind: 'CASE', rowId: sheetCaseId, outcome, targetId, basis, detail })
    }

    const rawStatus = cell(row, ix, 'status')
    const status = STATUS_MAP[store][rawStatus]
    if (!status) { record('SKIPPED', null, 'UNMAPPED_STATUS', `status ${JSON.stringify(rawStatus)} has no mapping for the ${store} store; refusing to guess`); continue }
    if (!ALLOWED_STATUSES[store].has(status)) { record('SKIPPED', null, 'STATUS_NOT_VALID_IN_STORE', `${rawStatus} -> ${status} is not a valid status in ${STORES[store].table}`); continue }

    const refs = refsByCase.get(sheetCaseId) ?? []
    const m = matchCase(db, table, sheetCaseId, refs, title, threadIdx, titleIndex)

    if (!m.caseId && (m.basis === 'FUZZY_TITLE_REVIEW' || m.basis === 'AMBIGUOUS_SOURCE_REFERENCE')) {
      record('CONFLICT_REVIEW', null, m.basis,
        `no automatic merge; candidates: ${JSON.stringify(m.candidates)}`)
      continue
    }

    const sheetTouchedAt = toEpoch(cell(row, ix, 'last_event_at')) ?? toEpoch(cell(row, ix, 'follow_up_at')) ?? null

    if (!m.caseId) {
      if (!APPLY) { record('WOULD_CREATE', sheetCaseId, m.basis, 'new case from baseline'); continue }
      const created = create(db, {
        caseId: sheetCaseId,
        title: title || sheetCaseId,
        caseType: cell(row, ix, 'category') || 'GENERAL_OPERATION',
        description: cell(row, ix, 'summary') || null,
        category: cell(row, ix, 'category') || null,
        status,
        priority: PRIORITY_MAP[cell(row, ix, 'priority')] ?? 'P3',
        owner: cell(row, ix, 'owner') || 'Istvan',
        actor: ACTOR,
        sourceSystem: SOURCE_SYSTEM,
        sourceReference: `${spreadsheetId}#${sheetName}#${sheetCaseId}`,
      }, now)
      appendEvent(db, {
        caseId: sheetCaseId, caseVersion: created.version, actor: ACTOR,
        eventType: 'EXTERNAL_STATE_IMPORT',
        reason: `Imported from the ChatGPT CoS baseline. This case carries NO triage receipt and must not be treated as one: it is external state as of the frozen snapshot, not a judgement Marveen made.`,
        payload: JSON.stringify({ origin: ORIGIN, spreadsheetId, sheetName, stableRowId: sheetCaseId, rowHash: rh, runId: RUN_ID }),
        sourceSystem: SOURCE_SYSTEM, sourceReference: `${spreadsheetId}#${sheetName}#${sheetCaseId}`,
        correlationId: iid,
      }, now)
      record('CREATED_AS_IMPORT', sheetCaseId, m.basis, null)
      continue
    }

    // Matched an existing Marveen case.
    const existing = get(db, m.caseId)
    if (!existing) { record('ERROR', m.caseId, m.basis, 'matched id vanished between query and read'); continue }

    if (before && before.row_hash === rh) { record('UNCHANGED', m.caseId, m.basis, 'row identical to the last import'); continue }

    const marveenFresher = sheetTouchedAt !== null && existing.updated_at > sheetTouchedAt
    const sheetChangedSinceLastImport = before && before.row_hash !== rh

    if (marveenFresher && sheetChangedSinceLastImport) {
      record('CONFLICT_REVIEW', m.caseId, m.basis,
        `both sides moved: Marveen updated_at=${existing.updated_at} > sheet last_event_at=${sheetTouchedAt}, and the sheet row changed since the last import. No silent overwrite.`)
      continue
    }
    if (marveenFresher) {
      record('UNCHANGED', m.caseId, m.basis,
        `Marveen is fresher (updated_at=${existing.updated_at} > sheet ${sheetTouchedAt}); the sheet may not overwrite it`)
      continue
    }
    if (isStale && existing.status !== status && ['COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(existing.status) === false && sheetTouchedAt === null) {
      // ZST sheet is partly old and carries no timestamp for this row: refusing to
      // move a live case on undated evidence is the whole point of the rule.
      record('CONFLICT_REVIEW', m.caseId, m.basis,
        `stale source with no last_event_at would change status ${existing.status} -> ${status}; refused`)
      continue
    }
    if (existing.status === status) { record('UNCHANGED', m.caseId, m.basis, 'status already agrees'); continue }

    if (!APPLY) { record('WOULD_UPDATE', m.caseId, m.basis, `${existing.status} -> ${status}`); continue }
    transition(db, {
      caseId: m.caseId, seenVersion: existing.version, newStatus: status, actor: ACTOR,
      reason: `ChatGPT CoS baseline: ${existing.status} -> ${status} (external state, frozen snapshot ${snap.meta.exportSha256.slice(0, 16)})`,
      correlationId: iid,
      patch: {
        next_action: cell(row, ix, 'next_action') || null,
        next_action_owner: cell(row, ix, 'next_action_owner') || null,
        due_at: toEpoch(cell(row, ix, 'deadline')),
        follow_up_at: toEpoch(cell(row, ix, 'follow_up_at')),
      },
    }, now)
    record('UPDATED', m.caseId, m.basis, `${existing.status} -> ${status}`)
  }
}

/** Non-case tabs are imported as case EVENTS rather than new tables: they are
 *  statements about a case (a decision taken, a promise made, a refund expected),
 *  and putting them anywhere else would make the case's own history incomplete. */
function importAsEvents(db, snap, opts, report) {
  const { store, sheetName, spreadsheetId, scopeLabel, keyCol, eventType, dateCol, summarise } = opts
  const { get, appendEvent } = STORES[store]
  const rows = snap.data[sheetName]
  if (!rows || rows.length < 2) { report.push({ scope: scopeLabel, kind: eventType, outcome: 'SKIPPED', detail: `${sheetName}: header only` }); return }
  const ix = headerIndex(rows)
  const now = Math.floor(Date.now() / 1000)
  const insLedger = db.prepare(`INSERT OR REPLACE INTO cos_external_import_ledger
    (import_id, run_id, spreadsheet_id, sheet_name, stable_row_id, row_hash, target_kind, target_id, outcome, match_basis, detail, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const prev = db.prepare('SELECT row_hash FROM cos_external_import_ledger WHERE import_id = ?')

  for (const row of realRows(rows)) {
    const rowId = cell(row, ix, keyCol)
    const caseId = cell(row, ix, 'case_id')
    const rh = rowHash(row)
    const iid = importId(spreadsheetId, sheetName, rowId)
    const record = (outcome, targetId, basis, detail) => {
      if (APPLY) insLedger.run(iid, RUN_ID, spreadsheetId, sheetName, rowId, rh, eventType, targetId, outcome, basis, detail, now)
      report.push({ scope: scopeLabel, kind: eventType, rowId, outcome, targetId, basis, detail })
    }
    const before = prev.get(iid)
    if (before && before.row_hash === rh) { record('UNCHANGED', caseId, 'LEDGER', 'row identical to the last import'); continue }
    if (!caseId) { record('SKIPPED', null, 'NO_CASE_ID', 'row names no case; an orphan event would fail the FK'); continue }
    const existing = get(db, caseId)
    if (!existing) { record('SKIPPED', caseId, 'CASE_NOT_PRESENT', 'the case this row refers to is not in the COS; skipped rather than invented'); continue }
    if (!APPLY) { record('WOULD_CREATE', caseId, 'EXACT_CASE_ID', eventType); continue }
    appendEvent(db, {
      caseId, caseVersion: existing.version, actor: ACTOR, eventType,
      reason: summarise(row, ix),
      payload: JSON.stringify({ origin: ORIGIN, spreadsheetId, sheetName, stableRowId: rowId, rowHash: rh, runId: RUN_ID,
        fields: Object.fromEntries(Object.keys(ix).map(k => [k, cell(row, ix, k)]).filter(([, v]) => v)) }),
      sourceSystem: SOURCE_SYSTEM, sourceReference: `${spreadsheetId}#${sheetName}#${rowId}`,
      correlationId: iid,
    }, toEpoch(cell(row, ix, dateCol)) ?? now)
    record('CREATED_AS_IMPORT', caseId, 'EXACT_CASE_ID', null)
  }
}

/** Account for a tab that is CONSUMED rather than written. Every row gets a line
 *  in the reconciliation saying what it was used for and whether its case exists,
 *  so the sanity check ("no Drive row vanishes") can be answered by counting
 *  instead of by trusting that consumption happened. */
function accountForMatchEvidence(db, snap, opts, report) {
  const { store, sheetName, spreadsheetId, scopeLabel, keyCol } = opts
  const { table } = STORES[store]
  const rows = snap.data[sheetName]
  if (!rows || rows.length < 2) { report.push({ scope: scopeLabel, kind: 'MATCH_EVIDENCE', outcome: 'SKIPPED', detail: `${sheetName}: header only` }); return }
  const ix = headerIndex(rows)
  for (const row of realRows(rows)) {
    const rowId = cell(row, ix, keyCol)
    const caseId = cell(row, ix, 'case_id')
    const known = caseId ? db.prepare(`SELECT 1 FROM ${table} WHERE case_id = ?`).get(caseId) : null
    report.push({
      scope: scopeLabel, kind: 'MATCH_EVIDENCE', rowId,
      outcome: known ? 'CONSUMED_AS_MATCH_EVIDENCE' : 'CONSUMED_CASE_NOT_PRESENT',
      targetId: caseId || null, basis: cell(row, ix, 'source_type') || null,
      detail: known ? null : 'row names a case that is not in the COS; used for nothing, recorded so it is not lost',
    })
  }
}

// --- run ------------------------------------------------------------------

const db = new Database(DB_PATH)
initLedger(db)
const report = []

const personal = JSON.parse(readFileSync(`${SNAP_DIR}/personal.rows.json`, 'utf8'))
const zst = JSON.parse(readFileSync(`${SNAP_DIR}/zst.rows.json`, 'utf8'))

const run = db.transaction(() => {
  importCases(db, personal, {
    store: 'personal', sheetName: 'Ügyek', spreadsheetId: personal.meta.spreadsheetId,
    scopeLabel: 'PERSONAL', isStale: false,
  }, report)
  for (const spec of [
    { sheetName: 'Döntések', keyCol: 'decision_id', eventType: 'DECISION_IMPORTED', dateCol: 'decided_at',
      summarise: (r, ix) => `Döntés (ChatGPT CoS): ${cell(r, ix, 'question')} -> ${cell(r, ix, 'decision') || '(még nincs döntés)'}` },
    { sheetName: 'Vállalások', keyCol: 'commitment_id', eventType: 'COMMITMENT_IMPORTED', dateCol: 'promised_at',
      summarise: (r, ix) => `Vállalás (${cell(r, ix, 'promised_by')}): ${cell(r, ix, 'promise')} [${cell(r, ix, 'status')}]` },
    { sheetName: 'Visszatérítések', keyCol: 'refund_id', eventType: 'REFUND_IMPORTED', dateCol: 'initiated_at',
      summarise: (r, ix) => `Visszatérítés ${cell(r, ix, 'counterparty')}: ${cell(r, ix, 'amount')} ${cell(r, ix, 'currency')} [${cell(r, ix, 'status')}]` },
    { sheetName: 'Számlák', keyCol: 'invoice_id', eventType: 'INVOICE_IMPORTED', dateCol: 'issue_date',
      summarise: (r, ix) => `Számla ${cell(r, ix, 'supplier')} ${cell(r, ix, 'invoice_no')}: ${cell(r, ix, 'total_shown')} ${cell(r, ix, 'currency')} [${cell(r, ix, 'status')}] — READ-ONLY állapot, fizetést nem indít` },
  ]) {
    importAsEvents(db, personal, { store: 'personal', spreadsheetId: personal.meta.spreadsheetId, scopeLabel: 'PERSONAL', ...spec }, report)
  }

  // Forráskapcsolatok is not imported as rows: it IS the matching evidence, and
  // its 94 entries are consumed above. It is still accounted for line by line,
  // because "used for matching" and "silently dropped" look identical in a
  // reconciliation that only counts what it wrote.
  accountForMatchEvidence(db, personal, {
    store: 'personal', sheetName: 'Forráskapcsolatok',
    spreadsheetId: personal.meta.spreadsheetId, scopeLabel: 'PERSONAL', keyCol: 'source_link_id',
  }, report)

  importCases(db, zst, {
    store: 'zst', sheetName: 'Ügyek', spreadsheetId: zst.meta.spreadsheetId,
    scopeLabel: 'ZST', isStale: true,
  }, report)
  for (const spec of [
    { sheetName: 'Számlák', keyCol: 'invoice_id', eventType: 'INVOICE_IMPORTED', dateCol: 'issue_date',
      summarise: (r, ix) => `ZST számla ${cell(r, ix, 'supplier_customer')} ${cell(r, ix, 'invoice_number')}: ${cell(r, ix, 'gross_amount')} ${cell(r, ix, 'currency')} — READ-ONLY` },
    { sheetName: 'Szerződések', keyCol: 'contract_id', eventType: 'CONTRACT_IMPORTED', dateCol: 'start_date',
      summarise: (r, ix) => `ZST szerződés ${cell(r, ix, 'partner')}: ${cell(r, ix, 'subject')}` },
    { sheetName: 'Döntések', keyCol: 'decision_id', eventType: 'DECISION_IMPORTED', dateCol: 'decided_at',
      summarise: (r, ix) => `ZST döntés: ${cell(r, ix, 'question')} -> ${cell(r, ix, 'decision') || '(még nincs döntés)'}` },
  ]) {
    importAsEvents(db, zst, { store: 'zst', spreadsheetId: zst.meta.spreadsheetId, scopeLabel: 'ZST', ...spec }, report)
  }
})

try { run() } catch (e) { console.error('IMPORT FAILED, transaction rolled back:', e.message); process.exitCode = 1 }

// --- reconciliation -------------------------------------------------------
const tally = {}
for (const r of report) {
  const k = `${r.scope}/${r.kind}`
  tally[k] ??= {}
  tally[k][r.outcome] = (tally[k][r.outcome] ?? 0) + 1
}
console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY-RUN',
  runId: RUN_ID,
  frozen: {
    personal: { spreadsheetId: personal.meta.spreadsheetId, exportSha256: personal.meta.exportSha256, capturedAt: personal.meta.capturedAt },
    zst: { spreadsheetId: zst.meta.spreadsheetId, exportSha256: zst.meta.exportSha256, capturedAt: zst.meta.capturedAt },
  },
  tally,
  conflicts: report.filter(r => r.outcome === 'CONFLICT_REVIEW'),
  skipped: report.filter(r => r.outcome === 'SKIPPED'),
  errors: report.filter(r => r.outcome === 'ERROR'),
}, null, 1))
db.close()
