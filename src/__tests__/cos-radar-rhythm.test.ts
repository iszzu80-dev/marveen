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
