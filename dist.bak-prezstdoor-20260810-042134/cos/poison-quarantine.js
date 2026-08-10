// Personal Chief of Staff (COS) — poison-message quarantine (v4.2.1 A.1).
//
// A message the system cannot process must not pin the account cursor forever.
// The state and the setter existed and were tested; nothing called them, so in
// practice a poison message would have held its batch open indefinitely and the
// cursor behind it — quietly, because an open batch looks like a busy one.
//
// A.1 does not simply allow quarantining. It allows the cursor to step OVER a
// quarantined message only when five things are true at once:
//   1. the source reference is kept,
//   2. a critical alert went out,
//   3. a manual review task exists,
//   4. the unprocessed state is audited,
//   5. an explicit policy permits the cursor to pass.
// All five are enforced here rather than described in a comment, because the
// whole point of the rule is that skipping a message is allowed only when
// somebody will certainly find out.
import { quarantineMessage } from './email-ingest.js';
/** Attempts after which a message is considered persistently unprocessable. */
export const POISON_ATTEMPT_THRESHOLD = 3;
/** Messages that have failed enough times to count as poison. */
export function poisonCandidates(db, batchId, threshold = POISON_ATTEMPT_THRESHOLD) {
    return db.prepare(`SELECT gmail_account_id, message_id, attempt, last_error
     FROM email_processing
     WHERE batch_id = ? AND status IN ('RECOVERY_REQUIRED','CLAIMED','DISCOVERED') AND attempt >= ?`).all(batchId, threshold);
}
/**
 * Quarantine one poison message, but ONLY with all five A.1 conditions met.
 *
 * When a condition fails the message stays where it is and the batch stays
 * blocked. That is the intended outcome: a stuck cursor is a visible problem,
 * while a cursor that steps over unprocessed mail is an invisible one, and the
 * second is how mail disappears without anybody noticing.
 */
export function quarantinePoison(db, accountId, messageId, reason, deps, now) {
    const row = db.prepare(`SELECT message_id, thread_id, attempt FROM email_processing
     WHERE gmail_account_id = ? AND message_id = ?`).get(accountId, messageId);
    const conditions = {
        // 1. The source reference is the message id itself, still on the row.
        sourceReferenceKept: !!row?.message_id,
        // 2/3. Attempted now; a failure to alert is a failure of the condition.
        alertRaised: false,
        reviewTaskCreated: false,
        // 4. Audited: the reason is written to the row, below.
        audited: !!reason && reason.length > 5,
        policyAllowsCursorAdvance: deps.policyAllowsCursorAdvance(),
    };
    if (!row) {
        return { quarantined: false, missing: ['sourceReferenceKept'], reason: `nincs ilyen üzenet: ${messageId}` };
    }
    conditions.alertRaised = deps.raiseAlert(accountId, messageId, reason);
    conditions.reviewTaskCreated = deps.createReviewTask(accountId, messageId, reason);
    const missing = Object.keys(conditions)
        .filter((k) => !conditions[k]);
    if (missing.length) {
        return {
            quarantined: false, missing,
            reason: `A.1 feltételek nem teljesültek: ${missing.join(', ')} — az üzenet marad, a köteg blokkolt`,
        };
    }
    // Condition 4 in practice: the reason and the attempt count go onto the row,
    // so the skip is inspectable long after everyone has forgotten the incident.
    quarantineMessage(db, accountId, messageId, `${reason} (kísérlet: ${row.attempt})`, now);
    return { quarantined: true, missing: [], reason };
}
/** Sweep a batch: quarantine every poison message that satisfies A.1. */
export function quarantineBatchPoison(db, batchId, deps, now, threshold = POISON_ATTEMPT_THRESHOLD) {
    const cands = poisonCandidates(db, batchId, threshold);
    const blocked = [];
    let quarantined = 0;
    for (const c of cands) {
        const r = quarantinePoison(db, c.gmail_account_id, c.message_id, c.last_error ?? 'tartósan feldolgozhatatlan üzenet', deps, now);
        if (r.quarantined)
            quarantined += 1;
        else
            blocked.push(r);
    }
    return { examined: cands.length, quarantined, blocked };
}
