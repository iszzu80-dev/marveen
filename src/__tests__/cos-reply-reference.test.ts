import { describe, it, expect } from 'vitest'
import { referencedMessageIds, resolveCaseByReplyReference } from '../cos/reply-reference.js'

// The live case this was built from, and it is the acceptance example:
// thread 1a065a4ad9539b9f opened its own case beside PRI-HOME-2026-005 because
// nothing asked what its first message was a reply to. It replies to
// AM0P193MB3123...DDE2, which sits on 19ea76492ebe4281 — a thread already
// attributed to PRI-HOME-2026-005.
const PARENT = '<AM0P193MB31236F251F34EC07A6825ABCBDDE2@AM0P193MB3123.EURP193.PROD.OUTLOOK.COM>'
const PARENT_BARE = PARENT.slice(1, -1)
const KNOWN_THREAD = '19ea76492ebe4281'

const mailbox = (id: string, map: Record<string, string>) => ({
  id, lookup: async (m: string) => map[m] ?? null,
})
const failing = (id: string) => ({
  id, lookup: async () => { throw new Error('mailbox unavailable') },
})
const caseOf = (t: string) => (t === KNOWN_THREAD ? ['PRI-HOME-2026-005'] : [])

describe('which ids to try, and in what order', () => {
  it('the direct parent comes first, then the nearest ancestor', () => {
    expect(referencedMessageIds({
      inReplyTo: '<c@x>', references: '<a@x> <b@x> <c@x>',
    })).toEqual(['c@x', 'b@x', 'a@x'])   // parent, then References newest-first
  })

  it('strips the angle brackets — they are envelope syntax, not the id', () => {
    expect(referencedMessageIds({ inReplyTo: PARENT })).toEqual([PARENT_BARE])
  })

  it('a message that replies to nothing offers nothing', () => {
    expect(referencedMessageIds({})).toEqual([])
    expect(referencedMessageIds({ inReplyTo: '   ', references: '' })).toEqual([])
  })
})

describe('THE ACCEPTANCE CASE — the orphan finds its dossier', () => {
  it('resolves through the reply relation, not through the thread id', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT, references: PARENT },
      [mailbox('private', { [PARENT_BARE]: KNOWN_THREAD })],
      caseOf,
    )
    expect(r).toEqual({
      kind: 'RESOLVED',
      caseId: 'PRI-HOME-2026-005',
      viaMessageId: PARENT_BARE,
      viaThreadId: KNOWN_THREAD,
      viaMailbox: 'private',
    })
  })

  it('and nothing about it names that thread — it is a rule, not a special case', async () => {
    // A completely different conversation resolves by the same code path.
    const r = await resolveCaseByReplyReference(
      { inReplyTo: '<other@vendor>' },
      [mailbox('private', { 'other@vendor': 'thread-zzz' })],
      (t) => (t === 'thread-zzz' ? ['PRI-OTHER-1'] : []),
    )
    expect(r).toMatchObject({ kind: 'RESOLVED', caseId: 'PRI-OTHER-1' })
  })
})

describe('what it refuses to do', () => {
  it('no reply relation, no link — similarity is somebody else’s feature', async () => {
    const r = await resolveCaseByReplyReference({}, [mailbox('private', {})], caseOf)
    expect(r).toBeNull()
  })

  it('a referenced message we cannot find yields nothing, not a guess', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: '<ghost@nowhere>' }, [mailbox('private', {})], caseOf)
    expect(r).toBeNull()
  })

  it('a found thread that belongs to no case yields nothing', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT },
      [mailbox('private', { [PARENT_BARE]: 'thread-nobody-claims' })],
      caseOf)
    expect(r).toBeNull()
  })
})

describe('cross-mailbox, and the cost of an unavailable one', () => {
  it('finds the parent in a second mailbox when the first does not have it', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT },
      [mailbox('private', {}), mailbox('zst', { [PARENT_BARE]: KNOWN_THREAD })],
      caseOf)
    expect(r).toMatchObject({ kind: 'RESOLVED', caseId: 'PRI-HOME-2026-005', viaMailbox: 'zst' })   // and it says which one answered
  })

  it('a mailbox that cannot be asked does not abort the search', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT },
      [failing('private'), mailbox('zst', { [PARENT_BARE]: KNOWN_THREAD })],
      caseOf)
    expect(r).toMatchObject({ kind: 'RESOLVED', caseId: 'PRI-HOME-2026-005' })
  })

  it('all mailboxes unavailable is null, never a wrong link', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT }, [failing('private'), failing('zst')], caseOf)
    expect(r).toBeNull()
  })
})

describe('the strongest claim wins', () => {
  it('prefers the direct parent over an older ancestor, even if both resolve', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: '<parent@x>', references: '<grandparent@x> <parent@x>' },
      [mailbox('private', { 'parent@x': 'thread-new', 'grandparent@x': 'thread-old' })],
      (t) => (t === 'thread-new' ? ['CASE-NEW'] : t === 'thread-old' ? ['CASE-OLD'] : []))
    expect(r).toMatchObject({ kind: 'RESOLVED', caseId: 'CASE-NEW' })
  })

  it('falls back to the ancestor when the parent leads nowhere', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: '<parent@x>', references: '<grandparent@x> <parent@x>' },
      [mailbox('private', { 'grandparent@x': 'thread-old' })],
      (t) => (t === 'thread-old' ? ['CASE-OLD'] : []))
    expect(r).toMatchObject({ kind: 'RESOLVED', caseId: 'CASE-OLD' })
  })
})

describe('AMBIGUITY — several cases claim the parent conversation', () => {
  // Owner ruling 2026-09-04: a multi-case relation must NOT auto-link canonically.
  // Six threads in the live store are claimed by more than one case, so the
  // tie-break that routes live mail exists and is deliberately not reused here.
  it('reports every claimant instead of picking one', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT },
      [mailbox('private', { [PARENT_BARE]: KNOWN_THREAD })],
      () => ['CASE-A', 'CASE-B'])
    expect(r).toEqual({
      kind: 'AMBIGUOUS',
      caseIds: ['CASE-A', 'CASE-B'],
      viaMessageId: PARENT_BARE,
      viaThreadId: KNOWN_THREAD,
      viaMailbox: 'private',
    })
  })

  it('carries the same evidence a resolution would — an ambiguity is auditable too', async () => {
    const r = await resolveCaseByReplyReference(
      { inReplyTo: PARENT }, [mailbox('zst', { [PARENT_BARE]: KNOWN_THREAD })], () => ['A', 'B', 'C'])
    expect(r).toMatchObject({ kind: 'AMBIGUOUS', viaThreadId: KNOWN_THREAD, viaMailbox: 'zst' })
  })

  it('stops at the ambiguity rather than walking on to an older, single-claim ancestor', async () => {
    // Walking past it would silently convert "we do not know" into a clean
    // canonical answer from a weaker relation — the exact laundering the rule forbids.
    const r = await resolveCaseByReplyReference(
      { inReplyTo: '<parent@x>', references: '<grandparent@x> <parent@x>' },
      [mailbox('private', { 'parent@x': 'thread-shared', 'grandparent@x': 'thread-single' })],
      (t) => (t === 'thread-shared' ? ['CASE-A', 'CASE-B'] : ['CASE-OLD']))
    expect(r).toMatchObject({ kind: 'AMBIGUOUS', caseIds: ['CASE-A', 'CASE-B'] })
  })
})
