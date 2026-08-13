// DiscoverCars rental adapter — calls the JSON API directly (plain fetch, NO
// browser). Implements the RentalAdapter contract: it can only SEARCH, never
// book/pay (assertRentalAdapterSafe enforces it).
//
// API flow (reverse-engineered 2026-08-05, see the
// discovercars-headless-automation-recon memory):
//   1. GET  /api/v2/autocomplete?location=<q>            → resolve name → ids
//   2. POST /api/v2/search/create-search  {ids, dates}  → { guid, sq }
//   3. GET  /api/v2/search/<guid>?sq=<sq>               → { offers: [...] }
// This replaced the fragile headless-browser + react-date-range calendar driver
// (which could not commit exact dates). The date-commit that beat every UI
// approach is trivial here: create-search takes pickup_from/pickup_to strings.
//
// No Playwright, no LD_LIBRARY_PATH — pure HTTP. The adapter still VERIFIES the
// committed `sq` window and fails loud on a mismatch.

import {
  type RentalAdapter, type RentalSearchParams, type RentalOffer, type LocationRef,
  parseApiOffers, assertRentalAdapterSafe, rentalDayCount,
} from '../rental-adapter.js'

const BASE = 'https://www.discovercars.com'
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: BASE,
  Referer: `${BASE}/`,
  Accept: 'application/json',
}

export interface DiscoverCarsOptions {
  /** Max POLL ROUNDS for the async offer aggregation — not seconds. The wall
   *  time is roughly pollAttempts × pollDelayMs. */
  pollAttempts?: number
  pollDelayMs?: number
  fetchImpl?: typeof fetch
}

export class DiscoverCarsAdapter implements RentalAdapter {
  readonly id = 'discovercars'
  readonly displayName = 'DiscoverCars'
  private readonly fetch: typeof fetch

  constructor(private readonly opts: DiscoverCarsOptions = {}) {
    assertRentalAdapterSafe(this)
    this.fetch = opts.fetchImpl ?? fetch
  }

  /** Resolve a location name → ids via /api/v2/autocomplete. Picks the result
   *  whose `place` matches `match` (case-insensitive substring), else the
   *  first. */
  async resolveLocation(query: string, match: string): Promise<LocationRef> {
    const r = await this.fetch(`${BASE}/api/v2/autocomplete?location=${encodeURIComponent(query)}`, { headers: HEADERS })
    const j: any = await r.json()
    const results: any[] = j?.result ?? []
    if (results.length === 0) throw new Error(`no DiscoverCars location for "${query}"`)
    const re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const hit = results.find((x) => re.test(String(x.place ?? ''))) ?? results[0]
    return { countryId: Number(hit.countryID), cityId: Number(hit.cityID), placeId: Number(hit.placeID), label: String(hit.place ?? '') }
  }

  async search(params: RentalSearchParams): Promise<RentalOffer[]> {
    // Sanity FIRST: the requested window must be a positive span. This used to
    // run at the very END — after create-search and after up to 12 × 2.5s of
    // polling — so a caller typo cost half a minute and a pointless remote
    // search before being told the dates were nonsense.
    if (rentalDayCount(params.pickupFrom, params.pickupTo) <= 0) {
      throw new Error('rental dropoff is not after pickup')
    }
    const pickTime = params.pickupFrom.split(' ')[1] ?? '10:00'
    const dropTime = params.pickupTo.split(' ')[1] ?? '10:00'
    const body = {
      is_drop_off: params.pickup.placeId !== params.dropoff.placeId,
      pick_up_country_id: params.pickup.countryId,
      pick_up_city_id: params.pickup.cityId,
      pick_up_location_id: params.pickup.placeId,
      pickup_id: params.pickup.placeId,
      drop_off_country_id: params.dropoff.countryId,
      drop_off_city_id: params.dropoff.cityId,
      drop_off_location_id: params.dropoff.placeId,
      dropoff_id: params.dropoff.placeId,
      pickup_from: params.pickupFrom,
      pickup_to: params.pickupTo,
      pick_time: pickTime,
      drop_time: dropTime,
      driver_age: String(params.driverAge ?? 35),
      residence_country: params.residenceCountry,
      partnerID: 0, excludeLocations: 0, recent_search: 0, isWhitelabel: false,
    }
    const cr = await this.fetch(`${BASE}/api/v2/search/create-search`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
    const cj: any = await cr.json()
    const guid: string | undefined = cj?.data?.guid
    const sq: string | undefined = cj?.data?.sq
    if (!guid || !sq) throw new Error(`DiscoverCars create-search failed: ${JSON.stringify(cj?.errors ?? cj).slice(0, 200)}`)

    // Verify the committed window matches the request (fail loud, never wrong dates).
    const dec = JSON.parse(Buffer.from(sq, 'base64').toString())
    const wantP = params.pickupFrom.replace(' ', 'T') + ':00'
    const wantD = params.pickupTo.replace(' ', 'T') + ':00'
    if (dec.PickupDateTime !== wantP || dec.DropOffDateTime !== wantD) {
      throw new Error(`DiscoverCars committed the wrong window (${dec.PickupDateTime}..${dec.DropOffDateTime} != ${wantP}..${wantD})`)
    }

    // Offers aggregate asynchronously; poll until the count STOPS GROWING.
    //
    // The old condition was `raw.length > 5`, which is not "aggregation
    // finished" — it is "more than five". A location with 1-5 genuine offers
    // never satisfied it, so every such search burned all 12 rounds (~30s) and
    // returned the same list it already had after the first one. Two identical
    // consecutive counts means the aggregator has settled, whatever the number.
    const attempts = this.opts.pollAttempts ?? 12
    const delay = this.opts.pollDelayMs ?? 2500
    let raw: any[] = []
    let previousCount = -1
    for (let i = 0; i < attempts; i++) {
      const or = await this.fetch(`${BASE}/api/v2/search/${guid}?sq=${sq}`, { headers: HEADERS })
      const oj: any = await or.json()
      raw = oj?.data?.offers ?? []
      if (raw.length > 0 && raw.length === previousCount) break
      previousCount = raw.length
      await new Promise((res) => setTimeout(res, delay))
    }
    return parseApiOffers(raw)
  }
}
