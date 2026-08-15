import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem, recordObservation } from '../cos/radar.js'
import { recordWebObservation } from '../cos/radar-web.js'
import { buildRadarDigest, reportUnverifiedFinds, radarDigestPostedToday } from '../cos/radar-digest.js'

/**
 * Acceptance criterion 2 of the 2026-08-15 card: deliverability has THREE
 * branches, and all three are proven.
 *
 * The first version of the criterion asked for a pair (ships / does not ship)
 * and left out the case that will actually dominate: a web search establishes
 * a price far more often than it establishes shipping to Hungary. An untested
 * 'UNKNOWN' branch would let the radar go silent with every test green — the
 * card's own argument failing on the branch nobody covered.
 *
 * RED PROOF for the third branch: remove the "not verified" line from
 * buildRadarDigest (return the zero-case text unconditionally) and exactly the
 * UNKNOWN-visibility tests go red, while the two firing tests stay green.
 */

const NOW = 1_000_000

function product(targetPrice = 35000) {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'Cipő', caseType: 'SHOPPING' }, NOW)
  createRadarItem(db, {
    radarId: 'r1', caseId: 'c1', kind: 'PRODUCT', label: 'HOFF – hasonló stílusú modellek',
    targetPrice, currency: 'HUF', checkIntervalSec: 86400,
  }, NOW)
  return db
}

describe('deliverability gates the hit — all three branches', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('YES: cheaper AND deliverable → FIRES', () => {
    const db = product()
    const deliver = vi.fn().mockReturnValue(true)

    const res = recordWebObservation(db, {
      radarId: 'r1', price: 27990, shop: 'Shopsy', shippableHu: 'YES',
    }, NOW + 60, deliver)

    expect(res.priceMet).toBe(true)
    expect(res.hit).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(buildRadarDigest(db).count).toBe(0)
  })

  it('NO: cheaper but does NOT ship → does not fire, and is still visible', () => {
    const db = product()
    const deliver = vi.fn().mockReturnValue(true)

    const res = recordWebObservation(db, {
      radarId: 'r1', price: 27990, shop: 'DE-Shop', shippableHu: 'NO',
    }, NOW + 60, deliver)

    // The price WAS met — that fact is not erased, it just is not a deal.
    expect(res.priceMet).toBe(true)
    expect(res.hit).toBe(false)
    expect(deliver).not.toHaveBeenCalled()

    const digest = buildRadarDigest(db)
    expect(digest.count).toBe(1)
    expect(digest.text).toContain('nem szallit Magyarorszagra')
    expect(digest.text).toContain('DE-Shop')
  })

  it('UNKNOWN: cheaper but delivery unverified → does not fire, MUST appear', () => {
    // The branch the first version of the criterion left untested, and the one
    // that will be hit most often in practice.
    const db = product()
    const deliver = vi.fn().mockReturnValue(true)

    const res = recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy' }, NOW + 60, deliver)

    expect(res.shippable).toBe('UNKNOWN')
    expect(res.priceMet).toBe(true)
    expect(res.hit).toBe(false)
    expect(deliver).not.toHaveBeenCalled()

    const digest = buildRadarDigest(db)
    expect(digest.count).toBe(1)
    expect(digest.text).toContain('a szallitas nem igazolt')
    expect(digest.text).toContain('HOFF')
    expect(digest.text).toContain('27')
  })

  it('an omitted shippability is UNKNOWN, never YES', () => {
    // Silence from a source is not consent. If this ever defaults to YES, a
    // future adapter earns a delivery guarantee by forgetting to answer.
    const db = product()
    const res = recordObservation(db, 'r1', { bestPrice: 27990, offerId: 'x' }, NOW + 60)
    expect(res.shippable).toBe('UNKNOWN')
    expect(res.hit).toBe(false)
  })
})

describe('deliverability does NOT gate rentals', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a rental under target still hits without any shipping claim', () => {
    // A rental car is collected at a counter. Gating it on delivery would have
    // killed the ONE radar path that demonstrably works — the rental item is
    // the only one that has ever alerted Istvan.
    const db = getDb()
    createCase(db, { caseId: 'c2', title: 'Spain', caseType: 'TRAVEL' }, NOW)
    createRadarItem(db, {
      radarId: 'r2', caseId: 'c2', kind: 'RENTAL', label: 'Valencia→Malaga',
      targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600,
    }, NOW)

    const res = recordObservation(db, 'r2', { bestPrice: 64471, offerId: 'Alamo|SEAT Leon' }, NOW + 60)

    expect(res.hit).toBe(true)
    expect(res.notify.should).toBe(true)
    // ...and it does not pollute the product-only digest.
    expect(buildRadarDigest(db).count).toBe(0)
  })
})

describe('the radar digest speaks the zero case', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('with nothing unverified it still reports, by name', () => {
    // Acceptance criterion 3. A signal that only appears when something is
    // wrong cannot be told apart from one that stopped running.
    const db = product()
    recordWebObservation(db, { radarId: 'r1', price: 55780, shop: 'ecipo' }, NOW + 60)

    const digest = buildRadarDigest(db)
    expect(digest.count).toBe(0)
    expect(digest.text).toContain('0 tetel')
  })

  it('posts once per day and is gated on its OWN receipt', () => {
    const db = product()
    recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy' }, NOW + 60)

    const first = reportUnverifiedFinds(db, '2026-08-15')
    expect(first.posted).toBe(true)
    expect(first.count).toBe(1)
    expect(radarDigestPostedToday(db, '2026-08-15')).toBe(true)

    const second = reportUnverifiedFinds(db, '2026-08-15')
    expect(second.posted).toBe(false)
    expect(second.alreadyToday).toBe(true)

    // A new day re-fires: the gate is the receipt, not a flag someone must reset.
    expect(radarDigestPostedToday(db, '2026-08-16')).toBe(false)
  })

  it('reports only the LATEST observation per item', () => {
    // A find that was under target on Tuesday and is not today must not be
    // reported forever — the digest answers "what is true now".
    const db = product()
    recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy' }, NOW + 60)
    expect(buildRadarDigest(db).count).toBe(1)

    recordWebObservation(db, { radarId: 'r1', price: 55780, shop: 'Shopsy' }, NOW + 120)
    expect(buildRadarDigest(db).count).toBe(0)
  })
})

describe('the zero case must not claim more than it checked', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('says nothing was found unverified — not that everything was verified', () => {
    // Caught by driving the live store: the first wording was "minden celar
    // alatti talalat szallithatosaga igazolt", which reads as "we checked them
    // and they are fine". On the live data the true reason for the zero was
    // that there were no under-target finds at all. A zero-case sentence that
    // over-claims is the same failure as `best_price IS NULL` read as "price
    // above target".
    const db = product()
    recordWebObservation(db, { radarId: 'r1', price: 55780, shop: 'ecipo', shippableHu: 'YES' }, NOW + 60)

    const text = buildRadarDigest(db).text
    expect(text).toContain('Nincs olyan celar alatti termek-talalat')
    expect(text).not.toContain('Minden celar alatti')
  })

  it('a watched product with NO price at all is reported as unknown, not as quiet', () => {
    // The live state on 2026-08-15: seven products, eMAG returns best_price
    // NULL for every one of them, every tick. "Nothing under target" is true
    // and useless; the digest has to say we are blind, not calm.
    const db = product()
    recordObservation(db, 'r1', { bestPrice: null, offerId: null }, NOW + 60)

    const digest = buildRadarDigest(db)
    expect(digest.count).toBe(0)
    expect(digest.text).toContain('EGYALTALAN NEM adott arat')
    expect(digest.text).toContain('nem azt tudjuk hogy dragak')
  })
})
