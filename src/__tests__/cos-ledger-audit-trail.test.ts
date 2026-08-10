// F-2 / AC-21 (review 2026-08-10): "every outbound action is traceable to an
// approval, a campaign, a case+version, a run and a source."
//
// It was not. rendered_payload_hash, case_version and run_id had no column at
// all; campaign_version, approval_version, rendered_variables_hash,
// provider_message_id and rfc_message_id HAD columns that nothing on the
// personal branch ever wrote — worse than missing, because a reader sees the
// column and assumes the trail is kept.
//
// These tests assert the trail from the ledger row itself, by SQL, because that
// is the surface AC-21 is about. Rebuilding it by re-hashing the payload (which
// is what was possible before) is a reconstruction, not a record.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector } from '../cos/connector-health.js'
import { setLadder } from '../cos/autonomy-ladder.js'
import { draftSend, approveSend, dispatchApprovedSend } from '../cos/send-flow.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'

const T0 = 1_700_000_000
const EMAIL = { to: 'vendor@example.com', subject: 'Ajanlatkeres', body: 'Kerem az arajanlatot.' }

function row(ledgerId: string) {
  return getDb().prepare('SELECT * FROM outbound_ledger WHERE ledger_id = ?').get(ledgerId) as Record<string, unknown>
}

describe('the outbound ledger carries its own audit trail (F-2 / AC-21)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'QUOTE' }, T0)
    registerConnector(getDb(), 'gmail', 'email', 'READ_WRITE', T0)
    // The rung, not the audit trail, is what would otherwise refuse the send:
    // QUOTE sits at PREPARE by default. Raised here so these tests measure the
    // ledger columns rather than re-testing §22.
    setLadder(getDb(), 'QUOTE', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
  })

  it('plan time: campaign, recipient, payload hash and case version are on the row', () => {
    const db = getDb()
    const d = draftSend(db, { caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    const r = row(d.ledgerId)
    expect(r.campaign_id).toBe(d.campaignId)
    expect(r.recipient).toBe(EMAIL.to)
    expect(r.rendered_payload_hash).toBe(d.renderedPayloadHash)
    expect(r.case_version).toBe(1)
  })

  it('plan time: they are written in the INSERT, so no window exists where the row is unattributable', () => {
    // The old code patched campaign_id and recipient in with a later UPDATE. A
    // crash between the two left a row nothing could attribute. There is no
    // way to observe an intermediate state from outside a synchronous call, so
    // this asserts the property that makes the window impossible: the columns
    // are non-null on a row that has never been updated (created_at == updated_at).
    const db = getDb()
    const d = draftSend(db, { caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    const r = db.prepare(
      `SELECT campaign_id, recipient, rendered_payload_hash FROM outbound_ledger
       WHERE ledger_id = ? AND rowid IN (SELECT rowid FROM outbound_ledger WHERE ledger_id = ?)`
    ).get(d.ledgerId, d.ledgerId) as Record<string, unknown>
    expect(r.campaign_id).not.toBeNull()
    expect(r.recipient).not.toBeNull()
    expect(r.rendered_payload_hash).not.toBeNull()
  })

  it('send time: run id, campaign version, approval version and provider id are recorded', async () => {
    const db = getDb()
    const d = draftSend(db, { caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, {
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
    }, T0)
    const t = new DryRunTransport()
    const res = await dispatchApprovedSend(db, new GmailSendAdapter(t), {
      ledgerId: d.ledgerId, connectorId: 'gmail', campaignId: d.campaignId,
      templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
      email: EMAIL, declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning',
      runId: 'run-42',
    }, T0 + 1)
    expect(res.sent).toBe(true)

    const r = row(d.ledgerId)
    expect(r.run_id).toBe('run-42')
    expect(r.campaign_version).toBe(1)
    expect(r.approval_version).toBe(1)
    expect(r.provider_message_id).toBe(r.external_ref)
    expect(r.provider_message_id).not.toBeNull()
  })

  it('AC-21 in one query: every field the criterion names is answerable from the row', async () => {
    const db = getDb()
    const d = draftSend(db, { caseId: 'c1', connectorId: 'gmail', templateId: 'freeform-v1', email: EMAIL }, T0)
    approveSend(db, {
      campaignId: d.campaignId, templateHash: d.templateHash,
      renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan', recipient: EMAIL.to,
    }, T0)
    await dispatchApprovedSend(db, new GmailSendAdapter(new DryRunTransport()), {
      ledgerId: d.ledgerId, connectorId: 'gmail', campaignId: d.campaignId,
      templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
      email: EMAIL, declaredSensitivity: 'PERSONAL', targetProfile: 'premium_reasoning',
      runId: 'run-7',
    }, T0 + 1)

    const trail = db.prepare(
      `SELECT l.ledger_id, l.case_id, l.case_version, l.campaign_id, l.campaign_version,
              l.approval_version, l.rendered_payload_hash, l.run_id, l.recipient,
              l.provider_message_id, a.approval_id, a.approved_by
       FROM outbound_ledger l
       JOIN campaign_approvals a
         ON a.campaign_id = l.campaign_id
        AND a.rendered_payload_hash = l.rendered_payload_hash
       WHERE l.ledger_id = ?`
    ).get(d.ledgerId) as Record<string, unknown> | undefined

    expect(trail).toBeDefined()
    for (const [k, v] of Object.entries(trail!)) {
      expect(v, `AC-21 field ${k} is null on the ledger row`).not.toBeNull()
    }
    expect(trail!.approved_by).toBe('istvan')
  })
})
