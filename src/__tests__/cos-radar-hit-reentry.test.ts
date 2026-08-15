import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createRadarItem, getRadarItem, recordObservation, markNotified } from '../cos/radar.js'

// The 2026-08-10 radar-spain-rental sequence, replayed. Istvan asked whether the
// hit had reached me; it had, and following it up is what surfaced these two.
//
// Real observations (radar_observations, target 85 000 HUF):
//   08-09 12:07  87 169   above target
//   08-10 11:13  64 471   HIT, owner notified
//   08-10 17:13  91 072   back above target
//   08-11 05:13  91 241   still above
//
// After that sequence the item still read HIT/64 471, and a later genuine drop
// to 80 000 (under target, same offer) would have been silently swallowed.

const NOW = 1_700_000_000
const TARGET = 85_000
const OFFER = 'Alamo|SEAT Leon'

function newRadar() {
  createRadarItem(getDb(), {
    radarId: 'r-spain', kind: 'RENTAL', label: 'Valencia -> Malaga',
    // A rental needs its pickup/dropoff descriptor: since 2026-08-15 an item
    // without one is refused at creation instead of throwing on every check.
    query: { search: { pickup: 'VLC', dropoff: 'AGP' } },
    targetPrice: TARGET, currency: 'HUF', checkIntervalSec: 21600,
  }, NOW)
}

describe('radar status reports the present, not the best past moment', () => {
  beforeEach(() => { initDatabase(':memory:'); newRadar() })

  it('leaves HIT when the price climbs back above target', () => {
    const db = getDb()
    recordObservation(db, 'r-spain', { bestPrice: 64_471, offerId: OFFER }, NOW + 3600)
    expect(getRadarItem(db, 'r-spain')!.status).toBe('HIT')

    const back = recordObservation(db, 'r-spain', { bestPrice: 91_072, offerId: OFFER }, NOW + 7200)
    expect(back.hit).toBe(false)
    expect(getRadarItem(db, 'r-spain')!.status,
      'a radar that still says HIT at 91 072 against an 85 000 target is lying about today').toBe('ACTIVE')
  })

  it('keeps best_seen_price as the historical minimum — that number is still true', () => {
    const db = getDb()
    recordObservation(db, 'r-spain', { bestPrice: 64_471, offerId: OFFER }, NOW + 3600)
    recordObservation(db, 'r-spain', { bestPrice: 91_072, offerId: OFFER }, NOW + 7200)
    expect(getRadarItem(db, 'r-spain')!.best_seen_price).toBe(64_471)
  })

  it('does NOT resurrect a radar the owner paused or closed', () => {
    // A price observation must never override an owner decision about whether to
    // watch at all. Only HIT is reversible, and only to ACTIVE.
    const db = getDb()
    for (const s of ['PAUSED', 'CLOSED'] as const) {
      db.prepare(`UPDATE radar_items SET status=? WHERE radar_id='r-spain'`).run(s)
      recordObservation(db, 'r-spain', { bestPrice: 91_072, offerId: OFFER }, NOW + 7200)
      expect(getRadarItem(db, 'r-spain')!.status).toBe(s)
    }
  })
})

describe('a one-off low must not silence future genuine hits', () => {
  beforeEach(() => { initDatabase(':memory:'); newRadar() })

  it('re-notifies when the price re-enters the target zone, even above the old low', () => {
    const db = getDb()
    // 08-10 11:13 — the freak low, owner told.
    const first = recordObservation(db, 'r-spain', { bestPrice: 64_471, offerId: OFFER }, NOW + 3600)
    expect(first.notify).toMatchObject({ should: true, reason: 'NEW_HIT' })
    markNotified(db, 'r-spain', { offerId: OFFER, price: 64_471, reason: 'NEW_HIT' }, NOW + 3600)

    // 08-10 17:13 and 08-11 05:13 — above target, nothing to say.
    expect(recordObservation(db, 'r-spain', { bestPrice: 91_072, offerId: OFFER }, NOW + 7200).notify.should).toBe(false)
    expect(recordObservation(db, 'r-spain', { bestPrice: 91_241, offerId: OFFER }, NOW + 10800).notify.should).toBe(false)

    // The case that used to be swallowed: 80 000 is UNDER his 85 000 target and
    // therefore real news — but it is worse than the 64 471 already notified, on
    // the same offer, so every dedup branch said "nothing changed".
    const reentry = recordObservation(db, 'r-spain', { bestPrice: 80_000, offerId: OFFER }, NOW + 14400)
    expect(reentry.hit).toBe(true)
    expect(reentry.notify, 'a price under the target is news even if a past freak low was lower')
      .toMatchObject({ should: true, reason: 'NEW_HIT' })
  })

  it('still does not repeat itself while the price stays in the target zone', () => {
    // The dedup this replaces was there for a reason: no re-alerting on every
    // six-hourly check for an unchanged offer.
    const db = getDb()
    recordObservation(db, 'r-spain', { bestPrice: 80_000, offerId: OFFER }, NOW + 3600)
    markNotified(db, 'r-spain', { offerId: OFFER, price: 80_000, reason: 'NEW_HIT' }, NOW + 3600)
    const again = recordObservation(db, 'r-spain', { bestPrice: 80_000, offerId: OFFER }, NOW + 7200)
    expect(again.notify.should, 'same offer, same price, still under target → silence').toBe(false)
  })

  it('still reports a significant further drop on the same offer', () => {
    const db = getDb()
    recordObservation(db, 'r-spain', { bestPrice: 80_000, offerId: OFFER }, NOW + 3600)
    markNotified(db, 'r-spain', { offerId: OFFER, price: 80_000, reason: 'NEW_HIT' }, NOW + 3600)
    const drop = recordObservation(db, 'r-spain', { bestPrice: 70_000, offerId: OFFER }, NOW + 7200)
    expect(drop.notify).toMatchObject({ should: true, reason: 'PRICE_DROP' })
  })
})
