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
import type { ShoppingAdapter, ProductSearchResult } from './shopping-adapter.js'

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

// ── PRODUCT price-watch engine ────────────────────────────────────────────────
// The generic price-watch runner for PRODUCT radar items (personal BUY-* and, via
// the same engine, ZST procurement items). It is adapter-pluggable: any
// ShoppingAdapter that can searchProducts() feeds it. NO checkout — the adapter
// contract forbids purchase methods (assertNoCheckoutSurface); this engine only
// searches, compares, and records observations. The HIT / notify decision is
// radar.recordObservation's job (target met + dedup), identical to rentals.

/** Radar item.query JSON for a PRODUCT item. `terms` is the search string; the
 *  optional filters narrow the adapter's results to the intended product. */
export interface ProductRadarQuery {
  terms?: string
  mustMatch?: string[]     // all of these (case-insensitive) must appear in the name
  excludeTerms?: string[]  // none of these may appear
  maxResults?: number
}

// Minor-unit exponent per currency (HUF has none: 100 Ft = 100 minor). Used to
// bring the adapter's priceMinor into the SAME major unit the radar target_price
// is stored in, so `best <= target` compares like-for-like.
const CURRENCY_MINOR_EXPONENT: Record<string, number> = { HUF: 0, JPY: 0, EUR: 2, USD: 2, GBP: 2, CHF: 2 }
export function minorToMajor(priceMinor: number, currency: string | null): number {
  const exp = CURRENCY_MINOR_EXPONENT[(currency ?? 'HUF').toUpperCase()] ?? 2
  return Math.round(priceMinor / 10 ** exp)
}

function matchesFilters(name: string, q: ProductRadarQuery): boolean {
  const n = name.toLowerCase()
  if (q.mustMatch && !q.mustMatch.every(t => n.includes(t.toLowerCase()))) return false
  if (q.excludeTerms && q.excludeTerms.some(t => n.includes(t.toLowerCase()))) return false
  return true
}

/**
 * Run one PRODUCT radar check: search via the ShoppingAdapter, filter to the
 * intended product, pick the cheapest in-currency offer, and record the
 * observation (which flips the item to HIT if the target is met and computes the
 * deduped notify decision). Offers priced in a currency other than the item's are
 * skipped (cross-currency FX for products is deferred — no silent apples-to-oranges).
 * An empty result records a 0-offer observation (honest "nothing found"), never a
 * fake price. Adapter errors propagate to the scheduler (connector_health).
 */
export async function runProductRadarCheck(
  db: Database.Database, item: RadarItemRow, adapter: ShoppingAdapter, now: number,
): Promise<ObservationResult> {
  if (item.kind !== 'PRODUCT') throw new Error(`radar item ${item.radar_id} is ${item.kind}, not PRODUCT`)
  const q: ProductRadarQuery = item.query ? safeParse(item.query) : {}
  const terms = q.terms ?? item.label
  const results = await adapter.searchProducts(terms, { limit: q.maxResults ?? 20 })

  const itemCurrency = (item.currency ?? 'HUF').toUpperCase()
  const priced = results
    .filter(r => r.priceMinor != null && (r.currency ?? itemCurrency).toUpperCase() === itemCurrency)
    .filter(r => matchesFilters(r.name, q))
  const cheapest = priced.reduce<ProductSearchResult | null>(
    (min, r) => (min == null || (r.priceMinor as number) < (min.priceMinor as number) ? r : min), null)

  const bestMajor = cheapest ? minorToMajor(cheapest.priceMinor as number, cheapest.currency) : null
  return recordObservation(db, item.radar_id, {
    bestPrice: bestMajor,
    currency: itemCurrency,
    offerCount: priced.length,
    offerId: cheapest ? `${cheapest.ref.adapterId}|${cheapest.ref.productId}` : null,
    offerRef: cheapest ? { name: cheapest.name, priceMinor: cheapest.priceMinor, currency: cheapest.currency, available: cheapest.available, adapter: cheapest.ref.adapterId } : null,
  }, now)
}

function safeParse(s: string): ProductRadarQuery {
  try { return JSON.parse(s) as ProductRadarQuery } catch { return {} }
}
