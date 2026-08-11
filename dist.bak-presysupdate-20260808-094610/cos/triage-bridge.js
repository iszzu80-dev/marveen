// Personal Chief of Staff (COS) — email-triage → intake bridge.
//
// The hard parts of "email monitoring" already exist: the read-only Google MCP
// reads Gmail, and the email-triage heartbeat (email-triage-fetch.py, run every
// few hours) polls both accounts, strips noise, and dedups already-reported
// messages. This bridge is the small glue that turns a TRIAGED email (a real
// candidate the heartbeat picked) into a COS case — feeding it through the
// intake instead of only pinging Istvan. Direction-aware (inbound vs his own
// sent), self-send filtered, and idempotent: a message already in
// email_processing is ALREADY_PROCESSED (no duplicate case, no clobbering a
// terminal row). No LLM here — the triage verdict is decided upstream (the
// heartbeat) and passed in.
import { openBatch } from './email-ingest.js';
import { ingestEmail } from './intake.js';
/** Ingest one triaged email into the COS. Idempotent per (account, message):
 *  a message already seen returns ALREADY_PROCESSED and is left untouched. */
export function ingestTriagedEmail(db, input, now) {
    const existing = db.prepare(`SELECT status FROM email_processing WHERE gmail_account_id = ? AND message_id = ?`).get(input.accountId, input.messageId);
    if (existing)
        return { outcome: 'ALREADY_PROCESSED', messageStatus: existing.status };
    // A minimal per-email batch (the authoritative history-sync checkpoint model
    // is not used here — the heartbeat's own --mark file is the poll-level dedup,
    // and email_processing's UNIQUE is the case-level dedup).
    const batchId = `triage-${input.accountId}-${input.messageId}`;
    openBatch(db, {
        batchId, accountId: input.accountId, cursorBefore: null, cursorAfter: `triage-${now}`,
        messages: [{ messageId: input.messageId, threadId: input.threadId }],
    }, now);
    const intakeInput = {
        accountId: input.accountId, messageId: input.messageId, threadId: input.threadId,
        subject: input.subject, from: input.from, to: input.to, snippet: input.snippet,
        actionable: input.actionable, caseType: input.caseType, title: input.title,
        declaredSensitivity: input.declaredSensitivity, direction: input.direction,
        followUpAt: input.followUpAt, headers: input.headers,
    };
    const res = ingestEmail(db, intakeInput, now);
    return { outcome: res.outcome, caseId: res.caseId, messageStatus: res.messageStatus };
}
