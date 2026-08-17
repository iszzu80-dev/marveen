import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getCase, createCase } from '../cos/case-store.js'
import { openBatch } from '../cos/email-ingest.js'
import { ingestEmail as ingestEmailRaw } from '../cos/intake.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { IDEMPOTENCY_HEADER } from '../cos/adapters/gmail-send.js'
import { linkedCases } from '../cos/case-link.js'

// COS email → case intake. Proves the inbound behavior: noise is excluded, an
// actionable email becomes a case with the escalated sensitivity, a message
// gets LOCAL_APPLIED with its case_id, and a second email on the same thread
// links to the existing case as a DUPLICATE.

const ACC = 'iszzu80', NOW = 1_000_000

// Stage 2G (2026-08-17): `ingestEmail` now refuses to open a case without a
// durable triage receipt. Production always has one — the bridge writes it
// before calling in — so these tests, which call the layer directly, write the
// same receipt first. The gate itself is proven separately in
// cos-triage-provenance.test.ts; shadowing it here would hide it.
function ingestEmail(db: any, input: any, now: number) {
  // The receipt must describe the SAME verdict the intake will re-derive, or the
  // exact-fingerprint gate rejects it — which is the point of the gate.
  const withProvenance = { ...input, triageActor: 'test' }
  recordTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: null, priority: null, declaredSensitivity: input.declaredSensitivity ?? null,
    actor: 'test', model: null, promptFingerprint: null,
  }, now)
  return ingestEmailRaw(db, withProvenance, now)
}

function discover(messageId: string, threadId?: string) {
  openBatch(getDb(), { batchId: `b-${messageId}`, accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId, threadId }] }, NOW)
}
function msgStatus(messageId: string) {
  return (getDb().prepare(`SELECT status, case_id FROM email_processing WHERE gmail_account_id=? AND message_id=?`).get(ACC, messageId) as any)
}

describe('COS email intake', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('non-actionable email → EXCLUDED, no case', () => {
    discover('m1')
    const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm1', subject: 'Newsletter', from: 'promo@x.com', snippet: 'sale', actionable: false }, NOW)
    expect(r.outcome).toBe('EXCLUDED')
    expect(msgStatus('m1').status).toBe('EXCLUDED')
  })

  it('actionable email → case created, message LOCAL_APPLIED with case_id', () => {
    discover('m2', 't2')
    const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm2', threadId: 't2', subject: 'Ajánlatkérés', from: 'vendor@x.com', snippet: 'kérem az árat', actionable: true, caseType: 'QUOTE' }, NOW)
    expect(r.outcome).toBe('CASE_CREATED')
    const c = getCase(getDb(), r.caseId!)!
    expect(c.title).toBe('Ajánlatkérés')
    expect(c.case_type).toBe('QUOTE')
    expect(c.source_references).toBe('m2')
    const m = msgStatus('m2')
    expect(m.status).toBe('LOCAL_APPLIED')
    expect(m.case_id).toBe(r.caseId)
  })

  it('escalates sensitivity from the content (declared PERSONAL, content has a card → HIGHLY_SENSITIVE)', () => {
    discover('m3', 't3')
    const r = ingestEmail(getDb(), { accountId: ACC, messageId: 'm3', threadId: 't3', subject: 'Fizetés', from: 'x@y.z', snippet: 'a kártyaszám 4111 1111 1111 1111', actionable: true, declaredSensitivity: 'PERSONAL' }, NOW)
    expect(r.sensitivity).toBe('HIGHLY_SENSITIVE')
    expect(getCase(getDb(), r.caseId!)!.sensitivity).toBe('HIGHLY_SENSITIVE')
  })

  it('a second email on the same thread links as DUPLICATE to the existing case', () => {
    const db = getDb()
    discover('m4', 'shared-thread')
    const first = ingestEmail(db, { accountId: ACC, messageId: 'm4', threadId: 'shared-thread', subject: 'Ügy', from: 'a@b.c', snippet: 'x', actionable: true }, NOW)
    discover('m5', 'shared-thread')
    const second = ingestEmail(db, { accountId: ACC, messageId: 'm5', threadId: 'shared-thread', subject: 'Re: Ügy', from: 'a@b.c', snippet: 'y', actionable: true }, NOW)
    expect(second.outcome).toBe('LINKED_DUPLICATE')
    expect(second.caseId).toBe(first.caseId)
    expect(msgStatus('m5').status).toBe('DUPLICATE')
    expect(msgStatus('m5').case_id).toBe(first.caseId)
  })

  it("self-event filter: the COS's own automated send (idempotency marker) is EXCLUDED, no case", () => {
    discover('m6')
    const r = ingestEmail(getDb(), {
      accountId: ACC, messageId: 'm6', subject: 'Quote request', from: 'me', snippet: 'x', actionable: true,
      headers: { [IDEMPOTENCY_HEADER]: 'mv-c1-EMAIL_SEND-1' }, // our own send
    }, NOW)
    expect(r.outcome).toBe('EXCLUDED_SELF_SEND')
    expect(msgStatus('m6').status).toBe('EXCLUDED')
    expect(msgStatus('m6').case_id ?? null).toBeNull()
  })

  it('OUTBOUND (email Istvan sent) → case in WAITING_EXTERNAL with a follow-up', () => {
    discover('m7', 't7')
    const r = ingestEmail(getDb(), {
      accountId: ACC, messageId: 'm7', threadId: 't7', subject: 'Ajánlatkérés a peremelemre', from: 'iszzu80@gmail.com',
      to: 'vendor@example.com', snippet: 'kérem az árat', actionable: true, direction: 'OUTBOUND', followUpAt: NOW + 259200,
    }, NOW)
    expect(r.outcome).toBe('CASE_CREATED')
    const c = getCase(getDb(), r.caseId!)!
    expect(c.status).toBe('WAITING_EXTERNAL')       // ball is with the recipient
    expect(c.description).toMatch(/Sent to: vendor@example.com/)
    expect(c.waiting_on).toMatch(/reply from vendor@example.com/)
    expect(c.follow_up_at).toBe(NOW + 259200)
  })
})

// P7 (review 2026-08-13). Intake auto-linked every STRONG candidate found in
// `subject + snippet` — text written by whoever sent the mail. A sender who
// names another case's order number therefore got the two cases wired together,
// deterministically, with nobody in the loop. Auto-linking now additionally
// requires the identifier to appear in a field the owner or this system wrote.
describe('a stranger cannot wire the case graph', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an order number quoted by an unrelated sender is SUGGESTED, not linked', () => {
    const db = getDb()
    // The victim case was itself born from a correspondent's mail, so its title
    // and description are sender-authored.
    createCase(db, { caseId: 'PRI-CLAIM-1', title: 'eCipő reklamáció 120001419444', caseType: 'ADMIN', description: 'rendelésszám 120001419444' }, NOW - 100)
    discover('m-attack', 't-attack')
    const r = ingestEmail(db, {
      accountId: ACC, messageId: 'm-attack', threadId: 't-attack',
      subject: 'Számla a 120001419444 rendeléshez', from: 'idegen@valahol.hu',
      snippet: 'kérem az utalást', actionable: true,
    }, NOW)
    expect(r.outcome).toBe('CASE_CREATED')
    expect(linkedCases(db, 'PRI-CLAIM-1'), 'no link may be written').toEqual([])
    expect(linkedCases(db, r.caseId!)).toEqual([])
    // …but it is on the record, so a human can see what was proposed.
    const ev = db.prepare(
      `SELECT reason FROM personal_case_events WHERE event_type='CASE_LINK_SUGGESTED'`,
    ).all() as Array<{ reason: string }>
    expect(ev).toHaveLength(1)
    expect(ev[0].reason).toContain('PRI-CLAIM-1')
    expect(ev[0].reason).toContain('120001419444')
  })

  it('an identifier the OWNER recorded on the case still auto-links', () => {
    // The counter-check: the feature this narrowing must not delete.
    const db = getDb()
    createCase(db, { caseId: 'PRI-CLAIM-2', title: 'eCipő reklamáció', caseType: 'ADMIN' }, NOW - 100)
    db.prepare(`UPDATE personal_cases SET waiting_on='visszatérítés a 120001419444 rendelésre' WHERE case_id='PRI-CLAIM-2'`).run()
    discover('m-gls', 't-gls')
    const r = ingestEmail(db, {
      accountId: ACC, messageId: 'm-gls', threadId: 't-gls',
      subject: 'Csomagfelvétel', from: 'noreply@gls.hu',
      snippet: 'a 120001419444 rendeléshez tartozó csomagot felvettük', actionable: true,
    }, NOW)
    expect(linkedCases(db, 'PRI-CLAIM-2')).toContain(r.caseId)
    expect(linkedCases(db, r.caseId!)).toContain('PRI-CLAIM-2')
  })
})

describe('recognising our own sent letter (2026-08-10)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a message the COS sent does NOT open a second case — it links to the original', () => {
    // The triage feeder reads Gmail by search and carries no headers, so the
    // header-based self-event filter never fires on it. A letter the system sent
    // came back through Sent as an ordinary candidate and would have opened a
    // second case for a matter already waiting.
    const db = getDb()
    createCase(db, { caseId: 'PRI-CLAIM-1', title: 'Reklamáció', caseType: 'ADMIN' }, NOW - 100)
    db.prepare(
      `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
         internal_idempotency_key, status, external_ref, created_at, updated_at)
       VALUES ('l1','PRI-CLAIM-1','EMAIL_SEND',1,'k1','APPLIED_UNVERIFIED','msg-sajat',?,?)`
    ).run(NOW, NOW)
    discover('msg-sajat')

    const r = ingestEmail(getDb(), {
      accountId: ACC, messageId: 'msg-sajat', subject: 'Re: Reklamáció',
      from: 'iszzu80@gmail.com', snippet: 'A csomagot feladtam', actionable: true,
      caseType: 'ADMIN', title: 'Saját levél', direction: 'OUTBOUND',
    }, NOW)

    expect(r.outcome).toBe('LINKED_DUPLICATE')
    expect(r.caseId).toBe('PRI-CLAIM-1')
    // and no new case was created
    expect(db.prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get()).toMatchObject({ n: 1 })
  })

  it('an ordinary inbound message is unaffected', () => {
    discover('msg-kulso')
    const r = ingestEmail(getDb(), {
      accountId: ACC, messageId: 'msg-kulso', subject: 'Árajánlat',
      from: 'valaki@mas.hu', snippet: 'Küldöm az árat', actionable: true,
      caseType: 'QUOTE', title: 'Árajánlat', direction: 'INBOUND',
    }, NOW)
    expect(r.outcome).toBe('CASE_CREATED')
  })
})
