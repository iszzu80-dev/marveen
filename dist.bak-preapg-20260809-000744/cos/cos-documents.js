// Unified COS document/attachment store (personal + ZST). One store, several
// inlets (email / telegram / drive / manual / web). Content lives LOCALLY, content-
// addressed by sha256 under a store root; this module writes the bytes + the index
// row + links the document to its case. Self-contained: no Google Drive dependency
// for the go-forward store.
//
// SAFETY: sensitivity-first. A document defaults to sensitivity UNKNOWN and
// external_share_allowed=0 — so nothing can be sent out until it is explicitly
// classified shareable + per-payload approved (the send path enforces that; this
// module just stores and never sends). Namespace isolation: personal and zst
// documents never mix (the row's namespace is the boundary).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
/** Default content-store root. Callers (tests) may override via opts.storeRoot. */
export function defaultDocStoreRoot() {
    return join(process.cwd(), 'store', 'cos-documents');
}
function contentPath(root, sha) {
    return join(root, sha.slice(0, 2), sha);
}
function sha256Of(buf) {
    return createHash('sha256').update(buf).digest('hex');
}
/**
 * Store a document into the unified COS store: content-address the bytes, write
 * them locally (dedup by sha256), insert the index row, and link it to the case.
 * Idempotent per (namespace, sha256, case): re-storing the same bytes for the same
 * case returns the existing document with duplicate=true — never a second file,
 * never a second row. Returns the document id + where the bytes live.
 */
export function storeDocument(db, input, opts = {}) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const root = opts.storeRoot ?? defaultDocStoreRoot();
    let sha;
    let storedPath;
    let byteSize;
    if (input.bytes) {
        sha = sha256Of(input.bytes);
        storedPath = contentPath(root, sha);
        byteSize = input.bytes.length;
        if (!existsSync(storedPath)) {
            mkdirSync(dirname(storedPath), { recursive: true });
            writeFileSync(storedPath, input.bytes);
        }
    }
    else if (input.storedPath) {
        // Adopt a file already on disk (Drive backfill) — hash it in place, don't move it.
        const buf = readFileSync(input.storedPath);
        sha = sha256Of(buf);
        storedPath = input.storedPath;
        byteSize = buf.length;
    }
    else {
        throw new Error('storeDocument: either bytes or storedPath is required');
    }
    const caseId = input.caseId ?? null;
    const existing = db.prepare(`SELECT document_id, stored_path FROM cos_documents WHERE namespace = ? AND sha256 = ? AND IFNULL(case_id,'') = IFNULL(?, '')`).get(input.namespace, sha, caseId);
    if (existing) {
        return { documentId: existing.document_id, sha256: sha, storedPath: existing.stored_path, duplicate: true };
    }
    // Derive the id from the dedup key (namespace|sha|case) so it is unique per row
    // yet stable: the same bytes in two namespaces, or linked to two cases, are
    // distinct documents with distinct ids (but the on-disk bytes still dedup).
    const documentId = `doc-${createHash('sha256').update(`${input.namespace}|${sha}|${caseId ?? ''}`).digest('hex').slice(0, 16)}`;
    db.prepare(`INSERT INTO cos_documents
       (document_id, namespace, case_id, source, source_ref, filename, mime_type, byte_size,
        sha256, stored_path, doc_kind, issuer, amount, due_date, extracted_text, sensitivity,
        external_share_allowed, received_at, created_at, updated_at)
     VALUES (@documentId, @namespace, @caseId, @source, @sourceRef, @filename, @mimeType, @byteSize,
        @sha256, @storedPath, @docKind, @issuer, @amount, @dueDate, @extractedText, @sensitivity,
        @externalShareAllowed, @receivedAt, @now, @now)`).run({
        documentId, namespace: input.namespace, caseId, source: input.source,
        sourceRef: input.sourceRef ?? null, filename: input.filename ?? null,
        mimeType: input.mimeType ?? null, byteSize, sha256: sha, storedPath,
        docKind: input.docKind ?? null, issuer: input.issuer ?? null, amount: input.amount ?? null,
        dueDate: input.dueDate ?? null, extractedText: input.extractedText ?? null,
        sensitivity: input.sensitivity ?? 'UNKNOWN',
        externalShareAllowed: input.externalShareAllowed ? 1 : 0,
        receivedAt: input.receivedAt ?? now, now,
    });
    if (caseId)
        linkDocumentToCase(db, input.namespace, caseId, documentId, now);
    return { documentId, sha256: sha, storedPath, duplicate: false };
}
/** Append a document id to the case's related_document_ids (JSON array), in the
 *  right namespace table. Idempotent — a doc already linked is not duplicated. */
export function linkDocumentToCase(db, namespace, caseId, documentId, now = Math.floor(Date.now() / 1000)) {
    const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases';
    const row = db.prepare(`SELECT related_document_ids FROM ${table} WHERE case_id = ?`).get(caseId);
    if (!row)
        return; // no such case (doc stays unlinked, still stored)
    let ids = [];
    try {
        ids = row.related_document_ids ? JSON.parse(row.related_document_ids) : [];
    }
    catch {
        ids = [];
    }
    if (!Array.isArray(ids))
        ids = [];
    if (ids.includes(documentId))
        return;
    ids.push(documentId);
    db.prepare(`UPDATE ${table} SET related_document_ids = ?, updated_at = ? WHERE case_id = ?`)
        .run(JSON.stringify(ids), now, caseId);
}
/** List documents for a case (namespace-scoped). */
export function documentsForCase(db, namespace, caseId) {
    return db.prepare(`SELECT document_id, namespace, case_id, source, filename, mime_type, byte_size, sha256,
       stored_path, doc_kind, amount, sensitivity, external_share_allowed
     FROM cos_documents WHERE namespace = ? AND case_id = ? ORDER BY created_at`).all(namespace, caseId);
}
/**
 * P4 send gate: resolve document ids to attachable content, enforcing the
 * share gate. A document is attachable to an OUTBOUND email ONLY if it is
 * explicitly marked shareable (external_share_allowed=1) and its content is
 * present (not purged). ANY id that is missing, not shareable, or purged makes
 * this THROW — so a send carrying an un-cleared document is blocked, never sent.
 * (The document ids live in the approved payload, so approval already covers
 * exactly which documents may go out — they cannot be swapped after approval.)
 */
export function resolveShareableAttachments(db, documentIds) {
    const out = [];
    for (const id of documentIds) {
        const row = db.prepare(`SELECT filename, mime_type, sha256, stored_path, external_share_allowed, content_purged_at, sensitivity
       FROM cos_documents WHERE document_id = ?`).get(id);
        if (!row)
            throw new Error(`attachment blocked: no document ${id}`);
        if (row.external_share_allowed !== 1) {
            throw new Error(`attachment blocked: document ${id} is not marked shareable (external_share_allowed=0, sensitivity=${row.sensitivity}) — clear it for sharing first`);
        }
        if (row.content_purged_at)
            throw new Error(`attachment blocked: document ${id} content was purged`);
        if (!row.stored_path || !existsSync(row.stored_path))
            throw new Error(`attachment blocked: document ${id} content missing on disk`);
        const buf = readFileSync(row.stored_path);
        if (sha256Of(buf) !== row.sha256)
            throw new Error(`attachment blocked: document ${id} integrity check failed`);
        out.push({
            documentId: id, filename: row.filename ?? `${id}.bin`,
            mimeType: row.mime_type ?? 'application/octet-stream', contentBase64: buf.toString('base64'),
        });
    }
    return out;
}
/** Mark a document shareable for outbound send (the explicit clearance the P4
 *  gate requires). Deliberately a separate, auditable action — a document is
 *  never shareable by default. */
export function setDocumentShareable(db, documentId, allowed, sensitivity, now = Math.floor(Date.now() / 1000)) {
    const sets = ['external_share_allowed = ?', 'updated_at = ?'];
    const args = [allowed ? 1 : 0, now];
    if (sensitivity) {
        sets.splice(1, 0, 'sensitivity = ?');
        args.splice(1, 0, sensitivity);
    }
    args.push(documentId);
    const info = db.prepare(`UPDATE cos_documents SET ${sets.join(', ')} WHERE document_id = ?`).run(...args);
    if (info.changes === 0)
        throw new Error(`no document ${documentId}`);
}
/** Read a stored document's bytes back (integrity-checked against its sha256).
 *  Throws if the content was purged or the on-disk bytes no longer match. */
export function readDocumentBytes(db, documentId) {
    const row = db.prepare(`SELECT sha256, stored_path, content_purged_at FROM cos_documents WHERE document_id = ?`).get(documentId);
    if (!row)
        throw new Error(`no document ${documentId}`);
    if (row.content_purged_at)
        throw new Error(`document ${documentId} content was purged`);
    if (!row.stored_path || !existsSync(row.stored_path))
        throw new Error(`document ${documentId} content missing on disk`);
    const buf = readFileSync(row.stored_path);
    if (sha256Of(buf) !== row.sha256)
        throw new Error(`document ${documentId} integrity check failed (sha mismatch)`);
    return buf;
}
