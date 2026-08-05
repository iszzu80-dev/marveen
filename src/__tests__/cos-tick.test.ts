import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { planAction } from '../cos/executor.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import { createRadarItem, getRadarItem } from '../cos/radar.js'
import { setNextWake } from '../cos/scheduler.js'
import { cosTick } from '../cos/tick.js'
import type { RentalAdapter, RentalOffer, RentalSearchParams } from '../cos/rental-adapter.js'

// COS tick — one cycle end to end: a planned email gets sent+verified, a due
// rental radar check records an observation and hits its target, and due
// cases/follow-ups are surfaced. Uses mock adapters (no network).

const NOW = 2_000_000

function offer(full: number): RentalOffer {
  return {
    car: 'Hyundai i30', category: 'Compact', transmission: 'Manual', seats: 5, bags: 2, supplier: 'Centauro',
    supplierKey: 'centauro', rating: 8.6, pickupType: 'Free shuttle service', pickupPlace: 'VLC',
    basePrice: full - 16000, currency: 'HUF', coveragePrice: 16000, fullPrice: full, deposit: 'Average deposit',
    depositValue: 'HUF 541,325', zeroExcessBadge: false, zeroDepositBadge: false, mileage: 'Unlimited', bookUrl: '/b',
  }
}
class MockRental implements RentalAdapter {
  readonly id = 'discovercars'; readonly displayName = 'DiscoverCars'
  async search(_p: RentalSearchParams): Promise<RentalOffer[]> { return [offer(84000)] }
}
const RENTAL_QUERY = {
  search: { pickup: { countryId: 26, cityId: 462, placeId: 462, label: 'VLC' }, dropoff: { countryId: 26, cityId: 455, placeId: 1848, label: 'AGP' }, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU' },
  categoryPattern: 'compact',
}

describe('cosTick (one full cycle)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  })

  it('sends+verifies a planned email, runs a due radar check that hits, and surfaces due work', async () => {
    const db = getDb()
    // a PLANNED outbound email
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'v@x.com', subject: 'Quote' } }, NOW)
    // a due RENTAL radar item with a reachable target
    createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', query: RENTAL_QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW - 7200) // next_check in the past → due
    // a due case wake + a due follow-up
    setNextWake(db, 'c1', NOW - 10, NOW)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'm', patch: { follow_up_at: NOW - 5 } }, NOW)

    const res = await cosTick(db, {
      outboundAdapters: { EMAIL_SEND: new GmailSendAdapter(new DryRunTransport()) },
      rentalAdapter: new MockRental(),
    }, NOW)

    expect(res.outboundProcessed).toBe(1)
    expect(res.errors).toEqual([])
    expect(res.radarChecked).toBe(1)
    expect(res.radarHits).toEqual(['r1'])
    expect(res.dueCases).toBe(1)
    expect(res.dueFollowUps).toBe(1)
    // effects landed
    const ledger = db.prepare(`SELECT status FROM outbound_ledger WHERE ledger_id=?`).get(p.ledgerId) as any
    expect(ledger.status).toBe('VERIFIED')
    expect(getRadarItem(db, 'r1')!.status).toBe('HIT')
  })

  it('skips outbound rows with no registered adapter, and does not throw', async () => {
    const db = getDb()
    planAction(db, { caseId: 'c1', actionType: 'CALENDAR_CREATE', sequenceNumber: 1, payload: {} }, NOW)
    const res = await cosTick(db, { outboundAdapters: {} }, NOW) // no CALENDAR_CREATE adapter
    expect(res.outboundProcessed).toBe(0)
    expect(res.outboundSkippedNoAdapter).toBe(1)
    expect(res.errors).toEqual([])
  })
})
