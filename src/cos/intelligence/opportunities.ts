// PHASE 2 -- OPPORTUNITIES.
//
// An opportunity is something worth doing that NOBODY OWES. That is the whole
// definition, and it is what keeps the band honest: the moment a thing is owed
// -- by the owner, by the engine, by a counterparty -- it is a commitment, and it
// belongs in a band that can interrupt.
//
// The temptation this resists is making opportunities feel important. A surface
// that suggests things wants to be read, and the easy way to be read is to
// borrow urgency from somewhere. So the ranking is structural (attention.ts) and
// the derivation here is deliberately conservative: it produces few items, each
// with a stated reason a person can disagree with, and nothing it produces can
// ever interrupt.
import type Database from 'better-sqlite3'
import {
  type IntelligenceElement, type Provenance, elementId, makeElement,
} from './element.js'

export type OpportunityKind =
  | 'STALLED_NO_ACTION'   // active, not blocked, and nothing says what next
  | 'CLOSEABLE'           // long idle in a state that usually means finished

export interface Opportunity extends IntelligenceElement {
  kind: 'RECOMMENDATION'   // narrowed: an opportunity is never a fact about a duty
  opportunityKind: OpportunityKind
  /** What a person MIGHT do. Never what may be executed, and nothing reads this
   *  as permission -- see element.assertNotAuthorization. */
  suggestion: string
}

interface Row {
  case_id: string; title: string; status: string
  next_action: string | null; blocked_reason: string | null
  due_at: number | null; updated_at: number
}

const IDLE_SEC = 21 * 86_400
const ACTIVE_NOT_BLOCKED = new Set(['NEW', 'READY', 'IN_PROGRESS', 'EXECUTING', 'SCHEDULED'])

export function opportunitiesForCase(row: Row, namespace: 'personal' | 'zst', now: number): Opportunity[] {
  const prov: Provenance = { source: 'CASE', ref: row.case_id, observedAt: row.updated_at, field: 'status' }
  const out: Opportunity[] = []

  const make = (k: OpportunityKind, statement: string, suggestion: string): Opportunity => ({
    ...makeElement({
      id: elementId('opportunity', namespace, row.case_id, k),
      kind: 'RECOMMENDATION',
      caseId: row.case_id, namespace, statement,
      provenance: [prov],
      // An opportunity is a suggestion about a situation the store describes
      // only partially. MEDIUM is the ceiling on purpose: claiming HIGH for a
      // guess is how a suggestion starts sounding like an instruction.
      confidence: 'MEDIUM',
      contradiction: { state: 'NONE' },
    }, now),
    kind: 'RECOMMENDATION',
    opportunityKind: k,
    suggestion,
  })

  // Owed work is NOT an opportunity. A case with a due date has a commitment on
  // it, and duplicating it here would let the same work appear in two bands --
  // one of which can interrupt and one of which must not.
  if (row.due_at != null) return out

  if (ACTIVE_NOT_BLOCKED.has(row.status) && !row.next_action?.trim() && !row.blocked_reason) {
    out.push(make('STALLED_NO_ACTION',
      `${row.case_id} is ${row.status} with no next action and no block recorded`,
      'decide a next action, or close it'))
  }

  if (now - row.updated_at > IDLE_SEC && ACTIVE_NOT_BLOCKED.has(row.status)) {
    out.push(make('CLOSEABLE',
      `${row.case_id} has not moved in ${Math.floor((now - row.updated_at) / 86_400)} days`,
      'confirm it is still live, or close it'))
  }

  return out
}

export function projectOpportunities(
  db: Database.Database, namespace: 'personal' | 'zst', now: number, limit = 500,
): Opportunity[] {
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  const rows = db.prepare(
    `SELECT case_id, title, status, next_action, blocked_reason, due_at, updated_at
     FROM ${table} WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as Row[]
  return rows.flatMap((r) => opportunitiesForCase(r, namespace, now))
}
