import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch } from '../cos/email-ingest.js'
import { ingestEmail as ingestEmailRaw } from '../cos/intake.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { planAction } from '../cos/executor.js'

// Stage 2G (2026-08-17): `ingestEmail` refuses to open a case without a durable
// triage receipt. Production writes one in the bridge before calling in; these
// tests call the layer directly, so they write the same receipt. The gate has
// its own tests in cos-stage2-semantics.test.ts — this wrapper must not be the
// only place it is exercised, or it would hide what it satisfies.
function ingestEmail(db: any, input: any, now: number) {
  // The receipt must describe the SAME verdict the intake will re-derive, or the
  // exact-fingerprint gate rejects it — which is the point of the gate.
  const withProvenance = { ...input, triageActor: 'test' }
  recordTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: null, priority: input.priority ?? null, declaredSensitivity: input.declaredSensitivity ?? null,
    actor: 'test', model: null, promptFingerprint: null,
  }, now)
  return ingestEmailRaw(db, withProvenance, now)
}


// IN-2 / §8: every processed message carries a thread id, no message is dropped
// to achieve that, and a thread id we INVENTED is never mistaken for one the
// source reported.
//
// The regression this locks down (2026-08-10, live): a feeder omitted threadId
// for one message, the column defaulted to NULL, and the acceptance criterion
// went PASS → FAIL. The NULL was not the whole cost — the message was our own
// sent letter to Modivo, so the case that sent it had no handle on its own
// thread, and Modivo's reply would have opened a SECOND case for a matter
// already WAITING_EXTERNAL.

const ACC = 'private'
const NOW = 1_700_000_000

const threadIdOf = (messageId: string) =>
  getDb().prepare(`SELECT thread_id, thread_id_derived FROM email_processing WHERE gmail_account_id=? AND message_id=?`)
    .get(ACC, messageId) as { thread_id: string | null; thread_id_derived: number } | undefined

describe('IN-2: thread id on every processed message', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an observed thread id is stored as observed', () => {
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'm1', threadId: 't1' }] }, NOW)
    expect(threadIdOf('m1')).toEqual({ thread_id: 't1', thread_id_derived: 0 })
  })

  it('a missing thread id is DERIVED from the message id, never left NULL', () => {
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'm-no-thread' }] }, NOW)
    // In Gmail a thread-opening message has threadId == its own id, so this is
    // usually the true value — but it was not observed, and the row says so.
    expect(threadIdOf('m-no-thread')).toEqual({ thread_id: 'm-no-thread', thread_id_derived: 1 })
  })

  it('the derived flag is what separates the two — the thread id alone cannot', () => {
    // A message whose real thread genuinely equals its id (thread opener) and a
    // message whose thread was invented store the SAME thread_id. Without the
    // flag nothing downstream can tell a reported value from a fallback.
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'opener', threadId: 'opener' }, { messageId: 'guessed' }] }, NOW)
    const observed = threadIdOf('opener')!
    const guessed = threadIdOf('guessed')!
    // Both rows satisfy thread_id == message_id, so that property distinguishes
    // nothing. Only the flag does.
    expect(observed.thread_id).toBe('opener')
    expect(guessed.thread_id).toBe('guessed')
    expect(observed.thread_id_derived).toBe(0)
    expect(guessed.thread_id_derived).toBe(1)
  })

  it('no batch can leave a NULL thread id behind, whatever the caller passes', () => {
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'a', threadId: 'ta' }, { messageId: 'b' }, { messageId: 'c', threadId: 'tc' }] }, NOW)
    const nulls = getDb().prepare(`SELECT COUNT(*) AS n FROM email_processing WHERE thread_id IS NULL`).get() as { n: number }
    expect(nulls.n, 'the acceptance criterion counts exactly this').toBe(0)
  })

  it('mail is never dropped to satisfy the invariant — a thread-less candidate still opens a case', () => {
    // The permissive direction, restated as a test because the first version of
    // this fix threw here and would have traded mail loss for tidiness.
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'no-thread' }] }, NOW)
    const res = ingestEmail(getDb(), {
      accountId: ACC, messageId: 'no-thread', subject: 'Számla', from: 'a@b.hu',
      snippet: 'fizetési határidő', actionable: true, caseType: 'FINANCE', title: 'Számla',
      direction: 'INBOUND',
    }, NOW)
    expect(res.outcome).toBe('CASE_CREATED')
  })

  it('re-discovery is still one row when the SAME message arrives with and without a thread', () => {
    // Not a claim that the composite key does this: it does not. A NULL (and
    // now a derived) thread_id makes UNIQUE(account, thread_id, message_id)
    // treat the two arrivals as different rows. What holds the line is the
    // separate uq_email_processing_msg index on (account, message_id) that the
    // A.3 migration added alongside the wide key. This test exists to keep that
    // index load-bearing — deleting it as "redundant with the composite key"
    // would pass every other test in the suite.
    openBatch(getDb(), { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'dup' }] }, NOW)
    openBatch(getDb(), { batchId: 'b2', accountId: ACC, cursorBefore: 'c1', cursorAfter: 'c2',
      messages: [{ messageId: 'dup', threadId: 'real-thread' }] }, NOW + 10)
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM email_processing WHERE gmail_account_id=? AND message_id='dup'`)
      .get(ACC) as { n: number }
    expect(n.n).toBe(1)
  })
})

describe('a case recognises the reply to its own letter', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('links an incoming message to the case whose SENT letter landed in that thread', () => {
    const db = getDb()
    // A case created without any thread of its own — exactly the live shape of
    // PRI-CLAIM-2026-001, whose gmail_thread_ids was NULL after the pilot send.
    createCase(db, { caseId: 'PRI-CLAIM-X', title: 'Reklamáció', caseType: 'CLAIM', status: 'WAITING_EXTERNAL' }, NOW)
    const action = planAction(db, {
      caseId: 'PRI-CLAIM-X', actionType: 'EMAIL_SEND', sequenceNumber: 1,
      payload: { to: 'reklamacio@modivo.hu', subject: 'Re: reklamáció', body: 'szöveg' },
      recipient: 'reklamacio@modivo.hu',
    }, NOW)
    // What the executor records when the provider reports which thread it used.
    db.prepare(`UPDATE outbound_ledger SET thread_ref='thread-42', external_ref='msg-out' WHERE ledger_id=?`)
      .run(action.ledgerId)

    openBatch(db, { batchId: 'b-reply', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'their-reply', threadId: 'thread-42' }] }, NOW + 100)
    const res = ingestEmail(db, {
      accountId: ACC, messageId: 'their-reply', threadId: 'thread-42',
      subject: 'Re: reklamáció', from: 'reklamacio@modivo.hu', snippet: 'megkaptuk',
      actionable: true, caseType: 'CLAIM', title: 'Válasz', direction: 'INBOUND',
    }, NOW + 100)

    expect(res.outcome, 'the answer to our own letter must not open a second case').toBe('LINKED_DUPLICATE')
    expect(res.caseId).toBe('PRI-CLAIM-X')
    const cases = db.prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get() as { n: number }
    expect(cases.n).toBe(1)
  })

  it('does not link through a ledger row of a CLOSED case', () => {
    const db = getDb()
    createCase(db, { caseId: 'PRI-OLD', title: 'Régi', caseType: 'CLAIM', status: 'COMPLETED' }, NOW)
    const action = planAction(db, {
      caseId: 'PRI-OLD', actionType: 'EMAIL_SEND', sequenceNumber: 1,
      payload: { to: 'x@y.hu', subject: 's', body: 'b' }, recipient: 'x@y.hu',
    }, NOW)
    db.prepare(`UPDATE outbound_ledger SET thread_ref='thread-old' WHERE ledger_id=?`).run(action.ledgerId)

    openBatch(db, { batchId: 'b2', accountId: ACC, cursorBefore: null, cursorAfter: 'c2',
      messages: [{ messageId: 'later', threadId: 'thread-old' }] }, NOW + 100)
    const res = ingestEmail(db, {
      accountId: ACC, messageId: 'later', threadId: 'thread-old', subject: 'Új ügy',
      from: 'x@y.hu', snippet: 'másik dolog', actionable: true, caseType: 'CLAIM',
      title: 'Új', direction: 'INBOUND',
    }, NOW + 100)
    // A finished case must not silently swallow new mail on an old thread.
    expect(res.outcome).toBe('CASE_CREATED')
  })
})
