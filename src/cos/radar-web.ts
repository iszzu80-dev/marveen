/**
 * The websearch sweep's write path: record one found price, and — when it is
 * news — TELL THE OWNER, in code.
 *
 * Why this file exists at all. The sweep's recorder was a standalone script
 * whose own header said it "does NOT send any alert — the caller (the daily
 * sweep) decides that from `notify`", and that caller was a model reading the
 * script's stdout. Measured on the live store 2026-08-15:
 *
 *   08-07 14:06  HOFF – hasonló   27 990 <= 35 000   websearch|Shopsy
 *   08-07 14:06  OLYMP No. Six    11 745 <= 20 000   websearch|About You
 *   08-09 09:03  HOFF – hasonló   34 120 <= 35 000   websearch|ecipo.hu
 *
 * All three were recorded, `decideNotify` returned should:true on all three,
 * and none of them ever reached Istvan: the only radar alert on the bus came
 * from the tick's own code path (the 08-10 rental). `markNotified` was never
 * called on this path either, so the per-shop dedup the sweep skill promises
 * did not exist here — the dedup keys off `last_notified_*`, which nothing on
 * this path wrote.
 *
 * The decision to notify was never the weak link; the decision was correct
 * every time. The weak link was that the last step belonged to a prompt.
 */
import type Database from 'better-sqlite3'
import { recordObservation, type ObservationResult, type Shippability } from './radar.js'
import { deliverRadarNotification } from './runtime.js'

export interface WebObservationInput {
  radarId: string
  /** Price in the item's currency major unit (e.g. 60990 for HUF). */
  price: number
  shop: string
  url?: string
  currency?: string
  /**
   * What the sweep could ESTABLISH about delivery to Hungary — not what it
   * hopes. Omitted means 'UNKNOWN', and 'UNKNOWN' is the honest answer most of
   * the time: a search result page rarely states shipping terms. An UNKNOWN
   * find is not a hit, but it is not lost either — it lands on the daily
   * "szállítás nem igazolt" line, which is the whole reason the field has three
   * values instead of a boolean.
   */
  shippableHu?: Shippability
}

export interface WebObservationResult extends ObservationResult {
  radarId: string
  /**
   * Whether the owner was actually told AND the item marked — NOT whether an
   * alert was warranted. `notify.should` is a decision; `delivered` is an
   * outcome, and the gap between the two is where a week of silence lived.
   * False with `notify.should === true` means the alert failed and the dedup
   * state was deliberately left untouched, so the next run retries.
   */
  delivered: boolean
}

/**
 * Record one web-found price and deliver the alert if it is news.
 *
 * Delivery goes through `deliverRadarNotification`, the SAME function the tick
 * uses — a second caller, not a fifth copy. The ordering rule it carries (alert
 * first, mark only on success, leave dedup untouched on failure) is exactly the
 * kind of rule that survives in one place and rots in five.
 *
 * `deliver` is injectable so a test can prove the call happens without a bus
 * post; production callers must not pass it.
 */
export function recordWebObservation(
  db: Database.Database, input: WebObservationInput,
  now = Math.floor(Date.now() / 1000),
  deliver: typeof deliverRadarNotification = deliverRadarNotification,
): WebObservationResult {
  const res = recordObservation(db, input.radarId, {
    bestPrice: Math.round(input.price),
    currency: (input.currency ?? 'HUF').toUpperCase(),
    offerCount: 1,
    // Stable per-shop id so the SAME shop's standing price does not re-alert
    // daily (P1.6 dedup); a new cheaper shop is a new offer and DOES alert.
    // This only works now that the path marks what it notified.
    offerId: `websearch|${input.shop}`,
    offerRef: { shop: input.shop, url: input.url ?? '', price: Math.round(input.price) },
    shippableHu: input.shippableHu ?? 'UNKNOWN',
  }, now)

  const delivered = res.notify.should
    ? deliver(db, {
      radarId: input.radarId, offerId: res.offerId,
      price: res.bestPrice, reason: res.notify.reason,
    }, now)
    : false

  return { radarId: input.radarId, ...res, delivered }
}
