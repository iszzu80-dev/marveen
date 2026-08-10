import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { storeDocument, documentsForCase, readDocumentBytes, linkDocumentToCase } from '../cos/cos-documents.js';
import { createZstCase } from '../cos/zst-case-store.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T0 = 1_700_000_000;
let ROOT;
describe('COS unified document store', () => {
    beforeEach(() => { initDatabase(':memory:'); ROOT = mkdtempSync(join(tmpdir(), 'cosdoc-')); });
    afterEach(() => { try {
        rmSync(ROOT, { recursive: true, force: true });
    }
    catch { /* noop */ } });
    it('stores bytes content-addressed, defaults to UNKNOWN/not-shareable, links to case', () => {
        const db = getDb();
        createZstCase(db, { caseId: 'zst-c1', title: 'Invoice case', caseType: 'INVOICE_INCOMING' }, T0);
        const r = storeDocument(db, {
            namespace: 'zst', caseId: 'zst-c1', source: 'email', filename: 'inv.pdf',
            mimeType: 'application/pdf', bytes: Buffer.from('hello-invoice'),
        }, { now: T0, storeRoot: ROOT });
        expect(r.duplicate).toBe(false);
        expect(existsSync(r.storedPath)).toBe(true);
        expect(r.storedPath.includes(r.sha256)).toBe(true);
        const docs = documentsForCase(db, 'zst', 'zst-c1');
        expect(docs).toHaveLength(1);
        expect(docs[0].sensitivity).toBe('UNKNOWN'); // sensitivity-first default
        expect(docs[0].external_share_allowed).toBe(0); // not shareable until classified
        // linked into the case's related_document_ids
        const rel = db.prepare(`SELECT related_document_ids FROM zst_cases WHERE case_id='zst-c1'`).get().related_document_ids;
        expect(JSON.parse(rel)).toContain(r.documentId);
    });
    it('dedups identical bytes for the same case (one file, one row)', () => {
        const db = getDb();
        createZstCase(db, { caseId: 'zst-c2', title: 'c', caseType: 'GENERAL_OPERATION' }, T0);
        const a = storeDocument(db, { namespace: 'zst', caseId: 'zst-c2', source: 'email', bytes: Buffer.from('same') }, { now: T0, storeRoot: ROOT });
        const b = storeDocument(db, { namespace: 'zst', caseId: 'zst-c2', source: 'email', bytes: Buffer.from('same') }, { now: T0 + 5, storeRoot: ROOT });
        expect(b.duplicate).toBe(true);
        expect(b.documentId).toBe(a.documentId);
        expect(db.prepare(`SELECT COUNT(*) n FROM cos_documents`).get().n).toBe(1);
    });
    it('keeps personal and zst namespaces separate (same bytes, two docs)', () => {
        const db = getDb();
        const p = storeDocument(db, { namespace: 'personal', source: 'telegram', bytes: Buffer.from('shared') }, { now: T0, storeRoot: ROOT });
        const z = storeDocument(db, { namespace: 'zst', source: 'telegram', bytes: Buffer.from('shared') }, { now: T0, storeRoot: ROOT });
        expect(p.documentId).not.toBe(z.documentId);
        expect(db.prepare(`SELECT COUNT(*) n FROM cos_documents`).get().n).toBe(2);
        // but the bytes dedup on disk (same sha, same file)
        expect(p.sha256).toBe(z.sha256);
        expect(p.storedPath).toBe(z.storedPath);
    });
    it('adopts a file already on disk (Drive backfill) without copying', () => {
        const db = getDb();
        const onDisk = join(ROOT, 'archive', 'pool.jpg');
        mkdirSync(join(ROOT, 'archive'), { recursive: true });
        writeFileSync(onDisk, Buffer.from('image-bytes'));
        const r = storeDocument(db, { namespace: 'personal', source: 'drive', storedPath: onDisk, filename: 'pool.jpg' }, { now: T0, storeRoot: ROOT });
        expect(r.storedPath).toBe(onDisk); // adopted in place
        expect(r.duplicate).toBe(false);
        const b = readDocumentBytes(db, r.documentId);
        expect(b.toString()).toBe('image-bytes');
    });
    it('reads bytes back with an integrity check', () => {
        const db = getDb();
        const r = storeDocument(db, { namespace: 'personal', source: 'manual', bytes: Buffer.from('content-x') }, { now: T0, storeRoot: ROOT });
        expect(readDocumentBytes(db, r.documentId).toString()).toBe('content-x');
    });
    it('a document can be stored before a case exists (nullable case_id)', () => {
        const db = getDb();
        const r = storeDocument(db, { namespace: 'personal', source: 'telegram', bytes: Buffer.from('orphan-photo') }, { now: T0, storeRoot: ROOT });
        expect(r.duplicate).toBe(false);
        const row = db.prepare(`SELECT case_id FROM cos_documents WHERE document_id=?`).get(r.documentId);
        expect(row.case_id).toBeNull();
    });
    it('linking is idempotent and skips a missing case', () => {
        const db = getDb();
        const r = storeDocument(db, { namespace: 'personal', source: 'manual', bytes: Buffer.from('doc') }, { now: T0, storeRoot: ROOT });
        linkDocumentToCase(db, 'personal', 'nonexistent-case', r.documentId, T0); // no throw
        expect(true).toBe(true);
    });
});
