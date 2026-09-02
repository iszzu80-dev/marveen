// Operational Completeness — measure, and where it is deterministic, repair.
//
// Owner directive 2026-09-02 (Telegram, after the Phase 4 policy review):
//   every WAITING/BLOCKED case must carry, provenance-backed, at least
//     blocked_reason | waiting_on | next_action (or an explicit NO_ACTION_POSSIBLE)
//     | owner/responsibility | wake/resume condition where relevant.
//   "Ne találj ki üzleti tényt." A gap that is deterministically reconstructible
//   from existing evidence may be repaired autonomously. A gap that needs a real
//   user decision becomes a bounded question, not a guess.
//
// THE RULE THIS FILE IS BUILT AROUND: every value written here must be COPIED
// from a recorded event, never composed. If the source event does not contain
// the sentence, the field stays empty and the case is classified NEEDS_HUMAN.
// A reconstructed field carries its own provenance (the event_id it came from)
// so a wrong repair can be traced back to the row that caused it — the same
// discipline the research ledger uses.
//
// Usage:
//   npx tsx scripts/cos-operational-completeness.ts            # measure only (default)
//   npx tsx scripts/cos-operational-completeness.ts --apply    # measure + repair
//   npx tsx scripts/cos-operational-completeness.ts --json OUT

import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const APPLY = process.argv.includes('--apply')
const jsonIdx = process.argv.indexOf('--json')
const JSON_OUT = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null

const DB_PATH = resolve(process.env.HOME ?? '', 'marveen/store/claudeclaw.db')
const db = new Database(DB_PATH, { readonly: !APPLY })

/** The waiting family. A case in one of these is, by definition, not moving on
 *  its own — which is exactly when the owner needs to know why. The two
 *  namespaces spell "information required" differently, so both spellings are
 *  listed rather than normalised: renaming a live status is a migration, not a
 *  measurement, and this script only measures and repairs fields. */
const STUCK = [
  'BLOCKED', 'WAITING_EXTERNAL', 'INFORMATION_REQUIRED', 'INFO_REQUIRED',
  'AWAITING_SELECTION', 'FOLLOW_UP_DUE',
] as const

interface NsSpec { ns: string; cases: string; events: string }
const NAMESPACES: NsSpec[] = [
  { ns: 'personal', cases: 'personal_cases', events: 'personal_case_events' },
  { ns: 'zst', cases: 'zst_cases', events: 'zst_case_events' },
]

type Gap = 'blocked_reason' | 'waiting_on' | 'next_action' | 'owner' | 'wake_condition'

interface CaseRow {
  case_id: string; title: string; status: string; case_type: string | null
  blocked_reason: string | null; waiting_on: string | null
  next_action: string | null; owner: string | null
  proj_blocked_reason: string | null; proj_next_action: string | null
  proj_wait_condition: string | null
  next_wake_at: number | null; follow_up_at: number | null; due_at: number | null
}

interface EventRow {
  event_id: string; event_type: string; reason: string | null
  previous_status: string | null; new_status: string | null
  payload: string | null; created_at: number; actor: string | null
}

/** A field the engine may write, and the single event row it was copied from.
 *  `verbatim` is the whole point: the value is the source text, not a summary. */
interface Repair { field: Gap; value: string; fromEventId: string; fromEventType: string }

/** Effective value of a field: the canonical column, else the projection's
 *  mirror. A projection value counts as present — it is derived, but it is
 *  derived by a step that already ran and recorded itself. */
const eff = (canonical: string | null, projected: string | null): string | null => {
  const c = (canonical ?? '').trim()
  if (c) return c
  const p = (projected ?? '').trim()
  return p || null
}

/** Does this case need a wake/resume condition? Only the statuses that wait on
 *  the passage of time or an external party. A BLOCKED case is blocked on a
 *  thing, not on a clock, so a missing wake condition there is not a gap. */
const NEEDS_WAKE = new Set(['WAITING_EXTERNAL', 'FOLLOW_UP_DUE'])

function gapsFor(c: CaseRow, hasWait: boolean): Gap[] {
  const g: Gap[] = []
  const blocked = eff(c.blocked_reason, c.proj_blocked_reason)
  const waiting = eff(c.waiting_on, c.proj_wait_condition)
  const next = eff(c.next_action, c.proj_next_action)

  // A stuck case must say WHY. BLOCKED wants blocked_reason; the waiting
  // statuses want waiting_on. Either one satisfies "why" for the others.
  if (c.status === 'BLOCKED') { if (!blocked) g.push('blocked_reason') }
  else if (!waiting && !blocked) g.push('waiting_on')

  if (!next) g.push('next_action')
  if (!(c.owner ?? '').trim()) g.push('owner')
  if (NEEDS_WAKE.has(c.status) && !hasWait
      && !c.next_wake_at && !c.follow_up_at && !c.due_at) g.push('wake_condition')
  return g
}

/** Reconstruct a field from the case's own event history — COPY ONLY.
 *
 *  The only events trusted as a source of "why" are the ones that RECORD a
 *  reason at the moment the case entered its current status. A reason attached
 *  to some earlier, unrelated transition is not evidence about the state the
 *  case is in now, and using it would be the exact failure this script exists
 *  to avoid: a field that looks provenance-backed while describing something
 *  else. */
function reconstruct(c: CaseRow, events: EventRow[], gaps: Gap[]): Repair[] {
  const out: Repair[] = []
  const asc = [...events].sort((a, b) => a.created_at - b.created_at)

  // The transition INTO the current status, latest one wins.
  const entering = [...asc].reverse().find(
    e => e.event_type === 'STATUS_CHANGED' && e.new_status === c.status,
  )

  for (const gap of gaps) {
    if (gap === 'blocked_reason' || gap === 'waiting_on') {
      const r = (entering?.reason ?? '').trim()
      if (entering && r) {
        out.push({ field: gap, value: r, fromEventId: entering.event_id, fromEventType: entering.event_type })
      }
      continue
    }
    if (gap === 'owner') {
      // Ownership is reconstructible only when the case was explicitly handed to
      // someone in an event. An actor that merely touched the row is NOT the
      // owner, and treating it as one would invent responsibility.
      const handed = [...asc].reverse().find(
        e => /OWNER_/.test(e.event_type) && (e.actor ?? '').trim(),
      )
      if (handed?.actor) {
        out.push({ field: 'owner', value: handed.actor.trim(), fromEventId: handed.event_id, fromEventType: handed.event_type })
      }
      continue
    }
    // next_action and wake_condition are deliberately NOT reconstructed.
    // A next step is a judgement about the future; no past event contains it,
    // and composing one would be inventing business fact. These become
    // questions instead.
  }
  return out
}

const stuckList = STUCK.map(s => `'${s}'`).join(',')
const report: Record<string, unknown> = {
  at: new Date().toISOString(), apply: APPLY, db: DB_PATH, namespaces: {},
}
let totalRepairs = 0

for (const spec of NAMESPACES) {
  const cases = db.prepare(
    `SELECT case_id,title,status,case_type,blocked_reason,waiting_on,next_action,owner,
            proj_blocked_reason,proj_next_action,proj_wait_condition,
            next_wake_at,follow_up_at,due_at
       FROM ${spec.cases} WHERE status IN (${stuckList})`,
  ).all() as CaseRow[]

  const waitRows = db.prepare(
    `SELECT case_id FROM case_wait_conditions WHERE domain = ? AND resolved_at IS NULL`,
  ).all(spec.ns) as { case_id: string }[]
  const hasWait = new Set(waitRows.map(r => r.case_id))

  const evStmt = db.prepare(
    `SELECT event_id,event_type,reason,previous_status,new_status,payload,created_at,actor
       FROM ${spec.events} WHERE case_id = ?`,
  )

  const perCase: unknown[] = []
  const counts = {
    stuck: cases.length,
    missing_why: 0, missing_next_action: 0, missing_owner: 0, missing_wake: 0,
    complete: 0, repairable: 0, needs_human: 0,
  }

  for (const c of cases) {
    const events = evStmt.all(c.case_id) as EventRow[]
    const gaps = gapsFor(c, hasWait.has(c.case_id))
    if (gaps.includes('blocked_reason') || gaps.includes('waiting_on')) counts.missing_why++
    if (gaps.includes('next_action')) counts.missing_next_action++
    if (gaps.includes('owner')) counts.missing_owner++
    if (gaps.includes('wake_condition')) counts.missing_wake++
    if (gaps.length === 0) { counts.complete++; continue }

    const repairs = reconstruct(c, events, gaps)
    const repairedFields = new Set(repairs.map(r => r.field))
    const remaining = gaps.filter(g => !repairedFields.has(g))
    if (repairs.length) counts.repairable++
    if (remaining.length) counts.needs_human++

    perCase.push({
      caseId: c.case_id, status: c.status, title: (c.title ?? '').slice(0, 90),
      gaps, repairs, remaining, events: events.length,
    })

    if (APPLY && repairs.length) {
      for (const r of repairs) {
        const col = r.field === 'owner' ? 'owner'
          : r.field === 'blocked_reason' ? 'blocked_reason' : 'waiting_on'
        db.prepare(`UPDATE ${spec.cases} SET ${col} = ? WHERE case_id = ? AND COALESCE(${col},'') = ''`)
          .run(r.value, c.case_id)
        // The repair records itself as an event, so the field can be traced to
        // the row it was copied from. A silent UPDATE would produce exactly the
        // undocumented state this whole exercise is cleaning up.
        // event_id is INTEGER PRIMARY KEY, i.e. the rowid — it must be left to
        // autoincrement. Passing a composed string here fails with
        // SQLITE_MISMATCH, which is how this was found.
        db.prepare(
          `INSERT INTO ${spec.events}
             (case_id,case_version,actor,source_system,source_reference,
              event_type,reason,payload,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          c.case_id, 0, 'marveen',
          'operational-completeness', String(r.fromEventId),
          'INFORMATION_ADDED',
          `operational completeness: ${r.field} copied verbatim from ${r.fromEventType} ${r.fromEventId}`,
          JSON.stringify({ field: r.field, value: r.value, fromEventId: r.fromEventId }),
          Math.floor(Date.now() / 1000),
        )
        totalRepairs++
      }
    }
  }

  ;(report.namespaces as Record<string, unknown>)[spec.ns] = { counts, cases: perCase }
  console.log(`=== ${spec.ns} ===`)
  console.log('  ', JSON.stringify(counts))
}

report.totalRepairsApplied = APPLY ? totalRepairs : 0
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 1)); console.log('wrote', JSON_OUT) }
console.log(JSON.stringify({ apply: APPLY, totalRepairsApplied: report.totalRepairsApplied }))
