import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem, recordObservation, markNotified } from '../cos/radar.js'
import { listAnalytics } from '../web/routes/cos.js'

// #5d analytics: aggregate roll-ups over cases / radar / campaigns / outbound.

const NOW = 1_000_000

describe('COS analytics (listAnalytics)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('empty store → zeroed aggregates, no throw', () => {
    const a = listAnalytics(getDb())
    expect(a.cases.total).toBe(0)
    expect(a.radar.total).toBe(0)
    expect(a.campaigns.total).toBe(0)
    expect(a.outbound.total).toBe(0)
    expect(a.cases.byStatus).toEqual({})
  })

  it('rolls up cases by status + sensitivity, radar hits/observations/notifications', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'A', caseType: 'TRAVEL', sensitivity: 'PERSONAL' }, NOW)
    createCase(db, { caseId: 'c2', title: 'B', caseType: 'ADMIN', sensitivity: 'HIGHLY_SENSITIVE' }, NOW)
    // radar with an observation that hits + a notification
    createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'x', targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW)
    const o = recordObservation(db, 'r1', { bestPrice: 84000, offerId: 'a' }, NOW + 10)
    markNotified(db, 'r1', { offerId: o.offerId, price: o.bestPrice, reason: o.notify.reason }, NOW + 10)

    const a = listAnalytics(db)
    expect(a.cases.total).toBe(2)
    expect(a.cases.byStatus.NEW).toBe(2)
    expect(a.cases.bySensitivity.PERSONAL).toBe(1)
    expect(a.cases.bySensitivity.HIGHLY_SENSITIVE).toBe(1)
    expect(a.radar.total).toBe(1)
    expect(a.radar.hits).toBe(1)           // it met the target
    expect(a.radar.observations).toBe(1)
    expect(a.radar.notifications).toBe(1)  // markNotified stamped last_notified_at
    expect(a.radar.byStatus.HIT).toBe(1)
  })
})
