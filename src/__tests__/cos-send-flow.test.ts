import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector, setMode, recordSuccess } from '../cos/connector-health.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import {
  draftSend, approveSend, rejectSend, dispatchApprovedSend, renderedPayloadHash,
  defaultSendQuota, DEFAULT_SEND_QUOTA_MAX,
} from '../cos/send-flow.js'
import { quotaUsage } from '../cos/quota.js'
import { AS_OPERATOR, TEST_OPERATOR } from './helpers/w10-identity.js'

// #4: the COS can send an email — but ONLY after the owner's explicit per-payload
// approval AND only through the full dispatch gate. These tests PROVE the
// invariant: nothing leaves without approval, a payload edited after approval is
// rejected, and a read-only/vetoed connector blocks the send.

const NOW = 1_000_000
const EMAIL = { to: 'vendor@example.com', subject: 'Ajánlatkérés', body: 'Kérek egy árajánlatot.' }

function setup() {
  initDatabase(':memory:')
    // §22: a kuldeshez fokozat is kell; uj tipus PREPARE-en indul es nem kuldhet.
    setLadder(getDb(), 'X', { rung: 'EXECUTE_WITH_APPROVAL' }, NOW - 1000)
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'X', sensitivity: 'PERSONAL' }, NOW)
  // gmail connector write-usable (Istvan consented to gmail.send)
  registerConnector(db, 'gmail', 'email', 'READ_WRITE', NOW)
  recordSuccess(db, 'gmail', NOW)
  return db
}
function draftArgs() {
  return { caseId: 'c1', connectorId: 'gmail', templateId: 'quote-request', email: EMAIL, declaredSensitivity: 'PERSONAL', origin: 'owner' as const }
}
function dispatchArgs(d: ReturnType<typeof draftSend>) {
  return {
    ...AS_OPERATOR,
    ledgerId: d.ledgerId, campaignId: d.campaignId, connectorId: 'gmail', email: EMAIL,
    templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
    declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning', recipient: 'teszt@pelda.hu' }
}

describe('COS approval-gated send flow (#4)', () => {
  beforeEach(() => { setup() })

  it('a drafted send CANNOT be dispatched before approval (payload not authorized)', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    expect(d.status).toBe('AWAITING_APPROVAL')
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 1)
    expect(r.sent).toBe(false)
    expect(r.decision.reasons.join()).toMatch(/campaign not authorized/i)
    expect(t.sent.size).toBe(0) // <-- nothing left the building
  })

  it('draft → approve → dispatch SENDS exactly once (through the gate)', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 2)
    expect(r.decision.allowed).toBe(true)
    expect(r.sent).toBe(true)
    expect(r.action?.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })

  it('a payload EDITED after approval is rejected (rendered-hash mismatch)', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    // attacker/typo edits the body → a different rendered hash than what was approved
    const tampered = { ...EMAIL, body: EMAIL.body + ' (utólag módosítva)' }
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
      ...dispatchArgs(d), email: tampered, renderedPayloadHash: renderedPayloadHash(tampered) }, NOW + 2)
    expect(r.sent).toBe(false)
    expect(r.decision.reasons.join()).toMatch(/not authorized|no APPROVED approval/i)
    expect(t.sent.size).toBe(0)
  })

  it('rejectSend cancels the planned row → a later dispatch is a no-op', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    const cancelled = rejectSend(db, d.ledgerId, 'Istvan meggondolta magát', NOW + 2)
    expect(cancelled.status).toBe('CANCELLED')
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 3)
    expect(r.action?.status).toBe('CANCELLED') // terminal, never sent
    expect(t.sent.size).toBe(0)
  })

  it('a READ_ONLY connector blocks the send even with a valid approval', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    setMode(db, 'gmail', 'READ_ONLY', NOW + 2) // connector downgraded
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 3)
    expect(r.sent).toBe(false)
    expect(r.decision.reasons.join()).toMatch(/not write-usable/i)
    expect(t.sent.size).toBe(0)
  })

  // E2 (review 2026-08-13). The claim that serialises two dispatches of the same
  // row took its owner id from `dispatch-${ledgerId}` — deterministic, and
  // acquireClaim is re-entrant for the same owner, so both concurrent callers
  // got acquired:true with the SAME fence. The serialisation the comment claimed
  // did not exist; the only thing standing between a double-click and two sends
  // was the ledger state machine.
  it('E2: two overlapping dispatches of the same row contend — only one gets the claim', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to, envelope: { maxTotalOutbound: 5 } }, NOW + 1)
    const t = new DryRunTransport()
    // A transport that blocks inside send() until we let it go: the second
    // dispatch runs while the first is genuinely mid-flight, which is the window
    // the claim exists for.
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const slow = new GmailSendAdapter(t)
    const realSend = slow.send.bind(slow)
    let first = true
    slow.send = async (a) => { if (first) { first = false; await held } return realSend(a) }

    const p1 = dispatchApprovedSend(db, slow, dispatchArgs(d), NOW + 2)
    await new Promise((r) => setImmediate(r))
    const r2 = await dispatchApprovedSend(db, slow, dispatchArgs(d), NOW + 2)
    release()
    const r1 = await p1

    expect(r2.sent).toBe(false)
    expect(r2.decision.reasons.join()).toMatch(/mar kuldes alatt van/)
    expect(r1.sent).toBe(true)
    expect(t.sent.size).toBe(1) // <-- exactly one delivery
  })

  // E7 (review 2026-08-13). quota.ts implemented a correct atomic rolling-window
  // cap and NOTHING in production ever passed opts.quota — the only caller was a
  // test. There was no per-window rate limit anywhere on the live send path.
  it('E7: the default send quota is live on the dispatch door', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    const t = new DryRunTransport()
    await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 2)
    // The counter exists and moved — before this, send_quotas stayed empty
    // forever no matter how much mail went out.
    expect(quotaUsage(db, defaultSendQuota('gmail').key)).toEqual({ used: 1, max: DEFAULT_SEND_QUOTA_MAX })
  })

  it('E7: a full quota window refuses the send, and the reason reaches the caller (E18)', async () => {
    const db = getDb()
    const d = draftSend(db, draftArgs(), NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to }, NOW + 1)
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), dispatchArgs(d), NOW + 2,
      { quota: { key: 'personal:EMAIL_SEND:gmail', maxCount: 0, windowSec: 3600 } })
    expect(r.sent).toBe(false)
    expect(t.sent.size).toBe(0)
    // The gate ALLOWED it — so decision.reasons is empty and the only place the
    // refusal is legible is lastError. That was the E18 hole.
    expect(r.decision.allowed).toBe(true)
    expect(String(r.lastError)).toMatch(/quota exceeded/)
  })

  it('highly-sensitive content to a low profile is blocked (sensitivity gate)', async () => {
    const db = getDb()
    const sensitive = { to: 'x@y.z', subject: 'kártyaadatok', body: 'a kártyaszám 4111 1111 1111 1111' }
    const d = draftSend(db, { ...draftArgs(), email: sensitive }, NOW)
    approveSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: sensitive.to }, NOW + 1)
    const t = new DryRunTransport()
    const r = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
      ...dispatchArgs(d), email: sensitive, renderedPayloadHash: d.renderedPayloadHash, targetProfile: 'routine_lowcost' }, NOW + 2)
    expect(r.sent).toBe(false)
    expect(r.decision.reasons.join()).toMatch(/not allowed for sensitivity/i)
    expect(t.sent.size).toBe(0)
  })
})
