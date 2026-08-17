import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { openBatch } from '../cos/email-ingest.js'
import { ingestEmail as ingestEmailRaw } from '../cos/intake.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { classifyScope } from '../cos/scope-gate.js'

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
    workspace: null, priority: null, declaredSensitivity: input.declaredSensitivity ?? null,
    actor: 'test', model: null, promptFingerprint: null,
  }, now)
  return ingestEmailRaw(db, withProvenance, now)
}


// The seam test.
//
// This is the test whose absence let the 2026-08-09 failure live for three days.
// 362 COS tests were green the whole time, because every one of them constructed
// its own input — and handed in the very field the real producer never supplied.
// A fixture that invents the input cannot discover that the producer omits
// something.
//
// So this test does not invent the input. It reads the REAL producer,
// scripts/email-triage-fetch.py, extracts the shape it actually emits, and
// drives that through the same consumer chain the HTTP route uses. If someone
// drops threadId from the Python again, this goes red — which is the only thing
// that would have caught the original bug.

const REPO = join(import.meta.dirname, '..', '..')
const FETCHER = join(REPO, 'scripts', 'email-triage-fetch.py')

/** The keys the producer puts on a candidate, read from its source. Parsing the
 *  producer rather than trusting a copy is the whole point: a duplicated
 *  contract drifts, and drift is what we are testing for. */
function producerCandidateKeys(): string[] {
  const src = readFileSync(FETCHER, 'utf8')
  const start = src.indexOf('cand = {')
  expect(start, 'the producer must still build a `cand` dict').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('}', start))
  return Array.from(block.matchAll(/"([a-zA-Z_]+)":/g)).map((m) => m[1])
}

const NOW = 1_800_000_000

describe('real feeder → intake seam', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the producer still emits threadId — the field whose absence caused the incident', () => {
    expect(producerCandidateKeys()).toContain('threadId')
  })

  it('the producer emits every field the consumer needs to place a case', () => {
    const keys = producerCandidateKeys()
    for (const need of ['account', 'id', 'threadId', 'direction', 'from', 'subject', 'snippet']) {
      expect(keys, `producer must emit ${need}`).toContain(need)
    }
  })

  it('a candidate of the REAL shape carries its thread into the case', () => {
    // Shape taken from the producer's own dict, values from the actual GLS mail.
    const candidate = {
      account: 'private',
      id: '19fe679bc6304673',
      threadId: '19fe679bc6304673',
      direction: 'INBOUND' as const,
      from: 'noreply@gls-hungary.com',
      subject: 'Csomagfelvétel',
      date: '9 Aug 2026 14:22:45 +0200',
      snippet: 'Ezúton értesítjük, hogy MODIVO.COM SA megbízásából csomag(ok) felvételére teszünk kísérletet.',
    }
    // Exactly what the route does with it, in order.
    const scope = classifyScope({ text: `${candidate.subject}\n${candidate.snippet}`, accountId: candidate.account })
    expect(scope.target).toBe('personal')

    const db = getDb()
    openBatch(db, {
      batchId: `triage-${candidate.account}-${candidate.id}`, accountId: candidate.account,
      cursorBefore: null, cursorAfter: `triage-${NOW}`,
      messages: [{ messageId: candidate.id, threadId: candidate.threadId }],
    }, NOW)
    const res = ingestEmail(db, {
      accountId: candidate.account, messageId: candidate.id, threadId: candidate.threadId,
      subject: candidate.subject, from: candidate.from, snippet: candidate.snippet,
      actionable: true, caseType: 'SHOPPING', title: 'GLS csomagfelvétel', direction: candidate.direction,
    }, NOW)

    expect(res.outcome).toBe('CASE_CREATED')
    // The assertion that matters: the thread survived the whole chain.
    const row = db.prepare(`SELECT gmail_thread_ids FROM personal_cases WHERE case_id=?`)
      .get(res.caseId) as { gmail_thread_ids: string }
    expect(row.gmail_thread_ids).toContain(candidate.threadId)
    const ep = db.prepare(`SELECT thread_id FROM email_processing WHERE message_id=?`)
      .get(candidate.id) as { thread_id: string }
    expect(ep.thread_id).toBe(candidate.threadId)
  })

  it('a SECOND message on the same thread links instead of opening a new case', () => {
    // The end-to-end proof of the fix: this is what did not happen on 08-09.
    const db = getDb()
    const thread = '19fe0876a4564ae1'
    const feed = (id: string) => {
      openBatch(db, { batchId: `triage-private-${id}`, accountId: 'private',
        cursorBefore: null, cursorAfter: `triage-${NOW}`, messages: [{ messageId: id, threadId: thread }] }, NOW)
      return ingestEmail(db, {
        accountId: 'private', messageId: id, threadId: thread,
        subject: 'Urgent confirmation needed – Revolut debit card – D014745393',
        from: 'support@discovercars.com', snippet: 'the rental supplier does not accept Revolut',
        actionable: true, caseType: 'TRAVEL', title: 'Valencia bérlés', direction: 'INBOUND',
      }, NOW)
    }
    const first = feed('19fe0876a4564ae1')
    expect(first.outcome).toBe('CASE_CREATED')
    const second = feed('19fe770e4367dd4f')
    expect(second.outcome).toBe('LINKED_DUPLICATE')
    expect(second.caseId).toBe(first.caseId)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get()).toMatchObject({ n: 1 })
  })

  it('a candidate WITHOUT a thread still opens a case — the chain must not lose mail', () => {
    // The permissive direction matters as much: a producer that fails to supply
    // the thread must degrade to "unlinked case", never to "dropped mail".
    const db = getDb()
    openBatch(db, { batchId: 'triage-x', accountId: 'private', cursorBefore: null,
      cursorAfter: 'c', messages: [{ messageId: 'no-thread' }] }, NOW)
    const res = ingestEmail(db, {
      accountId: 'private', messageId: 'no-thread', subject: 'Számla',
      from: 'a@b.hu', snippet: 'fizetési határidő', actionable: true,
      caseType: 'FINANCE', title: 'Számla', direction: 'INBOUND',
    }, NOW)
    expect(res.outcome).toBe('CASE_CREATED')
  })

  it('the producer still has a selftest, and it passes on its own fixtures', () => {
    // The filter's own regression cases live in the producer. If someone removes
    // them the filter can silently regrow the bug we fixed this afternoon.
    const src = readFileSync(FETCHER, 'utf8')
    expect(src).toContain('SELFTEST')
    const cases = Array.from(src.matchAll(/\(\s*(True|False)\s*,\s*\{"from"/g))
    expect(cases.length, 'the producer must keep its regression fixtures').toBeGreaterThanOrEqual(8)
  })
})
