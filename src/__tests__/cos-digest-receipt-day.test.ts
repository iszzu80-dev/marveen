import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem } from '../cos/radar.js'
import { recordWebObservation } from '../cos/radar-web.js'
import { reportUnverifiedFinds, radarDigestPostedToday } from '../cos/radar-digest.js'
import { reportPlannedOutbound, plannedDigestPostedToday } from '../cos/outbound-alert.js'

/**
 * BOTH once-per-day digests decide on a calendar day and then write a receipt.
 * Until 2026-08-16 the deciding end took the day it was given and the writing
 * end took its own from the process clock, so the receipt could be stamped on a
 * different day than the decision that produced it.
 *
 * In production the two agreed by coincidence, because the override IS the
 * current day -- except across midnight. A digest posted at 23:59:59 got a
 * receipt dated the next day; the next day's run then read its predecessor's
 * receipt, concluded "already posted", and said nothing. One whole day of the
 * digest gone, with nothing anywhere reporting the loss -- the exact failure
 * these receipts exist to prevent.
 *
 * HOW THIS TEST DIFFERS FROM THE TWO THAT CAUGHT IT: cos-radar-deliverability
 * and cos-radar-rhythm pin the literal dates 2026-08-15/16, so they went red
 * only once the real clock passed midnight into 08-16 -- they were green for
 * the whole life of the bug and would be green again tomorrow. This one uses a
 * day the process clock can never be, so it is red on EVERY day the two ends
 * disagree.
 */

const NOW = 1_000_000
// Deliberately a day the machine clock cannot be sitting on. If the write side
// ever goes back to reading the clock, the receipt lands somewhere else and
// these assertions fail -- today, tomorrow, and in five years.
const DAY = '2020-01-01'
const NEXT_DAY = '2020-01-02'

function receiptDates(): string[] {
  return (getDb().prepare(
    `SELECT date FROM daily_logs WHERE agent_id='marveen' ORDER BY id`
  ).all() as { date: string }[]).map(r => r.date)
}

describe('a digest receipt is stamped with the day the digest DECIDED on', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('radar: the receipt lands on the decided day, not on the process clock', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Cipő', caseType: 'SHOPPING' }, NOW)
    createRadarItem(db, {
      radarId: 'r1', caseId: 'c1', kind: 'PRODUCT', label: 'teszt',
      targetPrice: 35000, currency: 'HUF', checkIntervalSec: 86400,
      query: { terms: 'teszt keresokifejezes' } }, NOW)
    recordWebObservation(db, { radarId: 'r1', price: 27990, shop: 'Shopsy' }, NOW + 60)

    expect(reportUnverifiedFinds(db, DAY).posted).toBe(true)

    // The receipt is READ by day, so it must be WRITTEN by the same day.
    expect(receiptDates()).toEqual([DAY])
    expect(radarDigestPostedToday(db, DAY)).toBe(true)

    // ...and the gate it feeds now actually holds shut on that day.
    expect(reportUnverifiedFinds(db, DAY).posted).toBe(false)

    // POSITIVE CONTROL. A gate that read no receipt at all would satisfy every
    // line above by never firing twice for a different reason; the next day
    // must still be open, or the fix has traded a lost day for a lost feature.
    expect(radarDigestPostedToday(db, NEXT_DAY)).toBe(false)
    expect(reportUnverifiedFinds(db, NEXT_DAY).posted).toBe(true)
    expect(receiptDates()).toEqual([DAY, NEXT_DAY])
  })

  it('PLANNED: the same seam, the same day', () => {
    const db = getDb()

    expect(reportPlannedOutbound(db, NOW, DAY).posted).toBe(true)
    expect(receiptDates()).toEqual([DAY])
    expect(plannedDigestPostedToday(db, DAY)).toBe(true)
    expect(reportPlannedOutbound(db, NOW, DAY).posted).toBe(false)

    // Positive control, as above.
    expect(plannedDigestPostedToday(db, NEXT_DAY)).toBe(false)
    expect(reportPlannedOutbound(db, NOW, NEXT_DAY).posted).toBe(true)
    expect(receiptDates()).toEqual([DAY, NEXT_DAY])
  })

  it('with NO day given both digests still fall back to the Budapest day', () => {
    // The override is a seam for the caller and for tests -- it must not have
    // become the only way the day gets set. Without it the receipt still has to
    // land on a real calendar day that the gate then reads back.
    const db = getDb()
    expect(reportPlannedOutbound(db, NOW).posted).toBe(true)
    const [stamped] = receiptDates()
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(plannedDigestPostedToday(db)).toBe(true)
    expect(reportPlannedOutbound(db, NOW).posted).toBe(false)
  })
})
