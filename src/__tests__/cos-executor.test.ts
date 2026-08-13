import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { mintGatePermit } from '../cos/gate-permit.js'
import { createCase } from '../cos/case-store.js'
import {
  planAction, executeAction, recoverAction, verifyAction, cancelAction,
  idempotencyKey, SendError,
  type OutboundAdapter, type OutboundAction, type ReadbackResult,
} from '../cos/executor.js'
import { READBACK_ABSENT_GRACE_SEC, SENDING_RECOVERY_GRACE_SEC } from '../cos/executor-core.js'

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
// §22.2: the executor no longer accepts a caller-side boolean. A first send
// needs a ticket the deterministic gate issued. These unit tests drive the state
// machine directly, so they issue one the same way production does — via
// issueAuthorization — rather than being handed a bypass. That is the point: if
// a test could get in without a real ticket, so could anything else.
function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, actionType: string, now: number) {
  const ctx = {
    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,
    actionId: ledgerId, actionType, intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] })).authorizationId, authorizationContext: ctx }
}

const exec: typeof executeAction = (db, adapter, ledgerId, now, opts = {}) =>
  executeAction(db, adapter, ledgerId, now, {
    ...authorized(db, ledgerId, 'EMAIL_SEND', now), ...opts,
  })

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
    // CHANGED 2026-08-13 (E1): sending_at is set EXPLICITLY and the recovery runs
    // past the grace window. The test used to rely on `updated_at` happening to
    // be old enough, which made it pass for a reason it did not state — and the
    // row it modelled (a genuinely abandoned one) is exactly the row recovery
    // must still pick up after E1.
    db.prepare(`UPDATE outbound_ledger SET status='SENDING', sending_at=? WHERE ledger_id=?`).run(1000, p.ledgerId)
    ad.provider.add(p.externalIdempotencyMarker)
    const r = await exec(db, ad, p.ledgerId, 1000 + SENDING_RECOVERY_GRACE_SEC + 1) // sees SENDING → recover
    expect(r.status).toBe('VERIFIED')
    expect(ad.sendCalls).toBe(0) // never re-sent
  })

  // E1 HEADLINE (review 2026-08-13). SENDING is written BEFORE the provider call,
  // so an in-flight row and a crashed one look identical on the ledger. Recovery
  // used to accept a SENDING row at ANY age: a concurrent tick read back a marker
  // the provider had not indexed yet, called it absent, and reset the row to
  // PLANNED — from where the same message is sent a SECOND time.
  it('E1: a freshly-SENDING row is NOT recovered — an in-flight send is not an abandoned one', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    // the row a concurrent worker sees while OUR send is still awaiting the provider
    db.prepare(`UPDATE outbound_ledger SET status='SENDING', sending_at=? WHERE ledger_id=?`).run(1000, p.ledgerId)
    // the provider has not indexed it yet → readback finds nothing
    const r = await exec(db, ad, p.ledgerId, 1000 + 30)
    expect(r.status).toBe('SENDING')   // NOT reset to PLANNED
    expect(ad.sendCalls).toBe(0)
    // and a direct recoverAction call is guarded too, not only the queue
    expect((await recoverAction(db, ad, p.ledgerId, 1000 + 60)).status).toBe('SENDING')
    expect(ad.sendCalls).toBe(0)
    // CONTROL: once the row is genuinely old, recovery does its job — the guard
    // is a delay, not a refusal to ever recover.
    const rec = await recoverAction(db, ad, p.ledgerId, 1000 + SENDING_RECOVERY_GRACE_SEC + 1)
    expect(rec.status).toBe('PLANNED')
  })

  it('E1: a status write cannot overwrite a row that moved — the provider accepted, so a human is pinned', async () => {
    // Models the end of the race: our send was in flight, a recovery moved the
    // row back to PLANNED, and then the provider answered "accepted". The old
    // unconditional UPDATE stamped APPLIED_UNVERIFIED over it and the second send
    // sitting in the queue left no trace at all.
    const db = getDb()
    const p = planAction(db, PLAN, 1000)
    const racer: OutboundAdapter = {
      actionType: 'EMAIL_SEND',
      async send() {
        // the concurrent recovery, happening while we are inside adapter.send()
        db.prepare(`UPDATE outbound_ledger SET status='PLANNED' WHERE ledger_id=?`).run(p.ledgerId)
        return { externalRef: 'ext-1' }
      },
      async readback() { return { found: true, externalRef: 'ext-1' } },
    }
    const r = await exec(db, racer, p.ledgerId, 1001)
    expect(r.status).toBe('RECOVERY_REQUIRED')
    expect(String(r.lastError)).toMatch(/second delivery may be queued/)
  })

  // E4 (review 2026-08-13). Every refusal path wrote PLANNED regardless of the
  // status the row came in with, so a row that had already failed N times
  // re-entered as a fresh one: the F-15 ceiling counts only from
  // FAILED_RETRYABLE, so it could never fire, and the backoff never applied.
  it('E4: a refusal KEEPS the entry status instead of resetting the row to PLANNED', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    db.prepare(`UPDATE outbound_ledger SET status='FAILED_RETRYABLE', attempt=4, sending_at=? WHERE ledger_id=?`)
      .run(1000, p.ledgerId)
    // no ticket → refused at the §22.2 door, well past any backoff
    const r = await executeAction(db, ad, p.ledgerId, 100_000, { retry: { maxAttempts: 5, baseBackoffSec: 1 } })
    expect(r.status).toBe('FAILED_RETRYABLE')  // not laundered back into PLANNED
    expect(r.attempt).toBe(4)                  // and the count it is judged on survives
    expect(ad.sendCalls).toBe(0)
    // so the F-15 ceiling can still fire on the next real attempt
    const done = await exec(db, ad, p.ledgerId, 200_000, { retry: { maxAttempts: 4, baseBackoffSec: 1 } })
    expect(done.status).toBe('FAILED_TERMINAL')
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

  // CHANGED 2026-08-13 (E5). This asserted RECOVERY_REQUIRED on the FIRST probe,
  // milliseconds after the provider accepted the message — i.e. it asserted the
  // defect. A mail provider routinely has not indexed an accepted message yet,
  // so the common case of "delivered fine, not searchable for another few
  // seconds" was pinned in a state only a human can leave and nothing ever
  // re-checks. The property the test cared about (a claimed success is NEVER
  // blind-resent) is still asserted, on both sides of the grace window.
  it('P1.1 provider claimed success but marker absent: the FIRST miss waits, a CONFIRMED absence → RECOVERY_REQUIRED', async () => {
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'ok-but-vanish' // send "succeeds" but provider never really has it, readback available
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED') // not yet proof — the provider may still be indexing
    // and it is still not proof one minute later
    const soon = await exec(db, ad, p.ledgerId, 1001 + 60)
    expect(soon.status).toBe('APPLIED_UNVERIFIED')
    // Once the marker is STILL absent past the grace window, the absence is
    // evidence: a human must reconcile it.
    const later = await exec(db, ad, p.ledgerId, 1001 + READBACK_ABSENT_GRACE_SEC + 1)
    expect(later.status).toBe('RECOVERY_REQUIRED')
    // RECOVERY_REQUIRED is not auto-resent: re-running does not send again.
    const again = await exec(db, ad, p.ledgerId, 1001 + READBACK_ABSENT_GRACE_SEC + 2)
    expect(again.status).toBe('RECOVERY_REQUIRED')
    expect(ad.sendCalls).toBe(1) // <-- never resent, in any of the four passes
  })

  it('E5: a marker that shows up during the grace window VERIFIES instead of alarming', async () => {
    // The case the old first-probe escalation made unreachable: a perfectly
    // delivered letter whose provider indexed it a minute later.
    const db = getDb(), ad = new MockAdapter()
    const p = planAction(db, PLAN, 1000)
    ad.mode = 'ok-but-vanish'
    expect((await exec(db, ad, p.ledgerId, 1001)).status).toBe('APPLIED_UNVERIFIED')
    ad.provider.add(p.externalIdempotencyMarker) // the provider finished indexing
    const r = await exec(db, ad, p.ledgerId, 1001 + 120)
    expect(r.status).toBe('VERIFIED')
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
