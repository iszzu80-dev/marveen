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
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { buildCaseContext, contextIntegrityViolations } from '../cos/context-builder.js'

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
