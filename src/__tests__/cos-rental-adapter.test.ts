import { describe, it, expect } from 'vitest'
import {
  parseDiscoverCarsOfferCard, parseDiscoverCarsOffers,
  encodeDiscoverCarsSq, decodeDiscoverCarsSq, sqDatesMatch,
  filterByCategory, cheapestFirst, assertRentalAdapterSafe, rentalDayCount,
  type DiscoverCarsSq,
} from '../cos/rental-adapter.js'
import { isForbiddenMethodName } from '../cos/shopping-adapter.js'

// COS car-rental adapter. The browser driver isn't unit-tested (it drives a live
// site); the PURE heart is: the sq codec + date-verification, the offer parser
// (real DiscoverCars card text from the 2026-08-04 recon), and the no-booking
// safety guard.

const AYGO = [
  'Toyota Aygo', 'or similar Mini', 'Manual', '4 seats', '3 doors', 'Air Conditioning',
  'Fair offer', 'Compare', 'Outside of terminal pick-up — Valencia Airport (VLC)',
  'Low deposit', 'Instant confirmation!', 'Unlimited mileage', '8.1', 'Good', '1,641 ratings',
  'Total for 8 days', 'HUF 152,246', 'Free cancellation', 'View deal',
].join('\n')

const PEUGEOT = [
  'Peugeot 2008', 'or similar Compact SUV', 'Manual', '5 seats', '5 doors', 'Air Conditioning',
  'Fair offer', 'Compare', 'In terminal pick-up — Valencia Airport (VLC)',
  'Average deposit', 'Instant confirmation!', '150 km/day included mileage', '7.9', 'Good', '900 ratings',
  'Total for 5 days', 'HUF 98,500', 'Free cancellation', 'View deal',
].join('\n')

describe('parseDiscoverCarsOfferCard (real card text)', () => {
  it('parses the Toyota Aygo (Mini) card', () => {
    const o = parseDiscoverCarsOfferCard(AYGO)!
    expect(o).toMatchObject({
      car: 'Toyota Aygo', category: 'Mini', transmission: 'Manual', seats: 4,
      pickupType: 'Outside of terminal', pickupLocation: 'Valencia Airport (VLC)',
      deposit: 'Low', rating: '8.1', days: 8, totalPrice: 152246, currency: 'HUF',
    })
  })

  it('parses the Peugeot 2008 (Compact SUV) card', () => {
    const o = parseDiscoverCarsOfferCard(PEUGEOT)!
    expect(o).toMatchObject({
      car: 'Peugeot 2008', category: 'Compact SUV', transmission: 'Manual', seats: 5,
      pickupType: 'In terminal', deposit: 'Average', days: 5, totalPrice: 98500, currency: 'HUF',
    })
  })

  it('returns null for a card without a car line', () => {
    expect(parseDiscoverCarsOfferCard('Some ad\nHUF 100\nView deal')).toBeNull()
  })
})

describe('parseDiscoverCarsOffers + filters', () => {
  it('dedupes and filters by category / sorts by price', () => {
    const offers = parseDiscoverCarsOffers([AYGO, PEUGEOT, AYGO]) // dup Aygo
    expect(offers).toHaveLength(2)
    const compact = filterByCategory(offers, /compact/i)
    expect(compact.map((o) => o.car)).toEqual(['Peugeot 2008'])
    expect(cheapestFirst(offers).map((o) => o.totalPrice)).toEqual([98500, 152246])
  })
})

describe('DiscoverCars sq codec + date verification', () => {
  const q: DiscoverCarsSq = {
    PickupLocationId: 462, DropOffLocationId: 1848,
    PickupDateTime: '2026-08-18T10:00:00', DropOffDateTime: '2026-08-23T08:00:00',
    ResidenceCountry: 'HU', DriverAge: 35, Hash: '',
  }

  it('round-trips through base64', () => {
    expect(decodeDiscoverCarsSq(encodeDiscoverCarsSq(q))).toEqual(q)
  })

  it('sqDatesMatch is true only for the exact requested window', () => {
    const sq = encodeDiscoverCarsSq(q)
    expect(sqDatesMatch(sq, '2026-08-18T10:00:00', '2026-08-23T08:00:00')).toBe(true)
    expect(sqDatesMatch(sq, '2026-08-07T11:00:00', '2026-08-15T11:00:00')).toBe(false) // the cached default window
    expect(sqDatesMatch('not-base64', '2026-08-18T10:00:00', '2026-08-23T08:00:00')).toBe(false)
  })
})

describe('rentalDayCount', () => {
  it('counts whole days, correct across month boundaries', () => {
    expect(rentalDayCount('2026-08-18T10:00:00', '2026-08-23T08:00:00')).toBe(5)
    expect(rentalDayCount('2026-08-07T11:00:00', '2026-08-15T11:00:00')).toBe(8)
    expect(rentalDayCount('2026-08-30T10:00:00', '2026-09-02T10:00:00')).toBe(3) // Aug has 31 days
  })
})

describe('no-booking safety guard', () => {
  it('book/reserve method names are forbidden (rental booking verbs)', () => {
    for (const n of ['bookRental', 'book', 'reserve', 'reserveCar', 'checkout', 'payNow']) {
      expect(isForbiddenMethodName(n)).toBe(true)
    }
  })

  it('legit search/read method names are allowed', () => {
    for (const n of ['search', 'searchProducts', 'getProduct', 'parseOffers', 'bookmark', 'display']) {
      expect(isForbiddenMethodName(n)).toBe(false)
    }
  })

  it('a compliant rental-adapter-shaped object passes assertRentalAdapterSafe', () => {
    const ok = { id: 'x', displayName: 'X', async search() { return [] } }
    expect(() => assertRentalAdapterSafe(ok)).not.toThrow()
    const rogue = { id: 'y', displayName: 'Y', async search() { return [] }, async bookRental() { return {} } }
    expect(() => assertRentalAdapterSafe(rogue)).toThrow(/forbidden purchase method/i)
  })
})
