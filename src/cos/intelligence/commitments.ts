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
import { FULFILLING_EVENT_TYPES, REOPENING_EVENT_TYPES, isCaseStatus } from '../case-event-types.js'
import {
  classifyReopen, classifyClosure, type ReopenClass, type ClosureClass,
} from './lifecycle-classification.js'
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
  /** An external or baseline system imported the case already closed. Owner
   *  ruling 2026-09-03: NOT fulfilled, because no local proof exists, and NOT
   *  unknown, because we know exactly what happened -- somebody else asserted it
   *  and we recorded the assertion faithfully. */
  | 'IMPORTED_CLOSURE'
  /** Closed HERE because the matter moved to another canonical case. The work
   *  did not finish; it changed address, and `supersededBy` carries the address. */
  | 'SUPERSEDED'

/**
 * How well the STORE evidences that a terminal case actually ended. Measured,
 * not judged: three columns, three strengths, and the difference matters because
 * it decides whether an UNKNOWN fulfilment is a data-quality gap or merely a
 * thin record.
 *
 * `CLOSURE_REASON` a human or a rule wrote down WHY it ended -- weak evidence,
 *                  but real evidence, and it names its own author.
 * `COMPLETED_AT_ONLY` a timestamp and nothing else -- weaker: it says when,
 *                  never what or by whom.
 * `NONE`           the board says done and the record carries nothing at all.
 *                  This is the genuine data-quality gap.
 *
 * Owner ruling 2026-09-01: none of these may be raised to a SAFETY alarm on its
 * own. A generic "UNKNOWN therefore unsafe" is noise, not a finding.
 */
export type ClosureEvidence = 'CLOSURE_REASON' | 'COMPLETED_AT_ONLY' | 'NONE'

/**
 * WHY this case carries an obligation at all. A commitment cannot exist without
 * one of these, and each names a thing in the record rather than a thing the
 * engine decided.
 *
 * Owner ruling 2026-09-01: "a motor sajat next_action / follow-up sablonja
 * onmagaban SOHA ne legyen commitment evidence. A motor sajat terve csak
 * execution metadata."
 *
 * The gate is written as a REQUIREMENT, not as a filter of known bad strings. A
 * blocklist of the two templates seen today would pass the next one; requiring
 * positive evidence fails closed for every template, including ones nobody has
 * written yet.
 */
export type ObligationEvidence =
  /** An explicit deadline stands on the case. The strongest, and self-evidencing. */
  | 'EXPLICIT_DEADLINE'
  /** A next action stated for THIS case and no other. Boilerplate repeated across
   *  cases is the engine talking to itself; one case's promise is not, word for
   *  word, seventeen other cases' promise. */
  | 'CASE_SPECIFIC_ACTION'
  /** The board says the case ended and no event evidences it. Not an obligation
   *  anyone took on -- a data-quality finding that must not go silent. */
  | 'UNEVIDENCED_CLOSURE'

export interface Commitment extends IntelligenceElement {
  owner: CommitmentOwner
  /** Set ONLY when `status` is REOPENED. Derived from the reopening event, never
   *  from a rewritten history: the owner's 2026-09-03 ruling is that the 21
   *  restore-artifacts must not read as business reopens, and the way to do that
   *  is to classify, not to edit. */
  reopenClass: ReopenClass | null
  /** Set when a terminal row's closure cannot be explained by an ordinary
   *  transition: imported closed, superseded by another case, or a terminal row
   *  with no terminal event at all. Null when a normal close explains it. */
  closureClass: ClosureClass | null
  /** The successor case, when `closureClass` is SUPERSEDED_BY_TARGET. Provenance,
   *  not decoration: a supersession with no target is a closure with a nicer name. */
  supersededBy: string | null
  /** Case events whose status columns carried a value outside this namespace's
   *  vocabulary -- another object's lifecycle written onto the case. Reported,
   *  never used as evidence. */
  foreignStatusEvents: Array<{ eventId: number | string | null; value: string }>
  dueAt: number | null
  status: CommitmentStatus
  /** Set ONLY when `status` is UNKNOWN -- the tier of the closure record that
   *  could not be corroborated by an event. Null otherwise, so a reader cannot
   *  mistake "not applicable" for "no evidence". */
  closureEvidence: ClosureEvidence | null
  /** WHY this is a commitment. Never null: without one of these the element is
   *  not constructed at all. */
  obligationEvidence: ObligationEvidence
  /** When the ENGINE plans to look again (`follow_up_at`). Carried so the fact
   *  is not lost, and kept in a separate field from `dueAt` so that no caller
   *  can accidentally treat a wake-up as a deadline. Never makes a commitment
   *  overdue. */
  reviewWakeAt: number | null
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
  /** BOTH sides of the transition, and the actor and source that made it.
   *  These were not selected until 2026-09-03, which is why the classification
   *  below could only ever guess: a restore and a business reopen differ by
   *  `source_system`, and an imported closure by `actor` -- columns the reader
   *  was not fetching. A classifier starved of its discriminators returns
   *  UNKNOWN and looks like a policy decision. */
  previous_status: string | null
  new_status: string | null
  actor: string | null
  source_system: string | null
  reason: string | null
  created_at: number
}

/** Statuses that mean the case itself reached an end. */
/** Terminal statuses, PER NAMESPACE. This used to be one hard-coded set for
 *  both, which quietly left `FAILED_TERMINAL` out of the ZST side -- a ZST case
 *  in that state would not have been seen as closed at all. Zero rows carry it
 *  today (measured 2026-09-03), so this fixes nothing visible and removes a trap
 *  that was waiting for the first one. */
const TERMINAL_BY_NS: Record<'personal' | 'zst', ReadonlySet<string>> = {
  personal: new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED']),
  zst: new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED', 'FAILED_TERMINAL']),
}

/** Events that EVIDENCE a commitment being met, and events that can CONTRADICT
 *  one, both taken from the SHARED lifecycle vocabulary rather than retyped
 *  here. They used to be two hand-written lists beside the engine's own, and
 *  they had drifted by one letter -- `STATUS_CHANGE` against the engine's
 *  `STATUS_CHANGED` -- so neither set had ever matched a single row of the live
 *  store. See src/cos/case-event-types.ts.
 *
 *  `FOLLOW_UP_DUE` is deliberately NOT carried over: it is a case STATUS, never
 *  an event type, so its presence in the old reopen list was a category error
 *  that could not have matched anything either. A reopen is recognised the way
 *  it actually happens -- a later transition to a non-terminal status. */
const FULFILLING_EVENT = FULFILLING_EVENT_TYPES
const REOPENING_EVENT = REOPENING_EVENT_TYPES

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
  /** How many OTHER cases in this namespace carry the exact same `next_action`.
   *  0 means the text is this case's own. Passed in because the caller holds the
   *  namespace; defaulted to 0 so a single-case caller keeps the old behaviour
   *  for a genuinely unique action. */
  sharedActionCount = 0,
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
  // So: a next action (someone owes a step), or a DEADLINE (someone owes it BY
  // then). The title is only ever the WORDING when a deadline exists without a
  // stated action; it is never the reason a commitment exists.
  //
  // `follow_up_at` IS NOT A DEADLINE. Owner ruling 2026-09-01, and the measurement
  // that produced it: of 81 expired commitments on the live store, only SEVEN had
  // a real `due_at`. The other 74 were overdue against an engine review timer,
  // and 48 of those had no stated action at all. `follow_up_at` answers "when
  // should the engine look at this again" -- it is scheduler semantics, not a
  // promise to anyone, and reading it as a deadline manufactured 66 false
  // overdue obligations out of ordinary bookkeeping.
  //
  // The three cases, kept apart on purpose:
  //   A  due_at                        a real obligation deadline
  //   B  follow_up_at + next_action    something IS owed, with no deadline --
  //                                    a review wake, never overdue
  //   C  follow_up_at, no next_action  engine scheduling metadata. Not a
  //                                    commitment at all, and never user-facing.
  const hasAction = !!row.next_action?.trim()
  const hasDeadline = row.due_at != null

  // ONE EXCEPTION TO CASE C, and it is the reason this surface exists.
  //
  // A case the board calls finished, with no event evidencing it, is a
  // data-quality finding whether or not anybody ever wrote down an action. Case
  // C exists to keep ENGINE SCHEDULING METADATA out of the owner's view; a
  // terminal case with nothing to show for it is not scheduling metadata.
  //
  // Found by running the C rule on the live store: it swallowed BOTH cases in
  // the NO_CLOSURE_EVIDENCE tier -- the two car-rental deposit cases, the very
  // rows the owner asked to be given STRONGER data-quality attention. They had
  // no next_action, so the rule that removes 48 false obligations removed the
  // two real findings with them. Silence about the worst-evidenced closures is
  // the opposite of what the rule was for.
  const TERMINAL = TERMINAL_BY_NS[namespace]
  const unevidencedClosure = TERMINAL.has(row.status)
    && !events.some((e) => FULFILLING_EVENT.has(e.event_type) && e.new_status != null && TERMINAL.has(e.new_status))

  // THE OBLIGATION GATE. Default: no commitment. One of three positive,
  // provenanced reasons admits it.
  //
  // `CASE_SPECIFIC_ACTION` is the one that needed thought. Measured on the live
  // store 2026-09-01: all 17 ZST commitments restated one of two engine
  // templates, while all 50 personal ones carried 49 distinct authored texts.
  // Excluding the two known template strings would have worked today and failed
  // on the third template. Requiring the action to be THIS case's own catches
  // every template, named or not: an obligation repeated verbatim across cases
  // is the engine's execution metadata, because one case's promise is not, word
  // for word, seventeen other cases' promise.
  const caseSpecificAction = hasAction && sharedActionCount === 0
  const obligationEvidence: ObligationEvidence | null =
      hasDeadline ? 'EXPLICIT_DEADLINE'
    : caseSpecificAction ? 'CASE_SPECIFIC_ACTION'
    : unevidencedClosure ? 'UNEVIDENCED_CLOSURE'
    : null
  if (!obligationEvidence) return []

  const what = caseSpecificAction
    ? row.next_action!.trim()
    : (hasAction && hasDeadline ? row.next_action!.trim() : row.title?.trim())
  if (!what) return []

  const caseProv: Provenance = {
    source: 'CASE', ref: row.case_id, observedAt: row.updated_at, field: row.next_action ? 'next_action' : 'title',
  }
  // A COMMITMENT MAY HAVE NO DEADLINE. Only `due_at` can make one overdue.
  const dueAt = row.due_at ?? null
  const reviewWakeAt = row.follow_up_at ?? null

  // ── the evidence, oldest first, so "later contradicts earlier" is just order ──
  const ordered = [...events].sort((a, b) => a.created_at - b.created_at)
  // FOREIGN STATUSES ARE NOT EVIDENCE, and they are not silent either.
  //
  // Four events in the live store carried an outbound delivery's
  // `RECOVERY_REQUIRED -> VERIFIED` in the case's own status columns, and one of
  // them made PRI-CLAIM-2026-001 -- COMPLETED throughout -- read as a reopened
  // obligation for a week. A value outside this namespace's case vocabulary did
  // not come from this case's lifecycle, so it cannot evidence or contradict a
  // completion. It is collected and reported instead of ignored: a reader who
  // sees a case behaving oddly deserves to be shown the reason.
  const foreignStatusEvents = ordered
    .filter((e) => !isCaseStatus(namespace, e.new_status) || !isCaseStatus(namespace, (e as { previous_status?: string | null }).previous_status))
    .map((e) => ({
      eventId: e.event_id ?? null,
      value: `${(e as { previous_status?: string | null }).previous_status ?? '-'} -> ${e.new_status ?? '-'}`,
    }))

  const fulfilling = ordered.filter(
    (e) => FULFILLING_EVENT.has(e.event_type) && e.new_status != null
      && isCaseStatus(namespace, e.new_status) && TERMINAL.has(e.new_status),
  )
  const lastFulfil = fulfilling.at(-1) ?? null
  const contradicting = lastFulfil
    ? ordered.filter(
        (e) => e.created_at > lastFulfil.created_at && REOPENING_EVENT.has(e.event_type)
          && e.new_status != null && isCaseStatus(namespace, e.new_status) && !TERMINAL.has(e.new_status),
      )
    : []

  // Derived first, because two of the branches below are decided by it.
  const terminalClosure = TERMINAL.has(row.status) ? classifyClosure(ordered, TERMINAL) : null

  const proof: Provenance[] = []
  let status: CommitmentStatus
  let why: string
  let closureEvidence: ClosureEvidence | null = null
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
  } else if (TERMINAL.has(row.status) && terminalClosure?.klass === 'IMPORTED_CLOSURE') {
    // Imported closed. Named rather than reported as a gap: the record is
    // complete about what it is, it simply is not a local fulfilment proof.
    status = 'IMPORTED_CLOSURE'
    why = `imported already closed by ${'the baseline import'} (event ${terminalClosure.evidenceEventId}) -- ` +
      `an assertion made elsewhere, recorded faithfully, with no local proof of the work`
    confidenceParts = ['MEDIUM']
  } else if (TERMINAL.has(row.status) && terminalClosure?.klass === 'SUPERSEDED_BY_TARGET') {
    status = 'SUPERSEDED'
    why = terminalClosure.targetCaseId
      ? `closed here because the matter moved to ${terminalClosure.targetCaseId} (event ${terminalClosure.evidenceEventId})`
      : `closed here by a namespace move (event ${terminalClosure.evidenceEventId}) whose target could not be read from the record`
    confidenceParts = terminalClosure.targetCaseId ? ['HIGH'] : ['LOW']
  } else if (TERMINAL.has(row.status)) {
    // The case says done and NO event evidences it. This is the case the whole
    // surface exists for: reported as UNKNOWN, never rounded up to FULFILLED.
    status = 'UNKNOWN'
    closureEvidence = row.closure_reason != null && String(row.closure_reason).trim() !== ''
      ? 'CLOSURE_REASON'
      : row.completed_at != null ? 'COMPLETED_AT_ONLY' : 'NONE'
    why = `case status is ${row.status} but no event evidences the completion -- ` +
      `the board says done and the record cannot show when or by what ` +
      `(closure evidence: ${closureEvidence})`
    // The tier IS the confidence. A written reason is thin but real; a bare
    // timestamp is thinner; nothing at all is the gap itself.
    confidenceParts = closureEvidence === 'CLOSURE_REASON' ? ['MEDIUM'] : ['LOW']
  } else if (dueAt != null && dueAt < now) {
    status = 'EXPIRED'
    why = `due at ${dueAt}, now ${now}, and nothing evidences fulfilment`
    confidenceParts = ['HIGH']
  } else {
    status = 'OPEN'
    why = dueAt != null
      ? `owed, due at ${dueAt}`
      : reviewWakeAt != null
        ? `owed, no deadline on the record -- the engine plans to look again at ${reviewWakeAt}, ` +
          `which is a wake-up and not a promise`
        : 'owed, no date on the record'
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

  // DERIVED, never written back. The history says a case was closed and later
  // moved; these two say what that MEANT, so a restore artifact stops reading as
  // somebody's decision and an imported closure stops reading as a gap.
  // THE FIRST contradicting event, not the last. The first one is what ENDED the
  // fulfilment; anything after it is the case living its life afterwards. Taking
  // the last one asked a later, unrelated transition why the case was reopened,
  // and it did not know -- 13 of the 21 restore artifacts came back
  // UNKNOWN_REOPEN on that mistake alone.
  const reopenClass = status === 'REOPENED'
    ? classifyReopen(contradicting[0] ?? null)
    : null

  return [{
    ...el,
    owner: ownerOf(row),
    dueAt,
    status,
    closureEvidence,
    obligationEvidence,
    reviewWakeAt,
    reopenClass,
    closureClass: terminalClosure?.klass ?? null,
    supersededBy: terminalClosure?.targetCaseId ?? null,
    foreignStatusEvents,
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
      `SELECT event_id, case_id, event_type, previous_status, new_status, actor, source_system, reason, created_at
       FROM ${eventTable} WHERE case_id IN (${placeholders})`,
    ).all(...ids) as EventRow[]
  } catch { events = [] }

  const byCase = new Map<string, EventRow[]>()
  for (const e of events) {
    const list = byCase.get(e.case_id) ?? []
    list.push(e)
    byCase.set(e.case_id, list)
  }
  // How many cases share each `next_action`, verbatim. Computed over the whole
  // namespace slice so the caller can tell a stated obligation from boilerplate
  // without anyone maintaining a list of known templates.
  const shared = new Map<string, number>()
  for (const r of rows) {
    const a = r.next_action?.trim()
    if (a) shared.set(a, (shared.get(a) ?? 0) + 1)
  }

  return rows.flatMap((r) => {
    const a = r.next_action?.trim()
    const others = a ? (shared.get(a) ?? 1) - 1 : 0
    return commitmentsForCase(r, byCase.get(r.case_id) ?? [], namespace, now, others)
  })
}
