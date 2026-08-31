import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { openBatch, localApply, getCheckpoint, getHistoryPosition } from '../cos/email-ingest.js'
import { closeBatch, type SourceCommitter } from '../cos/source-commit.js'
import { classifySourceId, isSourceCommittable } from '../cos/source-id.js'
import { runDailyReconcile } from '../cos/reconcile.js'

// RECOVERY GATE, 2026-08-31. Two batches sat OPEN for 402 h and 170 h behind two
// LOCAL_APPLIED messages, holding two CRITICAL alerts red. The messages were
// synthetic go-live probes:
//
//   golive-probe-20260815 / STAGE2G-LIVE-GATE-PROBE-20260824
//
// Gmail answers such an id with 400 `Invalid id value` -- NOT 404 -- so the
// committer reported a failure, the chain retried, and it retried forever. The
// missing distinction was "this can never commit", and these tests are that
// distinction, plus the controls that stop each of them passing for the boring
// reason.

const DAY = 86_400
const now = 1_800_000_000

/** A committer that behaves the way Gmail actually did: a real-looking id
 *  commits, anything else is a hard 400. If the code under test ever hands it a
 *  synthetic id again, this throws instead of quietly failing -- the point is
 *  that the committer must never SEE one. */
const gmailLike: SourceCommitter = {
  id: 'test-gmail-like',
  async commit(_account: string, messageId: string) {
    if (!/^[0-9a-f]+$/.test(messageId)) {
      throw new Error(`the committer was handed a synthetic id: ${messageId}`)
    }
    return { outcome: 'COMMITTED' as const, reason: 'ok' }
  },
}

function seed(messageId: string, batchId: string, cursorAfter: string) {
  const db = getDb()
  openBatch(db, {
    batchId, accountId: 'private', cursorBefore: null, cursorAfter,
    messages: [{ messageId, threadId: messageId }],
  }, now - 400 * 3600)
  localApply(db, 'private', messageId, `case-${messageId}`, now - 400 * 3600)
  return db
}

describe('the id rule itself', () => {
  it('a Gmail id is committable; the two real probe ids are not', () => {
    expect(isSourceCommittable('private', '1a0566bde02154ff')).toBe(true)
    expect(isSourceCommittable('private', 'golive-probe-20260815')).toBe(false)
    expect(isSourceCommittable('private', 'STAGE2G-LIVE-GATE-PROBE-20260824')).toBe(false)
  })

  it('the refusal carries a REASON, not just a boolean', () => {
    const v = classifySourceId('private', 'golive-probe-20260815')
    expect(v.committable).toBe(false)
    if (!v.committable) {
      expect(v.reason).toContain('golive-probe-20260815')
      expect(v.reason).toContain('400 Invalid id value')
    }
  })

  it('a DELETED real message is still committable — the rule is the id, not existence', () => {
    // The distinction that makes the retry correct in one case and futile in the
    // other. A real id that 404s deserves its retry; a non-id never will.
    expect(isSourceCommittable('private', 'deadbeefdeadbeef')).toBe(true)
  })
})

describe('a synthetic probe never reaches the committer', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('terminalises as EXCLUDED, and the batch closes', async () => {
    const db = seed('golive-probe-20260815', 'triage-private-golive-probe-20260815', 'triage-1786752479')
    const res = await closeBatch(db, 'triage-private-golive-probe-20260815', gmailLike, now)

    expect(res.excluded).toBe(1)
    expect(res.committed).toBe(0)
    expect(res.failed).toBe(0)
    expect(res.batchClosed).toBe(true)

    const row = db.prepare(
      `SELECT status, last_error FROM email_processing WHERE message_id='golive-probe-20260815'`,
    ).get() as { status: string; last_error: string }
    expect(row.status).toBe('EXCLUDED')
    expect(row.last_error).toContain('not source-committable')
  })

  it('does NOT claim a source commit happened', () => {
    const db = getDb()
    const n = db.prepare(
      `SELECT COUNT(*) n FROM email_processing WHERE status IN ('SOURCE_COMMITTED','SOURCE_COMMIT_SKIPPED')`,
    ).get() as { n: number }
    // SOURCE_COMMITTED would be the F-8 lie. SOURCE_COMMIT_SKIPPED would claim a
    // policy decision that nobody made. Neither is what happened.
    expect(n.n).toBe(0)
  })

  it('does not advance the account cursor — a probe moves no mailbox position', async () => {
    initDatabase(':memory:')
    const db = seed('golive-probe-20260815', 'triage-private-golive-probe-20260815', 'triage-1786752479')
    await closeBatch(db, 'triage-private-golive-probe-20260815', gmailLike, now)
    expect(getCheckpoint(db, 'private')).toBeNull()
  })

  it('CONTROL: a REAL message in the same shape still commits normally', async () => {
    initDatabase(':memory:')
    const db = seed('1a0566bde02154ff', 'triage-private-1a0566bde02154ff', 'triage-1788159206')
    const res = await closeBatch(db, 'triage-private-1a0566bde02154ff', gmailLike, now)
    expect(res.committed).toBe(1)
    expect(res.excluded).toBe(0)
    const row = db.prepare(
      `SELECT status FROM email_processing WHERE message_id='1a0566bde02154ff'`,
    ).get() as { status: string }
    expect(row.status).toBe('SOURCE_COMMITTED')
  })

  it('the CRITICAL alerts go quiet, and they go quiet because the state changed', async () => {
    initDatabase(':memory:')
    const db = seed('golive-probe-20260815', 'triage-private-golive-probe-20260815', 'triage-1786752479')

    const before = runDailyReconcile(db, now).findings.map((f) => f.id)
    expect(before).toContain('messages_never_source_committed')
    expect(before).toContain('batches_never_closed')

    await closeBatch(db, 'triage-private-golive-probe-20260815', gmailLike, now)

    const after = runDailyReconcile(db, now).findings.map((f) => f.id)
    expect(after).not.toContain('messages_never_source_committed')
    expect(after).not.toContain('batches_never_closed')
  })
})

describe('the checkpoint is a position, or it is not a checkpoint', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a triage stamp is NOT a history position, and the accessor says so', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at) VALUES (?,?,?)`,
    ).run('private', 'triage-1786610507', now)

    // The raw value is still readable for diagnostics...
    expect(getCheckpoint(db, 'private')).toBe('triage-1786610507')
    // ...but nothing can be resumed from it.
    expect(getHistoryPosition(db, 'private')).toBeNull()
  })

  it('a real historyId passes both', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at) VALUES (?,?,?)`,
    ).run('private', '987654321', now)
    expect(getHistoryPosition(db, 'private')).toBe('987654321')
  })

  it('the monitor REPORTS a non-position instead of passing over it', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at) VALUES (?,?,?)`,
    ).run('private', 'triage-1786610507', now)

    const findings = runDailyReconcile(db, now).findings
    const f = findings.find((x) => x.id === 'checkpoint_not_a_position')
    expect(f).toBeTruthy()
    expect(f!.severity).toBe('WARNING')
    expect(f!.detail).toContain('triage-1786610507')

    // And it is NOT reported as a missing row: "never ran" and "ran and wrote
    // garbage" are different failures with different fixes.
    expect(findings.map((x) => x.id)).not.toContain('account_cursor_missing')
  })

  it('CONTROL: a good checkpoint raises neither finding', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at) VALUES (?,?,?)`,
    ).run('private', '987654321', now)
    const ids = runDailyReconcile(db, now).findings.map((x) => x.id)
    expect(ids).not.toContain('checkpoint_not_a_position')
    expect(ids).not.toContain('account_cursor_missing')
  })
})

describe('the duplicate-send CRITICAL fires on duplicates, not on re-plans', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    getDb().prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('case-x', 'duplicate-check fixture', 'ADMIN', now, now)
  })

  const plan = (id: string, status: string) => getDb().prepare(
    `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, status, campaign_id, recipient,
       internal_idempotency_key, sequence_number, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'case-x', 'EMAIL_SEND', status, 'camp-x', 'a@example.com', id, id.length, now, now)

  const dupFinding = () =>
    runDailyReconcile(getDb(), now).findings.find((f) => f.id === 'duplicate_send_attempt')

  it('a CANCELLED plan plus a fresh PLANNED one is NOT a duplicate', () => {
    // The live pair on 2026-08-31: cancelled 08-11, re-planned 08-31. Nothing
    // was sent twice, and nothing can be.
    plan('ob-1', 'CANCELLED')
    plan('ob-22', 'PLANNED')
    expect(dupFinding()).toBeUndefined()
  })

  it('a FAILED_TERMINAL plus a retry is NOT a duplicate', () => {
    plan('ob-3', 'FAILED_TERMINAL')
    plan('ob-44', 'PLANNED')
    expect(dupFinding()).toBeUndefined()
  })

  it('TWO rows that can both still deliver IS a duplicate', () => {
    plan('ob-5', 'PLANNED')
    plan('ob-66', 'FAILED_RETRYABLE')
    expect(dupFinding()?.severity).toBe('CRITICAL')
  })

  it('OUTCOME_UNKNOWN counts — the check must not assume the unknown one stayed home', () => {
    plan('ob-7', 'OUTCOME_UNKNOWN')
    plan('ob-88', 'PLANNED')
    expect(dupFinding()?.severity).toBe('CRITICAL')
  })

  it('a genuinely delivered pair still fires', () => {
    plan('ob-9', 'VERIFIED')
    plan('ob-100', 'VERIFIED')
    expect(dupFinding()?.severity).toBe('CRITICAL')
  })
})
