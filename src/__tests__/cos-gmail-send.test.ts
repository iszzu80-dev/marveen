import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { mintGatePermit } from '../cos/gate-permit.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { planAction, executeAction } from '../cos/executor.js'
import { GmailSendAdapter, DryRunTransport, IDEMPOTENCY_HEADER } from '../cos/adapters/gmail-send.js'

// COS Gmail send adapter wired to the Action Executor. Proves the searchable
// idempotency marker (X-Marveen-Idempotency-Key) is what makes the executor's
// readback real — including the headline crash case (reached Gmail but we
// errored → recovery VERIFIES with no second delivery).

const PLAN = {
  caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1,
  payload: { to: 'vendor@example.com', subject: 'Quote request', body: 'Please quote.' },
}

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
function ensureDraftEvidence(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number): { caseId: string; caseVersion: number } {
  const row = db.prepare(`SELECT case_id, status, case_version FROM outbound_ledger WHERE ledger_id=?`).get(ledgerId) as
    { case_id: string | null; status: string; case_version: number | null } | undefined
  if (!row?.case_id) throw new Error(`test outbound ledger has no case_id: ${ledgerId}`)
  const c = db.prepare(`SELECT version FROM personal_cases WHERE case_id=?`).get(row.case_id) as { version: number } | undefined
  if (!c) throw new Error(`test case missing: ${row.case_id}`)
  if (row.case_version == null) db.prepare(`UPDATE outbound_ledger SET case_version=? WHERE ledger_id=?`).run(c.version, ledgerId)
  if (row.status === 'PLANNED' || row.status === 'FAILED_RETRYABLE') {
    const exists = db.prepare(`SELECT 1 FROM personal_case_events WHERE case_id=? AND event_type='OUTBOUND_DRAFTED' AND source_reference=? LIMIT 1`).get(row.case_id, ledgerId)
    if (!exists) appendCaseEvent(db, {
      caseId: row.case_id, caseVersion: c.version, actor: 'test', eventType: 'OUTBOUND_DRAFTED',
      reason: 'production-equivalent draft evidence horizon for executor fixture',
      sourceSystem: 'test:executor', sourceReference: ledgerId, payload: { ledgerId },
    }, now)
  }
  return { caseId: row.case_id, caseVersion: c.version }
}

function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, actionType: string, now: number) {
  const evidence = ensureDraftEvidence(db, ledgerId, now)
  const ctx = {
    domain: 'personal' as const, caseId: evidence.caseId, caseVersion: evidence.caseVersion, goalVersion: null,
    actionId: ledgerId, actionType, intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] })).authorizationId, authorizationContext: ctx }
}

const exec: typeof executeAction = (db, adapter, ledgerId, now, opts = {}) =>
  executeAction(db, adapter, ledgerId, now, {
    ...authorized(db, ledgerId, 'EMAIL_SEND', now), ...opts,
  })

describe('GmailSendAdapter + executor', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('happy path: plan → execute → VERIFIED, message carries the idempotency marker', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
    const sent = [...t.sent.values()][0]
    expect(sent.headers[IDEMPOTENCY_HEADER]).toBe(p.externalIdempotencyMarker) // marker embedded
    expect(sent.to).toBe('vendor@example.com')
    expect(r.externalRef).toBe(sent.messageId)
  })

  it('HEADLINE: reached Gmail but we errored → recovery reads back the marker, no second delivery', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.reachThenThrow = true // delivers, then throws
    const after = await exec(db, ad, p.ledgerId, 1001)
    expect(after.status).toBe('OUTCOME_UNKNOWN')
    expect(t.sent.size).toBe(1) // it DID reach Gmail once
    // retry/restart: recovery finds the marker in Sent → VERIFIED, no resend
    t.reachThenThrow = false
    const rec = await exec(db, ad, p.ledgerId, 1002)
    expect(rec.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1) // <-- still exactly one delivery
  })

  it('genuine transport failure (never reached Gmail) does not leave a phantom marker', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.failNextSend = true
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    expect(t.sent.size).toBe(0)
    // recovery: readback finds nothing → back to PLANNED → resend succeeds once
    const rec = await exec(db, ad, p.ledgerId, 1002) // recover → PLANNED
    expect(['PLANNED', 'VERIFIED']).toContain(rec.status)
    const done = await exec(db, ad, p.ledgerId, 1003)
    expect(done.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })

  it('P1.1 sent to Gmail but Sent search unreachable → APPLIED_UNVERIFIED, never resent', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.readbackUnavailable = true // the message is delivered, but readback can't confirm
    let r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
    expect(t.sent.size).toBe(1)
    // reconcile drives it again: still can't confirm → stays, NO second delivery
    r = await exec(db, ad, p.ledgerId, 1002)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
    expect(t.sent.size).toBe(1)
    // Sent becomes reachable and the marker is there → VERIFIED
    t.readbackUnavailable = false
    r = await exec(db, ad, p.ledgerId, 1003)
    expect(r.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })

  // CHANGED 2026-08-10 (F-3). This test used to assert OUTCOME_UNKNOWN with the
  // comment "send threw → not a false success". The first half of that is right
  // and the second half hid a bug: OUTCOME_UNKNOWN does not mean "not a false
  // success", it means "we cannot tell whether it was delivered", and that is
  // untrue for a payload we never handed to the transport. The assertion is now
  // FAILED_TERMINAL; the "no false success" property it cared about is still
  // covered (nothing delivered, non-VERIFIED status).
  it('rejects a payload missing to/subject — terminal, and nothing delivered', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: { body: 'no recipient' } }, 1000)
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_TERMINAL')
    expect(t.sent.size).toBe(0)
  })
})

// F-3 (review 2026-08-10): a failure that happens BEFORE the transport call must
// not be recorded as OUTCOME_UNKNOWN. On the live send path readback is disabled
// (embedBodyMarker:false), so an OUTCOME_UNKNOWN row can never be resolved: the
// reconcile retries it forever and it never reaches the RECOVERY_REQUIRED alert
// either. A missing `to` is a local typo — it must be terminal, and nothing may
// have been delivered.
describe('GmailSendAdapter pre-flight failures are local, not unknown (F-3)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('payload missing to/subject → FAILED_TERMINAL, nothing delivered', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, { ...PLAN, payload: { subject: 'no recipient' } }, 1000)
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_TERMINAL')
    expect(t.sent.size).toBe(0)
  })

  it('attachments requested but no share-gated resolver wired → FAILED_TERMINAL', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t) // deliberately no resolver
    const p = planAction(db, {
      ...PLAN, payload: { ...PLAN.payload, attachmentDocumentIds: ['doc-1'] },
    }, 1000)
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_TERMINAL')
    expect(t.sent.size).toBe(0)
  })

  it('share gate refuses a document → FAILED_TERMINAL, and the refusal reaches last_error', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t, () => { throw new Error('attachment blocked: document doc-1 is not marked shareable') })
    const p = planAction(db, {
      ...PLAN, payload: { ...PLAN.payload, attachmentDocumentIds: ['doc-1'] },
    }, 1000)
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('FAILED_TERMINAL')
    // last_error is a ledger column, not a field on OutboundAction — read it
    // where it actually lives, so the assertion cannot pass on a stale object.
    const err = db.prepare('SELECT last_error FROM outbound_ledger WHERE ledger_id = ?')
      .get(p.ledgerId) as { last_error: string | null }
    expect(err.last_error ?? '').toContain('not marked shareable')
    expect(t.sent.size).toBe(0)
  })

  it('CONTROL: a real transport failure after the call still maps to OUTCOME_UNKNOWN', async () => {
    // Proves the fix narrowed the unknown branch instead of deleting it.
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.reachThenThrow = true
    const r = await exec(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
  })
})

// F-12 (review 2026-08-10): on the live send path embedBodyMarker is false —
// the owner approved the text verbatim, so nothing may be added to it — and the
// marker search therefore reports available:false forever. A send on that path
// could never reach VERIFIED, and a SENDING/OUTCOME_UNKNOWN row could never be
// resolved by anything: §7.3's recovery arm simply did not work there.
//
// The fallback is the provider id recorded at send time (F-2). Weaker evidence,
// and the code says so: it proves the message exists, not that its body is the
// approved one. Weaker evidence beats a row nothing can ever resolve.
describe('readback falls back to the provider id when no marker was embedded (F-12)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  /** A transport with no searchable marker, i.e. the live configuration. */
  function markerless(exists: boolean, reachable = true) {
    const sent: string[] = []
    return {
      sent,
      transport: {
        async send() { const id = `msg-${sent.length + 1}`; sent.push(id); return { messageId: id } },
        async findSentByHeader() { return { found: false, available: false } }, // no marker to search for
        async getById() { return reachable ? { found: exists, available: true } : { found: false, available: false } },
      },
    }
  }

  it('the message exists at the provider → VERIFIED instead of stuck', async () => {
    const db = getDb()
    const m = markerless(true)
    const r = await exec(db, new GmailSendAdapter(m.transport as never), planAction(db, PLAN, 1000).ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(m.sent).toHaveLength(1)
  })

  it('CONTROL: with no fallback available the row stays unverified, never resent', async () => {
    // Proves the fallback is what changed the outcome, not something else — and
    // that removing it restores the old, safe-but-stuck behaviour.
    const db = getDb()
    const noFallback = {
      async send() { return { messageId: 'msg-1' } },
      async findSentByHeader() { return { found: false, available: false } },
      // deliberately no getById
    }
    const r = await exec(db, new GmailSendAdapter(noFallback as never), planAction(db, PLAN, 1000).ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
  })

  it('the provider is unreachable → unavailable, NOT "absent"', async () => {
    // The distinction that stops a healthy send being resent.
    const db = getDb()
    const m = markerless(false, false)
    const r = await exec(db, new GmailSendAdapter(m.transport as never), planAction(db, PLAN, 1000).ledgerId, 1001)
    expect(r.status).toBe('APPLIED_UNVERIFIED')
    expect(m.sent).toHaveLength(1) // exactly one delivery, no resend
  })
})
