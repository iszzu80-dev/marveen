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

// Routing a hit to the owner's OWN channel (Istvan's open question, 2026-08-11).
//
// The bot is only an address; the work is the queue. `alertRadarHit` is
// synchronous — it runs inside the radar tick — so it may not await a Telegram
// call, and a hit lost to a transient network error would be lost for good.
// It enqueues; the channel step delivers with retry.
describe('radar HIT on the owner channel', () => {
  // Now a ROUTE LOOKUP, not a config load: the producer asks which channel
  // carries radar and gets whichever bot declares it. Istvan chose a third bot
  // (2026-08-11) — the producer does not know which one answers.
  const cfg = (routes: string[], channelId = 'telegram:radar') => () =>
    routes.includes('radar') ? { token: 'x', channelId, chatId: '1', routes } : null

  beforeEach(() => { initDatabase(':memory:') })

  it('queues the hit when the channel carries radar', () => {
    const db = seedHit()
    alertRadarHit(db, 'r1', { loadConfig: cfg(['radar']) })
    const row = db.prepare(
      `SELECT channel, kind, dedupe_key, text, sent_at FROM cos_channel_outbox`,
    ).get() as { channel: string; kind: string; dedupe_key: string; text: string; sent_at: number | null }
    expect(row.channel).toBe('telegram:radar')
    expect(row.kind).toBe('radar')
    // Keyed on the OBSERVATION, so a second tick over the same price is not
    // announced twice, while a genuine new drop is.
    expect(row.dedupe_key).toBe(`radar:r1:${NOW + 3600}`)
    expect(row.text).toContain('COS radar HIT')
    expect(row.sent_at).toBeNull()
  })

  it('does NOT queue when the channel does not carry radar', () => {
    // The default. Turning a channel on is a decision; a default must not make
    // it silently.
    const db = seedHit()
    alertRadarHit(db, 'r1', { loadConfig: cfg([]) })
    expect((db.prepare(`SELECT count(*) AS n FROM cos_channel_outbox`).get() as { n: number }).n).toBe(0)
  })

  it('with no bot configured it still posts to the bus and does not throw', () => {
    const db = seedHit()
    expect(() => alertRadarHit(db, 'r1', { loadConfig: () => null })).not.toThrow()
    expect((db.prepare(`SELECT count(*) AS n FROM cos_channel_outbox`).get() as { n: number }).n).toBe(0)
    const msg = db.prepare(`SELECT content FROM agent_messages ORDER BY id DESC LIMIT 1`).get() as { content: string }
    expect(msg.content).toContain('COS radar HIT')
  })

  it('the bus post is ADDED to, not replaced', () => {
    // The bus is what reaches Marveen and the daily log is the record. A second
    // route must not quietly remove the first.
    const db = seedHit()
    alertRadarHit(db, 'r1', { loadConfig: cfg(['radar']) })
    expect((db.prepare(`SELECT count(*) AS n FROM agent_messages`).get() as { n: number }).n).toBe(1)
    expect((db.prepare(`SELECT count(*) AS n FROM daily_logs`).get() as { n: number }).n).toBe(1)
    expect((db.prepare(`SELECT count(*) AS n FROM cos_channel_outbox`).get() as { n: number }).n).toBe(1)
  })
})
