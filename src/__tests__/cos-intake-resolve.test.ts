import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { openBatch } from '../cos/email-ingest.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { createCase } from '../cos/case-store.js'
import { linkCaseSource, getCaseDossier } from '../cos/case-sources.js'
import { ingestEmailWithReferences, openCasesClaimingThread } from '../cos/intake-resolve.js'

// THE EDGE, end to end: headers in, dossier link out.
//
// The point of these is the wiring, not the rule — the rule is proven in
// cos-reply-reference.test.ts and its intake half in cos-intake-reply-reference.
// What can only be proven here: that the lookup is asked at all, that it is NOT
// asked when the answer is already known, and that failing to ask never costs
// the email.

const ACC = 'iszzu80', NOW = 1_000_000
const PARENT = '<AM0P193MB3123X@outlook.com>'
const KNOWN_THREAD = 'thread-known'
const NEW_THREAD = 'thread-fresh'

const discover = (messageId: string, threadId?: string) =>
  openBatch(getDb(), { batchId: `b-${messageId}`, accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId, threadId }] }, NOW)

function dossier(caseId: string, thread = KNOWN_THREAD) {
  createCase(getDb(), { caseId, title: caseId, caseType: 'HOME_REPAIR', status: 'READY' } as any, NOW)
  linkCaseSource(getDb(), {
    namespace: 'personal', caseId, sourceType: 'GMAIL_THREAD', sourceRef: thread,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'fixture', discoveredBy: 'test',
  }, NOW)
}

function input(messageId: string, over: Record<string, unknown> = {}) {
  const base = {
    accountId: ACC, messageId, threadId: NEW_THREAD,
    subject: 'Re: peremelem', from: 'vendor@example.com', snippet: 'valasz',
    actionable: true, caseType: 'HOME_REPAIR', title: 'valasz', triageActor: 'test',
    headers: { 'In-Reply-To': PARENT },
    ...over,
  }
  recordTriageReceipt(getDb(), {
    accountId: ACC, messageId, threadId: (base.threadId as string) ?? null, sourceManifestHash: null,
    actionable: true, caseType: 'HOME_REPAIR', title: 'valasz', workspace: null,
    priority: null, declaredSensitivity: null, actor: 'test', model: null, promptFingerprint: null,
  }, NOW)
  return base as any
}

const mailbox = (id: string, map: Record<string, string>) =>
  ({ id, lookup: vi.fn(async (m: string) => map[m] ?? null) })

describe('end to end: an unknown thread, a known parent', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('asks the mailbox, and the dossier ends up owning the new conversation', async () => {
    discover('m1', NEW_THREAD)
    const mb = mailbox('private', { 'AM0P193MB3123X@outlook.com': KNOWN_THREAD })
    const r = await ingestEmailWithReferences(getDb(), input('m1'), [mb], NOW)

    expect(r).toMatchObject({ outcome: 'LINKED_DUPLICATE', caseId: 'PRI-HOME-2026-005' })
    expect(mb.lookup).toHaveBeenCalledWith('AM0P193MB3123X@outlook.com')

    const d = getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005')
    expect(d.byType.GMAIL_THREAD).toContain(NEW_THREAD)
    expect(d.byType.GMAIL_MESSAGE).toContain('m1')
  })

  it('does NOT ask when the thread is already ours — the answer is known', async () => {
    discover('m2', KNOWN_THREAD)
    const mb = mailbox('private', {})
    await ingestEmailWithReferences(getDb(), input('m2', { threadId: KNOWN_THREAD }), [mb], NOW)
    expect(mb.lookup).not.toHaveBeenCalled()
  })

  it('a message with no headers is ingested unchanged, not blocked', async () => {
    discover('m3', NEW_THREAD)
    const mb = mailbox('private', { 'AM0P193MB3123X@outlook.com': KNOWN_THREAD })
    const r = await ingestEmailWithReferences(getDb(), input('m3', { headers: undefined }), [mb], NOW)
    expect(r.outcome).toBe('CASE_CREATED')
    expect(mb.lookup).not.toHaveBeenCalled()
  })
})

describe('the lookup never costs the email', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('an unreachable mailbox still ingests — an orphan is recoverable, a lost email is not', async () => {
    discover('m4', NEW_THREAD)
    const broken = { id: 'private', lookup: vi.fn(async () => { throw new Error('down') }) }
    const r = await ingestEmailWithReferences(getDb(), input('m4'), [broken], NOW)
    expect(r.outcome).toBe('CASE_CREATED')     // ingested, just not linked
    expect(broken.lookup).toHaveBeenCalled()
  })
})

describe('cross-mailbox stays allowed', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('the parent found in the second mailbox links just the same', async () => {
    discover('m5', NEW_THREAD)
    const r = await ingestEmailWithReferences(getDb(), input('m5'),
      [mailbox('private', {}), mailbox('zst', { 'AM0P193MB3123X@outlook.com': KNOWN_THREAD })], NOW)
    expect(r.caseId).toBe('PRI-HOME-2026-005')
    const d = getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005')
    const link = d.canonical.find(l => l.sourceRef === NEW_THREAD)!
    expect(link.evidence).toContain('mailbox zst')   // says which one answered
  })
})

describe('openCasesClaimingThread returns ALL claimants', () => {
  it('so an ambiguity cannot be hidden by a helpful "best" answer', () => {
    initDatabase(':memory:')
    dossier('CASE-A'); dossier('CASE-B')
    expect(openCasesClaimingThread(getDb(), KNOWN_THREAD).sort()).toEqual(['CASE-A', 'CASE-B'])
  })

  it('and skips closed cases — a finished case does not claim live mail', () => {
    initDatabase(':memory:')
    dossier('CASE-A'); dossier('CASE-DONE')
    getDb().prepare(`UPDATE personal_cases SET status='COMPLETED' WHERE case_id='CASE-DONE'`).run()
    expect(openCasesClaimingThread(getDb(), KNOWN_THREAD)).toEqual(['CASE-A'])
  })
})
