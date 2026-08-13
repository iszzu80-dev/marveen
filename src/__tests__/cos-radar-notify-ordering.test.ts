import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem, getRadarItem } from '../cos/radar.js'
import { cosTick } from '../cos/tick.js'
import { deliverRadarNotifications } from '../cos/runtime.js'
import type { RentalAdapter, RentalOffer, RentalSearchParams } from '../cos/rental-adapter.js'

// P1 (review 2026-08-13). markNotified used to run INSIDE cosTick, while the
// alert it claims to describe (alertRadarHit) only fires one `.then()` later in
// runtime — whose catch merely logs. Anything failing in between stamped the item
// "the owner knows" while the owner knew nothing, and because the status stays
// HIT for as long as the price stays under target, every branch of decideNotify
// then returns should:false: the deal the system found is NEVER surfaced. These
// tests pin the ordering — decide in the tick, mark only after the alert returned.

const NOW = 5_000_000

class MockRental implements RentalAdapter {
  readonly id = 'discovercars'; readonly displayName = 'DiscoverCars'
  async search(_p: RentalSearchParams): Promise<RentalOffer[]> {
    return [{
      car: 'Hyundai i30', category: 'Compact', transmission: 'Manual', seats: 5, bags: 2,
      supplier: 'Centauro', supplierKey: 'centauro', rating: 8.6, pickupType: 'shuttle', pickupPlace: 'VLC',
      basePrice: 68000, currency: 'HUF', coveragePrice: 16000, fullPrice: 84000, deposit: 'Average deposit',
      depositValue: 'x', zeroExcessBadge: false, zeroDepositBadge: false, mileage: 'Unlimited', bookUrl: '/b',
    }]
  }
}
const QUERY = {
  search: { pickup: { countryId: 26, cityId: 462, placeId: 462, label: 'VLC' }, dropoff: { countryId: 26, cityId: 455, placeId: 1848, label: 'AGP' }, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU' },
  categoryPattern: 'compact',
}

function seedDueItem() {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', query: QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW - 7200)
  return db
}
const makeDueAgain = (db = getDb()) => db.prepare(`UPDATE radar_items SET next_check_at=? WHERE radar_id='r1'`).run(NOW + 10)

describe('radar notify ordering (decide in the tick, mark after the alert)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('cosTick surfaces the decision WITHOUT persisting it', async () => {
    const db = seedDueItem()
    const res = await cosTick(db, { rentalAdapter: new MockRental() }, NOW)
    expect(res.radarHits).toEqual(['r1'])
    expect(res.radarNotifications).toEqual([
      { radarId: 'r1', offerId: 'Centauro|Hyundai i30', price: 84000, reason: 'NEW_HIT' },
    ])
    // The tick made no claim about what the owner has heard.
    expect(getRadarItem(db, 'r1')!.last_notified_at).toBeNull()
  })

  it('a crash between the tick and the alert does NOT silence the hit forever', async () => {
    const db = seedDueItem()
    const deps = { rentalAdapter: new MockRental() }
    const first = await cosTick(db, deps, NOW)
    expect(first.radarHits).toEqual(['r1'])
    // …and here the process dies / alertRadarHit throws — nothing is delivered.
    makeDueAgain(db)
    const second = await cosTick(db, deps, NOW + 20)
    expect(second.radarChecked).toBe(1)
    expect(second.radarHits).toEqual(['r1']) // still owed: the owner was never told
  })

  it('deliverRadarNotifications alerts first, then records the dedup state', async () => {
    const db = seedDueItem()
    const res = await cosTick(db, { rentalAdapter: new MockRental() }, NOW)
    deliverRadarNotifications(db, res, NOW + 1)
    // the alert really went out
    const msg = db.prepare(`SELECT to_agent, content FROM agent_messages ORDER BY id DESC LIMIT 1`).get() as { to_agent: string; content: string }
    expect(msg.to_agent).toBe('marveen')
    expect(msg.content).toContain('COS radar HIT')
    // and only now is the item recorded as notified
    const item = getRadarItem(db, 'r1')!
    expect(item.last_notified_at).toBe(NOW + 1)
    expect(item.last_notified_offer_id).toBe('Centauro|Hyundai i30')
    expect(item.last_notified_price).toBe(84000)
    expect(item.notification_reason).toBe('NEW_HIT')
    // …so the next unchanged cycle is deduped, exactly as before the fix
    makeDueAgain(db)
    const second = await cosTick(db, { rentalAdapter: new MockRental() }, NOW + 20)
    expect(second.radarHits).toEqual([])
  })

  it('a failing alert leaves the item UNMARKED so the next tick re-offers it', async () => {
    const db = seedDueItem()
    const res = await cosTick(db, { rentalAdapter: new MockRental() }, NOW)
    // The bus post is the first statement of alertRadarHit; make it throw the way
    // a broken/read-only store would.
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('store unavailable') })
    deliverRadarNotifications(db, res, NOW + 1)
    spy.mockRestore()
    expect(getRadarItem(db, 'r1')!.last_notified_at).toBeNull()
    makeDueAgain(db)
    const second = await cosTick(db, { rentalAdapter: new MockRental() }, NOW + 20)
    expect(second.radarHits).toEqual(['r1'])
  })
})
