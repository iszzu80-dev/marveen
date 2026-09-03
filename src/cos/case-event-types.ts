/**
 * THE CANONICAL CASE LIFECYCLE VOCABULARY -- one definition, two sides.
 *
 * WHY THIS FILE EXISTS. On 2026-09-03 the commitment-fulfilment detector was
 * measured against the live store and had never once fired: it looked for an
 * event named `STATUS_CHANGE` while the engine writes `STATUS_CHANGED`. One
 * letter. 246 status events in the live database, zero of them matching, so
 * every properly closed case was reported as "the board says done and the
 * record cannot show when or by what" -- about a record that showed exactly
 * that. The reopen path carried the same wrong name and so could never fire
 * either.
 *
 * The defect was not the typo. The defect was that the producer and the
 * consumer each kept their own hand-written list of event names, and nothing
 * made them agree. A second typo would do the same thing again. So the names
 * live HERE, the engine writes them from here, the detector reads them from
 * here, and a test drives the real transition and asserts the event it produced
 * is a member of the set the detector uses -- which is a claim no literal in a
 * test file can make.
 *
 * WHAT IS AND IS NOT IN THE VOCABULARY. Only the LIFECYCLE events, the ones
 * whose names carry meaning for fulfilment and reopening. The store also holds
 * free-text event types imported from the ChatGPT-side baseline ("Foglalás
 * visszaigazolása" and eighty others); those are records, not vocabulary, and
 * nothing keys behaviour off them.
 */

/** Event names the ENGINE writes. The engine is the only producer of these. */
export const CASE_EVENT = {
  /** The one and only status transition event, written by `transitionCase`.
   *  Its MEANING is carried by `new_status`, not by the name: the same event
   *  evidences a completion and a reopen, and only the status tells them
   *  apart. */
  STATUS_CHANGED: 'STATUS_CHANGED',
  /** The reopen ANNOTATION, appended by `reopenCase` alongside the transition
   *  it has already made. It carries the superseded `completed_at` and no
   *  `new_status` of its own -- the transition beside it carries that. */
  CASE_REOPENED: 'CASE_REOPENED',
  CREATED: 'CREATED',
  PARENT_LINKED: 'PARENT_LINKED',
  CALENDAR_EVENTS_LINKED: 'CALENDAR_EVENTS_LINKED',
} as const

export type CaseEventType = typeof CASE_EVENT[keyof typeof CASE_EVENT]

/**
 * Events that can EVIDENCE a commitment being met.
 *
 * Membership here is necessary and NOT sufficient: the reader must also require
 * that the event's `new_status` is terminal. That second condition is what
 * keeps `STATUS_CHANGED -> WAITING_EXTERNAL` from counting as a completion, and
 * it is deliberately left with the reader rather than folded in here, because
 * "which statuses are terminal" is a per-namespace fact and this file is not.
 *
 * The legacy names are kept because removing them is a behaviour change, not a
 * bug fix: nothing in the live store has ever carried them (measured
 * 2026-09-03: zero rows for each), so they cost nothing and their removal
 * belongs to whoever decides they are dead.
 */
export const FULFILLING_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  CASE_EVENT.STATUS_CHANGED,
  // legacy, never observed in the live store:
  'COMPLETED', 'OUTBOUND_VERIFIED', 'ANSWER_RECORDED',
])

/**
 * Events that can CONTRADICT a fulfilment after the fact -- the reopen path.
 *
 * Same shape as above: membership plus a NON-terminal `new_status`. The reopen
 * flow transitions first and annotates second, so the contradicting evidence is
 * the transition; `CASE_REOPENED` is listed for completeness and cannot match on
 * its own because it carries no `new_status`.
 */
export const REOPENING_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  CASE_EVENT.STATUS_CHANGED,
  CASE_EVENT.CASE_REOPENED,
  // legacy, never observed in the live store:
  'REOPENED', 'CONTRADICTION_RECORDED',
])

// ── THE CANONICAL CASE-STATUS VOCABULARY, for the same reason ───────────────
//
// On 2026-09-03 an audit found four case events whose `previous_status` and
// `new_status` carried an OUTBOUND DELIVERY's lifecycle (`RECOVERY_REQUIRED ->
// VERIFIED`) rather than the case's. `VERIFIED` is not a case status in either
// namespace, but nothing checked, so a delivery's progress read as a case
// reopen and PRI-CLAIM-2026-001 -- COMPLETED throughout, never reopened --
// surfaced as a reopened obligation.
//
// A foreign object's status sitting in the case's status columns is
// indistinguishable, to any reader, from a real transition. The statuses
// themselves were already defined once, in schema.ts; they simply were not
// being consulted by the lifecycle. They are now, on BOTH sides: the engine
// refuses to write one, and the reader refuses to believe one.
import { CASE_STATUSES, ZST_CASE_STATUSES } from './schema.js'

export type CaseNamespace = 'personal' | 'zst'

const VOCABULARY: Record<CaseNamespace, ReadonlySet<string>> = {
  personal: new Set<string>(CASE_STATUSES),
  zst: new Set<string>(ZST_CASE_STATUSES),
}

/** The statuses this namespace's cases may be in. Not a style rule: a value
 *  outside it did not come from this case's lifecycle. */
export function caseStatusVocabulary(ns: CaseNamespace): ReadonlySet<string> {
  return VOCABULARY[ns]
}

/** `null` is legitimate -- most events carry no status at all. A non-null value
 *  outside the vocabulary is the finding. */
export function isCaseStatus(ns: CaseNamespace, status: string | null | undefined): boolean {
  return status == null || VOCABULARY[ns].has(status)
}

/** Which namespace a case table belongs to. The engine is table-generic; this
 *  is the one place that maps a table back to its vocabulary. */
export function namespaceForCaseTable(table: string): CaseNamespace {
  return table.startsWith('zst') ? 'zst' : 'personal'
}
