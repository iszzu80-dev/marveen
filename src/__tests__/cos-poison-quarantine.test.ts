import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, markRecoveryRequired, isBatchTerminal } from '../cos/email-ingest.js'
import {
  quarantinePoison, quarantineBatchPoison, poisonCandidates,
  POISON_ATTEMPT_THRESHOLD, type QuarantineDeps,
} from '../cos/poison-quarantine.js'

// Poison quarantine (A.1).
//
// The rule is not "a stuck message may be skipped". It is "a stuck message may
// be skipped only when five things guarantee somebody finds out". So almost
// every test here is about REFUSING to quarantine — because the failure mode
// that matters is not a jammed cursor, which is visible, but a cursor that
// walks over unprocessed mail, which is not.

const NOW = 1_800_000_000
const ACC = 'private'

function deps(over: Partial<QuarantineDeps> = {}): QuarantineDeps {
  return {
    raiseAlert: () => true,
    createReviewTask: () => true,
    policyAllowsCursorAdvance: () => true,
    ...over,
  }
}

function seedPoison(attempts = POISON_ATTEMPT_THRESHOLD) {
  initDatabase(':memory:')
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 1000)
  openBatch(db, {
    batchId: 'b1', accountId: ACC, cursorBefore: '1', cursorAfter: '2',
    messages: [{ messageId: 'poison' }, { messageId: 'fine' }],
  }, NOW - 900)
  for (let i = 0; i < attempts; i++) markRecoveryRequired(db, ACC, 'poison', 'sérült melléklet', NOW - 800 + i)
  return db
}

const statusOf = (m: string) => (getDb().prepare(
  `SELECT status, quarantine_reason FROM email_processing WHERE message_id=?`).get(m)) as
  { status: string; quarantine_reason: string | null }

describe('poison quarantine (A.1)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('finds a message that has failed the threshold number of times', () => {
    const db = seedPoison()
    const c = poisonCandidates(db, 'b1')
    expect(c.map((x) => x.message_id)).toEqual(['poison'])
  })

  it('does NOT consider a message poison before the threshold', () => {
    const db = seedPoison(POISON_ATTEMPT_THRESHOLD - 1)
    expect(poisonCandidates(db, 'b1')).toHaveLength(0)
  })

  it('quarantines when all five conditions hold, and records why on the row', () => {
    const db = seedPoison()
    const r = quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps(), NOW)
    expect(r.quarantined).toBe(true)
    const row = statusOf('poison')
    expect(row.status).toBe('QUARANTINED')
    expect(row.quarantine_reason).toMatch(/sérült melléklet/)
    expect(row.quarantine_reason).toMatch(/kísérlet: \d/)   // audited: how many tries
  })

  describe('each missing condition blocks it on its own', () => {
    it('no alert → refused', () => {
      const db = seedPoison()
      const r = quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps({ raiseAlert: () => false }), NOW)
      expect(r.quarantined).toBe(false)
      expect(r.missing).toContain('alertRaised')
      expect(statusOf('poison').status).not.toBe('QUARANTINED')
    })

    it('no review task → refused', () => {
      const db = seedPoison()
      const r = quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps({ createReviewTask: () => false }), NOW)
      expect(r.missing).toContain('reviewTaskCreated')
    })

    it('no policy → refused, and the batch stays non-terminal', () => {
      const db = seedPoison()
      const r = quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps({ policyAllowsCursorAdvance: () => false }), NOW)
      expect(r.missing).toContain('policyAllowsCursorAdvance')
      expect(isBatchTerminal(db, 'b1')).toBe(false)   // the cursor cannot pass
    })

    it('no usable reason → refused, because an unaudited skip is the dangerous one', () => {
      const db = seedPoison()
      const r = quarantinePoison(db, ACC, 'poison', 'x', deps(), NOW)
      expect(r.missing).toContain('audited')
    })

    it('an unknown message is refused by name, not silently ignored', () => {
      const db = seedPoison()
      const r = quarantinePoison(db, ACC, 'nincs-ilyen', 'valami ok', deps(), NOW)
      expect(r.quarantined).toBe(false)
      expect(r.reason).toContain('nincs-ilyen')
    })
  })

  // P8 (review 2026-08-13). raiseAlert and createReviewTask ran BEFORE the full
  // condition set was evaluated. An attempt that then failed on a later
  // condition had already created the `qtn-<mid>` kanban card, so the NEXT sweep
  // hit the primary-key conflict inside createReviewTask, its catch returned
  // false, and the condition read "review task NOT created" — the message could
  // never be quarantined again, the batch was pinned forever, and every sweep
  // inserted one more duplicate CRITICAL alert row.
  describe('a precondition failure costs nothing', () => {
    it('does not alert or create a review task when the policy forbids the advance', () => {
      const db = seedPoison()
      const alerts: string[] = [], tasks: string[] = []
      const r = quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps({
        policyAllowsCursorAdvance: () => false,
        raiseAlert: (_a, m) => { alerts.push(m); return true },
        createReviewTask: (_a, m) => { tasks.push(m); return true },
      }), NOW)
      expect(r.quarantined).toBe(false)
      expect(alerts, 'no duplicate CRITICAL alert per sweep').toEqual([])
      expect(tasks, 'no orphan qtn- card that the next retry then collides with').toEqual([])
    })

    it('does not alert when the reason is unusable (unaudited)', () => {
      const db = seedPoison()
      const tasks: string[] = []
      quarantinePoison(db, ACC, 'poison', 'x', deps({ createReviewTask: (_a, m) => { tasks.push(m); return true } }), NOW)
      expect(tasks).toEqual([])
    })

    it('a later retry with the policy granted still succeeds — the jam is not permanent', () => {
      const db = seedPoison()
      // sweep 1: refused on policy, nothing written anywhere
      let allow = false
      const d = deps({ policyAllowsCursorAdvance: () => allow })
      expect(quarantinePoison(db, ACC, 'poison', 'sérült melléklet', d, NOW).quarantined).toBe(false)
      // sweep 2: the owner grants the policy
      allow = true
      expect(quarantinePoison(db, ACC, 'poison', 'sérült melléklet', d, NOW + 60).quarantined).toBe(true)
      expect(statusOf('poison').status).toBe('QUARANTINED')
    })
  })

  it('a refusal keeps the cursor stuck — the visible failure, on purpose', () => {
    const db = seedPoison()
    quarantinePoison(db, ACC, 'poison', 'sérült melléklet', deps({ raiseAlert: () => false }), NOW)
    expect(isBatchTerminal(db, 'b1')).toBe(false)
  })

  it('the batch sweep reports what it could not quarantine, rather than passing quietly', () => {
    const db = seedPoison()
    const r = quarantineBatchPoison(db, 'b1', deps({ policyAllowsCursorAdvance: () => false }), NOW)
    expect(r.examined).toBe(1)
    expect(r.quarantined).toBe(0)
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].missing).toContain('policyAllowsCursorAdvance')
  })

  it('with the conditions met the sweep clears the jam so the batch can finish', () => {
    const db = seedPoison()
    // the other message is already terminal
    db.prepare(`UPDATE email_processing SET status='EXCLUDED' WHERE message_id='fine'`).run()
    expect(isBatchTerminal(db, 'b1')).toBe(false)
    const r = quarantineBatchPoison(db, 'b1', deps(), NOW)
    expect(r.quarantined).toBe(1)
    expect(isBatchTerminal(db, 'b1')).toBe(true)
  })
})
