// Personal Chief of Staff (COS) — email → case intake (inbound behavior).
//
// Turns a DISCOVERED email (from openBatch) into a case, composing the pieces
// built in this slice set: the email_processing state machine, the case store,
// and the sensitivity policy. This is where a message becomes work:
//   - not actionable → EXCLUDED (noise; the batch can still terminalize).
//   - actionable, new thread → CLAIMED → a new case is created (its sensitivity
//     is the ESCALATED tier of the declared value vs the actual content) →
//     LOCAL_APPLIED with the case_id. (The SOURCE_COMMITTED / Gmail-label step
//     is the source side, done once the connector confirms — separate.)
//   - actionable, thread already has a case → DUPLICATE, linked to that case.
//
// Pure DB composition — no Gmail client, so it builds/tests before the live
// connector. The triage decision (actionable? case_type?) is the caller's
// (heartbeat/LLM); this module executes it consistently and safely.
import { createCase } from './case-store.js';
import { claimMessage, localApply, excludeMessage, markDuplicate } from './email-ingest.js';
import { effectiveSensitivity } from './sensitivity.js';
import { suggestLinks, linkCases } from './case-link.js';
import { IDEMPOTENCY_HEADER } from './adapters/gmail-send.js';
function findActiveCaseByThread(db, threadId) {
    return db.prepare(`SELECT case_id FROM personal_cases
     WHERE gmail_thread_ids LIKE ? AND archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') LIMIT 1`).get(`%"${threadId}"%`);
}
export function ingestEmail(db, input, now) {
    // Self-event filter: a message carrying our own idempotency marker is a send
    // the COS executor made — never re-ingest it as new work.
    if (input.headers && input.headers[IDEMPOTENCY_HEADER]) {
        excludeMessage(db, input.accountId, input.messageId, now);
        return { outcome: 'EXCLUDED_SELF_SEND', messageStatus: 'EXCLUDED' };
    }
    // The same check without headers (2026-08-10, live): the triage feeder reads
    // Gmail via search and does not carry headers, so a letter the COS itself sent
    // came back through the Sent folder as an ordinary candidate — and would have
    // opened a SECOND case for a matter that was already waiting. The ledger knows
    // its own message ids, so ask it.
    //
    // Linked to the originating case rather than merely excluded: the sent letter
    // IS part of that case's history, and dropping it would lose the record of
    // what went out.
    const ownSend = db.prepare(`SELECT case_id FROM outbound_ledger WHERE external_ref = ? LIMIT 1`).get(input.messageId);
    if (ownSend?.case_id) {
        markDuplicate(db, input.accountId, input.messageId, now);
        db.prepare(`UPDATE email_processing SET case_id=@c WHERE gmail_account_id=@a AND message_id=@m`)
            .run({ c: ownSend.case_id, a: input.accountId, m: input.messageId });
        return { outcome: 'LINKED_DUPLICATE', caseId: ownSend.case_id, messageStatus: 'DUPLICATE' };
    }
    if (!input.actionable) {
        excludeMessage(db, input.accountId, input.messageId, now);
        return { outcome: 'EXCLUDED', messageStatus: 'EXCLUDED' };
    }
    const outbound = input.direction === 'OUTBOUND';
    const tx = db.transaction(() => {
        claimMessage(db, input.accountId, input.messageId, now);
        if (input.threadId) {
            const existing = findActiveCaseByThread(db, input.threadId);
            if (existing) {
                markDuplicate(db, input.accountId, input.messageId, now);
                // record which case it belongs to even though it's a duplicate message
                db.prepare(`UPDATE email_processing SET case_id=@caseId WHERE gmail_account_id=@acc AND message_id=@mid`)
                    .run({ caseId: existing.case_id, acc: input.accountId, mid: input.messageId });
                return { outcome: 'LINKED_DUPLICATE', caseId: existing.case_id, messageStatus: 'DUPLICATE' };
            }
        }
        const caseId = `case-${input.accountId}-${input.messageId}`;
        const tier = effectiveSensitivity(input.declaredSensitivity ?? 'PERSONAL', `${input.subject}\n${input.snippet}`);
        createCase(db, {
            caseId,
            title: input.title ?? input.subject,
            caseType: input.caseType ?? 'EMAIL',
            // OUTBOUND: Istvan sent this → the ball is with the recipient (waiting).
            status: outbound ? 'WAITING_EXTERNAL' : 'NEW',
            description: outbound ? `Sent to: ${input.to ?? '?'}` : `From: ${input.from}`,
            sensitivity: tier,
            priority: input.priority ?? 'P2',
            sourceSystem: 'gmail',
            sourceReference: input.messageId,
        }, now);
        const patch = {};
        if (input.threadId)
            patch.gmail_thread_ids = JSON.stringify([input.threadId]);
        // An outgoing email should be watched for a reply; default a follow-up.
        if (outbound) {
            patch.waiting_on = `reply from ${input.to ?? 'recipient'}`;
            patch.follow_up_at = input.followUpAt ?? now + 3 * 86400;
        }
        const keys = Object.keys(patch);
        if (keys.length) {
            db.prepare(`UPDATE personal_cases SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE case_id=@id`)
                .run({ ...patch, id: caseId });
        }
        // Cross-thread linking (2026-08-09). Thread matching above only catches a
        // reply on a conversation we already know; a courier or a merchant writes on
        // its own thread about the same matter. A STRONG match — a shared long
        // identifier such as an order number — is linked automatically: it is
        // deterministic, reversible, and acts on nothing outside the store. A WEAK
        // match (merchant name only) is NOT linked here; two cases mentioning the
        // same shop are often unrelated, and a wrong link costs more than a missing
        // one because it has to be disproved.
        const strong = suggestLinks(db, `${input.subject}\n${input.snippet}`, caseId)
            .filter((c) => c.strength === 'STRONG');
        for (const c of strong) {
            linkCases(db, caseId, c.caseId, c.evidence, now);
        }
        localApply(db, input.accountId, input.messageId, caseId, now);
        // Seed progression state for the new case so it doesn't stagnate at NEW.
        // Guarded by table existence — if the progression schema hasn't been deployed
        // yet, the intake path is unchanged (existing brownfield behavior).
        const progTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progression_state'").get();
        if (progTableExists) {
            db.prepare(`INSERT OR IGNORE INTO case_progression_state
         (domain, case_id, progression_enabled, progression_mode,
          next_progression_at, created_at, updated_at)
         VALUES ('personal', ?, 1, 'internal', ?, ?, ?)`).run(caseId, now, now, now);
        }
        return { outcome: 'CASE_CREATED', caseId, messageStatus: 'LOCAL_APPLIED', sensitivity: tier };
    });
    return tx();
}
