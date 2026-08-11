// §10.1 Context Builder.
//
// Deterministic code, not an agent, and that is the design: this component
// decides WHAT the Reader is allowed to see, so it must not itself be steerable
// by the content it is deciding about.
//
// The assertions below are §10.1's own acceptance conditions turned into
// functions — every item carries provenance and a trust class, and a
// cross-domain item is demonstrably excluded — because "we filter by domain"
// reviewed by eye is exactly the kind of claim tonight kept disproving.
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { buildCaseContext, contextIntegrityViolations } from '../cos/context-builder.js'
import { buildReaderPrompt, READER_SYSTEM_PROMPT } from '../cos/reader.js'

const T0 = 1_700_000_000

function doc(over: Record<string, unknown> = {}) {
  const db = getDb()
  const row = {
    document_id: 'doc-1', namespace: 'personal', case_id: 'c1', source: 'email',
    source_ref: 'msg-1', filename: 'thread.txt', mime_type: 'text/plain', byte_size: 10,
    sha256: 'x', stored_path: '/tmp/x', doc_kind: 'email_thread', sensitivity: 'PERSONAL',
    external_share_allowed: 0, received_at: T0, created_at: T0, updated_at: T0,
    extracted_text: 'A szallito visszaigazolta a hataridot.', content_purged_at: null,
    ...over,
  }
  const cols = Object.keys(row).join(', ')
  const ph = Object.keys(row).map(k => '@' + k).join(', ')
  db.prepare(`INSERT INTO cos_documents (${cols}) VALUES (${ph})`).run(row)
}

describe('§10.1 Context Builder', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Medence', caseType: 'HOME_REPAIR' }, T0)
  })

  it('every item carries provenance, a trust class and a sensitivity', () => {
    doc()
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.items.length).toBeGreaterThan(0)
    expect(contextIntegrityViolations(ctx)).toEqual([])
  })

  it('the case is TRUSTED and everything from outside is UNTRUSTED', () => {
    // The distinction the Reader's whole safety rests on (§10.2, §10.3).
    doc()
    transitionCase(getDb(), { caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'm' }, T0 + 1)
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 2)
    const caseItem = ctx.items.find(i => i.kind === 'CASE')
    expect(caseItem?.trust).toBe('TRUSTED_CASE_FIELD')
    for (const i of ctx.items.filter(x => x.kind !== 'CASE')) {
      expect(i.trust).toBe('UNTRUSTED_SOURCE_DATA')
    }
  })

  it('HEADLINE: a cross-domain document is excluded, and the exclusion is VISIBLE', () => {
    // Not fetching it is not enough. An exclusion nobody can see is
    // indistinguishable from a source nobody looked for, and §10.1 asks for the
    // boundary to be demonstrable.
    doc({ document_id: 'doc-zst', namespace: 'zst' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.items.some(i => i.provenance.reference.includes('doc-zst'))).toBe(false)
    expect(ctx.excluded.some(e => e.reference === 'doc-zst' && /cross-domain/.test(e.reason))).toBe(true)
  })

  it('a purged document is excluded with its reason, not silently missing', () => {
    doc({ document_id: 'doc-purged', content_purged_at: T0 })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.excluded.some(e => e.reference === 'doc-purged' && /purged/.test(e.reason))).toBe(true)
  })

  it('the content is the extracted TEXT, not just a filename', () => {
    // A Reader handed only labels reports confidently that a thread says
    // nothing — the failure mode that looks like an answer.
    doc()
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const thread = ctx.items.find(i => i.kind === 'EMAIL_THREAD')
    expect(thread?.content).toContain('visszaigazolta')
  })

  it('sources §10.1 names but this process cannot reach are REPORTED, not absent', () => {
    // "The Reader saw no calendar entries" and "there is no calendar connector"
    // lead to different conclusions and must not look the same.
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.unavailable.map(u => u.source)).toContain('calendar')
    expect(ctx.unavailable.every(u => u.reason.length > 0)).toBe(true)
  })

  it('a document reference is ATOMIC — the origin does not travel inside it', () => {
    // Live PRI-HOME-2026-002, 2026-08-11: the ref was `doc-1 (chatgpt-cos-drive)`,
    // the Reader cited `doc-1` — correct — and the exact-match provenance check
    // refused the whole packet. The check is right; the format was wrong.
    doc({ document_id: 'doc-1', source_ref: 'chatgpt-cos-drive' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const item = ctx.items.find(i => i.kind === 'EMAIL_THREAD')!
    expect(item.provenance.reference).toBe('doc-1')
    expect(item.provenance.reference).not.toMatch(/[ ()]/)
    expect(item.provenance.sourceRef).toBe('chatgpt-cos-drive')
  })

  it('a long item is cut, and the cut says so IN the content', () => {
    // Live 2026-08-11: the item COUNT was never the binding constraint — the
    // length of one email thread was. The Reader spent its whole output budget
    // reasoning over it and never wrote the packet. The marker is in the content
    // itself because that is the only place the model can see it.
    doc({ extracted_text: 'x'.repeat(9000) })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1, { maxCharsPerItem: 1000 })
    const item = ctx.items.find(i => i.kind === 'EMAIL_THREAD')!
    expect(item.content.length).toBeLessThan(1200)
    expect(item.content).toContain('LEVÁGVA')
    expect(item.content).toContain('CSONKA')
  })

  it('an item under the ceiling is untouched', () => {
    // The counter-case: a builder that marks everything as truncated teaches the
    // Reader to ignore the marker.
    doc({ extracted_text: 'rovid szoveg' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1, { maxCharsPerItem: 1000 })
    const item = ctx.items.find(i => i.kind === 'EMAIL_THREAD')!
    expect(item.content).toContain('rovid szoveg')
    expect(item.content).not.toContain('LEVÁGVA')
  })

  it('truncation is visible', () => {
    // distinct sha256 too: the store dedups on content, which is correct and
    // would otherwise collapse these eight into one.
    for (let i = 0; i < 8; i++) doc({ document_id: `doc-${i}`, source_ref: `msg-${i}`, sha256: `sha-${i}` })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1, { maxItems: 3 })
    expect(ctx.items).toHaveLength(3)
    expect(ctx.excluded.some(e => /context bound/.test(e.reason))).toBe(true)
  })

  it('a case that does not exist yields an empty context, not a throw', () => {
    const ctx = buildCaseContext(getDb(), 'personal', 'nincs-ilyen', T0 + 1)
    expect(ctx.items).toEqual([])
    expect(ctx.caseVersion).toBeNull()
  })
})

describe('document content: the bytes on disk are content too', () => {
  // Its own setup: this block sits outside the suite above, so it does not
  // inherit that beforeEach.
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Medence', caseType: 'HOME_REPAIR' }, T0)
  })

  it('HEADLINE: a thread with NULL extracted_text still reaches the Reader', () => {
    // Measured on the live store 2026-08-11: ALL 22 stored email threads had
    // extracted_text NULL while the files on disk held the plain-text
    // conversation. The Reader therefore reported "the thread is not readable"
    // on the ZST share-transfer case — a correct answer about a letter it was
    // never shown. The judgement layer was never the bottleneck.
    const db = getDb()
    const path = '/tmp/marveen-test-thread.txt'
    const body = 'Feladó: Panos\n\nItt vannak a kert adatok.'
    writeFileSync(path, body)
    doc({
      document_id: 'doc-bytes', doc_kind: 'email_thread', mime_type: 'text/plain',
      extracted_text: null, stored_path: path,
      // The byte read is INTEGRITY-CHECKED — readDocumentBytes compares the
      // sha256 and refuses a mismatch. The first version of this fixture used a
      // placeholder sha, the check correctly rejected it, and the test failed
      // for the right reason: content that does not match its checksum is not
      // the content.
      sha256: createHash('sha256').update(Buffer.from(body)).digest('hex'),
    })
    const ctx = buildCaseContext(db, 'personal', 'c1', T0 + 1)
    const item = ctx.items.find(i => i.kind === 'EMAIL_THREAD')!
    expect(item.content).toContain('Itt vannak a kert adatok')
  })

  it('a BINARY document is not decoded into noise', () => {
    // Noise reads to a model as content. A PDF turned into mojibake would be
    // worse than the honest label.
    const path = '/tmp/marveen-test-binary.pdf'
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x01])
    writeFileSync(path, bytes)
    doc({
      document_id: 'doc-bin', doc_kind: 'other', mime_type: 'application/pdf',
      extracted_text: null, stored_path: path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const item = ctx.items.find(i => i.provenance.reference === 'doc-bin')!
    expect(item.content).toContain('[no extracted text]')
  })

  it('extracted_text still WINS when it exists', () => {
    // The column is the cheap path and the one an extractor would populate;
    // reading bytes is the fallback, not a replacement.
    doc({ document_id: 'doc-both', extracted_text: 'A kinyert szoveg.', stored_path: '/nonexistent' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const item = ctx.items.find(i => i.provenance.reference === 'doc-both')!
    expect(item.content).toContain('A kinyert szoveg.')
  })

  it('a missing file falls back to the label, not a crash', () => {
    doc({ document_id: 'doc-gone', mime_type: 'text/plain', extracted_text: null, stored_path: '/nope/nope' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const item = ctx.items.find(i => i.provenance.reference === 'doc-gone')!
    expect(item.content).toContain('[no extracted text]')
  })
})

// A CORRECTION IS NOT A CONTRADICTION (card 92843ee8).
//
// Live 2026-08-11: the Reader read event:106 ("the DoD criteria were met") and
// event:122 ("Restored from event 106: closed by the progression engine on a
// generic, self-certified DoD ... the case was never finished"), saw that they
// disagree, and escalated the disagreement to Istvan as an open contradiction —
// asking the owner to adjudicate a bug his own system had already diagnosed, and
// spending one of the five channel slots on it. The same cleanup wrote that
// reason onto 26 cases, so it was pending on all of them.
//
// The pairing is now computed here, deterministically, BEFORE the model sees the
// events. These tests are what makes that claim checkable: a prompt sentence
// asking a model to notice the pairing cannot be run red.
describe('§10.1 superseded events', () => {
  const ev = (over: Record<string, unknown> = {}) => {
    const row = {
      event_id: 1, case_id: 'c1', case_version: 1, actor: 'marveen', source_system: null,
      source_reference: null, event_type: 'STATUS_CHANGED', previous_status: 'NEW',
      new_status: 'COMPLETED', reason: null, payload: null, correlation_id: null, created_at: T0,
      ...over,
    }
    const cols = Object.keys(row).join(', ')
    const ph = Object.keys(row).map(k => '@' + k).join(', ')
    getDb().prepare(`INSERT INTO personal_case_events (${cols}) VALUES (${ph})`).run(row)
  }
  const RESTORE = 'Restored from event 106: closed by the progression engine on a generic, '
    + 'self-certified DoD (incident 2026-08-09, card 0a7574db). The case was never finished.'

  beforeEach(() => {
    initDatabase(':memory:')
    // No cleanup of the case's own creation event: personal_case_events is
    // append-only and the trigger enforces it. The ids below start at 100 so
    // they cannot collide with it.
    createCase(getDb(), { caseId: 'c1', title: 'AWS Activate', caseType: 'ADMIN' }, T0)
  })

  it('marks the corrected event, and only it', () => {
    ev({ event_id: 106, reason: 'DoD criteria met, closing.' })
    ev({ event_id: 122, reason: RESTORE, new_status: 'IN_PROGRESS' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const corrected = ctx.items.find(i => i.provenance.reference === 'event:106')!
    const corrector = ctx.items.find(i => i.provenance.reference === 'event:122')!
    expect(corrected.supersededBy?.reference).toBe('event:122')
    expect(corrected.supersededBy?.reason).toContain('never finished')
    // The correction itself is the current state. Marking it too would erase the
    // whole pair and leave the Reader with nothing to stand on.
    expect(corrector.supersededBy).toBeUndefined()
  })

  it('a case with no correction marks nothing', () => {
    // The inverse of the assertion above: if the marker appeared here it would
    // "pass" the test above for a reason that has nothing to do with the fix.
    ev({ event_id: 106, reason: 'DoD criteria met, closing.' })
    ev({ event_id: 122, reason: 'Reopened after a call.', new_status: 'IN_PROGRESS' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.items.filter(i => i.supersededBy).length).toBe(0)
  })

  it('an event cannot correct itself or anything after it', () => {
    // Backwards and self-referential claims are how one row would annul a later,
    // truer one — the exact damage the fix is supposed to prevent.
    ev({ event_id: 10, reason: 'Restored from event 99: nonsense.' })
    ev({ event_id: 20, reason: 'Restored from event 20: itself.' })
    ev({ event_id: 99, reason: 'DoD criteria met.' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.items.filter(i => i.supersededBy).length).toBe(0)
  })

  it('EXTERNAL text cannot declare a correction', () => {
    // "Restored from event 106" is four words. An incoming email containing them
    // must not be able to strike this case's real history out of the Reader's
    // view — the check is on where the row came from, not on what it says.
    ev({ event_id: 106, reason: 'DoD criteria met, closing.' })
    ev({ event_id: 122, reason: RESTORE, source_system: 'gmail', actor: 'sender@example.com' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    expect(ctx.items.find(i => i.provenance.reference === 'event:106')!.supersededBy).toBeUndefined()
  })

  it('the newest correction wins when two events correct the same one', () => {
    ev({ event_id: 106, reason: 'DoD criteria met.' })
    ev({ event_id: 122, reason: 'Restored from event 106: first pass.' })
    ev({ event_id: 140, reason: 'Restored from event 106: and this is the final reading.' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const corrected = ctx.items.find(i => i.provenance.reference === 'event:106')!
    expect(corrected.supersededBy?.reference).toBe('event:140')
  })

  it('the marker reaches the prompt in the HEADER, outside the untrusted fence', () => {
    ev({ event_id: 106, reason: 'DoD criteria met, closing.' })
    ev({ event_id: 122, reason: RESTORE, new_status: 'IN_PROGRESS' })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const prompt = buildReaderPrompt(ctx)
    const header = prompt.split('\n').find(l => l.includes('[ref=event:106]'))!
    expect(header).toContain('[SUPERSEDED_BY=event:122]')
    // A marker with no rule explaining it is decoration. The rule and the marker
    // ship together or neither is worth anything.
    expect(READER_SYSTEM_PROMPT).toContain('[SUPERSEDED_BY=ref]')
  })
})
