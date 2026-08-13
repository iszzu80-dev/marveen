/**
 * The private-domain LOW findings from the 2026-08-13 code review.
 *
 * Small individually; the reason they are here rather than on a "someday" list
 * is that three of them put a WRONG FACT in front of a person — a number in a
 * letter to a counterparty, a plan that promises autonomy the engine refuses,
 * a mail body with its halves swapped — and two remove a silent failure.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { planFromEvidence } from '../cos/evidence-planner.js'
import { CONFIDENCE_THRESHOLDS } from '../cos/reader-arbitration.js'
import { decodeMessage } from '../cos/gmail-thread-read.js'
import { DiscoverCarsAdapter } from '../cos/adapters/discovercars.js'
import { buildRawMessage, stripHeaderBreaks } from '../cos/adapters/gmail-api-transport.js'
import { draftFollowUp, sweepFollowUpCandidates } from '../cos/followup-autodraft.js'
import { storeDocument, setDocumentShareable } from '../cos/cos-documents.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'

const packet = (confidence: number): ReaderEvidencePacket => ({
  caseId: 'P1', domain: 'personal',
  readSources: ['doc:1'], unreadableSources: [],
  facts: [{ statement: 'x', sourceRef: 'doc:1' } as never],
  missingRequirements: [],
  ballHolder: 'MARVEEN',
  candidateDecision: 'CONTINUE_AUTONOMOUSLY',
  confidence,
  uncertainty: [],
})

describe('the plan and the arbiter agree on one confidence floor', () => {
  it('does not promise autonomy at a confidence the arbiter would refuse', () => {
    // 0.65 sat between the planner's 0.6 and the arbiter's 0.7: the stored plan
    // said "can proceed on its own" about a step the engine then declined.
    const floor = CONFIDENCE_THRESHOLDS.CONTINUE_AUTONOMOUSLY!
    expect(floor).toBe(0.7)
    expect(planFromEvidence(packet(0.65)).nextBestAction?.canProceedAutonomously).toBe(false)
  })

  it('still allows it at or above the shared floor', () => {
    expect(planFromEvidence(packet(0.7)).nextBestAction?.canProceedAutonomously).toBe(true)
  })
})

describe('a multipart mail keeps its reading order', () => {
  it('concatenates sibling text/plain parts front to back', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
    const m = decodeMessage({
      id: 'm1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'S' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('ELSO. ') } },
          { mimeType: 'text/plain', body: { data: b64('MASODIK.') } },
        ],
      },
    })
    // The LIFO walk returned "MASODIK. ELSO. " — the mail read back to front.
    expect(m.body).toBe('ELSO. MASODIK.')
  })
})

describe('the rental adapter checks the dates before it goes to the network', () => {
  it('rejects a non-positive window without a single request', async () => {
    let calls = 0
    const adapter = new DiscoverCarsAdapter({
      fetchImpl: (async () => { calls++; return { json: async () => ({}) } }) as never,
    })
    await expect(adapter.search({
      pickup: { countryId: 1, cityId: 1, placeId: 1 },
      dropoff: { countryId: 1, cityId: 1, placeId: 1 },
      pickupFrom: '2026-09-10 10:00', pickupTo: '2026-09-10 10:00',
      residenceCountry: 'HU',
    } as never)).rejects.toThrow(/not after pickup/)
    // It used to create the search and poll for ~30s before saying this.
    expect(calls).toBe(0)
  })
})

describe('a header value cannot end its own line', () => {
  it('strips CR/LF from the recipient', () => {
    const raw = buildRawMessage(
      { to: 'a@example.com\r\nBcc: attacker@evil.example', subject: 'S', body: 'B', headers: {} } as never,
      'marker-1', 'from@example.com', false,
    )
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).not.toMatch(/^Bcc:/m)
    expect(decoded).toContain('a@example.com Bcc: attacker@evil.example')
  })

  it('strips CR/LF from an attachment filename', () => {
    const raw = buildRawMessage(
      {
        to: 'a@example.com', subject: 'S', body: 'B', headers: {},
        attachments: [{
          filename: 'ok.pdf"\r\nBcc: attacker@evil.example', mimeType: 'application/pdf',
          contentBase64: 'AAAA',
        }],
      } as never,
      'marker-2', 'from@example.com', false,
    )
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).not.toMatch(/^Bcc:/m)
  })

  it('leaves an ordinary value alone', () => {
    expect(stripHeaderBreaks('Számla 2026/08')).toBe('Számla 2026/08')
  })
})

describe('the follow-up letter states a true number', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('does not double-prefix a subject that already says RE:', () => {
    const c = { caseId: 'c', title: 't', recipient: 'r@e.com', threadId: 'th', waitingSinceDays: 3, lastSubject: 'RE: Ajánlatkérés' }
    expect(draftFollowUp(c).subject).toBe('RE: Ajánlatkérés')
    expect(draftFollowUp({ ...c, lastSubject: 'Ajánlatkérés' }).subject).toBe('Re: Ajánlatkérés')
  })

  it('counts the days from the SEND, not from when the follow-up fell due', () => {
    const db = getDb()
    const now = 1_800_000_000
    const DAY = 86400
    const sentAt = now - 30 * DAY
    // The follow-up only became due 3 days ago — the letter must not claim the
    // inquiry went out then. It went out 30 days ago.
    db.prepare(`INSERT INTO personal_cases
      (case_id, title, case_type, status, priority, sensitivity, source_system, owner,
       waiting_on, next_action_owner, follow_up_at, gmail_thread_ids, created_at, updated_at)
      VALUES ('c1', 'Ajánlatkérés', 'OTHER', 'WAITING_EXTERNAL', 'P2', 'PERSONAL', 'test', 'istvan',
              'szallito@example.com', 'EXTERNAL', ?, ?, ?, ?)`)
      .run(now - 3 * DAY, JSON.stringify(['th-1']), sentAt, now)
    db.prepare(`INSERT INTO outbound_ledger
      (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
       external_idempotency_marker, payload, status, attempt, applied_at, created_at, updated_at)
      VALUES ('l1', 'c1', 'EMAIL_SEND', 1, 'k1', 'm1', ?, 'VERIFIED', 1, ?, ?, ?)`)
      .run(JSON.stringify({ to: 'szallito@example.com' }), sentAt, sentAt, sentAt)

    const { eligible } = sweepFollowUpCandidates(db, now, 10)
    const c = eligible.find(e => e.caseId === 'c1')
    expect(c, 'the case should be a candidate').toBeTruthy()
    expect(c!.waitingSinceDays).toBe(30)
  })

  it('reports that the scan window was exhausted instead of truncating silently', () => {
    const db = getDb()
    const now = 1_800_000_000
    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO personal_cases
        (case_id, title, case_type, status, priority, sensitivity, source_system, owner,
         follow_up_at, created_at, updated_at)
        VALUES (?, 'T', 'OTHER', 'WAITING_EXTERNAL', 'P2', 'PERSONAL', 'test', 'istvan', ?, ?, ?)`)
        .run(`x${i}`, now - i, now, now)
    }
    // limit 3 → scan window 9, and there are 10 rows.
    const { skipped } = sweepFollowUpCandidates(db, now, 3)
    expect(skipped.some(s => s.code === 'scan_window_exhausted')).toBe(true)
  })
})

describe('a document sensitivity has to be a class somebody recognises', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('refuses a made-up class instead of storing it', () => {
    const db = getDb()
    const doc = storeDocument(db, {
      namespace: 'personal', source: 'manual', bytes: Buffer.from('x'),
    }, { storeRoot: '/tmp/cos-doc-test-lowfindings' })
    expect(() => setDocumentShareable(db, doc.documentId, true, 'PUBLIKUS'))
      .toThrow(/unknown document sensitivity/)
    const row = db.prepare('SELECT sensitivity, external_share_allowed FROM cos_documents WHERE document_id = ?')
      .get(doc.documentId) as { sensitivity: string; external_share_allowed: number }
    // And the refusal is total: the share flag did not move either.
    expect(row.sensitivity).toBe('UNKNOWN')
    expect(row.external_share_allowed).toBe(0)
  })

  it('accepts both vocabularies, because a document can belong to either store', () => {
    const db = getDb()
    const doc = storeDocument(db, {
      namespace: 'zst', source: 'manual', bytes: Buffer.from('y'),
    }, { storeRoot: '/tmp/cos-doc-test-lowfindings' })
    expect(() => setDocumentShareable(db, doc.documentId, true, 'ZST_INTERNAL')).not.toThrow()
    expect(() => setDocumentShareable(db, doc.documentId, true, 'PUBLIC')).not.toThrow()
  })
})
