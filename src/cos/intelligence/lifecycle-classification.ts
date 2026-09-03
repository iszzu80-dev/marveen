/**
 * DERIVED lifecycle classification -- history stays exactly as it is.
 *
 * The owner's ruling, 2026-09-03: the 21 cases the progression engine closed on
 * 2026-08-09 with a generic, self-certified DoD, and which were then restored by
 * hand, must not read as "business reopened" to anyone. The event history is the
 * authority and is not to be rewritten; what changes is what a reader is told
 * the history MEANS.
 *
 * So nothing here writes. Every function takes the events as they stand and
 * returns a label, and every label names the evidence it was derived from.
 */

export type ReopenClass =
  /** Somebody with standing decided the matter was not finished, and said why. */
  | 'BUSINESS_REOPEN'
  /** A close that should not have happened was undone. The close was the error;
   *  the restore put the case back where it had been minutes earlier. */
  | 'RECOVERY_RESTORE'
  /** An import moved a case out of a terminal state from a snapshot, without new
   *  business evidence. The record moved; the world did not. */
  | 'IMPORT_OVERRIDE'
  /** A later non-terminal transition with nothing saying why. Reported as
   *  itself, never rounded to any of the three above. */
  | 'UNKNOWN_REOPEN'

export type ClosureClass =
  /** An external or baseline system imported the case already closed. Not a
   *  local fulfilment proof and not a gap -- a faithfully recorded assertion
   *  made somewhere else. */
  | 'IMPORTED_CLOSURE'
  /** The case was closed HERE because it moved to another canonical case. The
   *  work did not finish; it changed address, and the address is evidence. */
  | 'SUPERSEDED_BY_TARGET'
  /** A terminal row with no event carrying a terminal status at all. Not a thin
   *  record -- an absent one. An integrity finding, not a closure. */
  | 'TERMINAL_ROW_NO_EVENT'

export interface LifecycleEventLike {
  event_id?: number | string
  event_type: string
  previous_status?: string | null
  new_status: string | null
  actor?: string | null
  source_system?: string | null
  source_reference?: string | null
  reason?: string | null
  created_at: number
}

/** Actors and sources that move records rather than matters. Matched on the
 *  RECORD, not guessed: every one of these appears in the live store. */
const RESTORE_SOURCE = /manual_restore|restore|recovery/i
const RESTORE_REASON = /restored from event|self-certified DoD|never finished|incident 2026-08-09/i
const IMPORT_ACTOR = /baseline-import|import|migration/i
const IMPORT_REASON = /baseline|frozen snapshot|external state|ChatGPT CoS/i

/**
 * Why a fulfilment stopped being current.
 *
 * The order is the argument. A restore and an import are both mechanical, and
 * both are checked BEFORE the human reading, because an actor field alone would
 * call a restore a business decision: the same `marveen` who restores also
 * decides things. What separates them is the source and the stated reason, and
 * those are on the event.
 */
export function classifyReopen(reopen: LifecycleEventLike | null): ReopenClass {
  if (!reopen) return 'UNKNOWN_REOPEN'
  const src = String(reopen.source_system ?? '')
  const reason = String(reopen.reason ?? '')
  const actor = String(reopen.actor ?? '')

  if (RESTORE_SOURCE.test(src) || RESTORE_REASON.test(reason)) return 'RECOVERY_RESTORE'
  if (IMPORT_ACTOR.test(actor) || IMPORT_REASON.test(reason)) return 'IMPORT_OVERRIDE'
  // A named actor with a stated reason is the only thing that earns the word
  // "business". Silence does not: it becomes UNKNOWN_REOPEN and stays visible.
  if (actor && reason.trim()) return 'BUSINESS_REOPEN'
  return 'UNKNOWN_REOPEN'
}

/**
 * Why a terminal row is terminal, when no `STATUS_CHANGED` says so.
 *
 * Returns null when an ordinary transition DID close the case -- this function
 * only speaks about the cases the normal path cannot explain.
 */
export function classifyClosure(
  events: readonly LifecycleEventLike[],
  terminal: ReadonlySet<string>,
): { klass: ClosureClass; evidenceEventId: number | string | null; targetCaseId: string | null } | null {
  const carriesTerminal = events.filter((e) => e.new_status != null && terminal.has(e.new_status))
  if (!carriesTerminal.length) {
    return { klass: 'TERMINAL_ROW_NO_EVENT', evidenceEventId: null, targetCaseId: null }
  }
  const last = carriesTerminal[carriesTerminal.length - 1]!

  if (last.event_type === 'MOVED_NAMESPACE') {
    // The successor id is written into the reason by the mover. Extracted rather
    // than assumed: a SUPERSEDED_BY with no target is just a closure again.
    const m = /(?:zst-moved-|case-private-|[A-Z]+-[A-Z]+-\d{4}-\d+)[\w-]*/.exec(String(last.reason ?? ''))
    return { klass: 'SUPERSEDED_BY_TARGET', evidenceEventId: last.event_id ?? null, targetCaseId: m ? m[0] : null }
  }
  if (last.event_type === 'CREATED'
      && (IMPORT_ACTOR.test(String(last.actor ?? '')) || IMPORT_REASON.test(String(last.source_system ?? '')))) {
    return { klass: 'IMPORTED_CLOSURE', evidenceEventId: last.event_id ?? null, targetCaseId: null }
  }
  return null
}
