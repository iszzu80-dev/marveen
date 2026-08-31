// PHASE 2 -- QUESTIONS, on top of the E2 bounded queue.
//
// E2 fixed the ORDER: class first (SAFETY_APPROVAL, BLOCKING_DECISION, NORMAL),
// then deadline, priority, age. It deliberately did NOT touch how many slots
// there are, and said so:
//
//     "It does not raise the ceiling, exempt a class from it, or supersede
//      anybody's open question."
//
// That left one hole, and it is the hole the owner is now closing. Ordering
// decides WHO GETS THE NEXT SLOT. It does nothing when there is no next slot --
// and five trivia questions fill the channel exactly as well as five
// authorization gates do. A safety approval arriving into a full channel waits
// behind "which Waterpik", not because the order is wrong but because the order
// never gets consulted.
//
// RESERVED CAPACITY is the fix, and it is a floor rather than an exemption: a
// number of slots that NORMAL questions may not occupy. The ceiling is
// unchanged, nobody is exempt from it, and no open question is superseded to
// make room. What changes is only that the channel cannot be filled to the brim
// with things that could have waited.
import { type QuestionClass } from '../owner-question.js'

export interface CapacityPolicy {
  /** Total open questions allowed. Unchanged from E2. */
  cap: number
  /** Of `cap`, how many may ONLY be taken by an urgent class. */
  reservedForUrgent: number
}

/** Two of five. Small on purpose: reserving too many makes the channel feel
 *  empty while ordinary questions queue, which is the failure mode in the other
 *  direction and just as real. */
export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = { cap: 5, reservedForUrgent: 2 }

const URGENT: ReadonlySet<QuestionClass> = new Set<QuestionClass>(['SAFETY_APPROVAL', 'BLOCKING_DECISION'])

export function isUrgentClass(cls: QuestionClass): boolean { return URGENT.has(cls) }

export interface AdmissionVerdict {
  admit: boolean
  /** One line, naming the numbers, for a report a person reads. */
  reason: string
  /** What the caller should do with a refused question: hold it (it may be
   *  asked later) rather than drop it. */
  disposition: 'ASK' | 'HOLD'
}

/**
 * May a question of this class take a slot right now?
 *
 * The general slots are `cap - reservedForUrgent`. An urgent question may use
 * any free slot; a NORMAL one may use only the general ones. So the reserved
 * slots stay empty rather than being filled by whatever arrived first, which is
 * the entire point -- an empty seat kept for an ambulance is not waste.
 */
export function admitQuestion(
  cls: QuestionClass,
  open: { urgent: number; normal: number },
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
): AdmissionVerdict {
  const total = open.urgent + open.normal
  if (total >= policy.cap) {
    return {
      admit: false, disposition: 'HOLD',
      reason: `channel full: ${total}/${policy.cap} open. Answering any open question frees a slot.`,
    }
  }
  if (isUrgentClass(cls)) {
    return { admit: true, disposition: 'ASK', reason: `urgent class ${cls} may take any free slot (${total}/${policy.cap} open)` }
  }
  const generalCap = policy.cap - policy.reservedForUrgent
  if (open.normal >= generalCap) {
    return {
      admit: false, disposition: 'HOLD',
      reason:
        `${open.normal}/${generalCap} general slots taken; the remaining ${policy.reservedForUrgent} ` +
        `are reserved for SAFETY_APPROVAL / BLOCKING_DECISION. The ceiling is unchanged and nothing ` +
        `has been superseded -- this question waits so an authorization gate does not have to.`,
    }
  }
  return { admit: true, disposition: 'ASK', reason: `general slot available (${open.normal}/${generalCap})` }
}

// ── expiry / staleness ──────────────────────────────────────────────────────

export interface AskLike {
  caseId: string
  /** The E3 axis, or any stable discriminator of the DECISION PROBLEM. */
  axis: string
  askedAt: number
  /** The moment the answer stops being useful, when the record knows one. */
  decisionHorizonAt?: number | null
}

export type Staleness =
  | { state: 'FRESH' }
  | { state: 'STALE'; why: string }
  | { state: 'MOOT'; why: string }

/**
 * An open question that can no longer change anything is worse than no question:
 * it occupies a slot AND it asks a person to spend attention on a decision that
 * has already been taken by the passage of time.
 *
 * MOOT and STALE are separated because they need different handling. A MOOT
 * question should be withdrawn -- its horizon passed. A STALE one should be
 * re-asked in current terms, because the situation it described has moved.
 */
export function assessStaleness(ask: AskLike, now: number, staleAfterSec = 7 * 86_400): Staleness {
  if (ask.decisionHorizonAt != null && ask.decisionHorizonAt < now) {
    return { state: 'MOOT', why: `its decision horizon passed at ${ask.decisionHorizonAt}; an answer can no longer change the outcome` }
  }
  const age = now - ask.askedAt
  if (age > staleAfterSec) {
    return { state: 'STALE', why: `open for ${Math.floor(age / 86_400)} days; re-ask in current terms rather than leave it occupying a slot` }
  }
  return { state: 'FRESH' }
}

// ── one decidable question per decision problem ─────────────────────────────

export interface DedupeResult<T extends AskLike> {
  ask: T[]
  /** Collapsed into an existing ask, with the id of the one that survives. */
  superseded: Array<{ dropped: T; keptCaseId: string; keptAxis: string; why: string }>
}

/**
 * Collapse to ONE question per (case, decision axis).
 *
 * The owner's phrasing is "egy döntési problémára lehetőleg egy döntésképes
 * kérdés", and the operative word is DECIDABLE. Two questions about the same
 * axis do not give a person two decisions to make; they give one decision and
 * two chances to answer it inconsistently.
 *
 * The OLDEST survives, not the newest. A person may already be composing an
 * answer to the one they were shown, and replacing it under them is how an
 * answer arrives for a question that no longer exists.
 */
export function dedupeByDecisionProblem<T extends AskLike>(asks: readonly T[]): DedupeResult<T> {
  const kept = new Map<string, T>()
  const superseded: DedupeResult<T>['superseded'] = []
  for (const a of [...asks].sort((x, y) => x.askedAt - y.askedAt)) {
    const key = `${a.caseId}::${a.axis}`
    const prev = kept.get(key)
    if (!prev) { kept.set(key, a); continue }
    superseded.push({
      dropped: a, keptCaseId: prev.caseId, keptAxis: prev.axis,
      why: `same decision problem (${key}); the older ask stands so an answer in flight still has its question`,
    })
  }
  return { ask: [...kept.values()], superseded }
}
