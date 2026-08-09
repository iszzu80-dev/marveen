import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createRadarItem, recordObservation } from '../cos/radar.js'
import { buildRadarHitAlert, alertRadarHit } from '../cos/radar-alert.js'

// COS radar HIT alert. Proves the alert text is built from the item + latest
// observation, and that a HIT posts a bus message to marveen (→ Telegram relay)
// plus a daily-log entry.

const NOW = 1_000_000

function seedHit() {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'Valencia→Malaga', targetPrice: 85000, currency: 'HUF', checkIntervalSec: 3600 }, NOW)
  recordObservation(db, 'r1', { bestPrice: 84000, offerRef: { car: 'Hyundai i30', category: 'Compact', supplier: 'Centauro' } }, NOW + 3600)
  return db
}

describe('COS radar HIT alert', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('builds an alert with label, best price, target, and the deal', () => {
    const db = seedHit()
    const text = buildRadarHitAlert(db, 'r1')!
    expect(text).toContain('Valencia→Malaga')
    expect(text).toContain('84,000')
    expect(text).toContain('85,000')
    expect(text).toContain('Hyundai i30')
    expect(text).toContain('Centauro')
  })

  it('returns null for a missing radar item', () => {
    initDatabase(':memory:')
    expect(buildRadarHitAlert(getDb(), 'nope')).toBeNull()
  })

  it('alertRadarHit posts a bus message to marveen and a daily-log entry', () => {
    const db = seedHit()
    alertRadarHit(db, 'r1')
    const msg = db.prepare(`SELECT from_agent, to_agent, content FROM agent_messages ORDER BY id DESC LIMIT 1`).get() as any
    expect(msg).toMatchObject({ from_agent: 'cos-radar', to_agent: 'marveen' })
    expect(msg.content).toContain('COS radar HIT')
    const log = db.prepare(`SELECT content FROM daily_logs ORDER BY id DESC LIMIT 1`).get() as any
    expect(log.content).toContain('COS RADAR HIT')
  })
})
