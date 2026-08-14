// F-6 (review 2026-08-10): the live PERSONAL send door hardcoded
// `declaredSensitivity: 'PERSONAL'`, so a case the store marks HIGHLY_SENSITIVE
// was handed to the dispatch gate as ordinary personal mail. §10 forbids exactly
// this downgrade, and §19 lists "sensitivity-downgrade attempt" as a critical
// alert. The ZST door three functions up already joined its case table for this
// column — the asymmetry was the tell.
//
// These tests go through dispatchApproved(), the function the HTTP route calls,
// not through the domain layer, because the defect was that the door and the
// domain disagreed.
//
// HONEST SCOPE (do not let this file imply more than it proves): with
// targetProfile hardcoded to 'premium_reasoning' — the one profile allowed at
// EVERY tier (sensitivity.ts PROFILE_ALLOWLIST) — the tier does not change
// allow/block on this path today. What the fix restores is that the tier is
// TRUE: it is reported truthfully, it is what an escalating content classifier
// escalates FROM, and it will block the day this path declares any other
// profile. A test asserting "HIGHLY_SENSITIVE is now refused" would be a test
// that fires on the wrong reason.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector } from '../cos/connector-health.js'
import { draftSend, approveSend } from '../cos/send-flow.js'
import { dispatchApproved } from '../web/routes/cos.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'vendor@example.com', subject: 'Ajanlatkeres', body: 'Kerem az arajanlatot.' }

function setup(sensitivity: string) {
  initDatabase(':memory:')
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'QUOTE' }, T0)
  db.prepare('UPDATE personal_cases SET sensitivity = ? WHERE case_id = ?').run(sensitivity, 'c1')
  registerConnector(db, 'gmail', 'email', 'READ_WRITE', T0)
  const d = draftSend(db, { origin: 'owner', caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
  approveSend(db, { initiatedBy: 'human',
    campaignId: d.campaignId, templateHash: d.templateHash,
    renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
  }, T0)
  return { db, ledgerId: d.ledgerId }
}

describe('the live personal send door carries the case sensitivity (F-6)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a HIGHLY_SENSITIVE case reaches the gate as HIGHLY_SENSITIVE, not PERSONAL', async () => {
    const { db, ledgerId } = setup('HIGHLY_SENSITIVE')
    const r = await dispatchApproved(db, ledgerId, T0 + 1)
    expect(r.sensitivityTier).toBe('HIGHLY_SENSITIVE')
  })

  it('a SENSITIVE_PERSONAL case is not flattened to PERSONAL either', async () => {
    const { db, ledgerId } = setup('SENSITIVE_PERSONAL')
    const r = await dispatchApproved(db, ledgerId, T0 + 1)
    expect(r.sensitivityTier).toBe('SENSITIVE_PERSONAL')
  })

  it('an ordinary PERSONAL case still reads PERSONAL — the fix is not a blanket escalation', async () => {
    const { db, ledgerId } = setup('PERSONAL')
    const r = await dispatchApproved(db, ledgerId, T0 + 1)
    expect(r.sensitivityTier).toBe('PERSONAL')
  })

  it('a ledger row whose case cannot be resolved fails CLOSED to HIGHLY_SENSITIVE', async () => {
    // Two schema facts make this the ONLY way the tier can be absent, and both
    // were checked rather than assumed: personal_cases.sensitivity is NOT NULL,
    // so an existing case always has one; and outbound_ledger.case_id carries a
    // foreign key, so it cannot point at a case that does not exist. What it CAN
    // be is NULL — a ledger row belonging to no case, which is exactly when
    // guessing PERSONAL would be worst. This is why the fix passes
    // `?? undefined` and not `?? 'PERSONAL'`: coerceSensitivity has to see the
    // absence and fall to the narrowest tier.
    const { db, ledgerId } = setup('PERSONAL')
    db.prepare('UPDATE outbound_ledger SET case_id = NULL WHERE ledger_id = ?').run(ledgerId)
    const r = await dispatchApproved(db, ledgerId, T0 + 1)
    expect(r.sensitivityTier).toBe('HIGHLY_SENSITIVE')
  })
})
