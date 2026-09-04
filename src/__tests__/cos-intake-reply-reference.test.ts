import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { openBatch } from '../cos/email-ingest.js'
import { ingestEmail as ingestEmailRaw } from '../cos/intake.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { linkCaseSource, getCaseDossier } from '../cos/case-sources.js'
import { createCase } from '../cos/case-store.js'

// INTAKE, WIRED TO THE PARENT ROUTE.
//
// The resolver is proven on its own in cos-reply-reference.test.ts. What is
// proven here is the thing that actually failed twice in production: an inbound
// message whose THREAD we do not know, but whose PARENT we do, must join the
// case that owns the parent instead of opening a second one beside it.

const ACC = 'iszzu80', NOW = 1_000_000
const PARENT_MSG = 'AM0P193MB3123X@outlook.com'
const KNOWN_THREAD = 'thread-known'
const NEW_THREAD = 'thread-fresh'

function ingest(input: any) {
  recordTriageReceipt(getDb(), {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: null, actionable: input.actionable, caseType: input.caseType ?? null,
    title: input.title ?? null, workspace: null, priority: input.priority ?? null,
    declaredSensitivity: input.declaredSensitivity ?? null, actor: 'test', model: null, promptFingerprint: null,
  }, NOW)
  return ingestEmailRaw(getDb(), { ...input, triageActor: 'test' }, NOW)
}
const discover = (messageId: string, threadId?: string) =>
  openBatch(getDb(), { batchId: `b-${messageId}`, accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId, threadId }] }, NOW)

/** A case that already owns KNOWN_THREAD, the way a dossier does. */
function dossier(caseId: string) {
  createCase(getDb(), { caseId, title: caseId, caseType: 'HOME_REPAIR', status: 'READY' } as any, NOW)
  linkCaseSource(getDb(), {
    namespace: 'personal', caseId, sourceType: 'GMAIL_THREAD', sourceRef: KNOWN_THREAD,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'fixture: the dossier already owns this conversation',
    discoveredBy: 'test',
  }, NOW)
}

const inbound = (messageId: string, extra: Record<string, unknown> = {}) => ({
  accountId: ACC, messageId, threadId: NEW_THREAD,
  subject: 'Re: peremelem', from: 'vendor@example.com', snippet: 'valasz',
  actionable: true, caseType: 'HOME_REPAIR', title: 'valasz', ...extra,
})

const resolved = {
  kind: 'RESOLVED' as const, caseId: 'PRI-HOME-2026-005',
  viaMessageId: PARENT_MSG, viaThreadId: KNOWN_THREAD, viaMailbox: 'private',
}

describe('an unknown thread whose parent we know', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('joins the dossier instead of opening a second case', () => {
    discover('m-reply', NEW_THREAD)
    const r = ingest(inbound('m-reply', { referenceResolution: resolved }))
    expect(r).toMatchObject({ outcome: 'LINKED_DUPLICATE', caseId: 'PRI-HOME-2026-005' })
  })

  it('and the dossier can be read back as owning the new conversation', () => {
    discover('m-reply', NEW_THREAD)
    ingest(inbound('m-reply', { referenceResolution: resolved }))

    // CONSUMER READBACK: not "the call returned a case id" but "a reader asking
    // the graph gets the thread and the message, with the reply relation stated".
    const dossier = getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005')
    // The grouped view a dossier reader actually uses — canonical only.
    expect(dossier.byType.GMAIL_THREAD).toContain(NEW_THREAD)
    expect(dossier.byType.GMAIL_MESSAGE).toContain('m-reply')
    const thread = dossier.canonical.find(l => l.sourceType === 'GMAIL_THREAD' && l.sourceRef === NEW_THREAD)!
    expect(thread.linkMethod).toBe('MESSAGE_REFERENCE')
    expect(thread.evidence).toContain(PARENT_MSG)      // says WHY, checkably
  })

  it('without the resolution it still opens its own case — this is the before picture', () => {
    discover('m-reply', NEW_THREAD)
    const r = ingest(inbound('m-reply'))
    expect(r.outcome).toBe('CASE_CREATED')
    expect(r.caseId).not.toBe('PRI-HOME-2026-005')
  })
})

describe('a known thread outranks the parent route', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('CASE-OWNS-THREAD') })

  it('the conversation we already own wins over what the message replies to', () => {
    discover('m2', KNOWN_THREAD)
    const r = ingest({
      ...inbound('m2'), threadId: KNOWN_THREAD,
      referenceResolution: { ...resolved, caseId: 'SOME-OTHER-CASE' },
    })
    expect(r.caseId).toBe('CASE-OWNS-THREAD')
  })
})

describe('an ambiguous parent never draws a canonical link', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    dossier('CASE-A')
    createCase(getDb(), { caseId: 'CASE-B', title: 'B', caseType: 'HOME_REPAIR', status: 'READY' } as any, NOW)
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'CASE-B', sourceType: 'GMAIL_THREAD', sourceRef: KNOWN_THREAD,
      linkMethod: 'EXPLICIT_RELATION', evidence: 'fixture: a second claimant', discoveredBy: 'test',
    }, NOW)
  })

  const ambiguous = {
    kind: 'AMBIGUOUS' as const, caseIds: ['CASE-A', 'CASE-B'],
    viaMessageId: PARENT_MSG, viaThreadId: KNOWN_THREAD, viaMailbox: 'private',
  }

  it('opens its own case rather than picking one of the claimants', () => {
    discover('m3', NEW_THREAD)
    const r = ingest(inbound('m3', { referenceResolution: ambiguous }))
    expect(r.outcome).toBe('CASE_CREATED')
    expect(['CASE-A', 'CASE-B']).not.toContain(r.caseId)
  })

  it('but records the relation on EVERY claimant as a candidate, with the reason', () => {
    discover('m3', NEW_THREAD)
    ingest(inbound('m3', { referenceResolution: ambiguous }))
    for (const claimant of ['CASE-A', 'CASE-B']) {
      const dossier = getCaseDossier(getDb(), 'personal', claimant)
      const cand = dossier.candidates.find(l => l.sourceRef === 'm3')
      expect(cand, `${claimant} kellene hogy hordozza a jelöltet`).toBeTruthy()
      expect(cand!.evidence).toContain('CASE-A, CASE-B') // names the ambiguity
      // and a consumer reading only canonical never sees it — that is the point
      expect(dossier.byType.GMAIL_MESSAGE).not.toContain('m3')
    }
  })
})
