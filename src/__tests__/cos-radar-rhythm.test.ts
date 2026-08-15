import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createRadarItem, recordObservation, getRadarItem, radarCreationRefusal } from '../cos/radar.js'
import {
  rhythmFor, STANDING_INTERVAL_SEC, DEADLINE_FAR_INTERVAL_SEC,
  DEADLINE_NEAR_INTERVAL_SEC, DEADLINE_NEAR_WINDOW_SEC,
} from '../cos/radar-rhythm.js'

/**
 * Acceptance criterion 5 of the 2026-08-15 card: every row of the rhythm table
 * has a test, and the model cannot overrule it.
 *
 * Istvan asked the system to decide the cadence. It decides from a named table
 * because a rhythm a model chose cannot be explained a fortnight later and
 * cannot be tested at all.
 */

const NOW = 1_000_000
const DAY = 86400

describe('rhythm table: one test per row', () => {
  it('STANDING — a lasting wish with no date: twice a day', () => {
    const r = rhythmFor('STANDING', null, NOW)
    expect(r.intervalSec).toBe(STANDING_INTERVAL_SEC)
    expect(STANDING_INTERVAL_SEC).toBe(12 * 3600)
    expect(r.close).toBe(false)
  })

  it('DEADLINE far off — weekly', () => {
    const r = rhythmFor('DEADLINE', NOW + 40 * DAY, NOW)
    expect(r.intervalSec).toBe(DEADLINE_FAR_INTERVAL_SEC)
    expect(r.close).toBe(false)
    expect(r.reason).toMatch(/hetente/)
  })

  it('DEADLINE inside the final fortnight — daily', () => {
    const r = rhythmFor('DEADLINE', NOW + 10 * DAY, NOW)
    expect(r.intervalSec).toBe(DEADLINE_NEAR_INTERVAL_SEC)
    expect(r.reason).toMatch(/naponta/)
  })

  it('DEADLINE — the boundary itself is already the near window', () => {
    // 14 days exactly. A boundary left to chance is a boundary nobody knows.
    const r = rhythmFor('DEADLINE', NOW + DEADLINE_NEAR_WINDOW_SEC, NOW)
    expect(r.intervalSec).toBe(DEADLINE_NEAR_INTERVAL_SEC)
  })

  it('DEADLINE reached — CLOSED, because the question is moot', () => {
    const r = rhythmFor('DEADLINE', NOW, NOW)
    expect(r.close).toBe(true)
    expect(r.reason).toMatch(/targytalan/)
  })

  it('ONE_OFF — one run, then CLOSED', () => {
    expect(rhythmFor('ONE_OFF', null, NOW, 0).close).toBe(false)
    const after = rhythmFor('ONE_OFF', null, NOW, 1)
    expect(after.close).toBe(true)
    // The answer is reported either way — including "nothing was cheaper".
    expect(after.reason).toMatch(/nem volt olcsobb/)
  })

  it('every shape names a reason — no silent branch', () => {
    for (const r of [
      rhythmFor('STANDING', null, NOW),
      rhythmFor('DEADLINE', NOW + DAY, NOW),
      rhythmFor('DEADLINE', NOW - DAY, NOW),
      rhythmFor('ONE_OFF', null, NOW, 0),
      rhythmFor('ONE_OFF', null, NOW, 2),
      rhythmFor('DEADLINE', null, NOW), // the contradictory row
    ]) {
      expect(r.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('the rhythm is enforced, not advisory', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const base = {
    kind: 'PRODUCT', label: 'HOFF Banks', targetPrice: 35000,
    query: { terms: 'hoff banks cipo' },
  }

  it('a stated shape OVERRIDES a requested interval — the model cannot pick the cadence', () => {
    // The whole point of criterion 5. If this ever honours the request, a
    // proposal becomes a decision.
    const item = createRadarItem(getDb(), {
      ...base, radarId: 'r1', watchShape: 'STANDING', checkIntervalSec: 60,
    }, NOW)
    expect(item.check_interval_sec).toBe(STANDING_INTERVAL_SEC)
    expect(item.next_check_at).toBe(NOW + STANDING_INTERVAL_SEC)
  })

  it('a DEADLINE watch TIGHTENS by itself as the date approaches', () => {
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'r2', watchShape: 'DEADLINE', expiresAt: NOW + 40 * DAY }, NOW)
    expect(getRadarItem(db, 'r2')!.check_interval_sec).toBe(DEADLINE_FAR_INTERVAL_SEC)

    // ...and an observation taken inside the fortnight re-derives it. A stored
    // number could never do this on its own.
    recordObservation(db, 'r2', { bestPrice: 99999, offerId: 'x' }, NOW + 30 * DAY)
    expect(getRadarItem(db, 'r2')!.check_interval_sec).toBe(DEADLINE_NEAR_INTERVAL_SEC)
  })

  it('a DEADLINE watch CLOSES itself on the day', () => {
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'r3', watchShape: 'DEADLINE', expiresAt: NOW + 10 * DAY }, NOW)
    const res = recordObservation(db, 'r3', { bestPrice: 99999, offerId: 'x' }, NOW + 10 * DAY)
    expect(res.rhythm.close).toBe(true)
    expect(getRadarItem(db, 'r3')!.status).toBe('CLOSED')
  })

  it('a ONE_OFF closes after its single run', () => {
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'r4', watchShape: 'ONE_OFF' }, NOW)
    recordObservation(db, 'r4', { bestPrice: 99999, offerId: 'x' }, NOW + 60)
    expect(getRadarItem(db, 'r4')!.status).toBe('CLOSED')
    expect(getRadarItem(db, 'r4')!.checks_count).toBe(1)
  })

  it('a clock never overrules PAUSED — that is the owner\'s decision', () => {
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'r5', watchShape: 'DEADLINE', expiresAt: NOW + DAY }, NOW)
    db.prepare("UPDATE radar_items SET status='PAUSED' WHERE radar_id='r5'").run()
    recordObservation(db, 'r5', { bestPrice: 99999, offerId: 'x' }, NOW + 2 * DAY)
    expect(getRadarItem(db, 'r5')!.status).toBe('PAUSED')
  })
})

describe('the creation gate knows the shapes', () => {
  it('refuses a DEADLINE with no date — it would never end', () => {
    expect(radarCreationRefusal({
      radarId: 'x', kind: 'PRODUCT', label: 'x', targetPrice: 1,
      query: { terms: 'x' }, watchShape: 'DEADLINE',
    })).toMatch(/hatarido nelkul/)
  })

  it('refuses a date on a shape that has no deadline', () => {
    expect(radarCreationRefusal({
      radarId: 'x', kind: 'PRODUCT', label: 'x', targetPrice: 1,
      query: { terms: 'x' }, watchShape: 'STANDING', expiresAt: NOW + DAY,
    })).toMatch(/csak HATARIDOS/)
  })
})

/**
 * A CLOSED watch gets a sentence — especially the one that found nothing.
 *
 * Acceptance criterion 4, which was NOT met until now and, worse, was CLAIMED
 * met by a string inside the rhythm itself: the ONE_OFF reason read "az
 * eredmeny ... jelentve" while `rhythm` had no consumer anywhere. Delivery
 * hangs off notify.should, and a one-off that finds nothing sets that false —
 * so it closed in silence, which from outside is indistinguishable from a radar
 * that died.
 *
 * RED PROOF: remove the closure lines from buildRadarDigest and exactly the
 * "reported" assertions here go red.
 */
describe('a closed watch is reported, including "nothing was cheaper"', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const base = {
    kind: 'PRODUCT', label: 'Van most olcsobb Garmin?', targetPrice: 120000,
    query: { terms: 'Garmin Forerunner 255' },
  }

  it('a ONE_OFF that found NOTHING still appears in the digest', async () => {
    const { buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'one1', watchShape: 'ONE_OFF' }, NOW)
    // Above target: no hit, notify.should is false, the alert path says nothing.
    recordObservation(db, 'one1', { bestPrice: 149000, offerId: 'x' }, NOW + 60)

    const digest = buildRadarDigest(db)
    expect(digest.closures).toHaveLength(1)
    expect(digest.text).toContain('LEZART FIGYELESEK')
    expect(digest.text).toContain('Van most olcsobb Garmin?')
    expect(digest.text).toContain('NEM volt olcsobb')
  })

  it('a ONE_OFF that DID find something says so', async () => {
    const { buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'one2', watchShape: 'ONE_OFF' }, NOW)
    recordObservation(db, 'one2', { bestPrice: 99000, offerId: 'x', shippableHu: 'YES' }, NOW + 60)

    expect(buildRadarDigest(db).text).toContain('talalt')
  })

  it('a DEADLINE that reached its day is reported too', async () => {
    const { buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'dl1', watchShape: 'DEADLINE', expiresAt: NOW + 10 * DAY }, NOW)
    recordObservation(db, 'dl1', { bestPrice: 149000, offerId: 'x' }, NOW + 10 * DAY)

    const digest = buildRadarDigest(db)
    expect(digest.closures).toHaveLength(1)
    expect(digest.text).toMatch(/targytalan/)
  })

  it('a closure is reported ONCE — the receipt stops the repeat', async () => {
    const { reportUnverifiedFinds, buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'one3', watchShape: 'ONE_OFF' }, NOW)
    recordObservation(db, 'one3', { bestPrice: 149000, offerId: 'x' }, NOW + 60)

    const first = reportUnverifiedFinds(db, '2026-08-15', NOW + 120)
    expect(first.posted).toBe(true)
    expect(first.closures).toBe(1)

    // Next day: the same closure must not be announced again.
    expect(buildRadarDigest(db).closures).toHaveLength(0)
    const second = reportUnverifiedFinds(db, '2026-08-16', NOW + 86_400)
    expect(second.posted).toBe(true)
    expect(second.closures).toBe(0)
  })

  it('an OPEN watch is not reported as closed', async () => {
    // Positive control: a rule that reported everything would pass the tests
    // above while burying Istvan in closures that never happened.
    const { buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, { ...base, radarId: 'st1', watchShape: 'STANDING' }, NOW)
    recordObservation(db, 'st1', { bestPrice: 149000, offerId: 'x' }, NOW + 60)
    expect(buildRadarDigest(db).closures).toHaveLength(0)
  })
})

/**
 * THE ORDER, proven — not asserted in a comment.
 *
 * Found by Claude's mutation pass 2026-08-15: moving markClosuresReported ABOVE
 * the post left all 31 tests green, while the comment right above it said
 * "AFTER the post, never before". The code was correct and nothing held it
 * there. A refactor that swaps two lines — or a try/catch wrapped around the
 * post — would keep the suite green and reintroduce the exact failure the
 * ordering exists to prevent: a watch marked as told, whose single sentence
 * Istvan never receives.
 *
 * This is the same guard the notify path already had
 * (cos-radar-notify-ordering: "a failing alert leaves the item UNMARKED so the
 * next tick re-offers it"). There the lesson was written as a test; here it had
 * only been written as prose.
 */
describe('a closure is marked reported ONLY after the post succeeded', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a FAILING post leaves closure_reported_at NULL, so tomorrow retries', async () => {
    const { reportUnverifiedFinds, buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, {
      radarId: 'ord1', kind: 'PRODUCT', label: 'Van most olcsobb?', targetPrice: 120000,
      query: { terms: 'garmin' }, watchShape: 'ONE_OFF',
    }, NOW)
    recordObservation(db, 'ord1', { bestPrice: 149000, offerId: 'x' }, NOW + 60)
    expect(buildRadarDigest(db).closures).toHaveLength(1)

    const boom = () => { throw new Error('bus unavailable') }
    expect(() => reportUnverifiedFinds(db, '2026-08-15', NOW + 120, boom)).toThrow(/bus unavailable/)

    // The choice this encodes: a repeat is a nuisance, a lost sentence is
    // permanent. So the closure stays UNREPORTED and comes back tomorrow.
    const row = db.prepare('SELECT closure_reported_at FROM radar_items WHERE radar_id=?').get('ord1') as { closure_reported_at: number | null }
    expect(row.closure_reported_at).toBeNull()
    expect(buildRadarDigest(db).closures).toHaveLength(1)
  })

  it('a SUCCEEDING post marks it, so it is not repeated', async () => {
    // Positive control: an ordering that never marks would pass the test above
    // while announcing the same closure every day for ever.
    const { reportUnverifiedFinds, buildRadarDigest } = await import('../cos/radar-digest.js')
    const db = getDb()
    createRadarItem(db, {
      radarId: 'ord2', kind: 'PRODUCT', label: 'Van most olcsobb?', targetPrice: 120000,
      query: { terms: 'garmin' }, watchShape: 'ONE_OFF',
    }, NOW)
    recordObservation(db, 'ord2', { bestPrice: 149000, offerId: 'x' }, NOW + 60)

    const res = reportUnverifiedFinds(db, '2026-08-15', NOW + 120, () => { /* delivered */ })
    expect(res.closures).toBe(1)
    expect(buildRadarDigest(db).closures).toHaveLength(0)
  })
})
