// §22.2 (spec v1.3.1) — the twelve adversarial tests the section makes mandatory.
//
// These are not "does it work" tests. Each one is an ATTACK, and the assertion
// is BLOCK. The model they replace was a caller-side boolean
// (`authorizedByDispatchGate: true`) that I wrote and whose own comment admitted
// it was an assertion rather than proof: any code path able to reach the
// executor was equally able to write `true`.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector } from '../cos/connector-health.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import { planAction, executeAction } from '../cos/executor.js'
import { draftSend, approveSend, dispatchApprovedSend } from '../cos/send-flow.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import {
  issueAuthorization, consumeAuthorization, revokeAuthorizationsForAction,
  type AuthorizationContext,
} from '../cos/action-authorization.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'v@x.com', subject: 'S', body: 'B' }
const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: EMAIL }

function ctx(over: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    domain: 'personal', caseId: 'c1', caseVersion: 1, goalVersion: null,
    actionId: 'ob-1', actionType: 'EMAIL_SEND', intent: 'SEND_APPROVED_EMAIL',
    targetReference: 'camp-1', recipient: EMAIL.to, payloadHash: 'hash-1',
    approvalId: 'appr-1', ...over,
  }
}

describe('§22.2 authorization ticket — adversarial', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'QUOTE' }, T0)
  })

  it('authorized=true without a ticket → BLOCK', async () => {
    // The old model, attempted directly: there is no boolean to set any more,
    // and an absent ticket is a refusal rather than a default.
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    const r = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1, {} as never)
    expect(r.status).toBe('PLANNED')
    expect(t.sent.size).toBe(0)
  })

  it('forged authorization_id → BLOCK', () => {
    const db = getDb()
    const r = consumeAuthorization(db, 'f'.repeat(64), ctx(), T0)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('unknown authorization ticket')
  })

  it('consumed ticket reuse → BLOCK', () => {
    const db = getDb()
    const c = ctx()
    const { authorizationId } = issueAuthorization(db, c, T0)
    expect(consumeAuthorization(db, authorizationId, c, T0 + 1).ok).toBe(true)
    const again = consumeAuthorization(db, authorizationId, c, T0 + 2)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toContain('already consumed')
  })

  it('recipient changed after authorization → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0)
    const r = consumeAuthorization(db, authorizationId, ctx({ recipient: 'attacker@evil.com' }), T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('changed after authorization')
  })

  it('payload changed after authorization → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0)
    expect(consumeAuthorization(db, authorizationId, ctx({ payloadHash: 'hash-2' }), T0 + 1).ok).toBe(false)
  })

  it('action type changed → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0)
    expect(consumeAuthorization(db, authorizationId, ctx({ actionType: 'PAYMENT' }), T0 + 1).ok).toBe(false)
  })

  it('ticket aimed at a DIFFERENT action → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx({ actionId: 'ob-1' }), T0)
    const r = consumeAuthorization(db, authorizationId, ctx({ actionId: 'ob-2' }), T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('issued for action')
  })

  it('expired ticket → BLOCK', () => {
    const db = getDb()
    const { authorizationId, expiresAt } = issueAuthorization(db, ctx(), T0)
    const r = consumeAuthorization(db, authorizationId, ctx(), expiresAt + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('expired')
  })

  it('case version changed → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx({ caseVersion: 1 }), T0)
    expect(consumeAuthorization(db, authorizationId, ctx({ caseVersion: 2 }), T0 + 1).ok).toBe(false)
  })

  it('approval withdrawn after issuance → BLOCK', () => {
    // Modelled as the approval id no longer matching: a different approval, or
    // none, cannot consume a ticket bound to the original.
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx({ approvalId: 'appr-1' }), T0)
    expect(consumeAuthorization(db, authorizationId, ctx({ approvalId: null }), T0 + 1).ok).toBe(false)
  })

  it('authority revoked after issuance → BLOCK, without waiting for expiry', () => {
    const db = getDb()
    const c = ctx()
    const { authorizationId } = issueAuthorization(db, c, T0)
    expect(revokeAuthorizationsForAction(db, c.actionId, T0 + 1)).toBe(1)
    expect(consumeAuthorization(db, authorizationId, c, T0 + 2).ok).toBe(false)
  })

  it('direct adapter bypass → the executor still refuses without a ticket', async () => {
    // "Impossible" is not something a test can prove; what it CAN prove is that
    // holding an adapter is not enough — the executor is the choke point and it
    // wants a ticket.
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1, {
      authorizationId: 'not-a-real-id', authorizationContext: ctx({ actionId: p.ledgerId }),
    })
    expect(t.sent.size).toBe(0)
  })

  it('CONTROL: a genuine ticket from the real door DOES send', async () => {
    // Without this the whole file could pass by refusing everything.
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
    setLadder(db, 'QUOTE', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
    const d = draftSend(db, { caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, {
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
    }, T0)
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
      ledgerId: d.ledgerId, connectorId: 'gmail', campaignId: d.campaignId,
      templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
      email: EMAIL, declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning',
    }, T0 + 1)
    expect(r.sent).toBe(true)
    expect(t.sent.size).toBe(1)
    // and the consumption is on the record, as §22.2 requires
    const used = db.prepare('SELECT COUNT(*) n FROM action_authorizations WHERE consumed_at IS NOT NULL').get() as { n: number }
    expect(used.n).toBe(1)
  })
})
