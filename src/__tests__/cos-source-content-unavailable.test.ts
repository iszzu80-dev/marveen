import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  linkCaseSource, getCaseDossier, findCasesForSource,
  markSourceContentUnavailable, markSourceContentAvailable,
} from '../cos/case-sources.js'

// A SOURCE THAT VANISHED IS STILL A SOURCE.
//
// Measured on the live store 2026-09-04: three threads had been abandoned after
// three 404s each, and their eleven-odd links still read as ordinary healthy
// CANONICAL rows. The dossier said the case was about those conversations; one
// could no longer be opened, and nothing anywhere said so.
//
// The requirement (owner, Priority 1/B): "404/eltűnt source = relation retained
// + CONTENT_UNAVAILABLE". Both halves, and the first half is why this is not
// simply a REJECTED link.

const NOW = 1_000_000
const src = { namespace: 'personal' as const, caseId: 'PRI-SEC-2026-001', sourceType: 'GMAIL_THREAD' as const, sourceRef: 'thread-gone' }

beforeEach(() => {
  initDatabase(':memory:')
  linkCaseSource(getDb(), {
    ...src, linkMethod: 'EXPLICIT_RELATION',
    evidence: 'fixture: the case was about this conversation', discoveredBy: 'test',
  }, NOW)
})

const link = () => getCaseDossier(getDb(), 'personal', src.caseId).canonical.find(l => l.sourceRef === 'thread-gone')!

describe('marking a source gone', () => {
  it('starts AVAILABLE — absence of a "gone" record IS the claim it is not', () => {
    expect(link().contentState).toBe('AVAILABLE')
    expect(link().contentCheckedAt).toBeNull()
  })

  it('records the loss without touching the relation', () => {
    const before = link()
    markSourceContentUnavailable(getDb(), { ...src, note: 'thread fetch failed: 404 after 3 attempts' }, NOW + 60)
    const after = link()

    expect(after.contentState).toBe('CONTENT_UNAVAILABLE')
    expect(after.contentNote).toContain('404')
    expect(after.contentCheckedAt).toBe(NOW + 60)
    // RELATION RETAINED — the half that makes this not a REJECTED link:
    expect(after.linkState).toBe(before.linkState)
    expect(after.linkMethod).toBe(before.linkMethod)
    expect(after.evidence).toBe(before.evidence)
  })

  it('the case still claims it, and it still claims the case', () => {
    markSourceContentUnavailable(getDb(), { ...src, note: 'gone' }, NOW + 60)
    const d = getCaseDossier(getDb(), 'personal', src.caseId)
    expect(d.byType.GMAIL_THREAD).toContain('thread-gone')       // still a source
    expect(findCasesForSource(getDb(), 'personal', 'GMAIL_THREAD', 'thread-gone').map(l => l.caseId))
      .toContain(src.caseId)                                      // still claimed
  })

  it('and a reader can SEE it is gone — the thing that was missing', () => {
    markSourceContentUnavailable(getDb(), { ...src, note: 'thread fetch failed: 404' }, NOW + 60)
    const d = getCaseDossier(getDb(), 'personal', src.caseId)
    expect(d.unavailable.map(l => l.sourceRef)).toEqual(['thread-gone'])
    expect(d.unavailable[0].contentNote).toContain('404')
  })

  it('refuses a mark with no note — an uncheckable claim is what evidence exists to prevent', () => {
    expect(() => markSourceContentUnavailable(getDb(), { ...src, note: '  ' }, NOW))
      .toThrow(/note is required/)
    expect(link().contentState).toBe('AVAILABLE')   // and nothing was written
  })

  it('a second mark keeps the FIRST timestamp — when it was found missing, not when confirmed', () => {
    markSourceContentUnavailable(getDb(), { ...src, note: 'gone' }, NOW + 60)
    const r = markSourceContentUnavailable(getDb(), { ...src, note: 'still gone' }, NOW + 9999)
    expect(r.changed).toBe(false)
    expect(link().contentCheckedAt).toBe(NOW + 60)
  })

  it('marking a link that does not exist changes nothing and does not throw', () => {
    const r = markSourceContentUnavailable(getDb(),
      { ...src, sourceRef: 'never-linked', note: 'gone' }, NOW)
    expect(r.changed).toBe(false)
  })
})

describe('coming back', () => {
  it('a restored source clears the state AND the stale note', () => {
    markSourceContentUnavailable(getDb(), { ...src, note: 'gone since March' }, NOW + 60)
    const r = markSourceContentAvailable(getDb(), src, NOW + 120)
    expect(r.changed).toBe(true)
    expect(link().contentState).toBe('AVAILABLE')
    expect(link().contentNote).toBeNull()   // "gone since March" on a living source is worse than nothing
    expect(getCaseDossier(getDb(), 'personal', src.caseId).unavailable).toEqual([])
  })

  it('is a no-op on a source that was never gone', () => {
    expect(markSourceContentAvailable(getDb(), src, NOW).changed).toBe(false)
  })
})
