import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { registerConnector, setMode } from '../cos/connector-health.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import {
  draftZstSend, approveZstSend, rejectZstSend, dispatchZstSend, evaluateZstSendGate,
  renderedPayloadHash,
} from '../cos/zst-send.js'
import type { OutboundAdapter, OutboundAction, ReadbackResult } from '../cos/executor-core.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'konyvelo@example.com', subject: 'Havi csomag', body: 'Csatolva a július.' }

// Mock transport-as-adapter. Records sends; readback answer is configurable.
function mockAdapter(over: { sendThrows?: unknown; readback?: ReadbackResult } = {}) {
  const sent: OutboundAction[] = []
  return {
    sent,
    adapter: {
      actionType: 'EMAIL_SEND',
      async send(a: OutboundAction) { if (over.sendThrows) throw over.sendThrows; sent.push(a); return { externalRef: 'zmsg-1' } },
      async readback(): Promise<ReadbackResult> { return over.readback ?? { found: true, externalRef: 'zmsg-1' } },
    } as OutboundAdapter,
  }
}

describe('ZST approval-gated send (Slice 1 write-half, AT-ZA)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDb()
    createZstCase(db, { caseId: 'ZST-ACC-1', title: 'Havi könyvelés', caseType: 'ACCOUNTING' }, T0)
    registerConnector(db, 'zst-gmail', 'gmail', 'READ_WRITE', T0)
    // CHANGED 2026-08-10 (F-9): the corporate gate now checks the autonomy rung,
    // as the personal one has since §22. Without this the whole file refuses at
    // the rung and never reaches what it is actually testing. The personal
    // send-flow suite has had the equivalent line all along.
    setLadder(db, 'ACCOUNTING', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
  })

  function draftAndApprove(email = EMAIL, recipients = [EMAIL.to]) {
    const db = getDb()
    const d = draftZstSend(db, { caseId: 'ZST-ACC-1', templateId: 'accounting-package', email }, T0)
    approveZstSend(db, { campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', allowedRecipients: recipients }, T0 + 1)
    return d
  }
  const dispatchInput = (d: ReturnType<typeof draftAndApprove>, email = EMAIL) => ({
    ledgerId: d.ledgerId, campaignId: d.campaignId, connectorId: 'zst-gmail', email,
    templateHash: d.templateHash, renderedPayloadHash: renderedPayloadHash(email),
    declaredSensitivity: 'ZST_INTERNAL', targetProfile: 'premium_reasoning',
    caseType: 'ACCOUNTING', now: T0 + 2,
  })

  it('F-9: the corporate gate refuses when the autonomy rung does not permit SEND', async () => {
    // The gap this closes: the personal gate has checked the rung since §22 and
    // the corporate one never did, so a case type parked at PREPARE could still
    // send here. Asserted on a rung the approval is otherwise perfect for, so
    // nothing else can be the reason for the refusal.
    const db = getDb()
    setLadder(db, 'ACCOUNTING', { rung: 'PREPARE' }, T0 - 1000)
    const d = draftAndApprove()
    const m = mockAdapter()
    const res = await dispatchZstSend(db, m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join(' ')).toMatch(/autonómia-fokozat/)
    expect(m.sent).toHaveLength(0)
  })

  it('F-9: an EXPIRED approval refuses — the corporate path used to ignore valid_until', async () => {
    // authorizeZstSend reimplemented a narrower check locally and never looked
    // at valid_until, stop conditions, channel or quotas. It delegates to the
    // shared engine now, so all of them apply to both namespaces.
    const db = getDb()
    const d = draftZstSend(db, { caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: EMAIL }, T0)
    approveZstSend(db, {
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', allowedRecipients: [EMAIL.to],
    }, T0 + 1)
    db.prepare('UPDATE zst_campaign_approvals SET valid_until = ? WHERE campaign_id = ?').run(T0 + 5, d.campaignId)
    const m = mockAdapter()
    const res = await dispatchZstSend(db, m.adapter, { ...dispatchInput(d), now: T0 + 999 }, T0 + 999)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join(' ')).toMatch(/expired/i)
    expect(m.sent).toHaveLength(0)
  })

  it('happy path: draft → approve → dispatch → VERIFIED (one send)', async () => {
    const d = draftAndApprove()
    const m = mockAdapter()
    const res = await dispatchZstSend(getDb(), m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(true)
    expect(res.action?.status).toBe('VERIFIED')
    expect(m.sent).toHaveLength(1)
  })

  it('AT-ZA06: a draft that is NOT approved does not send', async () => {
    const db = getDb()
    const d = draftZstSend(db, { caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: EMAIL }, T0)
    const m = mockAdapter()
    const res = await dispatchZstSend(db, m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(false)
    expect(m.sent).toHaveLength(0)
    expect(res.decision.reasons.join()).toMatch(/not authorized/)
  })

  it('AT-ZA04: a payload edited after approval fails the hash and does not send', async () => {
    const d = draftAndApprove()
    const edited = { ...EMAIL, body: 'MÓDOSÍTOTT szöveg' }
    const m = mockAdapter()
    const res = await dispatchZstSend(getDb(), m.adapter, dispatchInput(d, edited), T0 + 2)
    expect(res.sent).toBe(false)
    expect(m.sent).toHaveLength(0)
  })

  // CHANGED 2026-08-10 (F-9): wording only. The refusal now comes from the
  // shared approval engine, whose message reads "not ON the approved list"; the
  // local reimplementation said "not IN". Both accepted so the assertion is
  // about the refusal, not about one engine's phrasing.
  it('AT-ZA05: a recipient not on the approved list is vetoed', async () => {
    const d = draftAndApprove(EMAIL, ['someone-else@example.com'])
    const m = mockAdapter()
    const res = await dispatchZstSend(getDb(), m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join()).toMatch(/not on the approved list|not in the approved list/)
  })

  it('AT-ZA09: a connector that is not write-usable blocks the send', async () => {
    const d = draftAndApprove()
    setMode(getDb(), 'zst-gmail', 'READ_ONLY', T0 + 1)
    const m = mockAdapter()
    const res = await dispatchZstSend(getDb(), m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(false)
    expect(m.sent).toHaveLength(0)
    expect(res.decision.reasons.join()).toMatch(/not write-usable/)
  })

  it('AT-ZA10: UNKNOWN sensitivity is fail-closed for a non-premium profile', () => {
    const d = draftAndApprove()
    const dec = evaluateZstSendGate(getDb(), { ...dispatchInput(d), declaredSensitivity: 'UNKNOWN', targetProfile: 'analysis_efficient' })
    expect(dec.allowed).toBe(false)
    expect(dec.reasons.join()).toMatch(/not allowed for ZST sensitivity/)
  })

  it('AT-ZA01/02: no double-send — a second dispatch after success does not re-send', async () => {
    const d = draftAndApprove()
    const m = mockAdapter()
    await dispatchZstSend(getDb(), m.adapter, dispatchInput(d), T0 + 2)
    // second dispatch of the same ledger row: terminal VERIFIED → no send
    const res2 = await dispatchZstSend(getDb(), m.adapter, dispatchInput(d), T0 + 3)
    expect(m.sent).toHaveLength(1) // still one
    expect(res2.action?.status).toBe('VERIFIED')
  })

  it('AT-ZA02: a send with UNKNOWN outcome does not blind-resend (recovers via readback)', async () => {
    const d = draftAndApprove()
    // first attempt: send throws with no reachedProvider hint → OUTCOME_UNKNOWN
    const m1 = mockAdapter({ sendThrows: new Error('timeout') })
    const r1 = await dispatchZstSend(getDb(), m1.adapter, dispatchInput(d), T0 + 2)
    expect(r1.action?.status).toBe('OUTCOME_UNKNOWN')
    // recovery: readback says it DID land → VERIFIED, and no new send() happened
    const m2 = mockAdapter({ readback: { found: true } })
    const r2 = await dispatchZstSend(getDb(), m2.adapter, dispatchInput(d), T0 + 3)
    expect(r2.action?.status).toBe('VERIFIED')
    expect(m2.sent).toHaveLength(0) // recovered by readback, NOT resent
  })

  it('rejectZstSend cancels a planned, not-yet-sent row', () => {
    const db = getDb()
    const d = draftZstSend(db, { caseId: 'ZST-ACC-1', templateId: 't', email: EMAIL }, T0)
    const a = rejectZstSend(db, d.ledgerId, 'owner aborted', T0 + 1)
    expect(a.status).toBe('CANCELLED')
  })
})
