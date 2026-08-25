import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestTriagedEmail, type TriagedEmail } from '../cos/triage-bridge.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../cos/zst-intake.js'
import { triageReceiptsFor } from '../cos/triage-provenance.js'
import { ingestEmail } from '../cos/intake.js'

// Stage 2G activation blocker, found by Istvan on 2026-08-17 BEFORE activation:
// the Personal bridge recorded a receipt with full provenance and then built an
// intake input without it, so the exact gate would have re-derived a different
// fingerprint — and only once the fields stopped being UNDECLARED on both sides
// at once. These tests run the real bridge end to end so the seam cannot silently
// come apart again.

const NOW = 1_700_000_000

const personal = (over: Partial<TriagedEmail> = {}): TriagedEmail => ({
  accountId: 'iszzu80', messageId: 'm-e2e', threadId: 't-e2e',
  subject: 'Terasz beazas', from: 'kivitelezo@example.hu', snippet: 'Kedden mennenk.',
  actionable: true, caseType: 'HOME_REPAIR', title: 'Terasz beazas',
  priority: 'P1',
  sourceManifestHash: 'sha256:' + 'a'.repeat(64),
  triageActor: 'marveen', triageModel: 'claude-opus-5',
  triagePromptFingerprint: 'rules:deadbeefdeadbeefdeadbeefdeadbeef',
  triageDecidedAt: NOW - 5,
  ...over,
})

function ledgerRow(accountId: string, messageId: string) {
  return getDb().prepare(
    `SELECT case_id, triage_receipt_id FROM email_processing WHERE gmail_account_id=? AND message_id=?`
  ).get(accountId, messageId) as { case_id: string | null; triage_receipt_id: string | null }
}

function createdEventPayload(caseId: string) {
  const row = getDb().prepare(
    `SELECT payload FROM personal_case_events WHERE case_id=? AND event_type='CREATED'`
  ).get(caseId) as { payload: string | null } | undefined
  return row?.payload ? JSON.parse(row.payload) : null
}

describe('Stage 2G — Personal bridge end to end', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('full provenance flows bridge -> receipt -> intake -> ledger -> CREATED event', () => {
    const res = ingestTriagedEmail(getDb(), personal(), NOW)
    expect(res.outcome).toBe('CASE_CREATED')

    const receipts = triageReceiptsFor(getDb(), 'iszzu80', 'm-e2e')
    expect(receipts).toHaveLength(1)
    const receiptId = String(receipts[0].receipt_id)
    // nothing UNDECLARED: this is the state activation requires
    expect(receipts[0].actor).toBe('marveen')
    expect(receipts[0].model).toBe('claude-opus-5')
    expect(receipts[0].prompt_fingerprint).toBe('rules:deadbeefdeadbeefdeadbeefdeadbeef')
    expect(receipts[0].source_manifest_hash).toBe('sha256:' + 'a'.repeat(64))
    expect(receipts[0].priority).toBe('P1')

    const led = ledgerRow('iszzu80', 'm-e2e')
    expect(led.case_id).toBe(res.caseId)
    expect(led.triage_receipt_id).toBe(receiptId)
    expect(createdEventPayload(res.caseId!)).toEqual({ triageReceiptId: receiptId })
  })

  it('the case carries the verdict priority the receipt recorded', () => {
    const res = ingestTriagedEmail(getDb(), personal(), NOW)
    const row = getDb().prepare('SELECT priority FROM personal_cases WHERE case_id=?')
      .get(res.caseId) as { priority: string }
    expect(row.priority).toBe('P1')
    expect(triageReceiptsFor(getDb(), 'iszzu80', 'm-e2e')[0].priority).toBe('P1')
  })

  it.each(['sourceManifestHash', 'triageActor', 'triageModel', 'triagePromptFingerprint'] as const)(
    'changing %s between receipt and intake fails the exact gate', (field) => {
      const db = getDb()
      const verdict = personal({ messageId: `m-${field}`, threadId: `t-${field}` })
      // The bridge writes the receipt for THIS verdict…
      ingestTriagedEmail(db, verdict, NOW)
      // …and a second case on the same message with ONE provenance field changed
      // must not be able to open on that receipt.
      expect(() => ingestEmail(db, {
        accountId: verdict.accountId, messageId: verdict.messageId, threadId: verdict.threadId,
        subject: verdict.subject, from: verdict.from, snippet: verdict.snippet,
        actionable: verdict.actionable, caseType: verdict.caseType, title: verdict.title,
        priority: verdict.priority,
        sourceManifestHash: verdict.sourceManifestHash,
        triageActor: verdict.triageActor, triageModel: verdict.triageModel,
        triagePromptFingerprint: verdict.triagePromptFingerprint,
        [field]: 'MAS-ERTEK',
      }, NOW)).toThrow(/TRIAGE_PROVENANCE_VERDICT_MISMATCH/)
    })

  it('priority P1 receipt with a P2 intake fails closed', () => {
    const db = getDb()
    // Write the receipt through the bridge for a P1 verdict…
    ingestTriagedEmail(db, personal({ messageId: 'm-p1', threadId: 't-p1' }), NOW)
    // …then drive the intake layer directly with the SAME message but P2.
    expect(() => ingestEmail(db, {
      accountId: 'iszzu80', messageId: 'm-p1', threadId: 't-p1',
      subject: 'Terasz beazas', from: 'kivitelezo@example.hu', snippet: 'Kedden mennenk.',
      actionable: true, caseType: 'HOME_REPAIR', title: 'Terasz beazas',
      priority: 'P2',
      sourceManifestHash: 'sha256:' + 'a'.repeat(64),
      triageActor: 'marveen', triageModel: 'claude-opus-5',
      triagePromptFingerprint: 'rules:deadbeefdeadbeefdeadbeefdeadbeef',
    }, NOW)).toThrow(/TRIAGE_PROVENANCE_VERDICT_MISMATCH/)
  })

  it('the ZST path keeps its exact binding', () => {
    const db = getDb()
    const zst: ZstTriagedEmail = {
      accountId: 'zst', messageId: 'z1', threadId: 'zt1',
      subject: 'Szamla erkezett', from: 'relacio@szamlazz.hu', snippet: 'Kifizetes',
      actionable: true, caseType: 'INVOICE_INCOMING', title: 'Relacio szamla',
      priority: 'P2', workspace: 'OPERATIONS',
      sourceManifestHash: 'sha256:' + 'b'.repeat(64),
      triageActor: 'marveen', triageModel: 'claude-opus-5',
      triagePromptFingerprint: 'rules:deadbeefdeadbeefdeadbeefdeadbeef',
    }
    const res = ingestTriagedZstEmail(db, zst, NOW)
    expect(res.outcome).toBe('CASE_CREATED')
    const receiptId = String(triageReceiptsFor(db, 'zst', 'z1')[0].receipt_id)
    const led = db.prepare(
      `SELECT case_id, triage_receipt_id FROM zst_email_processing WHERE gmail_account_id=? AND message_id=?`
    ).get('zst', 'z1') as { case_id: string; triage_receipt_id: string }
    expect(led.case_id).toBe(res.caseId)
    expect(led.triage_receipt_id).toBe(receiptId)
  })
})
