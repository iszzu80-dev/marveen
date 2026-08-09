import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { planAction } from '../cos/executor.js'
import { buildOutboundRecoveryAlert, alertOutboundRecovery } from '../cos/outbound-alert.js'

// A RECOVERY_REQUIRED outbound row (provider claimed success but the marker is
// provably absent) must be surfaced to a human — it is never auto-resent.

const NOW = 1_000_000

function seedRecovery(seq: number, lastError = 'marker absent') {
  const db = getDb()
  const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: seq, payload: {} }, NOW)
  db.prepare(`UPDATE outbound_ledger SET status='RECOVERY_REQUIRED', last_error=? WHERE ledger_id=?`).run(lastError, p.ledgerId)
  return p.ledgerId
}

describe('outbound RECOVERY_REQUIRED alert', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW)
  })

  it('returns null when there is nothing to recover', () => {
    expect(buildOutboundRecoveryAlert(getDb())).toBeNull()
    expect(alertOutboundRecovery(getDb())).toBe(false)
  })

  it('builds an alert naming each stuck row + its error', () => {
    const id = seedRecovery(1, 'provider reported success but marker absent on readback')
    const text = buildOutboundRecoveryAlert(getDb())!
    expect(text).toContain('RECOVERY_REQUIRED (1)')
    expect(text).toContain(id)
    expect(text).toContain('marker absent on readback')
  })

  it('alertOutboundRecovery posts to the bus + daily log and returns true', () => {
    seedRecovery(1)
    const posted = alertOutboundRecovery(getDb())
    expect(posted).toBe(true)
    // it reached the inter-agent bus (marveen relays it to Telegram)
    const msg = getDb().prepare(`SELECT content FROM agent_messages WHERE from_agent='cos-outbound' ORDER BY id DESC LIMIT 1`).get() as any
    expect(msg?.content).toContain('RECOVERY_REQUIRED')
  })
})
