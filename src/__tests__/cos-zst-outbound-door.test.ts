// The corporate outbound door (card f832abf3, §7.3, AT-ZA).
//
// cos-zst-send.test.ts already proves the send CHAIN. This file proves the DOOR:
// the part that was missing, and whose absence made a complete, unit-tested,
// nine-test-green module a capability that did not exist. Every test here goes
// through approveAndDispatchZst() -- the function the HTTP route calls -- rather
// than through the domain functions, because the defect being fixed was
// precisely that nothing outside the tests ever called those.
//
// Nothing here reaches the network. Every case is a refusal, and
// dispatchZstSend evaluates the gate before it touches an adapter, so a refused
// send never constructs one. That is not a limitation of the test; it is the
// property being tested.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { registerConnector, setMode } from '../cos/connector-health.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import { draftZstSend, renderedPayloadHash } from '../cos/zst-send.js'
import { isProfileAllowedForZstSensitivity } from '../cos/zst-sensitivity.js'
import { approveAndDispatchZst, escalationNeedsIstvanInPerson } from '../web/routes/cos.js'
import { AS_OPERATOR, TEST_OPERATOR } from './helpers/w10-identity.js'

// The door builds its own live Gmail transport. Swapped for the in-memory
// DryRunTransport so the SUCCESS case can be driven end-to-end: the adapter, the
// executor, the readback and the ledger are all the real ones, and only the
// socket is not. Without this, "every test is a refusal" is not a choice about
// coverage, it is the only thing the file can do.
vi.mock('../cos/adapters/gmail-api-transport.js', async () => {
  const { DryRunTransport } = await import('../cos/adapters/gmail-send.js')
  return { GmailApiTransport: DryRunTransport }
})

const T0 = 1_700_000_000
const EMAIL = { to: 'zoltan@drvamosi.hu', subject: 'Üzletrész-adásvétel', body: 'Csatolva az igazolványok.' }

function draft(email = EMAIL, caseId = 'ZST-LEGAL-1') {
  return draftZstSend(getDb(), { origin: 'owner', caseId, templateId: 'zst-freeform-v1', email }, T0)
}

function approvals(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM zst_campaign_approvals').get() as { n: number }).n
}

describe('the corporate outbound door', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDb()
    createZstCase(db, { caseId: 'ZST-LEGAL-1', title: 'Üzletrész-adásvétel', caseType: 'CONTRACT' }, T0)
    registerConnector(db, 'gmail-zst', 'email', 'READ_WRITE', T0)
  })

  // ── The case this file did not have ──────────────────────────────────────
  //
  // Every other test here asserts a refusal, and a door that only ever refuses
  // is indistinguishable from a door that is nailed shut. It WAS nailed shut:
  // dispatchZstSend read the autonomy rung of the string 'UNKNOWN' — the route
  // never passed a case type and the gate defaulted to that literal — and an
  // unknown type sits at PREPARE, which cannot SEND. So with CONTRACT raised to
  // EXECUTE_WITH_APPROVAL the door still answered "UNKNOWN fokozata PREPARE".
  // The only way that door was open in production is if somebody raised the rung
  // of 'UNKNOWN' itself in the SHARED ladder table, which would have unlocked
  // SEND for every unknown case type on the personal path too.
  //
  // The gate reads the type off the ledger row now. This test is what makes that
  // checkable: it is the only one in the corporate suite that ends with a letter
  // actually leaving.
  it('a fully approved corporate mail actually goes out — the whole door, end to end', async () => {
    const db = getDb()
    // The case's OWN type, at the rung that permits an approved send.
    setLadder(db, 'CONTRACT', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
    const d = draft()
    const res = await approveAndDispatchZst(db, d.ledgerId, d.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)

    expect(res.reasons).toBeUndefined()
    expect(res.sent).toBe(true)
    expect(res.status).toBe('VERIFIED')
    expect(res.externalRef).toBeTruthy()
    // …and the ledger says so, with the audit trail F-2 asks for.
    const row = db.prepare(
      `SELECT status, external_ref, run_id, campaign_id, recipient, campaign_version, claim_fence
       FROM zst_outbound_ledger WHERE ledger_id = ?`,
    ).get(d.ledgerId) as {
      status: string; external_ref: string | null; run_id: string | null
      campaign_id: string | null; recipient: string | null; campaign_version: number | null
      claim_fence: number | null
    }
    expect(row.status).toBe('VERIFIED')
    expect(row.external_ref).toBeTruthy()
    expect(row.recipient).toBe(EMAIL.to)
    expect(row.campaign_id).toBe(d.campaignId)
    expect(row.run_id).toBeTruthy()
    expect(approvals()).toBe(1)
  })

  it('the rung that decides is the CASE\'s, not the string "UNKNOWN"', async () => {
    // The other half of the same defect: raising 'UNKNOWN' must NOT open the
    // corporate door, because that entry is shared with the personal path, where
    // approveOutbound falls back to 'UNKNOWN' for any case type it cannot read.
    const db = getDb()
    setLadder(db, 'UNKNOWN', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
    const d = draft()
    const res = await approveAndDispatchZst(db, d.ledgerId, d.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res.sent).toBe(false)
    expect(res.reasons?.join(' ')).toMatch(/CONTRACT fokozata PREPARE/)
  })

  it('drafting writes a ledger row and sends nothing', () => {
    const d = draft()
    const row = getDb().prepare(
      'SELECT status, case_id FROM zst_outbound_ledger WHERE ledger_id = ?',
    ).get(d.ledgerId) as { status: string; case_id: string }
    expect(row.case_id).toBe('ZST-LEGAL-1')
    expect(row.status).not.toBe('VERIFIED')
    expect(approvals()).toBe(0)
  })

  it('refuses when the text changed since the owner saw it, and records no approval', async () => {
    const d = draft()
    const res = await approveAndDispatchZst(getDb(), d.ledgerId, 'sha256:stale-hash', 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res.sent).toBe(false)
    expect(res.reasons?.join(' ')).toMatch(/megváltozott/)
    // The approval must not exist: a YES to a message that no longer exists
    // would sit in the table looking exactly like a valid one.
    expect(approvals()).toBe(0)
  })

  it('refuses a recipient the owner did not authorise', async () => {
    // CHANGED 2026-08-13: the door no longer records whatever list the caller
    // supplies, so the refusal names the address the caller tried to ADD rather
    // than the drafted addressee. The property under test is unchanged — a
    // recipient the owner never saw cannot end up on the envelope, and no
    // approval is written.
    const d = draft()
    const res = await approveAndDispatchZst(
      getDb(), d.ledgerId, d.renderedPayloadHash, 'istvan', ['valaki.mas@example.com'], T0 + 5)
    expect(res.sent).toBe(false)
    expect(res.reasons?.join(' ')).toContain('valaki.mas@example.com')
    expect(approvals()).toBe(0)
  })

  it('defaults the authorised list to exactly the drafted addressee', async () => {
    // Not to "everyone on the case", and not to an empty list that means
    // anything. One YES authorises one recipient.
    const d = draft()
    await approveAndDispatchZst(getDb(), d.ledgerId, d.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    const a = getDb().prepare(
      'SELECT allowed_recipients FROM zst_campaign_approvals LIMIT 1',
    ).get() as { allowed_recipients: string } | undefined
    expect(JSON.parse(a!.allowed_recipients)).toEqual([EMAIL.to])
  })

  it('refuses when the corporate connector is not write-usable', async () => {
    const db = getDb()
    setMode(db, 'gmail-zst', 'READ_ONLY', T0 + 1)
    const d = draft()
    const res = await approveAndDispatchZst(db, d.ledgerId, d.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res.sent).toBe(false)
    expect(res.reasons?.join(' ')).toMatch(/write-usable/)
  })

  // What this pair of tests does NOT claim is the point of them.
  //
  // The first draft of this test asserted that a ZST_HIGHLY_SENSITIVE case would
  // be refused. It was not, and the reason is worth writing down:
  // PROFILE_ALLOWLIST permits 'premium_reasoning' for every tier including
  // UNKNOWN, and this door fixes targetProfile at 'premium_reasoning'. So the
  // profile layer of evaluateZstSendGate cannot refuse anything sent through
  // here, at any sensitivity. That layer governs which MODEL may process
  // content, and an owner-approved verbatim email is not processed by a model.
  //
  // Asserting a refusal that cannot happen would have been a test asserting the
  // gate is stronger than it is. So: prove the tier is carried and correct, and
  // state plainly that it does not currently bind.
  //
  // Settled 2026-08-10 (card d7e5df01): Istvan declined a second approval for
  // highly sensitive corporate mail. One binding YES is the rule.
  it('carries the case sensitivity into the decision, and escalates it on content', async () => {
    const db = getDb()
    const d = draft()
    const res = await approveAndDispatchZst(db, d.ledgerId, d.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res.sensitivityTier).toBeTruthy()

    // A stricter case reaches the decision as the stricter tier, purely by
    // moving the case's own field.
    initDatabase(':memory:')
    const db2 = getDb()
    createZstCase(db2, { caseId: 'ZST-LEGAL-1', title: 'Titkos', caseType: 'CONTRACT', sensitivity: 'ZST_HIGHLY_SENSITIVE' }, T0)
    registerConnector(db2, 'gmail-zst', 'email', 'READ_WRITE', T0)
    const d2 = draft()
    const res2 = await approveAndDispatchZst(db2, d2.ledgerId, d2.renderedPayloadHash, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res2.sensitivityTier).toBe('ZST_HIGHLY_SENSITIVE')
    expect(res2.sensitivityTier).not.toBe(res.sensitivityTier)
  })

  it('the profile layer is currently inert — recorded here so nobody assumes otherwise', () => {
    // If this ever starts failing, the allowlist got tightened and the door
    // gained a real sensitivity gate. That is a good day; update the comment
    // above and give this test teeth.
    expect(isProfileAllowedForZstSensitivity('premium_reasoning', 'ZST_HIGHLY_SENSITIVE')).toBe(true)
    expect(isProfileAllowedForZstSensitivity('premium_reasoning', 'UNKNOWN')).toBe(true)
    // …and the layer is not dead, it just does not bite this caller: a weaker
    // profile IS refused at a strict tier.
    expect(isProfileAllowedForZstSensitivity('analysis_efficient', 'ZST_HIGHLY_SENSITIVE')).toBe(false)
  })

  it('refuses a ledger row whose campaign or payload is missing', async () => {
    const db = getDb()
    const d = draft()
    db.prepare('UPDATE zst_outbound_ledger SET payload = NULL WHERE ledger_id = ?').run(d.ledgerId)
    const res = await approveAndDispatchZst(db, d.ledgerId, undefined, 'istvan', undefined, T0 + 5, TEST_OPERATOR)
    expect(res.sent).toBe(false)
    expect(res.reasons?.join(' ')).toMatch(/hiányzik/)
    expect(approvals()).toBe(0)
  })

  it('the payload hash the door computes matches the one the draft advertised', () => {
    // If these two ever drift, every approval silently stops matching and the
    // door refuses everything -- a failure that looks like a gate working.
    const d = draft()
    expect(renderedPayloadHash(EMAIL)).toBe(d.renderedPayloadHash)
  })
})


// ── The Product Lab escalation door ───────────────────────────────────────
//
// zst-productlab.ts had the same problem as zst-send.ts: complete, tested, and
// imported by nothing, so zst_product_escalations could never have a row. The
// door is three endpoints; the part worth testing on its own is the one place
// where opening a door could have weakened a rule.
describe('the escalation door does not let HTTP spell its way past the hard gate', () => {
  const HARD = { target_workspace: 'ZST', request_type: 'CONTRACT' }
  const SOFT = { target_workspace: 'ZST', request_type: 'REVIEW' }

  it('refuses ACCEPT on a commitment-bearing escalation', () => {
    // transitionEscalation would allow this if the caller simply wrote
    // actor: 'istvan' -- which anything holding the dashboard token can do.
    expect(escalationNeedsIstvanInPerson(HARD, 'ACCEPTED')).toBe(true)
  })

  it('does not stand in the way of anything else', () => {
    expect(escalationNeedsIstvanInPerson(HARD, 'ACKNOWLEDGED')).toBe(false)
    expect(escalationNeedsIstvanInPerson(HARD, 'REJECTED')).toBe(false)
    expect(escalationNeedsIstvanInPerson(SOFT, 'ACCEPTED')).toBe(false)
    expect(escalationNeedsIstvanInPerson(undefined, 'ACCEPTED')).toBe(false)
  })

  it('every commitment-bearing request type is covered, not just the one I tested', () => {
    for (const t of ['PAID_SERVICE', 'LICENSE', 'SUBCONTRACTOR', 'CONTRACT', 'SIGNIFICANT_COST']) {
      expect(escalationNeedsIstvanInPerson({ target_workspace: 'ZST', request_type: t }, 'ACCEPTED'),
        `${t} must need Istvan`).toBe(true)
    }
  })
})
