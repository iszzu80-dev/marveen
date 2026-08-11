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
/** A message is terminal (done, one way or another) in these states. The batch
 *  is terminal iff every message is terminal — only then does the cursor move. */
export const TERMINAL_MESSAGE_STATUSES = new Set([
    'SOURCE_COMMITTED', 'EXCLUDED', 'DUPLICATE', 'QUARANTINED',
]);
/** Record a fetched batch + its messages as DISCOVERED. Re-discovering a message
 *  already seen (UNIQUE account,message) is a no-op, not a duplicate row. */
export function openBatch(db, input, now) {
    const tx = db.transaction(() => {
        db.prepare(`INSERT INTO email_processing_batches (batch_id, gmail_account_id, cursor_before, cursor_after, status, created_at, updated_at)
       VALUES (@batchId, @accountId, @cursorBefore, @cursorAfter, 'OPEN', @now, @now)`).run({ batchId: input.batchId, accountId: input.accountId, cursorBefore: input.cursorBefore, cursorAfter: input.cursorAfter, now });
        const ins = db.prepare(`INSERT OR IGNORE INTO email_processing (gmail_account_id, message_id, thread_id, batch_id, status, created_at, updated_at)
       VALUES (@accountId, @messageId, @threadId, @batchId, 'DISCOVERED', @now, @now)`);
        for (const m of input.messages) {
            ins.run({ accountId: input.accountId, messageId: m.messageId, threadId: m.threadId ?? null, batchId: input.batchId, now });
        }
    });
    tx();
}
/** Set a message's status (+ optional fields). Named helpers below wrap the
 *  common transitions; this is the generic primitive. */
export function setMessageStatus(db, accountId, messageId, status, patch, now) {
    const cols = ['status = @status', 'updated_at = @now'];
    const params = { accountId, messageId, status, now };
    if (patch.caseId !== undefined) {
        cols.push('case_id = @caseId');
        params.caseId = patch.caseId;
    }
    if (patch.lastError !== undefined) {
        cols.push('last_error = @lastError');
        params.lastError = patch.lastError;
    }
    if (patch.quarantineReason !== undefined) {
        cols.push('quarantine_reason = @quarantineReason');
        params.quarantineReason = patch.quarantineReason;
    }
    if (patch.attemptDelta)
        cols.push('attempt = attempt + ' + Math.trunc(patch.attemptDelta));
    const info = db.prepare(`UPDATE email_processing SET ${cols.join(', ')} WHERE gmail_account_id = @accountId AND message_id = @messageId`).run(params);
    if (info.changes === 0)
        throw new Error(`email_processing row not found: ${accountId}/${messageId}`);
}
export const claimMessage = (db, a, m, now) => setMessageStatus(db, a, m, 'CLAIMED', {}, now);
export const localApply = (db, a, m, caseId, now) => setMessageStatus(db, a, m, 'LOCAL_APPLIED', { caseId }, now);
export const sourceCommit = (db, a, m, now) => setMessageStatus(db, a, m, 'SOURCE_COMMITTED', {}, now);
export const excludeMessage = (db, a, m, now) => setMessageStatus(db, a, m, 'EXCLUDED', {}, now);
export const markDuplicate = (db, a, m, now) => setMessageStatus(db, a, m, 'DUPLICATE', {}, now);
export const markRecoveryRequired = (db, a, m, err, now) => setMessageStatus(db, a, m, 'RECOVERY_REQUIRED', { lastError: err, attemptDelta: 1 }, now);
/** P0.1: park a poison message terminally so the batch can finish. */
export const quarantineMessage = (db, a, m, reason, now) => setMessageStatus(db, a, m, 'QUARANTINED', { quarantineReason: reason }, now);
/** Is every message in the batch terminal? (empty batch → true.) */
export function isBatchTerminal(db, batchId) {
    const placeholders = [...TERMINAL_MESSAGE_STATUSES].map(() => '?').join(',');
    const row = db.prepare(`SELECT COUNT(*) AS n FROM email_processing WHERE batch_id = ? AND status NOT IN (${placeholders})`).get(batchId, ...TERMINAL_MESSAGE_STATUSES);
    return row.n === 0;
}
/**
 * P0.2: advance the account cursor to the batch's cursor_after ONLY if the batch
 * is terminal. Otherwise a no-op (cursor stays where it is). Marks the batch
 * TERMINAL and moves the account checkpoint in one transaction. The checkpoint
 * never regresses.
 */
export function tryAdvanceCheckpoint(db, batchId, now) {
    const tx = db.transaction(() => {
        const batch = db.prepare(`SELECT * FROM email_processing_batches WHERE batch_id = ?`).get(batchId);
        if (!batch)
            throw new Error(`batch not found: ${batchId}`);
        if (!isBatchTerminal(db, batchId)) {
            db.prepare(`UPDATE email_processing_batches SET status='PROCESSING', updated_at=? WHERE batch_id=? AND status='OPEN'`).run(now, batchId);
            const cp = db.prepare(`SELECT history_cursor FROM email_source_checkpoints WHERE gmail_account_id=?`).get(batch.gmail_account_id);
            return { advanced: false, cursor: cp?.history_cursor ?? null };
        }
        db.prepare(`UPDATE email_processing_batches SET status='TERMINAL', updated_at=? WHERE batch_id=?`).run(now, batchId);
        db.prepare(`INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at)
       VALUES (@acct, @cursor, @now)
       ON CONFLICT(gmail_account_id) DO UPDATE SET history_cursor=@cursor, updated_at=@now`).run({ acct: batch.gmail_account_id, cursor: batch.cursor_after, now });
        return { advanced: true, cursor: batch.cursor_after };
    });
    return tx();
}
export function getCheckpoint(db, accountId) {
    const r = db.prepare(`SELECT history_cursor FROM email_source_checkpoints WHERE gmail_account_id=?`).get(accountId);
    return r?.history_cursor ?? null;
}
