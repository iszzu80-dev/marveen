// Personal Chief of Staff (COS) — email ingestion (Slice 1 inbound safety).
//
// The inbound counterpart of the Action Executor. It enforces the two P0 rules
// the spec's review rounds set for reading Gmail:
//   P0.2 (checkpoint): the account's history cursor advances ONLY when a whole
//        BATCH is terminal — so if 4 of 5 messages committed and the 5th is
//        still in flight, the cursor does NOT move (the 5th is not skipped) and
//        the 4 are NOT reprocessed.
//   P0.1 (poison): a message that cannot be processed goes QUARANTINED (a
//        terminal state) so one bad message cannot pin the cursor forever.
//
// Pure DB state machine — no Gmail client here, so it builds/tests before any
// live connector.

import type Database from 'better-sqlite3'

export type MessageStatus =
  | 'DISCOVERED' | 'CLAIMED' | 'LOCAL_APPLIED' | 'SOURCE_COMMITTED'
  | 'SOURCE_COMMIT_SKIPPED'
  | 'RECOVERY_REQUIRED' | 'EXCLUDED' | 'DUPLICATE' | 'QUARANTINED'

/** A message is terminal (done, one way or another) in these states. The batch
 *  is terminal iff every message is terminal — only then does the cursor move.
 *
 *  F-8: SOURCE_COMMIT_SKIPPED is terminal — that is the whole point of the
 *  policy exception, the cursor has to be able to pass. What it is NOT is
 *  SOURCE_COMMITTED, so a query asking "which messages did we actually mark at
 *  the source" can now be answered truthfully. */
export const TERMINAL_MESSAGE_STATUSES: ReadonlySet<MessageStatus> = new Set<MessageStatus>([
  'SOURCE_COMMITTED', 'SOURCE_COMMIT_SKIPPED', 'EXCLUDED', 'DUPLICATE', 'QUARANTINED',
])

export interface OpenBatchInput {
  batchId: string
  accountId: string
  cursorBefore: string | null
  cursorAfter: string
  /** Still optional at the type level, deliberately — see resolveThreadId. */
  messages: Array<{ messageId: string; threadId?: string }>
}

/** IN-2 / §8: every processed message carries a thread id — and none is dropped.
 *
 *  `thread_id` used to default to NULL whenever a caller omitted it, and the
 *  only thing keeping §8 alive was a sentence in a feeder's prompt telling it to
 *  "leave it out if you don't have it". On 2026-08-10 a feeder did exactly that
 *  for one message and the criterion went from PASS to FAIL. A NULL there is not
 *  cosmetic:
 *  the thread id is what links a later reply to an existing case
 *  (intake.findActiveCaseByThread), so a NULL row means the reply opens a SECOND
 *  case for a matter already in flight.
 *
 *  (It also sits in UNIQUE(gmail_account_id, thread_id, message_id), where
 *  SQLite treats every NULL as distinct — but that hole is already closed by the
 *  separate uq_email_processing_msg index on (account, message_id), which the
 *  A.3 migration added for exactly this reason. Dedup was never the damage
 *  here; linking was.)
 *
 *  The first version of this fix THREW on a missing thread id. That was wrong,
 *  and a test said so in its own words: "a producer that fails to supply the
 *  thread must degrade to unlinked case, never to dropped mail". Refusing the
 *  batch would have traded a linking defect for mail loss, which is the worse
 *  failure by a wide margin.
 *
 *  So it degrades instead: a message with no thread id becomes its own thread.
 *  In Gmail a thread-opening message genuinely has threadId == its own id, so
 *  this is usually the CORRECT value and never a NULL. What it is not is
 *  OBSERVED, and a derived value that reads like an observed one is its own kind
 *  of lie — so the row records which it was (`thread_id_derived`). Derived rows
 *  stay countable, alertable, and correctable later; nothing has to trust that
 *  the fallback was rare. */
function resolveThreadId(m: { messageId: string; threadId?: string }): { threadId: string; derived: 0 | 1 } {
  return m.threadId ? { threadId: m.threadId, derived: 0 } : { threadId: m.messageId, derived: 1 }
}

/** Record a fetched batch + its messages as DISCOVERED. Re-discovering a message
 *  already seen (UNIQUE account,message) is a no-op, not a duplicate row. */
export function openBatch(db: Database.Database, input: OpenBatchInput, now: number): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO email_processing_batches (batch_id, gmail_account_id, cursor_before, cursor_after, status, created_at, updated_at)
       VALUES (@batchId, @accountId, @cursorBefore, @cursorAfter, 'OPEN', @now, @now)`
    ).run({ batchId: input.batchId, accountId: input.accountId, cursorBefore: input.cursorBefore, cursorAfter: input.cursorAfter, now })
    const ins = db.prepare(
      `INSERT OR IGNORE INTO email_processing (gmail_account_id, message_id, thread_id, thread_id_derived, batch_id, status, created_at, updated_at)
       VALUES (@accountId, @messageId, @threadId, @derived, @batchId, 'DISCOVERED', @now, @now)`
    )
    for (const m of input.messages) {
      const { threadId, derived } = resolveThreadId(m)
      ins.run({ accountId: input.accountId, messageId: m.messageId, threadId, derived, batchId: input.batchId, now })
    }
  })
  tx()
}

export interface MessagePatch {
  caseId?: string | null
  lastError?: string | null
  quarantineReason?: string | null
  attemptDelta?: number
}

/** Set a message's status (+ optional fields). Named helpers below wrap the
 *  common transitions; this is the generic primitive. */
export function setMessageStatus(
  db: Database.Database, accountId: string, messageId: string, status: MessageStatus, patch: MessagePatch, now: number,
): void {
  const cols = ['status = @status', 'updated_at = @now']
  const params: Record<string, unknown> = { accountId, messageId, status, now }
  if (patch.caseId !== undefined) { cols.push('case_id = @caseId'); params.caseId = patch.caseId }
  if (patch.lastError !== undefined) { cols.push('last_error = @lastError'); params.lastError = patch.lastError }
  if (patch.quarantineReason !== undefined) { cols.push('quarantine_reason = @quarantineReason'); params.quarantineReason = patch.quarantineReason }
  if (patch.attemptDelta) cols.push('attempt = attempt + ' + Math.trunc(patch.attemptDelta))
  const info = db.prepare(
    `UPDATE email_processing SET ${cols.join(', ')} WHERE gmail_account_id = @accountId AND message_id = @messageId`
  ).run(params)
  if (info.changes === 0) throw new Error(`email_processing row not found: ${accountId}/${messageId}`)
}

export const claimMessage = (db: Database.Database, a: string, m: string, now: number) => setMessageStatus(db, a, m, 'CLAIMED', {}, now)
export const localApply = (db: Database.Database, a: string, m: string, caseId: string, now: number) => setMessageStatus(db, a, m, 'LOCAL_APPLIED', { caseId }, now)
export const sourceCommit = (db: Database.Database, a: string, m: string, now: number) => setMessageStatus(db, a, m, 'SOURCE_COMMITTED', {}, now)
/** F-8 / §6.3: terminal, but NOT the success terminal. The message is done on
 *  our side and was deliberately let past WITHOUT being marked at the source.
 *  It used to be written as SOURCE_COMMITTED with the truth in last_error — a
 *  state name that claims the opposite of what happened, which every later query
 *  then inherits. */
export const sourceCommitSkipped = (db: Database.Database, a: string, m: string, reason: string, now: number) =>
  setMessageStatus(db, a, m, 'SOURCE_COMMIT_SKIPPED', { lastError: reason }, now)
export const excludeMessage = (db: Database.Database, a: string, m: string, now: number) => setMessageStatus(db, a, m, 'EXCLUDED', {}, now)
export const markDuplicate = (db: Database.Database, a: string, m: string, now: number) => setMessageStatus(db, a, m, 'DUPLICATE', {}, now)
export const markRecoveryRequired = (db: Database.Database, a: string, m: string, err: string, now: number) => setMessageStatus(db, a, m, 'RECOVERY_REQUIRED', { lastError: err, attemptDelta: 1 }, now)
/** P0.1: park a poison message terminally so the batch can finish. */
export const quarantineMessage = (db: Database.Database, a: string, m: string, reason: string, now: number) => setMessageStatus(db, a, m, 'QUARANTINED', { quarantineReason: reason }, now)

/** Is every message in the batch terminal? (empty batch → true.) */
export function isBatchTerminal(db: Database.Database, batchId: string): boolean {
  const placeholders = [...TERMINAL_MESSAGE_STATUSES].map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM email_processing WHERE batch_id = ? AND status NOT IN (${placeholders})`
  ).get(batchId, ...TERMINAL_MESSAGE_STATUSES) as { n: number }
  return row.n === 0
}

export interface AdvanceResult {
  advanced: boolean
  cursor: string | null
}

/**
 * P0.2: advance the account cursor to the batch's cursor_after ONLY if the batch
 * is terminal. Otherwise a no-op (cursor stays where it is). Marks the batch
 * TERMINAL and moves the account checkpoint in one transaction. The checkpoint
 * never regresses.
 */
export function tryAdvanceCheckpoint(db: Database.Database, batchId: string, now: number): AdvanceResult {
  const tx = db.transaction((): AdvanceResult => {
    const batch = db.prepare(`SELECT * FROM email_processing_batches WHERE batch_id = ?`).get(batchId) as
      | { gmail_account_id: string; cursor_after: string; status: string } | undefined
    if (!batch) throw new Error(`batch not found: ${batchId}`)
    if (!isBatchTerminal(db, batchId)) {
      db.prepare(`UPDATE email_processing_batches SET status='PROCESSING', updated_at=? WHERE batch_id=? AND status='OPEN'`).run(now, batchId)
      const cp = db.prepare(`SELECT history_cursor FROM email_source_checkpoints WHERE gmail_account_id=?`).get(batch.gmail_account_id) as { history_cursor: string | null } | undefined
      return { advanced: false, cursor: cp?.history_cursor ?? null }
    }
    db.prepare(`UPDATE email_processing_batches SET status='TERMINAL', updated_at=? WHERE batch_id=?`).run(now, batchId)
    db.prepare(
      `INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at)
       VALUES (@acct, @cursor, @now)
       ON CONFLICT(gmail_account_id) DO UPDATE SET history_cursor=@cursor, updated_at=@now`
    ).run({ acct: batch.gmail_account_id, cursor: batch.cursor_after, now })
    return { advanced: true, cursor: batch.cursor_after }
  })
  return tx()
}

export function getCheckpoint(db: Database.Database, accountId: string): string | null {
  const r = db.prepare(`SELECT history_cursor FROM email_source_checkpoints WHERE gmail_account_id=?`).get(accountId) as { history_cursor: string | null } | undefined
  return r?.history_cursor ?? null
}
