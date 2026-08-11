// Personal Chief of Staff (COS) — Gmail send adapter (OutboundAdapter for the
// Action Executor). This is a SANCTIONED write path (unlike shopping adapters,
// sending an approved typed email is the point), so no no-checkout guard here.
//
// The whole crash-safety of the executor rests on one thing this adapter
// provides: a SEARCHABLE idempotency marker. Every outbound message carries the
// header X-Marveen-Idempotency-Key = the action's internalIdempotencyKey, and
// readback() finds an already-sent message by that header in the Sent mailbox.
// Without a searchable marker the executor's readback would be blind and
// double-send could not be ruled out (spec P0.3).
//
// The real Gmail-write transport is injected (MailTransport); the default
// DryRunTransport sends nothing (records in memory) so this builds and runs
// before the write-scope consent + a live Gmail connector exist.
export const IDEMPOTENCY_HEADER = 'X-Marveen-Idempotency-Key';
export class GmailSendAdapter {
    transport;
    attachmentResolver;
    actionType = 'EMAIL_SEND';
    constructor(transport, attachmentResolver) {
        this.transport = transport;
        this.attachmentResolver = attachmentResolver;
    }
    async send(action) {
        const p = action.payload;
        if (!p?.to || !p.subject)
            throw new Error(`EMAIL_SEND payload missing to/subject (ledger ${action.ledgerId})`);
        // P4: attachments only via the share gate. The document ids are part of the
        // approved payload, so approval already fixed exactly which documents go out.
        let attachments;
        if (p.attachmentDocumentIds && p.attachmentDocumentIds.length) {
            if (!this.attachmentResolver) {
                throw new Error(`EMAIL_SEND requests attachments but no share-gated resolver is wired (ledger ${action.ledgerId})`);
            }
            attachments = this.attachmentResolver(p.attachmentDocumentIds); // throws if any doc is not shareable
        }
        const email = {
            to: p.to, subject: p.subject, body: p.body ?? '',
            // The searchable marker embedded in the message = the external marker.
            headers: { [IDEMPOTENCY_HEADER]: action.externalIdempotencyMarker },
            ...(attachments ? { attachments } : {}),
        };
        const { messageId } = await this.transport.send(email);
        return { externalRef: messageId };
    }
    async readback(externalIdempotencyMarker) {
        const r = await this.transport.findSentByHeader(IDEMPOTENCY_HEADER, externalIdempotencyMarker);
        return { found: r.found, available: r.available, externalRef: r.messageId };
    }
}
/**
 * A transport that sends NOTHING for real — it records messages in memory keyed
 * by their idempotency header, so readback can find them. Safe default until a
 * live Gmail-write transport is wired, and the deterministic backing for tests.
 */
export class DryRunTransport {
    sent = new Map(); // key = idempotency header
    seq = 0;
    /** Set to simulate a transport error on the next send. */
    failNextSend = false;
    /** If true, send() delivers to the provider (records) THEN throws — models
     *  "it reached Gmail but we got a timeout". */
    reachThenThrow = false;
    /** If true, findSentByHeader reports the search could not run (available:false)
     *  — models the Sent mailbox being unreachable during readback. */
    readbackUnavailable = false;
    async send(email) {
        const key = email.headers[IDEMPOTENCY_HEADER];
        if (this.reachThenThrow) {
            const messageId = `dry-${++this.seq}`;
            if (key)
                this.sent.set(key, { ...email, messageId });
            throw new Error('timeout after delivery');
        }
        if (this.failNextSend) {
            this.failNextSend = false;
            throw new Error('transport failure');
        }
        const messageId = `dry-${++this.seq}`;
        if (key)
            this.sent.set(key, { ...email, messageId });
        return { messageId };
    }
    async findSentByHeader(name, value) {
        if (this.readbackUnavailable)
            return { found: false, available: false };
        if (name !== IDEMPOTENCY_HEADER)
            return { found: false };
        const m = this.sent.get(value);
        return m ? { found: true, messageId: m.messageId } : { found: false };
    }
}
