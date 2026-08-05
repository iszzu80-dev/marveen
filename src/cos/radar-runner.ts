// Personal Chief of Staff (COS) — radar runner (connects the radar to adapters).
//
// The scheduler finds due radar items (radar.dueRadarChecks) and, for a RENTAL
// item, calls this to actually run the search through the RentalAdapter, pick
// the best offer, and record the observation (which flips the item to HIT if the
// target is met). This is the working glue between the price radar (Slice 4) and
// the DiscoverCars rental adapter — the two subsystems built earlier, doing
// something together. No purchase — the adapter has no checkout.

import type Database from 'better-sqlite3'
import { type RentalAdapter, type RentalSearchParams, filterByCategory, cheapestByFullPrice } from './rental-adapter.js'
import { recordObservation, type RadarItemRow, type ObservationResult } from './radar.js'

export interface RentalRadarQuery {
  search: RentalSearchParams
  /** Optional category filter, e.g. 'compact' → only compact/Compact SUV offers. */
  categoryPattern?: string
}

/**
 * Run one RENTAL radar check: search via the adapter, apply the item's category
 * filter, pick the cheapest by all-in (base + full-coverage) price, and record
 * the observation. Returns the observation result (hit / new low / status).
 * An adapter error propagates — the scheduler treats it as a failed check and
 * (via connector_health) may degrade the connector.
 */
export async function runRentalRadarCheck(
  db: Database.Database, item: RadarItemRow, adapter: RentalAdapter, now: number,
): Promise<ObservationResult> {
  if (item.kind !== 'RENTAL') throw new Error(`radar item ${item.radar_id} is ${item.kind}, not RENTAL`)
  if (!item.query) throw new Error(`radar item ${item.radar_id} has no query`)
  const q = JSON.parse(item.query) as RentalRadarQuery

  let offers = await adapter.search(q.search)
  if (q.categoryPattern) offers = filterByCategory(offers, new RegExp(q.categoryPattern, 'i'))
  const best = cheapestByFullPrice(offers)[0]

  return recordObservation(db, item.radar_id, {
    bestPrice: best?.fullPrice != null ? Math.round(best.fullPrice) : null,
    currency: best?.currency,
    offerCount: offers.length,
    // Stable id of the best offer so P1.6 dedup can tell "same deal" from "new
    // deal" — supplier + vehicle identifies the offer across checks.
    offerId: best ? `${best.supplier}|${best.car}` : null,
    offerRef: best
      ? { car: best.car, category: best.category, transmission: best.transmission, supplier: best.supplier, fullPrice: best.fullPrice, deposit: best.deposit }
      : null,
  }, now)
}
