import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  createRadarItem, getRadarItem, dueRadarChecks, recordObservation, setRadarStatus,
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
    const r = createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW)
    expect(r.status).toBe('ACTIVE')
    expect(r.next_check_at).toBe(NOW + 3600)
  })

  it('dueRadarChecks returns only ACTIVE items whose check time has arrived', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'due', kind: 'RENTAL', label: 'a', checkIntervalSec: 100 }, NOW - 200) // next = NOW-100 → due
    createRadarItem(db, { radarId: 'future', kind: 'RENTAL', label: 'b', checkIntervalSec: 100000 }, NOW)  // next far off
    createRadarItem(db, { radarId: 'paused', kind: 'RENTAL', label: 'c', checkIntervalSec: 100 }, NOW - 200)
    setRadarStatus(db, 'paused', 'PAUSED', NOW)
    expect(dueRadarChecks(db, NOW).map((x) => x.radar_id)).toEqual(['due'])
  })

  it('records observations, tracks the new low, and does NOT hit above target', () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 80000, currency: 'HUF', checkIntervalSec: 3600 }, NOW)
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
    createRadarItem(db, { radarId: 'r1', kind: 'RENTAL', label: 'x', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600 }, NOW)
    const o = recordObservation(db, 'r1', { bestPrice: 84000, offerRef: { car: 'Hyundai i30', supplier: 'Centauro' } }, NOW + 3600)
    expect(o.hit).toBe(true)
    expect(o.status).toBe('HIT')
    expect(getRadarItem(db, 'r1')!.status).toBe('HIT')
  })
})
