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
import { mintGatePermit } from '../cos/gate-permit.js'
import { engageKillSwitch } from '../cos/kill-switch.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'v@x.com', subject: 'S', body: 'B' }
const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: EMAIL }

function ctx(over: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    domain: 'personal', caseId: 'c1', caseVersion: 1, goalVersion: null,
    actionId: 'ob-1', actionType: 'EMAIL_SEND', intent: 'SEND_APPROVED_EMAIL',
    targetReference: 'camp-1', recipient: EMAIL.to, payloadHash: 'hash-1',
    // approvalId is null by DEFAULT because these tests are about the ticket
    // mechanics. Consumption now re-checks a named approval's live validity and
    // fails CLOSED when it cannot verify one — so a made-up id like 'appr-1'
    // would refuse every test here for the right reason but the wrong subject.
    // The approval-specific tests below use real, approved rows.
    approvalId: null, ...over,
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
    const { authorizationId } = issueAuthorization(db, c, T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, authorizationId, c, T0 + 1).ok).toBe(true)
    const again = consumeAuthorization(db, authorizationId, c, T0 + 2)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toContain('already consumed')
  })

  it('recipient changed after authorization → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    const r = consumeAuthorization(db, authorizationId, ctx({ recipient: 'attacker@evil.com' }), T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('changed after authorization')
  })

  it('payload changed after authorization → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, authorizationId, ctx({ payloadHash: 'hash-2' }), T0 + 1).ok).toBe(false)
  })

  it('action type changed → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx(), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, authorizationId, ctx({ actionType: 'PAYMENT' }), T0 + 1).ok).toBe(false)
  })

  it('ticket aimed at a DIFFERENT action → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx({ actionId: 'ob-1' }), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    const r = consumeAuthorization(db, authorizationId, ctx({ actionId: 'ob-2' }), T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('issued for action')
  })

  it('expired ticket → BLOCK', () => {
    const db = getDb()
    const { authorizationId, expiresAt } = issueAuthorization(db, ctx(), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    const r = consumeAuthorization(db, authorizationId, ctx(), expiresAt + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('expired')
  })

  it('case version changed → BLOCK', () => {
    const db = getDb()
    const { authorizationId } = issueAuthorization(db, ctx({ caseVersion: 1 }), T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, authorizationId, ctx({ caseVersion: 2 }), T0 + 1).ok).toBe(false)
  })

  it('approval withdrawn after issuance → BLOCK (REAL revocation, same id)', async () => {
    // CHANGED 2026-08-10 22:56. This test used to model withdrawal as the
    // approval ID no longer matching — which the policy hash already caught, so
    // it was green while proving the EASIER half. The case the spec names is the
    // same approval, revoked: identical id, identical hash, and until the fix
    // nothing looked at whether it was still valid. Found by auditing the
    // implementation against §22.2's TOCTOU list instead of against my own tests.
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
    setLadder(db, 'QUOTE', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
    const d = draftSend(db, { origin: 'owner', caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, { initiatedBy: 'human',
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
      approvalId: 'appr-live',
    }, T0)

    const c = ctx({ actionId: d.ledgerId, approvalId: 'appr-live', payloadHash: d.renderedPayloadHash, targetReference: d.campaignId })
    const { authorizationId } = issueAuthorization(db, c, T0, {}, mintGatePermit({ allowed: true, reasons: [] }))

    // revoked through the real mechanism, id unchanged
    db.prepare("UPDATE campaign_approvals SET status='REVOKED' WHERE approval_id='appr-live'").run()

    const r = consumeAuthorization(db, authorizationId, c, T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('REVOKED')
  })

  it('a stop condition tripped after issuance → BLOCK', () => {
    // §3.4's other withdrawal route, same shape: id unchanged, authority gone.
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
    const d = draftSend(db, { origin: 'owner', caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, { initiatedBy: 'human',
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
      approvalId: 'appr-stop',
    }, T0)
    const c = ctx({ actionId: d.ledgerId, approvalId: 'appr-stop', payloadHash: d.renderedPayloadHash, targetReference: d.campaignId })
    const { authorizationId } = issueAuthorization(db, c, T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    db.prepare("UPDATE campaign_approvals SET stopped_reason='előleget kértek' WHERE approval_id='appr-stop'").run()
    const r = consumeAuthorization(db, authorizationId, c, T0 + 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('stopped')
  })

  it('CONTROL: an untouched approval still lets the ticket through', () => {
    // Without this the previous two could pass by refusing everything with an
    // approval id attached.
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
    const d = draftSend(db, { origin: 'owner', caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, { initiatedBy: 'human',
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
      approvalId: 'appr-ok',
    }, T0)
    const c = ctx({ actionId: d.ledgerId, approvalId: 'appr-ok', payloadHash: d.renderedPayloadHash, targetReference: d.campaignId })
    const { authorizationId } = issueAuthorization(db, c, T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, authorizationId, c, T0 + 1).ok).toBe(true)
  })

  it('authority revoked after issuance → BLOCK, without waiting for expiry', () => {
    const db = getDb()
    const c = ctx()
    const { authorizationId } = issueAuthorization(db, c, T0, {}, mintGatePermit({ allowed: true, reasons: [] }))
    expect(revokeAuthorizationsForAction(db, c.actionId, T0 + 1)).toBe(1)
    expect(consumeAuthorization(db, authorizationId, c, T0 + 2).ok).toBe(false)
  })

  // E8 (review 2026-08-13). Revocation was spelled "set consumed_at", and
  // consumption only blocks on consumed_at when single_use=1 (the predicate is
  // `consumed_at IS NULL OR single_use = 0`). So a ticket issued with
  // singleUse:false walked straight through a revocation that had counted it.
  // Latent — every issuer today passes single-use — and still a broken §22.2
  // contract, with the audit row asserting the opposite of what happened.
  it('E8: revocation blocks a MULTI-USE ticket too, not only a single-use one', () => {
    const db = getDb()
    const c = ctx()
    const multi = issueAuthorization(db, c, T0, { singleUse: false }, mintGatePermit({ allowed: true, reasons: [] }))
    expect(revokeAuthorizationsForAction(db, c.actionId, T0 + 1)).toBe(1)
    const r = consumeAuthorization(db, multi.authorizationId, c, T0 + 2)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/revoked/)
  })

  it('E8: the kill switch kills a multi-use ticket, and the audit says REVOKED not consumed', () => {
    const db = getDb()
    const c = ctx()
    const multi = issueAuthorization(db, c, T0, { singleUse: false }, mintGatePermit({ allowed: true, reasons: [] }))
    engageKillSwitch(db, { reason: 'allj le', actor: 'istvan' }, T0 + 1)
    expect(consumeAuthorization(db, multi.authorizationId, c, T0 + 2).ok).toBe(false)
    // and the two facts are distinguishable afterwards, which they were not while
    // both were written to consumed_at
    const row = db.prepare('SELECT revoked_at, revoked_reason, consumed_at FROM action_authorizations WHERE authorization_id=?')
      .get(multi.authorizationId) as { revoked_at: number | null; revoked_reason: string | null; consumed_at: number | null }
    expect(row.revoked_at).toBe(T0 + 1)
    expect(row.consumed_at).toBeNull()
    expect(String(row.revoked_reason)).toContain('allj le')
  })

  it('CONTROL: a multi-use ticket that nobody revoked is consumable twice', () => {
    // Without this, the two tests above could pass by refusing multi-use tickets
    // outright — which would be a different bug wearing the fix as a disguise.
    const db = getDb()
    const c = ctx()
    const multi = issueAuthorization(db, c, T0, { singleUse: false }, mintGatePermit({ allowed: true, reasons: [] }))
    expect(consumeAuthorization(db, multi.authorizationId, c, T0 + 1).ok).toBe(true)
    expect(consumeAuthorization(db, multi.authorizationId, c, T0 + 2).ok).toBe(true)
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
    const d = draftSend(db, { origin: 'owner', caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, { initiatedBy: 'human',
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
