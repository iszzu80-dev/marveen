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
import { parseApiOffers, assertRentalAdapterSafe, rentalDayCount, } from '../rental-adapter.js';
const BASE = 'https://www.discovercars.com';
const HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Origin: BASE,
    Referer: `${BASE}/`,
    Accept: 'application/json',
};
export class DiscoverCarsAdapter {
    opts;
    id = 'discovercars';
    displayName = 'DiscoverCars';
    fetch;
    constructor(opts = {}) {
        this.opts = opts;
        assertRentalAdapterSafe(this);
        this.fetch = opts.fetchImpl ?? fetch;
    }
    /** Resolve a location name → ids via /api/v2/autocomplete. Picks the result
     *  whose `place` matches `match` (case-insensitive substring), else the
     *  first. */
    async resolveLocation(query, match) {
        const r = await this.fetch(`${BASE}/api/v2/autocomplete?location=${encodeURIComponent(query)}`, { headers: HEADERS });
        const j = await r.json();
        const results = j?.result ?? [];
        if (results.length === 0)
            throw new Error(`no DiscoverCars location for "${query}"`);
        const re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const hit = results.find((x) => re.test(String(x.place ?? ''))) ?? results[0];
        return { countryId: Number(hit.countryID), cityId: Number(hit.cityID), placeId: Number(hit.placeID), label: String(hit.place ?? '') };
    }
    async search(params) {
        const pickTime = params.pickupFrom.split(' ')[1] ?? '10:00';
        const dropTime = params.pickupTo.split(' ')[1] ?? '10:00';
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
        };
        const cr = await this.fetch(`${BASE}/api/v2/search/create-search`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
        const cj = await cr.json();
        const guid = cj?.data?.guid;
        const sq = cj?.data?.sq;
        if (!guid || !sq)
            throw new Error(`DiscoverCars create-search failed: ${JSON.stringify(cj?.errors ?? cj).slice(0, 200)}`);
        // Verify the committed window matches the request (fail loud, never wrong dates).
        const dec = JSON.parse(Buffer.from(sq, 'base64').toString());
        const wantP = params.pickupFrom.replace(' ', 'T') + ':00';
        const wantD = params.pickupTo.replace(' ', 'T') + ':00';
        if (dec.PickupDateTime !== wantP || dec.DropOffDateTime !== wantD) {
            throw new Error(`DiscoverCars committed the wrong window (${dec.PickupDateTime}..${dec.DropOffDateTime} != ${wantP}..${wantD})`);
        }
        // Offers aggregate asynchronously; poll until populated.
        const attempts = this.opts.pollAttempts ?? 12;
        const delay = this.opts.pollDelayMs ?? 2500;
        let raw = [];
        for (let i = 0; i < attempts; i++) {
            const or = await this.fetch(`${BASE}/api/v2/search/${guid}?sq=${sq}`, { headers: HEADERS });
            const oj = await or.json();
            raw = oj?.data?.offers ?? [];
            if (raw.length > 5)
                break;
            await new Promise((res) => setTimeout(res, delay));
        }
        const offers = parseApiOffers(raw);
        // Sanity: the requested window is a positive span (guards a caller typo).
        if (rentalDayCount(params.pickupFrom, params.pickupTo) <= 0) {
            throw new Error('rental dropoff is not after pickup');
        }
        return offers;
    }
}
