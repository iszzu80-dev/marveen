import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  openBatch, isBatchTerminal, isCursorPositionClear, tryAdvanceCheckpoint, getCheckpoint,
  sourceCommit, excludeMessage, markDuplicate, markRecoveryRequired, quarantineMessage, localApply,
  TRIAGE_BATCH_PREFIX,
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
    expect(r).toEqual({ advanced: true, batchTerminal: true, cursor: '150' })
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

  // P4 (review 2026-08-13). The upsert set history_cursor unconditionally while
  // the docstring above it already claimed "the checkpoint never regresses".
  // Nothing enforced it, and closeOpenBatches does not guarantee creation order
  // — an older blocked batch closes AFTER a newer one — so the cursor walked
  // backwards and the mail between the two positions was served, and processed,
  // a second time.
  describe('P0.2: the checkpoint never regresses', () => {
    it('a batch closing out of order does NOT pull the cursor backwards', () => {
      const db = getDb()
      openBatch(db, { batchId: 'b-old', accountId: ACC, cursorBefore: '100', cursorAfter: '150', messages: [{ messageId: 'm1' }] }, 1000)
      openBatch(db, { batchId: 'b-new', accountId: ACC, cursorBefore: '150', cursorAfter: '900', messages: [{ messageId: 'm2' }] }, 1100)
      // Both batches' messages are done, but only the NEWER one gets closed on
      // this sweep (the older one's close was never reached — a crash, or a
      // quarantine pass that ran out of budget).
      sourceCommit(db, ACC, 'm1', 1101)
      sourceCommit(db, ACC, 'm2', 1102)
      expect(tryAdvanceCheckpoint(db, 'b-new', 1103).advanced).toBe(true)
      expect(getCheckpoint(db, ACC)).toBe('900')
      // now the older one closes — it must terminalise WITHOUT moving the cursor
      const r = tryAdvanceCheckpoint(db, 'b-old', 1201)
      expect(r.advanced).toBe(false)
      expect(r.batchTerminal, 'the batch still closes — holding it open would pin the queue').toBe(true)
      expect(r.holdReason).toMatch(/regress/)
      expect(getCheckpoint(db, ACC)).toBe('900')
      expect((db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id='b-old'`).get() as any).status).toBe('TERMINAL')
    })

    it('compares historyIds NUMERICALLY, not as text', () => {
      const db = getDb()
      // '999' > '1000' lexicographically; as historyIds 1000 is the later one.
      openBatch(db, { batchId: 'b-999', accountId: ACC, cursorBefore: null, cursorAfter: '999', messages: [{ messageId: 'm1' }] }, 1000)
      sourceCommit(db, ACC, 'm1', 1001)
      tryAdvanceCheckpoint(db, 'b-999', 1002)
      expect(getCheckpoint(db, ACC)).toBe('999')
      openBatch(db, { batchId: 'b-1000', accountId: ACC, cursorBefore: '999', cursorAfter: '1000', messages: [{ messageId: 'm2' }] }, 1100)
      sourceCommit(db, ACC, 'm2', 1101)
      expect(tryAdvanceCheckpoint(db, 'b-1000', 1102).advanced).toBe(true)
      expect(getCheckpoint(db, ACC)).toBe('1000')
    })

    it('a TRIAGE batch closes but never writes its wall-clock stamp into the checkpoint', () => {
      const db = getDb()
      // a real history batch first, so there is a genuine cursor to protect
      openBatch(db, { batchId: 'b-real', accountId: ACC, cursorBefore: null, cursorAfter: '4200', messages: [{ messageId: 'm1' }] }, 1000)
      sourceCommit(db, ACC, 'm1', 1001)
      tryAdvanceCheckpoint(db, 'b-real', 1002)
      // …then the triage bridge's synthetic per-message batch
      openBatch(db, {
        batchId: `${TRIAGE_BATCH_PREFIX}${ACC}-mx`, accountId: ACC,
        cursorBefore: null, cursorAfter: `${TRIAGE_BATCH_PREFIX}1755000000`, messages: [{ messageId: 'mx' }],
      }, 1100)
      sourceCommit(db, ACC, 'mx', 1101)
      const r = tryAdvanceCheckpoint(db, `${TRIAGE_BATCH_PREFIX}${ACC}-mx`, 1102)
      expect(r.batchTerminal).toBe(true)
      expect(r.advanced).toBe(false)
      expect(getCheckpoint(db, ACC), 'the P0.2 cursor must stay a historyId').toBe('4200')
    })

    it('a triage batch does not seed a garbage checkpoint on a fresh account either', () => {
      const db = getDb()
      openBatch(db, {
        batchId: `${TRIAGE_BATCH_PREFIX}${ACC}-m1`, accountId: ACC,
        cursorBefore: null, cursorAfter: `${TRIAGE_BATCH_PREFIX}1755000000`, messages: [{ messageId: 'm1' }],
      }, 1000)
      sourceCommit(db, ACC, 'm1', 1001)
      tryAdvanceCheckpoint(db, `${TRIAGE_BATCH_PREFIX}${ACC}-m1`, 1002)
      // getCheckpoint() is what a future historyId poller seeds itself from.
      expect(getCheckpoint(db, ACC)).toBeNull()
    })
  })

  // P9 (review 2026-08-13). openBatch is INSERT OR IGNORE, so a message
  // re-listed in a newer overlapping batch KEEPS its original batch_id — while
  // isBatchTerminal counted only rows carrying the NEW batch_id. The still-
  // pending message therefore did not block the new batch, which terminalized
  // and moved the cursor past it for good. Not reachable through today's
  // per-message triage flow; exactly the shape a history poller with overlapping
  // deltas produces.
  describe('P0.2 says "no unprocessed mail at or before this position"', () => {
    it('an overlapping newer batch cannot step over a message pending in the older one', () => {
      const db = getDb()
      openBatch(db, { batchId: 'b-old', accountId: ACC, cursorBefore: '100', cursorAfter: '150', messages: [{ messageId: 'm1' }, { messageId: 'm2' }] }, 1000)
      sourceCommit(db, ACC, 'm1', 1001)          // m2 is still DISCOVERED
      // the poller re-lists m2 in the next delta; INSERT OR IGNORE keeps it in b-old
      openBatch(db, { batchId: 'b-new', accountId: ACC, cursorBefore: '150', cursorAfter: '200', messages: [{ messageId: 'm2' }, { messageId: 'm3' }] }, 1100)
      expect((db.prepare(`SELECT batch_id FROM email_processing WHERE message_id='m2'`).get() as any).batch_id).toBe('b-old')
      sourceCommit(db, ACC, 'm3', 1101)
      // Every row TAGGED b-new is terminal…
      expect(isBatchTerminal(db, 'b-new')).toBe(true)
      // …but m2 sits at position 150, before b-new's 200, and is not done.
      expect(isCursorPositionClear(db, 'b-new')).toBe(false)
      const r = tryAdvanceCheckpoint(db, 'b-new', 1102)
      expect(r.advanced).toBe(false)
      expect(getCheckpoint(db, ACC), 'the cursor may not pass unprocessed mail').toBeNull()
      // finish m2 and the position clears
      sourceCommit(db, ACC, 'm2', 1200)
      expect(tryAdvanceCheckpoint(db, 'b-new', 1201).advanced).toBe(true)
      expect(getCheckpoint(db, ACC)).toBe('200')
    })

    it('a LATER batch never blocks an earlier one', () => {
      const db = getDb()
      openBatch(db, { batchId: 'b-1', accountId: ACC, cursorBefore: null, cursorAfter: '150', messages: [{ messageId: 'm1' }] }, 1000)
      openBatch(db, { batchId: 'b-2', accountId: ACC, cursorBefore: '150', cursorAfter: '200', messages: [{ messageId: 'm2' }] }, 1100)
      sourceCommit(db, ACC, 'm1', 1001)          // m2 still pending, at a LATER position
      expect(tryAdvanceCheckpoint(db, 'b-1', 1002).advanced).toBe(true)
      expect(getCheckpoint(db, ACC)).toBe('150')
    })

    it('a pending TRIAGE message does not block a real history batch (it carries no position)', () => {
      const db = getDb()
      openBatch(db, {
        batchId: `${TRIAGE_BATCH_PREFIX}${ACC}-mt`, accountId: ACC,
        cursorBefore: null, cursorAfter: `${TRIAGE_BATCH_PREFIX}1755000000`, messages: [{ messageId: 'mt' }],
      }, 1000)
      openBatch(db, { batchId: 'b-real', accountId: ACC, cursorBefore: null, cursorAfter: '150', messages: [{ messageId: 'm1' }] }, 1100)
      sourceCommit(db, ACC, 'm1', 1101)          // mt stays DISCOVERED
      expect(tryAdvanceCheckpoint(db, 'b-real', 1102).advanced).toBe(true)
      expect(getCheckpoint(db, ACC)).toBe('150')
    })
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
