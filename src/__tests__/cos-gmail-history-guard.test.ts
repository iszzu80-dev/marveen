import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { openBatch, sourceCommit, claimMessage } from '../cos/email-ingest.js'
import { classifyHistoryEvent, recordSelfEvent, COS_OWNED_LABELS } from '../cos/gmail-history-guard.js'

// AC-28: a self-generated Gmail label event (the COS/Processed label WE added)
// must NOT start new business processing — otherwise labeling a message wakes the
// poller which reprocesses it, forever. The guard classifies each history event
// against the ledger + a content fingerprint before any processing.

const ACCT = 'private'
const NOW = 1_000_000

function seed(messageId: string, status: 'processed' | 'inflight', contentHash?: string) {
  const db = getDb()
  openBatch(db, { batchId: `b-${messageId}`, accountId: ACCT, cursorBefore: null, cursorAfter: 'c1', messages: [{ messageId }] }, NOW)
  if (status === 'processed') sourceCommit(db, ACCT, messageId, NOW)
  else claimMessage(db, ACCT, messageId, NOW)
  if (contentHash) db.prepare(`UPDATE email_processing SET content_hash=? WHERE gmail_account_id=? AND message_id=?`).run(contentHash, ACCT, messageId)
}

describe('gmail history self-event guard (AC-28)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the COS/Processed label WE added on a known message → SELF_LABEL_NOOP (no business)', () => {
    seed('m1', 'processed')
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', labelsAdded: ['COS/Processed'] })
    expect(c.outcome).toBe('SELF_LABEL_NOOP')
    expect(c.knownStatus).toBe('SOURCE_COMMITTED')
    // origin logged, status untouched
    recordSelfEvent(getDb(), ACCT, 'm1', NOW + 5)
    const row = getDb().prepare(`SELECT status, self_event_count, last_self_event_at FROM email_processing WHERE message_id='m1'`).get() as any
    expect(row.status).toBe('SOURCE_COMMITTED')
    expect(row.self_event_count).toBe(1)
    expect(row.last_self_event_at).toBe(NOW + 5)
  })

  it('COS/Processed is one of our owned labels', () => {
    expect(COS_OWNED_LABELS.has('COS/Processed')).toBe(true)
  })

  it('a FOREIGN label added on a known message is NOT a self-event → NEW_BUSINESS', () => {
    seed('m1', 'inflight')
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', labelsAdded: ['IMPORTANT'] })
    expect(c.outcome).toBe('NEW_BUSINESS')
  })

  it('our label PLUS a foreign label on an in-flight message is NOT a pure self-event → NEW_BUSINESS', () => {
    seed('m1', 'inflight') // CLAIMED = non-terminal, so the DUPLICATE shortcut does not apply
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', labelsAdded: ['COS/Processed', 'IMPORTANT'] })
    expect(c.outcome).toBe('NEW_BUSINESS')
  })

  it('a label REMOVAL alongside our add on an in-flight message is not a pure self-event → NEW_BUSINESS', () => {
    seed('m1', 'inflight')
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', labelsAdded: ['COS/Processed'], labelsRemoved: ['UNREAD'] })
    expect(c.outcome).toBe('NEW_BUSINESS')
  })

  it('any event on an already-committed (terminal) message is never new business → DUPLICATE', () => {
    seed('m1', 'processed')
    // even a foreign label on an already-processed message must not reprocess it
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', labelsAdded: ['IMPORTANT'] })
    expect(c.outcome).toBe('DUPLICATE')
  })

  it('a genuinely new message → NEW_BUSINESS', () => {
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'never-seen', messageAdded: true })
    expect(c.outcome).toBe('NEW_BUSINESS')
    expect(c.knownStatus).toBeNull()
  })

  it('an already-committed message re-surfacing (same id) → DUPLICATE, not new business', () => {
    seed('m1', 'processed')
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm1', messageAdded: true })
    expect(c.outcome).toBe('DUPLICATE')
  })

  it('a DIFFERENT message id carrying already-committed content (resend) → DUPLICATE via content-hash', () => {
    seed('m1', 'processed', 'hash-abc')
    const c = classifyHistoryEvent(getDb(), { accountId: ACCT, messageId: 'm2-resend', messageAdded: true, contentHash: 'hash-abc' })
    expect(c.outcome).toBe('DUPLICATE')
    expect(c.reason).toMatch(/content-hash matches already-seen message m1/)
  })

  it('the self-label echo scoped to the ACCOUNT: same message id on another account is new', () => {
    seed('m1', 'processed')
    const c = classifyHistoryEvent(getDb(), { accountId: 'zst', messageId: 'm1', labelsAdded: ['COS/Processed'] })
    // 'zst' has never seen m1 → not a known message → not a self-echo
    expect(c.outcome).toBe('NEW_BUSINESS')
    expect(c.knownStatus).toBeNull()
  })
})
