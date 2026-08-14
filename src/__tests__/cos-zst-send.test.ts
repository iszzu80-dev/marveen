import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createZstCase, acquireZstClaim } from '../cos/zst-case-store.js'
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
    const d = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email }, T0)
    approveZstSend(db, { initiatedBy: 'human', campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', allowedRecipients: recipients }, T0 + 1)
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

  it('F-9: an approval EXPIRES on its own — no test fixture propping up valid_until', async () => {
    // CHANGED 2026-08-13. This test used to UPDATE valid_until by hand before
    // dispatching, which proved the shared engine READS the column and proved
    // nothing about what approveZstSend WRITES into it — and what it wrote was
    // NULL, which that same engine reads as "never expires". The fixture was
    // standing in for the bug. Nothing is patched now: the approval is recorded
    // the way the door records it, and the clock does the rest.
    const db = getDb()
    const d = draftAndApprove()
    const m = mockAdapter()
    const eightDays = T0 + 8 * 24 * 3600
    const res = await dispatchZstSend(db, m.adapter, { ...dispatchInput(d), now: eightDays }, eightDays)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join(' ')).toMatch(/expired/i)
    expect(m.sent).toHaveLength(0)
  })

  it('§3.2: one YES is not a standing permission — the envelope carries a TTL and a ceiling', () => {
    // The raw INSERT this replaced left both columns NULL: never-expiring and
    // uncapped. Reproduced live before the fix — a new draft of the same payload
    // a YEAR later dispatched with no new approval.
    const d = draftAndApprove()
    const a = getDb().prepare(
      'SELECT valid_until, max_total_outbound, allowed_channels FROM zst_campaign_approvals WHERE campaign_id = ?',
    ).get(d.campaignId) as { valid_until: number | null; max_total_outbound: number | null; allowed_channels: string }
    expect(a.valid_until).toBe(T0 + 1 + 7 * 24 * 3600)
    expect(a.max_total_outbound).toBe(1)
    expect(JSON.parse(a.allowed_channels)).toEqual(['EMAIL'])
  })

  it('§3.2: a SECOND letter on the same campaign needs more than the first YES', async () => {
    // The owner approved one message. A new draft, even freshly approved, meets
    // the campaign ceiling the approval carries — a second send is a second
    // decision, and widening the ceiling is how the owner takes it.
    const db = getDb()
    const first = draftAndApprove()
    const m = mockAdapter()
    expect((await dispatchZstSend(db, m.adapter, dispatchInput(first), T0 + 2)).sent).toBe(true)

    const second = { ...EMAIL, body: 'Még egy kérdés a júliusi csomaghoz.' }
    const d2 = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: second }, T0 + 10)
    approveZstSend(db, { initiatedBy: 'human',
      campaignId: d2.campaignId, templateHash: d2.templateHash,
      renderedPayloadHash: d2.renderedPayloadHash, approvedBy: 'istvan', allowedRecipients: [EMAIL.to],
    }, T0 + 11)
    const res = await dispatchZstSend(db, m.adapter, { ...dispatchInput(d2, second), now: T0 + 12 }, T0 + 12)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join(' ')).toMatch(/quota/i)
    expect(m.sent).toHaveLength(1) // still the first one only
  })

  it('N-2: the claim and the ceilings actually reach the executor', async () => {
    // Both used to be dropped on this path: dispatchZstSend passed no claim and
    // no campaignLimit, so the executor's fence check and its in-transaction
    // ceiling count sat behind `if (opts.claim)` / `if (opts.campaignLimit)` that
    // no caller ever satisfied — and authorizeZstSend threw away the `limits` the
    // shared engine had already computed for it.
    const db = getDb()
    const d = draftAndApprove()
    const dec = evaluateZstSendGate(db, dispatchInput(d))
    expect(dec.limits?.maxTotal).toBe(1)
    expect(dec.approvalId).toBeTruthy()

    const m = mockAdapter()
    await dispatchZstSend(db, m.adapter, dispatchInput(d), T0 + 2)
    // claim_fence is written by the executor ONLY when a claim is supplied.
    const row = db.prepare('SELECT claim_fence, run_id FROM zst_outbound_ledger WHERE ledger_id = ?')
      .get(d.ledgerId) as { claim_fence: number | null; run_id: string | null }
    expect(row.claim_fence).not.toBeNull()
    expect(row.run_id).toBeTruthy()
    // …and the claim is released again, or the row could never be retried.
    const held = db.prepare('SELECT COUNT(*) AS n FROM zst_case_claims WHERE claim_key = ?')
      .get(`zst-outbound:${d.ledgerId}`) as { n: number }
    expect(held.n).toBe(0)
  })

  it('N-2: a row another run is already sending is not sent a second time', async () => {
    const db = getDb()
    const d = draftAndApprove()
    // Another worker holds the row. Its run id is NOT ours — a deterministic
    // `dispatch-${ledgerId}` run id would have matched here and handed the claim
    // straight back, which is a claim that can never refuse anyone.
    acquireZstClaim(db, { claimKey: `zst-outbound:${d.ledgerId}`, ownerRunId: 'masik-run', ttlSeconds: 120 }, T0 + 1)
    const m = mockAdapter()
    const res = await dispatchZstSend(db, m.adapter, dispatchInput(d), T0 + 2)
    expect(res.sent).toBe(false)
    expect(res.decision.reasons.join(' ')).toMatch(/küldés alatt/)
    expect(m.sent).toHaveLength(0)
  })

  it('F-1/F-2: the drafted row is attributable from birth, and the seq is MAX+1', () => {
    const db = getDb()
    const d = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: EMAIL }, T0)
    const row = db.prepare(
      `SELECT campaign_id, recipient, rendered_payload_hash, case_version, outbound_kind, sequence_number
       FROM zst_outbound_ledger WHERE ledger_id = ?`,
    ).get(d.ledgerId) as {
      campaign_id: string | null; recipient: string | null; rendered_payload_hash: string | null
      case_version: number | null; outbound_kind: string | null; sequence_number: number
    }
    expect(row.campaign_id).toBe(d.campaignId)
    expect(row.recipient).toBe(EMAIL.to)
    expect(row.rendered_payload_hash).toBe(d.renderedPayloadHash)
    expect(row.case_version).not.toBeNull()
    // Without outbound_kind the envelope's per-kind quotas count nothing at all.
    expect(row.outbound_kind).toBe('INITIAL')
    expect(row.sequence_number).toBe(1)

    // The next draft takes MAX(seq)+1 — and survives a hole in the sequence that
    // COUNT(*)+1 would have walked straight into, re-using a live number.
    const d2 = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: { ...EMAIL, body: 'másik' } }, T0 + 1)
    expect(d2.sequenceNumber).toBe(2)
    db.prepare('DELETE FROM zst_outbound_ledger WHERE ledger_id = ?').run(d.ledgerId)
    const d3 = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: { ...EMAIL, body: 'harmadik' } }, T0 + 2)
    expect(d3.sequenceNumber).toBe(3)
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
    const d = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 'accounting-package', email: EMAIL }, T0)
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
    const d = draftZstSend(db, { origin: 'owner', caseId: 'ZST-ACC-1', templateId: 't', email: EMAIL }, T0)
    const a = rejectZstSend(db, d.ledgerId, 'owner aborted', T0 + 1)
    expect(a.status).toBe('CANCELLED')
  })
})
