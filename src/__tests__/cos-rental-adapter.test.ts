import { describe, it, expect } from 'vitest'
import {
  parseApiOffer, parseApiOffers, isDebitFriendly, filterByCategory,
  underFullPrice, cheapestByFullPrice, rentalDayCount, assertRentalAdapterSafe,
  type LocationRef,
} from '../cos/rental-adapter.js'
import { isForbiddenMethodName } from '../cos/shopping-adapter.js'
import { DiscoverCarsAdapter } from '../cos/adapters/discovercars.js'

// COS car-rental adapter (DiscoverCars JSON API). The pure heart — the offer
// parser (over the real 2026-08-05 API shape), filters, day-count — plus a
// mocked-fetch search() that proves the create-search → poll → parse flow and
// the fail-loud date verification. No network in tests.

// Real API offer shape (Jeep Avenger, Centauro, Aug 18-23).
const AVENGER = {
  vehicle: { carName: 'Jeep Avenger', sippGroup: 'Compact SUV', specifications: { isAutomaticTransmission: 0, seats: { number: 5 }, bags: { number: 2 } } },
  price: { raw: 73904.72, currency: 'HUF' },
  coverage: { total: 17884.31, currency: 'HUF' },
  depositType: { title: 'Average deposit', value: 'HUF 541,325' },
  badges: { zero_excess: false, zero_deposit: false },
  supplier: { name: 'Centauro', key: 'centauro', rating: { score: '8.6' }, loc: { label: 'Free shuttle service' } },
  location: { name: 'Valencia Airport (VLC)' },
  mileage: { label: 'Unlimited' },
  bookUrl: '/book/abc',
}
const AYGO = {
  vehicle: { carName: 'Toyota Aygo', sippGroup: 'Mini', specifications: { isAutomaticTransmission: 1, seats: { number: 4 }, bags: { number: 1 } } },
  price: { raw: 55317.29, currency: 'HUF' }, coverage: { total: 23473.15, currency: 'HUF' },
  depositType: { title: 'Low deposit', value: 'HUF 72,180' }, badges: {},
  supplier: { name: 'Alamo', key: 'alamo', rating: { score: '8.2' }, loc: { label: 'In terminal' } },
  location: { name: 'Valencia Airport (VLC)' }, mileage: { label: 'Unlimited' },
}

describe('parseApiOffer', () => {
  it('parses the real API offer shape', () => {
    const o = parseApiOffer(AVENGER)!
    expect(o).toMatchObject({
      car: 'Jeep Avenger', category: 'Compact SUV', transmission: 'Manual', seats: 5, bags: 2,
      supplier: 'Centauro', supplierKey: 'centauro', rating: 8.6, pickupType: 'Free shuttle service',
      pickupPlace: 'Valencia Airport (VLC)', basePrice: 73904.72, coveragePrice: 17884.31,
      deposit: 'Average deposit', depositValue: 'HUF 541,325', zeroExcessBadge: false, mileage: 'Unlimited',
    })
    expect(o.fullPrice).toBeCloseTo(91789.03, 1)
    expect(parseApiOffer(AYGO)!.transmission).toBe('Automatic')
  })
  it('returns null when there is no vehicle', () => {
    expect(parseApiOffer({ price: { raw: 1 } })).toBeNull()
  })
})

describe('filters', () => {
  const offers = parseApiOffers([AVENGER, AYGO])
  it('debit-friendly, category, under-price, cheapest', () => {
    expect(isDebitFriendly(offers[0])).toBe(true)  // Centauro
    expect(isDebitFriendly(offers[1])).toBe(false) // Alamo
    expect(filterByCategory(offers, /compact/i).map((o) => o.car)).toEqual(['Jeep Avenger'])
    expect(underFullPrice(offers, 100000)).toHaveLength(2)
    expect(underFullPrice(offers, 80000).map((o) => o.car)).toEqual(['Toyota Aygo']) // Aygo full ~78,790
    expect(cheapestByFullPrice(offers).map((o) => o.car)).toEqual(['Toyota Aygo', 'Jeep Avenger'])
  })
})

describe('rentalDayCount', () => {
  it('counts whole days (API "YYYY-MM-DD HH:mm" format), month-boundary correct', () => {
    expect(rentalDayCount('2026-08-18 10:00', '2026-08-23 08:00')).toBe(5)
    expect(rentalDayCount('2026-08-30 10:00', '2026-09-02 10:00')).toBe(3)
  })
})

// ---- mocked-fetch search() ----------------------------------------------------

function sqFor(pickup: string, dropoff: string): string {
  return Buffer.from(JSON.stringify({ PickupDateTime: pickup, DropOffDateTime: dropoff })).toString('base64')
}
function jsonResp(body: any) { return { json: async () => body } as any }

const VLC: LocationRef = { countryId: 26, cityId: 462, placeId: 462, label: 'Valencia (all locations)' }
const AGP: LocationRef = { countryId: 26, cityId: 455, placeId: 1848, label: 'Malaga Airport (AGP)' }
const PARAMS = { pickup: VLC, dropoff: AGP, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU', driverAge: 35 }

describe('DiscoverCarsAdapter.search (mocked fetch)', () => {
  it('creates the search, polls, and returns parsed offers', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, opts?: any) => {
      calls.push((opts?.method ?? 'GET') + ' ' + String(url).replace(/^https:\/\/[^/]+/, ''))
      if (String(url).includes('create-search')) {
        return jsonResp({ success: true, data: { guid: 'g1', sq: sqFor('2026-08-18T10:00:00', '2026-08-23T08:00:00') } })
      }
      return jsonResp({ success: true, data: { offers: [AVENGER, AYGO] } })
    }) as unknown as typeof fetch

    const a = new DiscoverCarsAdapter({ fetchImpl, pollAttempts: 3, pollDelayMs: 0 })
    const offers = await a.search(PARAMS)
    expect(offers.map((o) => o.car)).toEqual(['Jeep Avenger', 'Toyota Aygo'])
    expect(calls[0]).toContain('POST /api/v2/search/create-search')
    expect(calls[1]).toContain('GET /api/v2/search/g1')
  })

  it('fails loud when the committed window differs from the request', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('create-search')) {
        return jsonResp({ data: { guid: 'g1', sq: sqFor('2026-08-07T11:00:00', '2026-08-15T11:00:00') } }) // wrong window
      }
      return jsonResp({ data: { offers: [AVENGER] } })
    }) as unknown as typeof fetch
    const a = new DiscoverCarsAdapter({ fetchImpl, pollAttempts: 1, pollDelayMs: 0 })
    await expect(a.search(PARAMS)).rejects.toThrow(/wrong window/i)
  })

  it('resolveLocation maps an autocomplete result to ids', async () => {
    const fetchImpl = (async () => jsonResp({ success: true, result: [{ place: 'Malaga Airport (AGP)', countryID: 26, cityID: 455, placeID: 1848 }] })) as unknown as typeof fetch
    const a = new DiscoverCarsAdapter({ fetchImpl })
    expect(await a.resolveLocation('Malaga', 'Airport (AGP)')).toEqual({ countryId: 26, cityId: 455, placeId: 1848, label: 'Malaga Airport (AGP)' })
  })
})

describe('no-booking safety guard', () => {
  it('rejects book/reserve/checkout/pay method names', () => {
    for (const n of ['bookRental', 'book', 'reserve', 'checkout', 'payNow']) expect(isForbiddenMethodName(n)).toBe(true)
  })
  it('allows search/read names', () => {
    for (const n of ['search', 'resolveLocation', 'parseApiOffer', 'bookmark']) expect(isForbiddenMethodName(n)).toBe(false)
  })
  it('a compliant adapter passes the guard; a rogue booking method throws', () => {
    expect(() => assertRentalAdapterSafe(new DiscoverCarsAdapter())).not.toThrow()
    expect(() => assertRentalAdapterSafe({ id: 'x', displayName: 'X', async search() { return [] }, async bookRental() {} })).toThrow(/forbidden purchase method/i)
  })
})
