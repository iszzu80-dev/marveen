import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, localApply, getCheckpoint, excludeMessage } from '../cos/email-ingest.js'
import { initCosSchema } from '../cos/schema.js'
import {
  closeBatch, closeOpenBatches, openBatchIds,
  NoSourceWriteCommitter, GmailLabelCommitter, type SourceCommitter,
} from '../cos/source-commit.js'

// Closing the inbound chain.
//
// The tests are built around the distinction that was lost for three days:
// "marked at the source" and "we could not mark it" must not collapse into the
// same outcome. A committer that cannot write must leave the chain visibly
// open, unless an explicit policy says otherwise — and then the reason has to be
// on the row.

const NOW = 1_800_000_000
const ACC = 'private'

function seed(batchId = 'b1', messages = ['m1']) {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 1000)
  openBatch(db, {
    batchId, accountId: ACC, cursorBefore: '100', cursorAfter: '200',
    messages: messages.map((m) => ({ messageId: m })),
  }, NOW - 1000)
  for (const m of messages) localApply(db, ACC, m, 'c1', NOW - 900)
  return db
}

const statusOf = (m: string) => (getDb().prepare(
  `SELECT status FROM email_processing WHERE message_id = ?`).get(m) as { status: string }).status

describe('COS source commit + batch closure', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a working committer closes the chain and moves the cursor', async () => {
    const db = seed()
    const labeled: string[] = []
    const committer = new GmailLabelCommitter(async (_a, m) => { labeled.push(m) })

    const r = await closeBatch(db, 'b1', committer, NOW)
    expect(r.committed).toBe(1)
    expect(r.batchClosed).toBe(true)
    expect(r.cursor).toBe('200')
    expect(statusOf('m1')).toBe('SOURCE_COMMITTED')
    expect(getCheckpoint(db, ACC)).toBe('200')
    expect(labeled).toEqual(['m1'])
  })

  it('without source-write capability the chain stays OPEN — visibly, not silently', async () => {
    const db = seed()
    const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW)
    expect(r.skipped).toBe(1)
    expect(r.committed).toBe(0)
    expect(r.batchClosed).toBe(false)
    expect(statusOf('m1')).toBe('LOCAL_APPLIED')
    expect(getCheckpoint(db, ACC)).toBeNull()
    // and the reason names the missing capability rather than shrugging
    expect(r.reason).toMatch(/modify scope/)
  })

  // CHANGED 2026-08-10 (F-8). This asserted SOURCE_COMMITTED for a message that
  // was deliberately NOT marked at the source — §6.3's terminal SUCCESS state
  // standing in for "we could not, and we let it past anyway", with the truth
  // demoted to last_error. Any later query asking "what did we actually commit"
  // inherited that. The state is now SOURCE_COMMIT_SKIPPED: still terminal, so
  // the cursor still passes, which is what the rest of this test checks.
  it('with the explicit policy the chain closes AND the row says it was SKIPPED, not committed', async () => {
    const db = seed()
    const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW,
      { allowCursorAdvanceWithoutSourceWrite: true })
    expect(r.batchClosed).toBe(true)
    expect(statusOf('m1')).toBe('SOURCE_COMMIT_SKIPPED')
    expect(statusOf('m1')).not.toBe('SOURCE_COMMITTED')
    const row = db.prepare(`SELECT last_error FROM email_processing WHERE message_id='m1'`)
      .get() as { last_error: string }
    expect(row.last_error).toMatch(/source-commit kihagyva/)
    expect(row.last_error).toMatch(/modify scope/)
  })

  it('F-8: the policy exception raises the A.1 alert and review task, not just a log line', async () => {
    // A.1 lists five conditions for letting a batch past an item it could not
    // fully process. Two of them — the critical alert and the human review task
    // — were wired only to the quarantine branch, so this branch let messages
    // through silently. An exception nobody is told about is indistinguishable
    // from a bug.
    const db = seed()
    const alerts: string[] = []
    const tasks: string[] = []
    const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW, {
      allowCursorAdvanceWithoutSourceWrite: true,
      quarantine: {
        raiseAlert: (_a, m, reason) => { alerts.push(`${m}:${reason}`); return true },
        createReviewTask: (_a, m, reason) => { tasks.push(`${m}:${reason}`); return true },
        policyAllowsCursorAdvance: () => true,
      },
    })
    expect(r.batchClosed).toBe(true)
    expect(alerts.some(a => a.startsWith('m1:') && /source-commit skipped/.test(a))).toBe(true)
    expect(tasks.some(a => a.startsWith('m1:') && /source-commit skipped/.test(a))).toBe(true)
  })

  it('a failing committer does NOT close the batch and does not move the cursor', async () => {
    const db = seed()
    const boom: SourceCommitter = {
      id: 'boom',
      commit: async () => ({ outcome: 'FAILED', reason: 'HTTP 500' }),
    }
    const r = await closeBatch(db, 'b1', boom, NOW, { allowCursorAdvanceWithoutSourceWrite: true })
    expect(r.failed).toBe(1)
    expect(r.batchClosed).toBe(false)
    expect(getCheckpoint(db, ACC)).toBeNull()
    // the policy exception must not rescue a genuine failure
    expect(statusOf('m1')).toBe('LOCAL_APPLIED')
  })

  it('one unfinished message holds the whole batch — the cursor never steps over it', async () => {
    const db = seed('b1', ['m1', 'm2'])
    let calls = 0
    const flaky: SourceCommitter = {
      id: 'flaky',
      commit: async () => (++calls === 1
        ? { outcome: 'COMMITTED', reason: 'ok' }
        : { outcome: 'FAILED', reason: 'timeout' }),
    }
    const r = await closeBatch(db, 'b1', flaky, NOW)
    expect(r.committed).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.batchClosed).toBe(false)
    expect(getCheckpoint(db, ACC)).toBeNull()
  })

  it('EXCLUDED messages are already terminal and do not block closure', async () => {
    const db = seed('b1', ['m1', 'm2'])
    excludeMessage(db, ACC, 'm2', NOW - 800)
    const r = await closeBatch(db, 'b1', new GmailLabelCommitter(async () => {}), NOW)
    expect(r.attempted).toBe(1)          // only the LOCAL_APPLIED one needed work
    expect(r.batchClosed).toBe(true)
  })

  it('is idempotent: a second close is a no-op, not a second cursor step', async () => {
    const db = seed()
    const c = new GmailLabelCommitter(async () => {})
    await closeBatch(db, 'b1', c, NOW)
    const again = await closeBatch(db, 'b1', c, NOW + 10)
    expect(again.attempted).toBe(0)
    expect(getCheckpoint(db, ACC)).toBe('200')
  })

  it('closeOpenBatches walks every open batch, oldest first', async () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 2000)
    openBatch(db, { batchId: 'old', accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId: 'a' }] }, NOW - 2000)
    localApply(db, ACC, 'a', 'c1', NOW - 1900)
    openBatch(db, { batchId: 'new', accountId: ACC, cursorBefore: '2', cursorAfter: '3', messages: [{ messageId: 'b' }] }, NOW - 1000)
    localApply(db, ACC, 'b', 'c1', NOW - 900)

    expect(openBatchIds(db)).toEqual(['old', 'new'])
    const r = await closeOpenBatches(db, new GmailLabelCommitter(async () => {}), NOW)
    expect(r.batches).toBe(2)
    expect(r.closed).toBe(2)
    expect(getCheckpoint(db, ACC)).toBe('3')
  })

  it('reproduces 2026-08-09 and fixes it: eighteen-style backlog, all stuck, then closed', async () => {
    const db = seed('b1', ['m1', 'm2', 'm3'])
    expect(['m1', 'm2', 'm3'].every((m) => statusOf(m) === 'LOCAL_APPLIED')).toBe(true)
    expect(getCheckpoint(db, ACC)).toBeNull()

    const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW,
      { allowCursorAdvanceWithoutSourceWrite: true })
    expect(r.committed).toBe(3)
    expect(r.batchClosed).toBe(true)
    expect(getCheckpoint(db, ACC)).toBe('200')
  })
})

// N-1 (second review, 2026-08-10): the CHECK-widening migration used to DETECT
// "is the constraint already wide?" by writing the probe value onto a real row
// and throwing '__rollback__' to undo it. The try/catch was INSIDE the
// transaction callback, so the throw never reached better-sqlite3's wrapper and
// the transaction committed — probe UPDATE included. Every process start
// rewrote the lowest-rowid row: email_processing SOURCE_COMMITTED →
// SOURCE_COMMIT_SKIPPED, which is terminal, so a batch became closeable and the
// account cursor advanceable over a message nobody ever marked at the source.
//
// The regression test is behavioural, not structural: boot the schema
// repeatedly over rows in known states and assert NOTHING moved. A test that
// only checked "the CHECK is wide" would have passed against the broken code.
describe('schema init never rewrites a row (N-1)', () => {
  it('four consecutive inits leave every status untouched', () => {
    initDatabase(':memory:')
    const db = getDb()
    openBatch(db, {
      batchId: 'b-probe', accountId: 'acc', cursorBefore: '1', cursorAfter: '2',
      messages: [{ messageId: 'm-probe' }],
    }, NOW)
    // Put the rows in states the probe values would visibly clobber.
    db.prepare("UPDATE email_processing SET status='LOCAL_APPLIED' WHERE message_id='m-probe'").run()
    db.prepare("UPDATE email_processing_batches SET status='TERMINAL' WHERE batch_id='b-probe'").run()

    const snapshot = () => JSON.stringify({
      msg: (db.prepare("SELECT status FROM email_processing WHERE message_id='m-probe'").get() as { status: string }).status,
      batch: (db.prepare("SELECT status FROM email_processing_batches WHERE batch_id='b-probe'").get() as { status: string }).status,
    })
    const before = snapshot()
    expect(before).toContain('LOCAL_APPLIED')

    for (let i = 0; i < 4; i++) initCosSchema(db)
    expect(snapshot()).toBe(before)
  })
})
