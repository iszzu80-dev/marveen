import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  openBatch, isBatchTerminal, tryAdvanceCheckpoint, getCheckpoint,
  sourceCommit, excludeMessage, markDuplicate, markRecoveryRequired, quarantineMessage, localApply,
} from '../cos/email-ingest.js'

// COS email ingestion. Proves the two P0 rules: the account cursor advances
// ONLY on a terminal batch (P0.2 — no skip, no reprocess), and a poison message
// quarantines so it cannot pin the cursor forever (P0.1).

const ACC = 'iszzu80'

function batch3() {
  openBatch(getDb(), {
    batchId: 'b1', accountId: ACC, cursorBefore: '100', cursorAfter: '150',
    messages: [{ messageId: 'm1', threadId: 't1' }, { messageId: 'm2' }, { messageId: 'm3' }],
  }, 1000)
}

describe('COS email ingestion', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('openBatch records DISCOVERED messages; re-discovery across batches is a no-op', () => {
    const db = getDb()
    batch3()
    expect((db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE batch_id='b1'`).get() as any).n).toBe(3)
    // a later batch that re-includes m1 must NOT create a second processing row
    openBatch(db, { batchId: 'b2', accountId: ACC, cursorBefore: '150', cursorAfter: '200', messages: [{ messageId: 'm1' }, { messageId: 'm4' }] }, 1100)
    expect((db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE gmail_account_id=? AND message_id='m1'`).get(ACC) as any).n).toBe(1)
  })

  it('P0.2: the cursor does NOT advance while any message is non-terminal', () => {
    const db = getDb()
    batch3()
    sourceCommit(db, ACC, 'm1', 1010)
    localApply(db, ACC, 'm2', 'c1', 1011); sourceCommit(db, ACC, 'm2', 1012)
    markRecoveryRequired(db, ACC, 'm3', 'transient parse fail', 1013) // 3rd still in flight
    expect(isBatchTerminal(db, 'b1')).toBe(false)
    const r = tryAdvanceCheckpoint(db, 'b1', 1014)
    expect(r.advanced).toBe(false)
    expect(getCheckpoint(db, ACC)).toBeNull() // 4-of-... rule: cursor pinned
    expect((db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id='b1'`).get() as any).status).toBe('PROCESSING')
  })

  it('advances only once EVERY message is terminal (mixed terminal states)', () => {
    const db = getDb()
    batch3()
    sourceCommit(db, ACC, 'm1', 1010)
    excludeMessage(db, ACC, 'm2', 1011)     // noise
    markDuplicate(db, ACC, 'm3', 1012)      // already seen
    expect(isBatchTerminal(db, 'b1')).toBe(true)
    const r = tryAdvanceCheckpoint(db, 'b1', 1013)
    expect(r).toEqual({ advanced: true, cursor: '150' })
    expect(getCheckpoint(db, ACC)).toBe('150')
    expect((db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id='b1'`).get() as any).status).toBe('TERMINAL')
  })

  it('P0.1: a poison message QUARANTINED lets the batch terminalize → cursor advances', () => {
    const db = getDb()
    batch3()
    sourceCommit(db, ACC, 'm1', 1010)
    sourceCommit(db, ACC, 'm2', 1011)
    markRecoveryRequired(db, ACC, 'm3', 'keeps failing', 1012)
    expect(tryAdvanceCheckpoint(db, 'b1', 1013).advanced).toBe(false) // pinned by m3
    // policy escalates the poison message to QUARANTINED (terminal)
    quarantineMessage(db, ACC, 'm3', 'unparseable after 3 attempts', 1014)
    const r = tryAdvanceCheckpoint(db, 'b1', 1015)
    expect(r.advanced).toBe(true)
    expect(getCheckpoint(db, ACC)).toBe('150') // no longer blocked forever
  })

  it('sequential batches advance the cursor forward', () => {
    const db = getDb()
    batch3()
    ;['m1', 'm2', 'm3'].forEach((m, i) => sourceCommit(db, ACC, m, 1010 + i))
    tryAdvanceCheckpoint(db, 'b1', 1020)
    expect(getCheckpoint(db, ACC)).toBe('150')
    openBatch(db, { batchId: 'b2', accountId: ACC, cursorBefore: '150', cursorAfter: '200', messages: [{ messageId: 'm9' }] }, 1100)
    sourceCommit(db, ACC, 'm9', 1101)
    tryAdvanceCheckpoint(db, 'b2', 1102)
    expect(getCheckpoint(db, ACC)).toBe('200')
  })
})
