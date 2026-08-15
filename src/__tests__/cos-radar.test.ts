import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  createRadarItem, getRadarItem, dueRadarChecks, recordObservation, setRadarStatus,
  markNotified, decideNotify,
} from '../cos/radar.js'

// COS price radar. Proves: due-check selection, new-low tracking, HIT when the
// target is met, and that observations accumulate. Purchase is never autonomous
// (no checkout anywhere) — a HIT only surfaces the deal.

const NOW = 1_000_000

describe('COS price radar', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  })

  it('creates an ACTIVE item and schedules the next check', () => {
    const db = getDb()
    const r = createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    expect(r.status).toBe('ACTIVE')
    expect(r.next_check_at).toBe(NOW + 3600)
  })

  it('dueRadarChecks returns only ACTIVE items whose check time has arrived', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'due', kind: 'RENTAL', label: 'a', checkIntervalSec: 100, targetPrice: 50000, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW - 200) // next = NOW-100 → due
    createRadarItem(db, { radarId: 'future', kind: 'RENTAL', label: 'b', checkIntervalSec: 100000, targetPrice: 50000, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)  // next far off
    createRadarItem(db, { radarId: 'paused', kind: 'RENTAL', label: 'c', checkIntervalSec: 100, targetPrice: 50000, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW - 200)
    setRadarStatus(db, 'paused', 'PAUSED', NOW)
    expect(dueRadarChecks(db, NOW).map((x) => x.radar_id)).toEqual(['due'])
  })

  it('records observations, tracks the new low, and does NOT hit above target', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 80000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o1 = recordObservation(db, 'r1', { bestPrice: 95000, offerCount: 500 }, NOW + 3600)
    expect(o1).toMatchObject({ hit: false, isNewLow: true, status: 'ACTIVE' })
    const o2 = recordObservation(db, 'r1', { bestPrice: 88000 }, NOW + 7200)
    expect(o2).toMatchObject({ hit: false, isNewLow: true })
    const o3 = recordObservation(db, 'r1', { bestPrice: 92000 }, NOW + 10800) // higher → not a new low
    expect(o3.isNewLow).toBe(false)
    expect(getRadarItem(db, 'r1')!.best_seen_price).toBe(88000)
    expect((db.prepare(`SELECT COUNT(*) n FROM radar_observations WHERE radar_id='r1'`).get() as any).n).toBe(3)
  })

  it('flips to HIT when an observation meets the target', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o = recordObservation(db, 'r1', { bestPrice: 84000, offerRef: { car: 'Hyundai i30', supplier: 'Centauro' } }, NOW + 3600)
    expect(o.hit).toBe(true)
    expect(o.status).toBe('HIT')
    expect(getRadarItem(db, 'r1')!.status).toBe('HIT')
  })

  // ── P1.6 notification dedup (AC-29) ──────────────────────────────────
  it('AC-29: the FIRST hit notifies (NEW_HIT); the SAME unchanged offer does NOT re-notify', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o1 = recordObservation(db, 'r1', { bestPrice: 84000, offerId: 'Centauro|i30' }, NOW + 3600)
    expect(o1.notify).toEqual({ should: true, reason: 'NEW_HIT' })
    // the tick persists the notification
    markNotified(db, 'r1', { offerId: o1.offerId, price: o1.bestPrice, reason: o1.notify.reason }, NOW + 3600)
    // next check: same offer, same price → NO repeat notification
    const o2 = recordObservation(db, 'r1', { bestPrice: 84000, offerId: 'Centauro|i30' }, NOW + 7200)
    expect(o2.hit).toBe(true) // still a hit
    expect(o2.notify.should).toBe(false) // but deduped
  })

  it('AC-29: a DIFFERENT offer at/under target re-notifies (NEW_OFFER)', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o1 = recordObservation(db, 'r1', { bestPrice: 84000, offerId: 'Centauro|i30' }, NOW + 3600)
    markNotified(db, 'r1', { offerId: o1.offerId, price: o1.bestPrice, reason: o1.notify.reason }, NOW + 3600)
    const o2 = recordObservation(db, 'r1', { bestPrice: 83500, offerId: 'Goldcar|Corsa' }, NOW + 7200)
    expect(o2.notify).toEqual({ should: true, reason: 'NEW_OFFER' })
  })

  it('AC-29: same offer, a SIGNIFICANT further drop re-notifies (PRICE_DROP); a tiny drop does not', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o1 = recordObservation(db, 'r1', { bestPrice: 84000, offerId: 'Centauro|i30' }, NOW + 3600)
    markNotified(db, 'r1', { offerId: o1.offerId, price: o1.bestPrice, reason: o1.notify.reason }, NOW + 3600)
    // 0.5% lower → below the significance threshold → no re-notify
    const small = recordObservation(db, 'r1', { bestPrice: 83600, offerId: 'Centauro|i30' }, NOW + 7200)
    expect(small.notify.should).toBe(false)
    // 5% lower → significant → re-notify
    const big = recordObservation(db, 'r1', { bestPrice: 79800, offerId: 'Centauro|i30' }, NOW + 10800)
    expect(big.notify).toEqual({ should: true, reason: 'PRICE_DROP' })
  })

  it('decideNotify: a non-hit never notifies', () => {
    const fake: any = { last_notified_at: null, last_notified_offer_id: null, last_notified_price: null }
    expect(decideNotify(fake, 90000, 'x', false)).toEqual({ should: false, reason: null })
  })

  // ── P1.5 FX (currency handling) ──────────────────────────────────────
  it('P1.5: a single-currency observation records identity FX (converted == best)', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    recordObservation(db, 'r1', { bestPrice: 84000, currency: 'HUF', offerId: 'a' }, NOW + 3600)
    const row = db.prepare(`SELECT * FROM radar_observations WHERE radar_id='r1' ORDER BY observed_at DESC LIMIT 1`).get() as any
    expect(row.original_currency).toBe('HUF')
    expect(row.comparison_currency).toBe('HUF')
    expect(row.converted_final_price).toBe(84000)
    expect(row.original_final_price).toBe(84000)
    expect(row.fx_rate).toBe(1)
    expect(row.fx_rate_source).toBe('none')
  })

  it('P1.5: a foreign-currency merchant records the original + converted price and the rate', () => {
    const db = getDb()
    // target in HUF; merchant quotes EUR 210, converted at 400 HUF/EUR → 84000 HUF
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600, query: { search: { pickup: 'VLC', dropoff: 'AGP' } } }, NOW)
    const o = recordObservation(db, 'r1', {
      bestPrice: 84000, currency: 'HUF', offerId: 'a',
      fx: { originalPrice: 210, originalCurrency: 'EUR', rate: 400, rateSource: 'ecb', rateTimestamp: NOW + 3600 },
    }, NOW + 3600)
    expect(o.hit).toBe(true) // compared on the CONVERTED price
    const row = db.prepare(`SELECT * FROM radar_observations WHERE radar_id='r1' ORDER BY observed_at DESC LIMIT 1`).get() as any
    expect(row.original_currency).toBe('EUR')
    expect(row.original_final_price).toBe(210)
    expect(row.comparison_currency).toBe('HUF')
    expect(row.converted_final_price).toBe(84000)
    expect(row.fx_rate).toBe(400)
    expect(row.fx_rate_source).toBe('ecb')
  })
})
