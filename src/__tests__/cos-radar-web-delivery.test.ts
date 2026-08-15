import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem, getRadarItem } from '../cos/radar.js'
import { recordWebObservation } from '../cos/radar-web.js'

/**
 * The websearch sweep must DELIVER, not merely decide.
 *
 * This is the acceptance test for the 2026-08-15 card. What it guards is a
 * measured failure, not a hypothetical: three at-target product prices were
 * recorded on this path (08-07 Shopsy 27 990, 08-07 About You 11 745, 08-09
 * ecipo.hu 34 120), `decideNotify` said "tell him" all three times, and none of
 * them reached Istvan — because the last step was a model reading stdout.
 *
 * RED PROOF (acceptance criterion 1): delete the `deliver(...)` call in
 * `recordWebObservation` and exactly the first test here goes red, while the
 * "no hit, no alert" test stays green. Delivery is not covered by the fact that
 * a notification was *computed*.
 *
 * These cases state `shippableHu: 'YES'` explicitly because they are about
 * whether the ALERT goes out, not about whether the shop ships. Since the
 * 2026-08-15 deliverability gate, a PRODUCT hit needs both; leaving it implicit
 * here would test the gate a second time and this path not at all.
 */

const NOW = 1_000_000

function seed(targetPrice = 35000) {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'Cipő', caseType: 'SHOPPING' }, NOW)
  createRadarItem(db, {
    radarId: 'r1', caseId: 'c1', kind: 'PRODUCT', label: 'HOFF – hasonló stílusú modellek',
    targetPrice, currency: 'HUF', checkIntervalSec: 86400,
  }, NOW)
  return db
}

describe('websearch sweep delivery', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an at-target web price is DELIVERED and marked — not just decided', () => {
    const db = seed()
    const deliver = vi.fn().mockReturnValue(true)

    const res = recordWebObservation(db, {
      radarId: 'r1', price: 27990, shop: 'Shopsy', url: 'https://shopsy.hu/x', shippableHu: 'YES',
    }, NOW + 60, deliver)

    // The decision is right...
    expect(res.hit).toBe(true)
    expect(res.notify.should).toBe(true)
    // ...and it actually went out. This second assertion is the whole card.
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][1]).toMatchObject({
      radarId: 'r1', price: 27990, offerId: 'websearch|Shopsy',
    })
    expect(res.delivered).toBe(true)
  })

  it('a price above target neither alerts nor claims it did', () => {
    const db = seed()
    const deliver = vi.fn().mockReturnValue(true)

    const res = recordWebObservation(db, { radarId: 'r1', price: 55780, shop: 'ecipo' }, NOW + 60, deliver)

    expect(res.hit).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(res.delivered).toBe(false)
  })

  it('a FAILED alert leaves the item unmarked, so the next run retries', () => {
    const db = seed()
    // deliverRadarNotification returns false when the alert threw: the dedup
    // state is deliberately untouched. Never telling him is worse than telling
    // him twice — a price falls below target once.
    const deliver = vi.fn().mockReturnValue(false)

    const res = recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy', shippableHu: 'YES' }, NOW + 60, deliver)

    expect(res.notify.should).toBe(true)
    expect(res.delivered).toBe(false)
    expect(getRadarItem(db, 'r1')!.last_notified_at).toBeNull()
  })

  it('the SAME shop at the same price does not re-alert the next day', () => {
    // The sweep skill advertises this dedup. On the old path it did not exist:
    // nothing called markNotified here, so `last_notified_at` stayed NULL and
    // every run took decideNotify's NEW_HIT branch. Real delivery is used here
    // (no injected fake) precisely because the marking is what is under test.
    const db = seed()

    const first = recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy', shippableHu: 'YES' }, NOW + 60)
    expect(first.delivered).toBe(true)
    expect(getRadarItem(db, 'r1')!.last_notified_at).toBe(NOW + 60)

    const second = recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy', shippableHu: 'YES' }, NOW + 86460)
    expect(second.hit).toBe(true)
    expect(second.notify.should).toBe(false)
    expect(second.delivered).toBe(false)
  })

  it('a NEW cheaper shop is news even after the first was notified', () => {
    const db = seed()
    recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy', shippableHu: 'YES' }, NOW + 60)

    const other = recordWebObservation(db, { radarId: 'r1', price: 24990, shop: 'About You', shippableHu: 'YES' }, NOW + 120)

    expect(other.notify.should).toBe(true)
    expect(other.delivered).toBe(true)
  })
})

/**
 * The tick counts what it declined to look at.
 *
 * Not a bug fix — nothing broke because of the silent `continue`. It is a
 * legibility fix: `radarChecked` alone cannot distinguish "one item was due"
 * from "one checked, eight skipped for want of an adapter", and that ambiguity
 * is what let three wrong explanations survive contact with the telemetry.
 */
describe('tick radar skip is counted', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a due item with no adapter for its kind is reported, not swallowed', async () => {
    const { cosTick } = await import('../cos/tick.js')
    const db = seed()
    // A PRODUCT item is due, and deps carry NO shoppingAdapter.
    const res = await cosTick(db, {}, NOW + 100_000)

    expect(res.radarChecked).toBe(0)
    expect(res.radarSkippedNoAdapter).toBe(1)
    expect(res.errors).toHaveLength(0)
  })
})
