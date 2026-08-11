// N-2 + N-3 (second review, 2026-08-10). The first review named the system's
// recurring fault as "the gate gets built and never joins the traffic". While
// fixing it I reproduced it exactly: executor-core's fence check and quota
// reservation were correct and sat behind `if (opts.claim)` / `if
// (opts.campaignLimit)` that NO production caller ever satisfied. My own
// scripts/cos-caller-report.ts would have shown it in one run. I did not run it
// on my own work.
//
// So these tests assert through the REAL dispatch functions, never by calling
// executeAction with hand-made opts — the defect was precisely that the domain
// call was perfect and the door did not use it.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector } from '../cos/connector-health.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import { draftSend, approveSend, dispatchApprovedSend } from '../cos/send-flow.js'
import { executeAction } from '../cos/executor.js'
import { reconcileOutbound } from '../cos/scheduler.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'v@x.com', subject: 'S', body: 'B' }

function prep(caseId = 'c1') {
  const db = getDb()
  createCase(db, { caseId, title: 'T', caseType: 'QUOTE' }, T0)
  registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
  setLadder(db, 'QUOTE', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
  return db
}

function draftApprove(caseId: string, envelope?: Record<string, unknown>) {
  const db = getDb()
  const d = draftSend(db, { caseId, connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
  approveSend(db, {
    campaignId: d.campaignId, templateHash: d.templateHash,
    renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
    ...(envelope ? { envelope } : {}),
  }, T0)
  return d
}

const dispatchInput = (d: ReturnType<typeof draftApprove>) => ({
  ledgerId: d.ledgerId, connectorId: 'gmail', campaignId: d.campaignId,
  templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
  email: EMAIL, declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning',
})

describe('the live dispatch door passes the claim and the ceilings (N-2)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the ledger row carries a claim_fence after a real dispatch', async () => {
    const db = prep()
    const d = draftApprove('c1')
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(new DryRunTransport()), dispatchInput(d), T0 + 1)
    expect(r.sent).toBe(true)
    const row = db.prepare('SELECT claim_fence FROM outbound_ledger WHERE ledger_id=?').get(d.ledgerId) as { claim_fence: number | null }
    // Before N-2 this was NULL on every row ever sent: the column existed, the
    // check existed, and nothing connected them.
    expect(row.claim_fence).not.toBeNull()
  })

  it('the claim is RELEASED afterwards, so the row is not blocked for its TTL', async () => {
    const db = prep()
    const d = draftApprove('c1')
    await dispatchApprovedSend(db, new GmailSendAdapter(new DryRunTransport()), dispatchInput(d), T0 + 1)
    const held = db.prepare("SELECT COUNT(*) n FROM case_claims WHERE claim_key = ?").get(`outbound:${d.ledgerId}`) as { n: number }
    expect(held.n).toBe(0)
  })

  it('the envelope ceiling is enforced through the door, not only pre-checked', async () => {
    const db = prep()
    createCase(db, { caseId: 'c2', title: 'T2', caseType: 'QUOTE' }, T0)
    // maxTotalOutbound 1 is the default (F-16); the second send on the same
    // campaign must be refused.
    const d1 = draftApprove('c1')
    const first = await dispatchApprovedSend(db, new GmailSendAdapter(new DryRunTransport()), dispatchInput(d1), T0 + 1)
    expect(first.sent).toBe(true)

    const d2 = draftSend(db, { caseId: 'c2', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL, campaignId: d1.campaignId }, T0)
    approveSend(db, {
      campaignId: d1.campaignId, templateHash: d2.templateHash,
      renderedPayloadHash: d2.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
      approvalId: 'appr-second', // the default id is derived from the payload hash, identical here
      envelope: { maxTotalOutbound: 1 },
    }, T0)
    const t = new DryRunTransport()
    const second = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
      ...dispatchInput(d2), campaignId: d1.campaignId,
    }, T0 + 2)
    expect(second.sent).toBe(false)
    expect(t.sent.size).toBe(0)
  })
})

describe('a retry is a first delivery and needs the gate (N-3)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('reconcileOutbound does not offer a FAILED_RETRYABLE row', () => {
    const db = prep()
    const d = draftApprove('c1')
    db.prepare("UPDATE outbound_ledger SET status='FAILED_RETRYABLE' WHERE ledger_id=?").run(d.ledgerId)
    expect(reconcileOutbound(db).map(w => w.ledger_id)).not.toContain(d.ledgerId)
  })

  it('executeAction refuses to retry without a declared decision', async () => {
    const db = prep()
    const d = draftApprove('c1')
    db.prepare("UPDATE outbound_ledger SET status='FAILED_RETRYABLE', attempt=1, sending_at=? WHERE ledger_id=?").run(T0, d.ledgerId)
    const t = new DryRunTransport()
    // well past any backoff, so only the gate can be the reason
    const r = await executeAction(db, new GmailSendAdapter(t), d.ledgerId, T0 + 100_000)
    expect(t.sent.size).toBe(0)
    expect(r.status).not.toBe('VERIFIED')
    const row = db.prepare('SELECT last_error FROM outbound_ledger WHERE ledger_id=?').get(d.ledgerId) as { last_error: string | null }
    // §22.2: the refusal reason changed with the model — a missing ticket, not a
    // missing boolean. The property under test (refused, nothing sent) is the same.
    expect(row.last_error ?? '').toContain('no authorization ticket supplied')
  })

  it('CONTROL: the same retry DOES go through the gated door', async () => {
    const db = prep()
    const d = draftApprove('c1')
    db.prepare("UPDATE outbound_ledger SET status='FAILED_RETRYABLE', attempt=1, sending_at=? WHERE ledger_id=?").run(T0, d.ledgerId)
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(new DryRunTransport()), dispatchInput(d), T0 + 100_000)
    expect(r.sent).toBe(true)
  })
})
