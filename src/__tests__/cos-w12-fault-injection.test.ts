import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  openBatch, sourceCommit, tryAdvanceCheckpoint, getCheckpoint, isBatchTerminal,
  claimMessage, setMessageStatus, MessageStatusConflictError,
} from '../cos/email-ingest.js'
import { ingestTriagedEmail } from '../cos/triage-bridge.js'

// W12 / §6.8 — the two fault injections the audit found missing.
//
// §6.8 lists six faults. Five were already exercised somewhere in the suite
// (duplicate input, crash during processing, side-effect success with a timed
// out response, side-effect failure, readback timeout, restart with pending
// state). Two were not, and both are WRITE failures on our own store rather
// than on a provider:
//
//   1. a state write fails mid-processing
//   2. the CURSOR write fails
//
// They matter for opposite reasons. A failed state write must not leave a half
// case; a failed cursor write must not leave the cursor claiming a position the
// messages do not support — that one silently SKIPS MAIL, which is the worst
// outcome the inbound design has.
//
// The fault is injected with a SQLite trigger rather than by stubbing a
// function. A stub proves what the code does when the mock throws; a trigger
// makes the real statement fail inside the real transaction, which is the thing
// being asked about.

const ACC = 'iszzu80'
const NOW = 1_700_000_000

function failOn(sql: string) { getDb().exec(sql) }

describe('W12 §6.8 — a state write fails mid-processing', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('leaves NO partial state: no case, no processing row, no triage receipt', () => {
    const db = getDb()
    // The write that fails is the LOCAL_APPLIED transition — after the claim,
    // after the case has been created inside the transaction. The worst possible
    // moment, deliberately.
    failOn(`CREATE TRIGGER t_fail_state BEFORE UPDATE ON email_processing
            WHEN NEW.status = 'LOCAL_APPLIED'
            BEGIN SELECT RAISE(ABORT, 'simulated disk I/O error'); END`)

    expect(() => ingestTriagedEmail(db, {
      accountId: ACC, messageId: 'm1', threadId: 't1', subject: 'S', from: 'a@b.c',
      snippet: 'x', actionable: true, caseType: 'EMAIL', title: 'S',
    }, NOW)).toThrow(/simulated disk I\/O error/)

    // Everything the attempt touched is gone. A half-ingested message is worse
    // than an un-ingested one: the batch would exist, the case would not, and
    // the message id would be taken — so the retry would return
    // ALREADY_PROCESSED and the mail would be lost with a success-shaped answer.
    expect((db.prepare(`SELECT COUNT(*) n FROM personal_cases WHERE case_id=?`).get(`case-${ACC}-m1`) as { n: number }).n).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE message_id='m1'`).get() as { n: number }).n).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) n FROM email_processing_batches`).get() as { n: number }).n).toBe(0)
    // The triage receipt is gone too — and here the rollback is more complete
    // than expected: `cos_triage_provenance` is created LAZILY, by the first
    // write, so the failed transaction rolled back the table's own CREATE along
    // with the row. The assertion therefore asks "no receipt", not "an empty
    // table", because both are correct answers and only one of them exists.
    const receipts = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='cos_triage_provenance'`).get()
      ? (db.prepare(`SELECT COUNT(*) n FROM cos_triage_provenance`).get() as { n: number }).n
      : 0
    expect(receipts).toBe(0)
  })

  it('and the SAME message ingests cleanly once the fault is gone — no duplicate side effect', () => {
    const db = getDb()
    failOn(`CREATE TRIGGER t_fail_state BEFORE UPDATE ON email_processing
            WHEN NEW.status = 'LOCAL_APPLIED'
            BEGIN SELECT RAISE(ABORT, 'simulated disk I/O error'); END`)
    const input = {
      accountId: ACC, messageId: 'm1', threadId: 't1', subject: 'S', from: 'a@b.c',
      snippet: 'x', actionable: true, caseType: 'EMAIL', title: 'S',
    }
    expect(() => ingestTriagedEmail(db, input, NOW)).toThrow()
    db.exec(`DROP TRIGGER t_fail_state`)

    const res = ingestTriagedEmail(db, input, NOW + 60)
    expect(res.outcome).toBe('CASE_CREATED')
    expect((db.prepare(`SELECT COUNT(*) n FROM personal_cases WHERE case_id=?`).get(`case-${ACC}-m1`) as { n: number }).n).toBe(1)
    // Exactly one of everything. The failed attempt left nothing to collide
    // with and nothing to duplicate.
    expect((db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE message_id='m1'`).get() as { n: number }).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) n FROM cos_triage_provenance`).get() as { n: number }).n).toBe(1)
  })
})

describe('W12 §6.8 — the CURSOR write fails', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  function terminalBatch() {
    const db = getDb()
    openBatch(db, {
      batchId: 'b1', accountId: ACC, cursorBefore: '100', cursorAfter: '150',
      messages: [{ messageId: 'm1', threadId: 't1' }, { messageId: 'm2', threadId: 't2' }],
    }, NOW)
    sourceCommit(db, ACC, 'm1', NOW + 1)
    sourceCommit(db, ACC, 'm2', NOW + 2)
    expect(isBatchTerminal(db, 'b1')).toBe(true)
  }

  it('the cursor does not move, and the batch does not close either', () => {
    const db = getDb()
    terminalBatch()
    failOn(`CREATE TRIGGER t_fail_cursor BEFORE INSERT ON email_source_checkpoints
            BEGIN SELECT RAISE(ABORT, 'simulated checkpoint write failure'); END`)

    expect(() => tryAdvanceCheckpoint(db, 'b1', NOW + 10)).toThrow(/simulated checkpoint write failure/)

    // The cursor is untouched — that is the obvious half.
    expect(getCheckpoint(db, ACC)).toBeNull()
    // The batch is NOT marked TERMINAL — that is the half that matters. The
    // close and the cursor write happen in one transaction, so a failure rolls
    // BOTH back. Had the close survived alone, the batch would be finished with
    // the cursor still behind it: the next poller would re-read the same
    // history range and no batch would ever move the cursor past it again.
    const b = db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id='b1'`).get() as { status: string }
    expect(b.status).toBe('OPEN')
  })

  it('a retry after the fault clears advances exactly once — nothing skipped, nothing reprocessed', () => {
    const db = getDb()
    terminalBatch()
    failOn(`CREATE TRIGGER t_fail_cursor BEFORE INSERT ON email_source_checkpoints
            BEGIN SELECT RAISE(ABORT, 'simulated checkpoint write failure'); END`)
    expect(() => tryAdvanceCheckpoint(db, 'b1', NOW + 10)).toThrow()
    db.exec(`DROP TRIGGER t_fail_cursor`)

    const r = tryAdvanceCheckpoint(db, 'b1', NOW + 20)
    expect(r).toEqual({ advanced: true, batchTerminal: true, cursor: '150' })
    expect(getCheckpoint(db, ACC)).toBe('150')
    // Both messages are still exactly where they were: the failed attempt
    // touched no message state.
    const statuses = db.prepare(`SELECT message_id, status FROM email_processing ORDER BY message_id`).all() as Array<{ message_id: string; status: string }>
    expect(statuses).toEqual([
      { message_id: 'm1', status: 'SOURCE_COMMITTED' },
      { message_id: 'm2', status: 'SOURCE_COMMITTED' },
    ])
  })

  it('an UPDATE-path cursor failure rolls back too — the second advance is the dangerous one', () => {
    const db = getDb()
    // First batch advances normally, so a checkpoint ROW now exists and the next
    // write takes the ON CONFLICT ... DO UPDATE path. The INSERT trigger above
    // would never fire again, and a test that only ever injects on INSERT would
    // silently stop testing anything from the second batch onwards.
    terminalBatch()
    expect(tryAdvanceCheckpoint(db, 'b1', NOW + 10).advanced).toBe(true)

    openBatch(db, {
      batchId: 'b2', accountId: ACC, cursorBefore: '150', cursorAfter: '200',
      messages: [{ messageId: 'm3', threadId: 't3' }],
    }, NOW + 20)
    sourceCommit(db, ACC, 'm3', NOW + 21)
    failOn(`CREATE TRIGGER t_fail_cursor_upd BEFORE UPDATE ON email_source_checkpoints
            BEGIN SELECT RAISE(ABORT, 'simulated checkpoint update failure'); END`)

    expect(() => tryAdvanceCheckpoint(db, 'b2', NOW + 30)).toThrow(/simulated checkpoint update failure/)
    expect(getCheckpoint(db, ACC)).toBe('150')  // still at the FIRST batch's position
    const b2 = db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id='b2'`).get() as { status: string }
    expect(b2.status).toBe('OPEN')
  })
})


describe('W12 §6.9 — the claim is a compare-and-swap, and it can refuse', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    openBatch(getDb(), {
      batchId: 'b1', accountId: ACC, cursorBefore: '100', cursorAfter: '150',
      messages: [{ messageId: 'm1', threadId: 't1' }],
    }, NOW)
  })

  // The ingest bridge serialises callers in an IMMEDIATE transaction, so in
  // practice a second claim never arrives — which is exactly why this guard
  // needs its own test. A protection whose failure path is unreachable from the
  // only caller is a protection nobody has ever seen work.
  it('a second claim is REFUSED, and the error names what it found', () => {
    const db = getDb()
    claimMessage(db, ACC, 'm1', NOW + 1)
    let caught: unknown
    try { claimMessage(db, ACC, 'm1', NOW + 2) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(MessageStatusConflictError)
    const e = caught as MessageStatusConflictError
    expect(e.expected).toEqual(['DISCOVERED'])
    expect(e.actual).toBe('CLAIMED')
    expect(e.message).toMatch(/is CLAIMED, expected DISCOVERED/)
  })

  it('a MISSING row and a MISMATCHED row are still different diagnoses', () => {
    const db = getDb()
    // Missing: the caller never opened the batch. That is a bug in the caller
    // and must not be reported as a concurrency outcome.
    expect(() => setMessageStatus(db, ACC, 'nope', 'CLAIMED', {}, NOW, ['DISCOVERED']))
      .toThrow(/row not found/)
    // Mismatched: the row is there, in another state. A different fact, and a
    // different type — the two used to be one message that named the wrong one.
    claimMessage(db, ACC, 'm1', NOW + 1)
    expect(() => setMessageStatus(db, ACC, 'm1', 'CLAIMED', {}, NOW + 2, ['DISCOVERED']))
      .toThrow(MessageStatusConflictError)
  })

  it('an unguarded write is unchanged: the transitions the owner makes stay simple', () => {
    const db = getDb()
    claimMessage(db, ACC, 'm1', NOW + 1)
    // No `expect` argument → no CAS. The owner of a claimed message does not
    // race itself, and forcing every transition through a compare-and-swap
    // would have been a change with no failure to point at.
    expect(() => setMessageStatus(db, ACC, 'm1', 'LOCAL_APPLIED', { caseId: 'c1' }, NOW + 3)).not.toThrow()
    const st = db.prepare(`SELECT status FROM email_processing WHERE message_id='m1'`).get() as { status: string }
    expect(st.status).toBe('LOCAL_APPLIED')
  })
})
