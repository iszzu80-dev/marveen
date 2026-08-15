/**
 * How often a watch is checked, and when it ends — decided by a TABLE, not by a
 * model.
 *
 * Istvan asked the system to decide the rhythm. It does, from a named rule,
 * because a cadence a model picked cannot be explained two weeks later and
 * cannot be tested at all: "why is it checking that hourly?" would have no
 * answer but "it seemed right at the time". The model may propose the SHAPE of
 * a watch (is this a deadline, a standing wish, or one question?); the shape
 * maps to an interval here, in code, with a test per row.
 *
 * The three shapes come from Istvan's own examples (card D3, 2026-08-15):
 *
 *   DEADLINE  a renewal with a date — insurance in September. Weekly while it
 *             is far off, daily inside the last fortnight when a better offer
 *             still changes the decision, and CLOSED on the day, because after
 *             it the question is moot.
 *   STANDING  a lasting wish with no date — the shoes. Twice a day, until it
 *             hits or Istvan closes it.
 *   ONE_OFF   one question: "is there anything cheaper right now?" One run,
 *             then CLOSED.
 *
 * THE ONE_OFF's ANSWER IS ALWAYS REPORTED, including "nothing was cheaper".
 * A single-shot search that only speaks when it finds something is
 * indistinguishable from one that never ran — the distinction this entire card
 * exists to preserve.
 */

export type WatchShape = 'DEADLINE' | 'STANDING' | 'ONE_OFF'

export const WATCH_SHAPES: readonly WatchShape[] = ['DEADLINE', 'STANDING', 'ONE_OFF'] as const

const HOUR = 3600
const DAY = 24 * HOUR

/** Twice a day — Istvan's "naponta 2x" for a standing wish. */
export const STANDING_INTERVAL_SEC = 12 * HOUR
/** Far from the deadline: weekly is enough to notice a market move. */
export const DEADLINE_FAR_INTERVAL_SEC = 7 * DAY
/** Inside the final fortnight a better offer still changes the decision. */
export const DEADLINE_NEAR_INTERVAL_SEC = DAY
/** How long before the deadline the rhythm tightens. */
export const DEADLINE_NEAR_WINDOW_SEC = 14 * DAY

export interface RhythmDecision {
  /** Seconds until the next check. Meaningless when `close` is true. */
  intervalSec: number
  /** The watch is over — the caller sets status CLOSED. */
  close: boolean
  /** Why, in words, for the log and for Istvan. Always present. */
  reason: string
}

/**
 * The rhythm for one watch, at one moment.
 *
 * Pure and total: every shape has a branch, and every branch names its reason.
 * `checksSoFar` matters only to ONE_OFF, which is defined by having had one.
 */
export function rhythmFor(
  shape: WatchShape, expiresAt: number | null, now: number, checksSoFar = 0,
): RhythmDecision {
  if (shape === 'ONE_OFF') {
    return checksSoFar >= 1
      // NOT "jelentve". This string said the result had been reported, and
      // nothing consumed it: delivery hangs off notify.should, so a ONE_OFF
      // that found nothing closed in silence while the reason claimed
      // otherwise. A sentence asserting a delivery that does not happen is
      // worse than no sentence — it is what a reader checks instead of the
      // code. Reporting is now a separate, recorded step (closure_reason /
      // closure_reported_at); this branch states only what it does.
      ? { intervalSec: 0, close: true, reason: 'egyszeri kereses: lefutott, lezarva -- az eredmenyt (talalat VAGY "nem volt olcsobb") a napi kivonat jelenti' }
      : { intervalSec: 0, close: false, reason: 'egyszeri kereses: meg nem futott le' }
  }
  if (shape === 'STANDING') {
    return { intervalSec: STANDING_INTERVAL_SEC, close: false, reason: 'tartos figyeles hatarido nelkul: naponta ketszer' }
  }
  // DEADLINE
  if (expiresAt == null) {
    // Not a silent fallback: a DEADLINE without a date is a contradiction, and
    // treating it as STANDING would quietly create a watch that never ends —
    // the shape of failure this card is about. The creation gate refuses it;
    // this branch exists so the function stays total for a row that predates
    // the gate.
    return { intervalSec: STANDING_INTERVAL_SEC, close: false, reason: 'HATARIDOS figyeles hatarido NELKUL -- hibas allapot, tartos ritmussal fut amig valaki javitja' }
  }
  if (now >= expiresAt) {
    return { intervalSec: 0, close: true, reason: 'a hatarido elerkezett: a kerdes targytalan, lezarva' }
  }
  const left = expiresAt - now
  return left <= DEADLINE_NEAR_WINDOW_SEC
    ? { intervalSec: DEADLINE_NEAR_INTERVAL_SEC, close: false, reason: `a hatarido ${Math.ceil(left / DAY)} nap mulva: naponta` }
    : { intervalSec: DEADLINE_FAR_INTERVAL_SEC, close: false, reason: `a hatarido ${Math.ceil(left / DAY)} nap mulva: hetente` }
}

/** Whether a string is one of the three shapes — for validating intake input
 *  without letting an unknown value fall through to a default. */
export function isWatchShape(v: unknown): v is WatchShape {
  return typeof v === 'string' && (WATCH_SHAPES as readonly string[]).includes(v)
}
