import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { storeDocument, resolveShareableAttachments, setDocumentShareable } from '../cos/cos-documents.js';
import { GmailSendAdapter } from '../cos/adapters/gmail-send.js';
import { buildRawMessage } from '../cos/adapters/gmail-api-transport.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T0 = 1_700_000_000;
let ROOT;
function storeDoc(shareable) {
    const db = getDb();
    const r = storeDocument(db, { namespace: 'zst', source: 'email', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: Buffer.from('PDFDATA') }, { now: T0, storeRoot: ROOT });
    if (shareable)
        setDocumentShareable(db, r.documentId, true, 'ZST_INTERNAL', T0);
    return r.documentId;
}
// A capturing transport so the test sees exactly what would be sent.
function captureTransport() {
    const sent = [];
    const t = {
        async send(email) { sent.push(email); return { messageId: 'msg-1' }; },
        async findSentByHeader() { return { found: false, available: true }; },
    };
    return { t, sent };
}
function action(payload) {
    return { ledgerId: 'L1', externalIdempotencyMarker: 'MARK-1', payload };
}
describe('P4 document send gate', () => {
    beforeEach(() => { initDatabase(':memory:'); ROOT = mkdtempSync(join(tmpdir(), 'p4-')); });
    afterEach(() => { try {
        rmSync(ROOT, { recursive: true, force: true });
    }
    catch { /* noop */ } });
    it('resolveShareableAttachments BLOCKS a document not cleared for sharing', () => {
        const db = getDb();
        const id = storeDoc(false); // default: external_share_allowed=0
        expect(() => resolveShareableAttachments(db, [id])).toThrow(/not marked shareable/);
    });
    it('resolveShareableAttachments returns content once cleared', () => {
        const db = getDb();
        const id = storeDoc(true);
        const atts = resolveShareableAttachments(db, [id]);
        expect(atts).toHaveLength(1);
        expect(atts[0].filename).toBe('invoice.pdf');
        expect(Buffer.from(atts[0].contentBase64, 'base64').toString()).toBe('PDFDATA');
    });
    it('blocks a missing document id', () => {
        expect(() => resolveShareableAttachments(getDb(), ['doc-nope'])).toThrow(/no document/);
    });
    it('GmailSendAdapter refuses to send when an attachment is not shareable', async () => {
        const db = getDb();
        const id = storeDoc(false);
        const { t } = captureTransport();
        const adapter = new GmailSendAdapter(t, ids => resolveShareableAttachments(db, ids));
        await expect(adapter.send(action({ to: 'a@b.hu', subject: 'S', body: 'B', attachmentDocumentIds: [id] })))
            .rejects.toThrow(/not marked shareable/);
    });
    it('GmailSendAdapter attaches a cleared document and sends', async () => {
        const db = getDb();
        const id = storeDoc(true);
        const { t, sent } = captureTransport();
        const adapter = new GmailSendAdapter(t, ids => resolveShareableAttachments(db, ids));
        const r = await adapter.send(action({ to: 'a@b.hu', subject: 'S', body: 'B', attachmentDocumentIds: [id] }));
        expect(r.externalRef).toBe('msg-1');
        expect(sent[0].attachments).toHaveLength(1);
        expect(sent[0].attachments[0].filename).toBe('invoice.pdf');
    });
    it('a payload requesting attachments with NO resolver wired is refused (fail-closed)', async () => {
        const { t } = captureTransport();
        const adapter = new GmailSendAdapter(t); // no resolver
        await expect(adapter.send(action({ to: 'a@b.hu', subject: 'S', body: 'B', attachmentDocumentIds: ['x'] })))
            .rejects.toThrow(/no share-gated resolver/);
    });
    it('buildRawMessage produces multipart/mixed with the attachment', () => {
        const email = {
            to: 'a@b.hu', subject: 'Szia', body: 'test', headers: {},
            attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('PDFDATA').toString('base64') }],
        };
        const raw = Buffer.from(buildRawMessage(email, 'MARK-1', 'me@zstradio.com', false).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
        expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary=/);
        expect(raw).toMatch(/Content-Disposition: attachment; filename="invoice.pdf"/);
        expect(raw).toMatch(/Content-Transfer-Encoding: base64/);
    });
    it('setDocumentShareable is an explicit, auditable clearance (default stays blocked)', () => {
        const db = getDb();
        const id = storeDoc(false);
        const row0 = db.prepare(`SELECT external_share_allowed FROM cos_documents WHERE document_id=?`).get(id);
        expect(row0.external_share_allowed).toBe(0);
        setDocumentShareable(db, id, true, 'ZST_INTERNAL', T0);
        const row1 = db.prepare(`SELECT external_share_allowed, sensitivity FROM cos_documents WHERE document_id=?`).get(id);
        expect(row1.external_share_allowed).toBe(1);
        expect(row1.sensitivity).toBe('ZST_INTERNAL');
    });
});
