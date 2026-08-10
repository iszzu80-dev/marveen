import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  planAction, executeAction, recoverAction, verifyAction, cancelAction,
  idempotencyKey, SendError,
  type OutboundAdapter, type OutboundAction, type ReadbackResult,
} from '../cos/executor.js'

// COS Action Executor. These tests PROVE the crash-safety invariants, not just
// the happy path: SENDING is durable before the call, a prior attempt is never
// blind-resent, recovery reads back the marker, and DB UNIQUE blocks a duplicate
// plan. The headline test is "provider got it but we errored → no double-send".
// The P1.1 refinement adds: APPLIED_UNVERIFIED when the provider accepted but
// readback is unavailable (NEVER resent), RECOVERY_REQUIRED when the provider
// claimed success but the marker is provably absent, FAILED_RETRYABLE/TERMINAL
// when a send provably never reached the provider, and CANCELLED for a
// deliberate abort of a not-yet-sent row.

// Mock adapter. `provider` = the set of idempotency markers the outside world has
// actually received. Configurable to model each failure mode.
class MockAdapter implements OutboundAdapter {
  readonly actionType = 'EMAIL_SEND'
  sendCalls = 0
  provider = new Set<string>()
  mode: 'ok' | 'throw' | 'reach-then-throw' | 'ok-but-vanish' | 'fail-retryable' | 'fail-terminal' = 'ok'
  readbackMode: 'normal' | 'unavailable' | 'throw' = 'normal'
  async send(a: OutboundAction): Promise<{ externalRef: string }> {
    this.sendCalls++
    const marker = a.externalIdempotencyMarker
    if (this.mode === 'throw') throw new Error('network down')
    if (this.mode === 'fail-retryable') throw new SendError('connection refused before request', { reachedProvider: false, terminal: false })
    if (this.mode === 'fail-terminal') throw new SendError('recipient rejected', { reachedProvider: false, terminal: true })
    if (this.mode === 'reach-then-throw') { this.provider.add(marker); throw new Error('timeout after send') }
    if (this.mode === 'ok') this.provider.add(marker)
    // 'ok-but-vanish': returns success but the provider never actually has it
    return { externalRef: 'ext-' + a.sequenceNumber }
  }
  async readback(marker: string): Promise<ReadbackResult> {
    if (this.readbackMode === 'throw') throw new Error('sent search unreachable')
    if (this.readbackMode === 'unavailable') return { found: false, available: false }
    return this.provider.has(marker) ? { found: true, externalRef: 'ext-rb' } : { found: false }
  }
}

const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' } }

// F-7: executeAction now refuses to leave PLANNED unless the caller declares
// that it evaluated the dispatch gate (§7.3). Production declares it in
// dispatchApprovedSend / dispatchZstSend, after the gate has actually run. This
// file tests the STATE MACHINE, not the policy, so it declares it once here
// rather than repeating the flag on every call. Recovery paths do not need it,
// and passing it changes nothing for them.
const exec: typeof executeAction = (db, adapter, ledgerId, now, opts = {}) =>
  executeAction(db, adapter, ledgerId, now, { authorizedByDispatchGate: true, ...opts })

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
    expect(p.externalIdempotencyMarker).toBe(p.internalIdempotencyKey) // D.1 default
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(r.externalRef).toBeTruthy()
    expect(ad.sendCalls).toBe(1)
  })

  // CHANGED 2026-08-10 (F-1). The last line asserted the LITERAL old key,
  // `mv-c1-EMAIL_SEND-1` — a key that binds neither the recipient nor the
  // content, which is the defect §7.1 names. Asserting a literal digest instead
  // would just re-freeze whatever the code happens to produce, so the
  // assertions are now about the PROPERTIES the key must have.
  it('deterministic idempotency: a duplicate plan trips the UNIQUE constraint', () => {
    const db = getDb()
    planAction(db, PLAN, 1000)
    expect(() => planAction(db, PLAN, 1000)).toThrow(/UNIQUE/i)
    // deterministic: same inputs, same key
    expect(idempotencyKey({ caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1 }))
      .toBe(idempotencyKey({ caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1 }))
  })

  it('F-1: the key separates two sends that the old key called identical', () => {
    // Same case, same action type, same sequence number — different person,
    // different words. The old formula produced ONE key for all of these.
    const base = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1 }
    const a = idempotencyKey({ ...base, campaignId: 'camp-1', recipient: 'a@x.com', renderedPayloadHash: 'h1' })
    const differentRecipient = idempotencyKey({ ...base, campaignId: 'camp-1', recipient: 'b@x.com', renderedPayloadHash: 'h1' })
    const differentPayload = idempotencyKey({ ...base, campaignId: 'camp-1', recipient: 'a@x.com', renderedPayloadHash: 'h2' })
    const differentCampaign = idempotencyKey({ ...base, campaignId: 'camp-2', recipient: 'a@x.com', renderedPayloadHash: 'h1' })
    expect(new Set([a, differentRecipient, differentPayload, differentCampaign]).size).toBe(4)
    // and the same tuple is still stable — idempotency has to survive a retry
    expect(idempotencyKey({ ...base, campaignId: 'camp-1', recipient: 'a@x.com', renderedPayloadHash: 'h1' })).toBe(a)
  })

  // MEASURED, not assumed: replanning the same case+type+seq with an edited
  // payload cannot happen at all — UNIQUE(case_id, action_type, sequence_number)
  // refuses it before the key is consulted. So the old key's weakness was one of
  // FORM, not a live collision inside a single store. Where the form matters is
  // the EXTERNAL MARKER: it is embedded in the outgoing message and readback
  // finds a message by searching for it, so a marker that does not bind the
  // recipient or the content identifies a message only as strongly as the tuple
  // it does bind.
  it('F-1: the external marker embedded in the message binds the payload', () => {
    const db = getDb()
    createCase(db, { caseId: 'c2', title: 'T2', caseType: 'X' }, 900) // outbound_ledger.case_id is a foreign key
    const p1 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 7, payload: { to: 'a@x.com', subject: 'first' } }, 1000)
    const p2 = planAction(db, { caseId: 'c2', actionType: 'EMAIL_SEND', sequenceNumber: 7, payload: { to: 'a@x.com', subject: 'EDITED' } }, 1000)
    expect(p2.externalIdempotencyMarker).not.toBe(p1.externalIdempotencyMarker)
    // and the marker is a stable function of the inputs, not a counter
    expect(p1.externalIdempotencyMarker).toBe(p1.internalIdempotencyKey)
  })

  it('F-1: replanning an edited payload on the same case+type+seq is refused by the schema', () => {
    // Stated as its own test so the protection is attributed to the constraint
    // that actually provides it, rather than being credited to the new key.
    const db = getDb()
    planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 7, payload: { to: 'a@x.com', subject: 'first' } }, 1000)
    expect(() => planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 7, payload: { to: 'a@x.com', subject: 'EDITED' } }, 1000))
      .toThrow(/UNIQUE/i)
  })

  it('HEADLINE: provider received it but we errored → recovery VERIFIES without a second send', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'reach-then-throw' // the message lands, then we get a timeout
    const after = await exec(db, ad, p.ledgerId, 1001)
    expect(after.status).toBe('OUTCOME_UNKNOWN')
    expect(ad.sendCalls).toBe(1)
    // Re-run (e.g. a retry/restart): recovery reads back the marker → VERIFIED,
    // and send is NOT called again.
    const rec = await exec(db, ad, p.ledgerId, 1002)
    expect(rec.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1) // <-- no double-send
  })

  it('crash after SENDING was persisted (before the call returned): recover, no double-send', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    // Simulate the crash window: SENDING is durable, and the provider already
    // has the message (the send had reached it before we died).
    db.prepare(`UPDATE outbound_ledger SET status='SENDING' WHERE ledger_id=?`).run(p.ledgerId)
    ad.provider.add(p.externalIdempotencyMarker)
    const r = await exec(db, ad, p.ledgerId, 2000) // sees SENDING → recover
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(0) // never re-sent
  })

  it('unknown-outcome failure → OUTCOME_UNKNOWN → recovery to PLANNED → safe resend', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'throw' // a plain throw: we cannot PROVE it did not reach the provider
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    // recover: readback absent → PLANNED (safe to resend)
    r = await recoverAction(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('PLANNED')
    // now the network is back → resend succeeds
    ad.mode = 'ok'
    r = await exec(db, ad, p.ledgerId, 1003)
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(2) // first failed, second sent — exactly one real delivery
  })

  it('P1.1 send provably never reached provider → FAILED_RETRYABLE → retry → VERIFIED', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'fail-retryable' // adapter PROVES the request never left
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_RETRYABLE')
    // CHANGED 2026-08-10 (F-15): the retry used to run at 1001+1. There is a
    // backoff now, so an immediate retry is a no-op — which is the point:
    // without it every tick retried instantly and "5 attempts" would be spent
    // inside a minute. Asserted explicitly rather than just skipping ahead.
    ad.mode = 'ok'
    const tooSoon = await exec(db, ad, p.ledgerId, 1002)
    expect(tooSoon.status).toBe('FAILED_RETRYABLE')
    expect(ad.sendCalls).toBe(1) // nothing was attempted
    // FAILED_RETRYABLE is re-sendable (proven not sent, so no double-send risk)
    r = await exec(db, ad, p.ledgerId, 1001 + 60)
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(2)
  })

  it('P1.1 send provably rejected (terminal) → FAILED_TERMINAL, a terminal no-op', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'fail-terminal'
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_TERMINAL')
    // terminal: re-running executeAction does nothing, never sends
    r = await exec(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('FAILED_TERMINAL')
    expect(ad.sendCalls).toBe(1)
  })

  it('P1.1 provider accepted but readback UNAVAILABLE → APPLIED_UNVERIFIED (never resent), later verifies', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.readbackMode = 'unavailable' // send succeeds, but we can't confirm via Sent
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
    expect(ad.sendCalls).toBe(1)
    // The daily reconcile drives it again; a resend is FORBIDDEN from
    // APPLIED_UNVERIFIED — it only re-attempts readback.
    r = await exec(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
    expect(ad.sendCalls).toBe(1) // <-- never resent
    // Once readback works and finds the marker → VERIFIED.
    ad.readbackMode = 'normal'
    r = await exec(db, ad, p.ledgerId, 1003)
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1) // still exactly one delivery
  })

  it('P1.1 a thrown readback is treated as unavailable, not absent (no resend)', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.readbackMode = 'throw'
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED') // provider accepted; readback threw → unavailable
    expect(ad.sendCalls).toBe(1)
  })

  it('P1.1 provider claimed success but marker PROVABLY absent → RECOVERY_REQUIRED (human, never resent)', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'ok-but-vanish' // send "succeeds" but provider never really has it, readback available
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('RECOVERY_REQUIRED') // we refuse to resend on a claimed success
    // RECOVERY_REQUIRED is not auto-resent: re-running does not send again.
    const again = await exec(db, ad, p.ledgerId, 1002)
    expect(again.status).toBe('RECOVERY_REQUIRED')
    expect(ad.sendCalls).toBe(1)
  })

  it('P1.1 recovery with readback unavailable stays OUTCOME_UNKNOWN (never a blind resend)', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'throw'
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    ad.readbackMode = 'unavailable'
    r = await recoverAction(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('OUTCOME_UNKNOWN') // cannot prove absent → do NOT resend
    expect(ad.sendCalls).toBe(1)
  })

  it('P1.1 cancelAction aborts a PLANNED row → CANCELLED; cannot cancel one the provider may hold', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    const c = cancelAction(db, p.ledgerId, 'campaign revoked', 1001)
    expect(c.status).toBe('CANCELLED')
    // CANCELLED is terminal: executeAction never sends it.
    const r = await exec(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('CANCELLED')
    expect(ad.sendCalls).toBe(0)
    // A row the provider may already hold cannot be cancelled.
    const p2 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: { to: 'a@b.c' } }, 1000)
    ad.readbackMode = 'unavailable'
    await exec(db, ad, p2.ledgerId, 1001) // → APPLIED_UNVERIFIED
    expect(() => cancelAction(db, p2.ledgerId, 'too late', 1002)).toThrow(/cannot cancel APPLIED_UNVERIFIED/)
  })

  it('P0.4 quota: a full window blocks the send (stays PLANNED, not sent) and frees next window', async () => {
    const db = getDb(), ad = new MockAdapter()
    const q = { key: 'EMAIL_SEND:test', maxCount: 1, windowSec: 3600 }
    const p1 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: {} }, 1000)
    const p2 = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: {} }, 1000)
    // first consumes the only slot → sent
    expect((await exec(db, ad, p1.ledgerId, 1001, { quota: q })).status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1)
    // second is over quota → NOT sent, stays PLANNED
    const r2 = await exec(db, ad, p2.ledgerId, 1002, { quota: q })
    expect(r2.status).toBe('PLANNED')
    expect(ad.sendCalls).toBe(1) // <-- send NOT called for the blocked action
    // once the window rolls over, it goes through
    const r3 = await exec(db, ad, p2.ledgerId, 1002 + 3601, { quota: q })
    expect(r3.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(2)
  })

  it('terminal states are idempotent no-ops (VERIFIED never re-sends)', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    await exec(db, ad, p.ledgerId, 1001) // → VERIFIED, sendCalls 1
    const again = await exec(db, ad, p.ledgerId, 1002)
    expect(again.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(1)
  })

  it('verifyAction directly: APPLIED_UNVERIFIED + found marker → VERIFIED', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    db.prepare(`UPDATE outbound_ledger SET status='APPLIED_UNVERIFIED' WHERE ledger_id=?`).run(p.ledgerId)
    ad.provider.add(p.externalIdempotencyMarker)
    const r = await verifyAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(0)
  })
})
