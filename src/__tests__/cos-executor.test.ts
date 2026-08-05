import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  planAction, executeAction, recoverAction, idempotencyKey,
  type OutboundAdapter, type OutboundAction,
} from '../cos/executor.js'

// COS Action Executor. These tests PROVE the crash-safety invariants, not just
// the happy path: SENDING is durable before the call, a prior attempt is never
// blind-resent, recovery reads back the marker, and DB UNIQUE blocks a duplicate
// plan. The headline test is "provider got it but we errored → no double-send".

// Mock adapter. `provider` = the set of idempotency keys the outside world has
// actually received. Configurable to model each failure mode.
class MockAdapter implements OutboundAdapter {
  readonly actionType = 'EMAIL_SEND'
  sendCalls = 0
  provider = new Set<string>()
  mode: 'ok' | 'throw' | 'reach-then-throw' | 'ok-but-vanish' = 'ok'
  async send(a: OutboundAction): Promise<{ externalRef: string }> {
    this.sendCalls++
    if (this.mode === 'throw') throw new Error('network down')
    if (this.mode === 'reach-then-throw') { this.provider.add(a.internalIdempotencyKey); throw new Error('timeout after send') }
    if (this.mode === 'ok') this.provider.add(a.internalIdempotencyKey)
    // 'ok-but-vanish': returns success but the provider never actually has it
    return { externalRef: 'ext-' + a.sequenceNumber }
  }
  async readback(key: string): Promise<{ found: boolean; externalRef?: string }> {
    return this.provider.has(key) ? { found: true, externalRef: 'ext-rb' } : { found: false }
  }
}

const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' } }

describe('COS Action Executor', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // An outbound action belongs to a real case (case_id FK).
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('happy path: PLANNED → VERIFIED, send called exactly once', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    expect(p.status).toBe('PLANNED')
    const r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(r.externalRef).toBeTruthy()
    expect(ad.sendCalls).toBe(1)
  })

  it('deterministic idempotency: a duplicate plan trips the UNIQUE constraint', () => {
    const db = getDb()
    planAction(db, PLAN, 1000)
    expect(() => planAction(db, PLAN, 1000)).toThrow(/UNIQUE/i)
    expect(idempotencyKey('c1', 'EMAIL_SEND', 1)).toBe('mv-c1-EMAIL_SEND-1')
  })

  it('HEADLINE: provider received it but we errored → recovery VERIFIES without a second send', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'reach-then-throw' // the message lands, then we get a timeout
    const after = await executeAction(db, ad, p.ledgerId, 1001)
    expect(after.status).toBe('OUTCOME_UNKNOWN')
    expect(ad.sendCalls).toBe(1)
    // Re-run (e.g. a retry/restart): recovery reads back the marker → VERIFIED,
    // and send is NOT called again.
    const rec = await executeAction(db, ad, p.ledgerId, 1002)
    expect(rec.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1) // <-- no double-send
  })

  it('crash after SENDING was persisted (before the call returned): recover, no double-send', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    // Simulate the crash window: SENDING is durable, and the provider already
    // has the message (the send had reached it before we died).
    db.prepare(`UPDATE outbound_ledger SET status='SENDING' WHERE ledger_id=?`).run(p.ledgerId)
    ad.provider.add(p.internalIdempotencyKey)
    const r = await executeAction(db, ad, p.ledgerId, 2000) // sees SENDING → recover
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(0) // never re-sent
  })

  it('genuine failure (never reached provider) → OUTCOME_UNKNOWN → recovery to PLANNED → safe resend', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'throw'
    let r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    // recover: readback absent → PLANNED (safe to resend)
    r = await recoverAction(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('PLANNED')
    // now the network is back → resend succeeds
    ad.mode = 'ok'
    r = await executeAction(db, ad, p.ledgerId, 1003)
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(2) // first failed, second sent — exactly one real delivery
  })

  it('P0.4 quota: a full window blocks the send (stays PLANNED, not sent) and frees next window', async () => {
    const db = getDb(), ad = new MockAdapter()
    const q = { key: 'EMAIL_SEND:test', maxCount: 1, windowSec: 3600 }
    const p1 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: {} }, 1000)
    const p2 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: {} }, 1000)
    // first consumes the only slot → sent
    expect((await executeAction(db, ad, p1.ledgerId, 1001, { quota: q })).status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1)
    // second is over quota → NOT sent, stays PLANNED
    const r2 = await executeAction(db, ad, p2.ledgerId, 1002, { quota: q })
    expect(r2.status).toBe('PLANNED')
    expect(ad.sendCalls).toBe(1) // <-- send NOT called for the blocked action
    // once the window rolls over, it goes through
    const r3 = await executeAction(db, ad, p2.ledgerId, 1002 + 3601, { quota: q })
    expect(r3.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(2)
  })

  it('APPLIED but readback cannot find it → OUTCOME_UNKNOWN, not a false VERIFIED', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'ok-but-vanish' // send "succeeds" but provider never really has it
    const r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN') // we refuse to claim VERIFIED without proof
  })

  it('terminal states are idempotent no-ops (VERIFIED never re-sends)', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    await executeAction(db, ad, p.ledgerId, 1001) // → VERIFIED, sendCalls 1
    const again = await executeAction(db, ad, p.ledgerId, 1002)
    expect(again.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1)
  })
})
