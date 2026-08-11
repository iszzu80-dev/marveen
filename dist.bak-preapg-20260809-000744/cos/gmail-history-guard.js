// Personal Chief of Staff (COS) — self-generated Gmail event guard (spec P1.2,
// AC-28).
//
// When the COS finishes processing a message it labels it (COS/Processed). That
// label write is itself a change in the Gmail mailbox, so the history-delta
// poller will later SEE it. Left unguarded, the poller would treat our own label
// echo as a brand-new event and re-process the message — a self-wake loop.
//
// The guard classifies each history event BEFORE any business processing, using
// the message ledger (email_processing) + a content fingerprint:
//   - SELF_LABEL_NOOP: the only change is us adding our own label(s) to a message
//     we already know → no business, origin logged.
//   - DUPLICATE: a message we already committed re-surfaces, or a different
//     message id carries content we already committed (resend).
//   - NEW_BUSINESS: anything else → process normally.
//
// Pure over the DB (no Gmail client), so it is fully testable before the live
// history poller (which needs the write-scope consent) exists.
import { TERMINAL_MESSAGE_STATUSES } from './email-ingest.js';
/** Labels the COS itself writes. A history event whose ONLY change is adding one
 *  of these, on a message we already know, is our own echo. Keep in sync with
 *  whatever label the source-commit step applies. */
export const COS_OWNED_LABELS = new Set(['COS/Processed']);
function knownStatus(db, accountId, messageId) {
    const r = db.prepare(`SELECT status FROM email_processing WHERE gmail_account_id=? AND message_id=?`).get(accountId, messageId);
    return r?.status ?? null;
}
/**
 * Classify a Gmail history event. The self-label echo test is deliberately
 * strict: the message must already be in the ledger, the event must be
 * label-only (no new message), the added labels must ALL be COS-owned, and
 * nothing may be removed. Anything looser risks swallowing a real event.
 */
export function classifyHistoryEvent(db, e) {
    const status = knownStatus(db, e.accountId, e.messageId);
    const added = e.labelsAdded ?? [];
    const removed = e.labelsRemoved ?? [];
    const isLabelOnly = !e.messageAdded && (added.length > 0 || removed.length > 0);
    const addedAllOurs = added.length > 0 && added.every(l => COS_OWNED_LABELS.has(l));
    // Self-generated label echo: known message, the only change is us adding our
    // own label(s), nothing removed. NOT new business.
    if (status != null && isLabelOnly && addedAllOurs && removed.length === 0) {
        return { outcome: 'SELF_LABEL_NOOP', reason: `self label echo (${added.join(',')}) on ${status} message`, knownStatus: status };
    }
    // A message we already carried to a terminal state re-surfacing (same id) is a
    // duplicate, not new business.
    if (status != null && TERMINAL_MESSAGE_STATUSES.has(status)) {
        return { outcome: 'DUPLICATE', reason: `message already processed (${status})`, knownStatus: status };
    }
    // Resend dedup: a DIFFERENT message id carrying content we already committed.
    if (e.contentHash) {
        const dup = db.prepare(`SELECT message_id FROM email_processing
       WHERE gmail_account_id=? AND content_hash=? AND message_id<>?
       ORDER BY created_at ASC LIMIT 1`).get(e.accountId, e.contentHash, e.messageId);
        if (dup)
            return { outcome: 'DUPLICATE', reason: `content-hash matches already-seen message ${dup.message_id}`, knownStatus: status };
    }
    return { outcome: 'NEW_BUSINESS', reason: status == null ? 'new message' : `known message, non-self change (${status})`, knownStatus: status };
}
/** Origin log for a recognised self-generated echo (P1.2 "az origin naplózva"):
 *  bump the per-message counter + timestamp so the audit shows we saw and
 *  ignored our own label write. No status change — the message stays where it is. */
export function recordSelfEvent(db, accountId, messageId, now) {
    db.prepare(`UPDATE email_processing
       SET self_event_count = self_event_count + 1, last_self_event_at = @now, updated_at = @now
     WHERE gmail_account_id = @accountId AND message_id = @messageId`).run({ accountId, messageId, now });
}
