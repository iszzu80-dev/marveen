// Personal Chief of Staff (COS) — car-rental adapter contract.
//
// Car rental is a different search shape than the grocery ShoppingAdapter
// (search by pickup/dropoff + dates, not by product name), so it gets its own
// interface. The SAME safety invariant holds and is enforced with the shared
// guard: NO book/checkout/pay method exists, so a rental adapter can only
// SEARCH and PRESENT options — the human books and pays. See
// assertNoCheckoutSurface (src/cos/shopping-adapter.ts).
//
// This module is PURE (no browser): the sq codec and the offer parser are the
// testable heart. The Playwright driver lives in ./adapters/discovercars.ts and
// calls parseDiscoverCarsOffers on the scraped card text.

import { assertNoCheckoutSurface } from './shopping-adapter.js'

export interface LocationQuery {
  /** Text typed into the autocomplete, e.g. 'Valencia'. */
  query: string
  /** Substring/pattern to select the right autocomplete row, e.g. 'all locations'
   *  or 'Airport (AGP)'. */
  match: string
}

export interface RentalSearchParams {
  pickup: LocationQuery
  dropoff: LocationQuery
  /** Local wall-clock 'YYYY-MM-DDTHH:mm:ss'. The day drives the calendar; the
   *  full value is verified against the committed results sq, and the day-count
   *  against the offers' "Total for N days" (DiscoverCars' SPA can serve stale
   *  offers on a URL date-rewrite, so both checks fail loud). */
  pickupDateTime: string
  dropoffDateTime: string
  /** ISO country of the driver's residence (affects price/currency), e.g. 'HU'. */
  residenceCountry: string
  driverAge?: number
}

/** Whole days between two 'YYYY-MM-DDTHH:mm:ss' local timestamps (DiscoverCars
 *  bills by calendar-day span; used to cross-check the rendered "Total for N
 *  days"). */
export function rentalDayCount(pickupDateTime: string, dropoffDateTime: string): number {
  const day = (s: string) => {
    const [y, m, d] = s.split('T')[0].split('-').map(Number)
    return Date.UTC(y, m - 1, d) // month is 0-based
  }
  return Math.round((day(dropoffDateTime) - day(pickupDateTime)) / 86_400_000)
}

export interface RentalOffer {
  car: string
  category: string
  transmission: string
  seats: number | null
  supplier: string
  pickupType: string
  pickupLocation: string
  deposit: string
  mileage: string
  rating: string
  totalPrice: number | null
  currency: string
  days: number | null
}

export interface RentalAdapter {
  readonly id: string
  readonly displayName: string
  /** Return available rental offers for the params. No booking method exists. */
  search(params: RentalSearchParams): Promise<RentalOffer[]>
}

/** Validate an adapter instance carries no purchase/booking method (reuses the
 *  shopping guard) — payment is always manual. Call at registration/construction. */
export function assertRentalAdapterSafe(adapter: object): void {
  assertNoCheckoutSurface(adapter)
}

// ---- DiscoverCars sq codec ----------------------------------------------------
// The results URL carries the search as a base64-encoded JSON `sq` param.

export interface DiscoverCarsSq {
  PickupLocationId: number
  DropOffLocationId: number
  PickupDateTime: string
  DropOffDateTime: string
  ResidenceCountry: string
  DriverAge: number
  Hash: string
}

/** Direct id-based query for building/reading a DiscoverCars `sq` (the results
 *  URL param). The live driver sets locations by text, but the results sq is
 *  id-based; this codec reads it back for verification. */
export function encodeDiscoverCarsSq(q: DiscoverCarsSq): string {
  return Buffer.from(JSON.stringify(q)).toString('base64')
}

export function decodeDiscoverCarsSq(sq: string): DiscoverCarsSq {
  return JSON.parse(Buffer.from(sq, 'base64').toString('utf8')) as DiscoverCarsSq
}

/** Does a results-page `sq` match the dates we asked for? The adapter uses this
 *  to VERIFY the committed search period (DiscoverCars caches an existing
 *  search's dates if you only rewrite the URL — see the recon memory), so it
 *  never reports prices for the wrong window. */
export function sqDatesMatch(sq: string, pickupDateTime: string, dropoffDateTime: string): boolean {
  try {
    const d = decodeDiscoverCarsSq(sq)
    return d.PickupDateTime === pickupDateTime && d.DropOffDateTime === dropoffDateTime
  } catch {
    return false
  }
}

// ---- offer parser (pure) ------------------------------------------------------
// Parses the innerText of a DiscoverCars offer card. Line-based (the card renders
// one field per line) rather than a global regex, so whitespace collapse can't
// scramble it.

function parsePrice(s: string): { amount: number | null; currency: string } {
  const m = /([A-Z]{3}|€|\$)\s?([\d.,\s]+)/.exec(s)
  if (!m) return { amount: null, currency: '' }
  const currency = m[1] === '€' ? 'EUR' : m[1] === '$' ? 'USD' : m[1]
  const amount = Number(m[2].replace(/[.,\s]/g, '')) // HUF/EUR both group with , or .
  return { amount: Number.isFinite(amount) ? amount : null, currency }
}

export function parseDiscoverCarsOfferCard(cardText: string): RentalOffer | null {
  const L = cardText.split('\n').map((s) => s.trim()).filter(Boolean)
  const carIdx = L.findIndex((l) => /or similar/.test(l))
  if (carIdx < 1) return null
  const car = L[carIdx - 1]
  const category = L[carIdx].replace(/or similar\s*/i, '').trim()
  const transmission = L.find((l) => /^(Manual|Automatic)$/.test(l)) ?? ''
  const seatsLine = L.find((l) => /\bseats?\b/i.test(l))
  const seats = seatsLine ? Number((/(\d+)\s*seats?/i.exec(seatsLine) || [])[1]) || null : null
  const puLine = L.find((l) => /pick-up/i.test(l)) ?? ''
  const pickupType = (/(In terminal|Outside of terminal|Meet (?:and|&) greet|Shuttle)/i.exec(puLine) || [])[1] ?? ''
  const pickupLocation = puLine.replace(/.*pick-up\s*[—–-]*\s*/i, '').trim()
  const deposit = (/(Low|Average|High|No)\s+deposit/i.exec(cardText) || [])[1] ?? ''
  const mileage = (L.find((l) => /mileage|km\/day|Unlimited/i.test(l)) ?? '').slice(0, 40)
  const rating = L.find((l) => /^\d(\.\d)?$/.test(l)) ?? ''
  const daysM = /Total for (\d+) days?/i.exec(cardText)
  const days = daysM ? Number(daysM[1]) : null
  // price line is the one after "Total for N days", or the first currency line
  const ti = L.findIndex((l) => /Total for \d+ days?/i.test(l))
  const priceLine = ti >= 0 && L[ti + 1] ? L[ti + 1] : (L.find((l) => /(HUF|EUR|€|\$)\s?[\d.,]/.test(l)) ?? '')
  const { amount, currency } = parsePrice(priceLine)
  return { car, category, transmission, seats, supplier: '', pickupType, pickupLocation, deposit, mileage, rating, totalPrice: amount, currency, days }
}

export function parseDiscoverCarsOffers(cardTexts: string[]): RentalOffer[] {
  const out: RentalOffer[] = []
  const seen = new Set<string>()
  for (const t of cardTexts) {
    const o = parseDiscoverCarsOfferCard(t)
    if (!o) continue
    const key = `${o.car}|${o.category}|${o.totalPrice}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o)
  }
  return out
}

/** Convenience filters for presenting a shortlist. */
export function filterByCategory(offers: RentalOffer[], re: RegExp): RentalOffer[] {
  return offers.filter((o) => re.test(o.category))
}
export function cheapestFirst(offers: RentalOffer[]): RentalOffer[] {
  return [...offers].sort((a, b) => (a.totalPrice ?? Infinity) - (b.totalPrice ?? Infinity))
}
