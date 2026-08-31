// PHASE 2 -- COMMITMENTS.
//
// A commitment is a promise the record can point at: who owes what, by when,
// and whether the store can PROVE it was done.
//
// THE POINT OF THE WHOLE SURFACE is the last part. "Status: fulfilled" is easy
// and worth nothing; a fulfilment nobody can evidence is indistinguishable from
// one that never happened, and this codebase has been bitten by exactly that
// shape more than once (a SOURCE_COMMITTED that was never marked at the source;
// a cursor that "advanced" because a field said so). So a commitment is
// FULFILLED only when a provenance-carrying observation says so, and
// `fulfillment.proof` is the observation itself, not a boolean somebody set.
//
// AND IT REOPENS. The owner asked for it in one line -- "reopen, ha későbbi
// evidence cáfolja a teljesítést" -- and it is the reason this is a projection
// rather than a table. Because the status is DERIVED on every read, a later
// contradicting event flips it back with no migration, no refresh job, and no
// window in which the stored answer and the evidence disagree.
import type Database from 'better-sqlite3'
import {
  type Confidence, type IntelligenceElement, type Provenance,
  combineConfidence, elementId, makeElement,
} from './element.js'

export type CommitmentOwner = 'OWNER' | 'ENGINE' | 'EXTERNAL' | 'UNKNOWN'

export type CommitmentStatus =
  | 'OPEN'        // owed, not yet evidenced
  | 'FULFILLED'   // evidenced by an observation, and the proof is attached
  | 'REOPENED'    // was fulfilled, then later evidence contradicted it
  | 'EXPIRED'     // its moment passed with nothing evidencing it
  | 'UNKNOWN'     // the store cannot say -- reported, never rounded to OPEN

export interface Commitment extends IntelligenceElement {
  owner: CommitmentOwner
  dueAt: number | null
  status: CommitmentStatus
  fulfillment: {
    /** True ONLY when `proof` is non-empty. The two cannot disagree because
     *  this is computed from `proof`, never passed in. */
    proven: boolean
    proof: Provenance[]
    /** Why the status is what it is, in one line, for a reader who disagrees. */
    why: string
  }
}

interface CaseRow {
  case_id: string; title: string; status: string; owner: string | null
  due_at: number | null; follow_up_at: number | null
  waiting_on: string | null; next_action: string | null; next_action_owner: string | null
  completed_at: number | null; closure_reason: string | null
  created_at: number; updated_at: number
}

interface EventRow {
  event_id: string; case_id: string; event_type: string
  new_status: string | null; reason: string | null; created_at: number
}

/** Statuses that mean the case itself reached an end. */
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED'])

/** Events that EVIDENCE a commitment being met, as opposed to merely describing
 *  progress. Deliberately narrow: a status change to COMPLETED is evidence, an
 *  enrichment note is not. */
const FULFILLING_EVENT = new Set(['STATUS_CHANGE', 'COMPLETED', 'OUTBOUND_VERIFIED', 'ANSWER_RECORDED'])

/** Events that can CONTRADICT a fulfilment after the fact -- the reopen path. */
const REOPENING_EVENT = new Set(['REOPENED', 'STATUS_CHANGE', 'CONTRADICTION_RECORDED', 'FOLLOW_UP_DUE'])

function ownerOf(row: CaseRow): CommitmentOwner {
  const o = (row.next_action_owner ?? row.owner ?? '').toLowerCase()
  if (!o) return 'UNKNOWN'
  if (o.includes('istvan') || o === 'owner' || o.includes('user')) return 'OWNER'
  if (o.includes('marveen') || o.includes('engine') || o.includes('agent')) return 'ENGINE'
  return 'EXTERNAL'
}

/**
 * Derive the commitments a case carries.
 *
 * A case yields at most one commitment today -- "this case's next action, owed
 * by someone, perhaps by a date". The shape is a list because a case will carry
 * several once outbound promises and answer deadlines are folded in, and a
 * caller written against a single object would have to change then.
 */
export function commitmentsForCase(
  row: CaseRow, events: readonly EventRow[], namespace: 'personal' | 'zst', now: number,
): Commitment[] {
  // A COMMITMENT NEEDS SOMETHING OWED. A bare title is not a promise.
  //
  // Found by mutation on 2026-08-31: with `next_action || title` every case with
  // a title became a commitment, so the overlap rule in project.ts dropped EVERY
  // opportunity as a duplicate and the opportunity surface was structurally
  // empty. Two tests were passing over nothing -- "an opportunity never
  // interrupts" cannot fail when no opportunity exists -- and the mutant that
  // fed opportunities in as obligations stayed green for the same reason.
  //
  // So: a next action (someone owes a step), or a date (someone owes it BY
  // then). The title is only ever the WORDING when a date exists without a
  // stated action; it is never the reason a commitment exists.
  const dueForCheck = row.due_at ?? row.follow_up_at ?? null
  const owed = row.next_action?.trim() || (dueForCheck != null ? row.title?.trim() : '')
  const what = owed
  if (!what) return []

  const caseProv: Provenance = {
    source: 'CASE', ref: row.case_id, observedAt: row.updated_at, field: row.next_action ? 'next_action' : 'title',
  }
  const dueAt = row.due_at ?? row.follow_up_at ?? null

  // ── the evidence, oldest first, so "later contradicts earlier" is just order ──
  const ordered = [...events].sort((a, b) => a.created_at - b.created_at)
  const fulfilling = ordered.filter(
    (e) => FULFILLING_EVENT.has(e.event_type) && e.new_status != null && TERMINAL.has(e.new_status),
  )
  const lastFulfil = fulfilling.at(-1) ?? null
  const contradicting = lastFulfil
    ? ordered.filter(
        (e) => e.created_at > lastFulfil.created_at && REOPENING_EVENT.has(e.event_type)
          && e.new_status != null && !TERMINAL.has(e.new_status),
      )
    : []

  const proof: Provenance[] = []
  let status: CommitmentStatus
  let why: string
  let confidenceParts: Confidence[] = ['HIGH']

  if (lastFulfil && contradicting.length) {
    // REOPENED. The order is the whole argument: something terminal happened,
    // and then something later said it was not over.
    status = 'REOPENED'
    const c = contradicting.at(-1)!
    why = `evidenced complete by ${lastFulfil.event_id} at ${lastFulfil.created_at}, then contradicted by ` +
      `${c.event_id} (${c.event_type} -> ${c.new_status}) at ${c.created_at}`
    proof.push({ source: 'CASE_EVENT', ref: c.event_id, observedAt: c.created_at, field: 'new_status' })
    confidenceParts = ['HIGH']
  } else if (lastFulfil) {
    status = 'FULFILLED'
    why = `evidenced by event ${lastFulfil.event_id} (${lastFulfil.event_type} -> ${lastFulfil.new_status})`
    proof.push({ source: 'CASE_EVENT', ref: lastFulfil.event_id, observedAt: lastFulfil.created_at, field: 'new_status' })
  } else if (TERMINAL.has(row.status)) {
    // The case says done and NO event evidences it. This is the case the whole
    // surface exists for: reported as UNKNOWN, never rounded up to FULFILLED.
    status = 'UNKNOWN'
    why = `case status is ${row.status} but no event evidences the completion -- ` +
      `the board says done and the record cannot show when or by what`
    confidenceParts = ['LOW']
  } else if (dueAt != null && dueAt < now) {
    status = 'EXPIRED'
    why = `due at ${dueAt}, now ${now}, and nothing evidences fulfilment`
    confidenceParts = ['HIGH']
  } else {
    status = 'OPEN'
    why = dueAt != null ? `owed, due at ${dueAt}` : 'owed, no date on the record'
    confidenceParts = dueAt != null ? ['HIGH'] : ['MEDIUM']
  }

  const provenance = [caseProv, ...proof]
  const el = makeElement({
    id: elementId('commitment', namespace, row.case_id),
    // A commitment reports what the record SAYS. Its status is a fact about the
    // store; only the reopen judgement leans on a rule, and that rule is above.
    kind: status === 'UNKNOWN' ? 'INFERENCE' : 'FACT',
    caseId: row.case_id,
    namespace,
    statement: what,
    provenance,
    confidence: combineConfidence(confidenceParts),
    contradiction: status === 'REOPENED'
      ? {
          state: 'UNRESOLVED', axis: 'TERMINALITY',
          detail: why,
          provenance: proof,
        }
      : { state: 'NONE' },
  }, now)

  return [{
    ...el,
    owner: ownerOf(row),
    dueAt,
    status,
    fulfillment: { proven: proof.length > 0 && status === 'FULFILLED', proof, why },
  }]
}

const CASE_COLUMNS =
  `case_id, title, status, owner, due_at, follow_up_at, waiting_on, next_action,
   next_action_owner, completed_at, closure_reason, created_at, updated_at`

/** Project the commitments across a namespace. Reads only; writes nothing. */
export function projectCommitments(
  db: Database.Database, namespace: 'personal' | 'zst', now: number, limit = 500,
): Commitment[] {
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  const eventTable = namespace === 'personal' ? 'personal_case_events' : 'zst_case_events'
  const rows = db.prepare(
    `SELECT ${CASE_COLUMNS} FROM ${table} WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as CaseRow[]
  if (!rows.length) return []

  const ids = rows.map((r) => r.case_id)
  const placeholders = ids.map(() => '?').join(',')
  let events: EventRow[] = []
  try {
    events = db.prepare(
      `SELECT event_id, case_id, event_type, new_status, reason, created_at
       FROM ${eventTable} WHERE case_id IN (${placeholders})`,
    ).all(...ids) as EventRow[]
  } catch { events = [] }

  const byCase = new Map<string, EventRow[]>()
  for (const e of events) {
    const list = byCase.get(e.case_id) ?? []
    list.push(e)
    byCase.set(e.case_id, list)
  }
  return rows.flatMap((r) => commitmentsForCase(r, byCase.get(r.case_id) ?? [], namespace, now))
}
