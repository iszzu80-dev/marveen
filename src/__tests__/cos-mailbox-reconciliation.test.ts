import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { linkCaseSource, markSourceContentUnavailable } from '../cos/case-sources.js'
import { createCase } from '../cos/case-store.js'
import { openBatch } from '../cos/email-ingest.js'
import { unprocessedClaimedThreads, reconcileMailbox } from '../cos/mailbox-reconciliation.js'

// MEASURED BEFORE BUILT: on the live store 53 of 111 canonically claimed
// personal threads had no email_processing row. These tests pin the shape of
// that answer, and — more importantly — the two ways it could lie: by hiding
// vanished threads among recoverable ones, and by reporting an unchecked
// mailbox as a clean one.

const NOW = 1_000_000

function claim(caseId: string, threadId: string) {
  const exists = getDb().prepare(`SELECT 1 FROM personal_cases WHERE case_id=?`).get(caseId)
  if (!exists) createCase(getDb(), { caseId, title: caseId, caseType: 'ADMIN', status: 'READY' } as any, NOW)
  linkCaseSource(getDb(), {
    namespace: 'personal', caseId, sourceType: 'GMAIL_THREAD', sourceRef: threadId,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'fixture: the case is about this conversation',
    discoveredBy: 'test',
  }, NOW)
}
const processed = (messageId: string, threadId: string) =>
  openBatch(getDb(), { batchId: `b-${messageId}`, accountId: 'iszzu80', cursorBefore: '1', cursorAfter: '2', messages: [{ messageId, threadId }] }, NOW)

beforeEach(() => { initDatabase(':memory:') })

describe('what the dossier claims and the intake never saw', () => {
  it('finds a claimed thread with no processing row', () => {
    claim('CASE-A', 'thread-never-seen')
    const out = unprocessedClaimedThreads(getDb(), 'personal')
    expect(out).toEqual([{ threadId: 'thread-never-seen', caseIds: ['CASE-A'], contentUnavailable: false }])
  })

  it('says nothing about a thread the intake HAS processed', () => {
    claim('CASE-A', 'thread-seen')
    processed('m1', 'thread-seen')
    expect(unprocessedClaimedThreads(getDb(), 'personal')).toEqual([])
  })

  it('names every claimant — six live threads are claimed by more than one case', () => {
    claim('CASE-A', 'shared'); claim('CASE-B', 'shared')
    const out = unprocessedClaimedThreads(getDb(), 'personal')
    expect(out).toHaveLength(1)
    expect(out[0].caseIds.sort()).toEqual(['CASE-A', 'CASE-B'])
  })

  it('ignores CANDIDATE links — a guess is not a statement that the thread matters', () => {
    createCase(getDb(), { caseId: 'CASE-A', title: 'a', caseType: 'ADMIN', status: 'READY' } as any, NOW)
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'CASE-A', sourceType: 'GMAIL_THREAD', sourceRef: 'maybe',
      linkMethod: 'SEMANTIC_CANDIDATE', evidence: 'looks related', discoveredBy: 'test',
    }, NOW)
    expect(unprocessedClaimedThreads(getDb(), 'personal')).toEqual([])
  })
})

describe('a vanished thread is separated, not blended in', () => {
  it('so nobody is sent chasing a conversation that cannot be fetched', () => {
    claim('CASE-A', 'thread-live')
    claim('CASE-A', 'thread-gone')
    markSourceContentUnavailable(getDb(), {
      namespace: 'personal', caseId: 'CASE-A', sourceType: 'GMAIL_THREAD', sourceRef: 'thread-gone',
      note: 'thread fetch failed: 404 after 3 attempts',
    }, NOW + 60)

    const r = reconcileMailbox(getDb(), 'personal')
    expect(r.unprocessed.map(t => t.threadId)).toEqual(['thread-live'])
    expect(r.unprocessedAndGone.map(t => t.threadId)).toEqual(['thread-gone'])
    // and it is still counted as claimed — it did not stop being a source
    expect(r.claimedThreads).toBe(2)
  })
})

describe('an unchecked mailbox is not a clean one', () => {
  it('reports mailboxChecked=false when no listing was supplied', () => {
    claim('CASE-A', 'thread-x')
    const r = reconcileMailbox(getDb(), 'personal')
    expect(r.mailboxChecked).toBe(false)
    expect(r.mailboxOnly).toEqual([])   // empty, and the flag says why
  })

  it('reports mailboxChecked=true with a listing, even when it finds nothing', () => {
    claim('CASE-A', 'thread-x'); processed('m1', 'thread-x')
    const r = reconcileMailbox(getDb(), 'personal', ['thread-x'])
    expect(r.mailboxChecked).toBe(true)
    expect(r.mailboxOnly).toEqual([])
  })

  it('lists threads the mailbox has and the intake does not', () => {
    processed('m1', 'known')
    const r = reconcileMailbox(getDb(), 'personal', ['known', 'stranger-b', 'stranger-a', 'stranger-a'])
    expect(r.mailboxOnly).toEqual(['stranger-a', 'stranger-b'])   // deduped, ordered
  })
})

describe('the counts a reader will quote', () => {
  it('claimed and processed add up to what is claimed', () => {
    claim('CASE-A', 't1'); claim('CASE-A', 't2'); claim('CASE-B', 't3')
    processed('m1', 't1')
    const r = reconcileMailbox(getDb(), 'personal')
    expect(r.claimedThreads).toBe(3)
    expect(r.processedThreads).toBe(1)
    expect(r.unprocessed.length + r.unprocessedAndGone.length).toBe(2)
  })
})
