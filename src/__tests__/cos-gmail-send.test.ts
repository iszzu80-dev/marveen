import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
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
    const r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
    const sent = [...t.sent.values()][0]
    expect(sent.headers[IDEMPOTENCY_HEADER]).toBe(p.internalIdempotencyKey) // marker embedded
    expect(sent.to).toBe('vendor@example.com')
    expect(r.externalRef).toBe(sent.messageId)
  })

  it('HEADLINE: reached Gmail but we errored → recovery reads back the marker, no second delivery', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.reachThenThrow = true // delivers, then throws
    const after = await executeAction(db, ad, p.ledgerId, 1001)
    expect(after.status).toBe('OUTCOME_UNKNOWN')
    expect(t.sent.size).toBe(1) // it DID reach Gmail once
    // retry/restart: recovery finds the marker in Sent → VERIFIED, no resend
    t.reachThenThrow = false
    const rec = await executeAction(db, ad, p.ledgerId, 1002)
    expect(rec.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1) // <-- still exactly one delivery
  })

  it('genuine transport failure (never reached Gmail) does not leave a phantom marker', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const ad = new GmailSendAdapter(t)
    const p = planAction(db, PLAN, 1000)
    t.failNextSend = true
    const r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    expect(t.sent.size).toBe(0)
    // recovery: readback finds nothing → back to PLANNED → resend succeeds once
    const rec = await executeAction(db, ad, p.ledgerId, 1002) // recover → PLANNED
    expect(['PLANNED', 'VERIFIED']).toContain(rec.status)
    const done = await executeAction(db, ad, p.ledgerId, 1003)
    expect(done.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })

  it('rejects a payload missing to/subject', async () => {
    const db = getDb()
    const ad = new GmailSendAdapter(new DryRunTransport())
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: { body: 'no recipient' } }, 1000)
    const r = await executeAction(db, ad, p.ledgerId, 1001)
    expect(r.status).toBe('OUTCOME_UNKNOWN') // send threw → not a false success
  })
})
