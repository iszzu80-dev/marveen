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

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type DocNamespace = 'personal' | 'zst'
export type DocSource = 'email' | 'telegram' | 'drive' | 'manual' | 'web'

export interface StoreDocumentInput {
  namespace: DocNamespace
  caseId?: string | null
  source: DocSource
  sourceRef?: string
  filename?: string
  mimeType?: string
  /** The file bytes. Omit ONLY when adopting a file already on disk (pass storedPath). */
  bytes?: Buffer
  /** Adopt a file already on disk (e.g. the Drive backfill archive) instead of copying. */
  storedPath?: string
  docKind?: string
  issuer?: string
  amount?: number
  dueDate?: string
  extractedText?: string
  sensitivity?: string
  externalShareAllowed?: boolean
  receivedAt?: number
}

export interface StoredDocument {
  documentId: string
  sha256: string
  storedPath: string
  duplicate: boolean
}

/** Default content-store root. Callers (tests) may override via opts.storeRoot. */
export function defaultDocStoreRoot(): string {
  return join(process.cwd(), 'store', 'cos-documents')
}

function contentPath(root: string, sha: string): string {
  return join(root, sha.slice(0, 2), sha)
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Store a document into the unified COS store: content-address the bytes, write
 * them locally (dedup by sha256), insert the index row, and link it to the case.
 * Idempotent per (namespace, sha256, case): re-storing the same bytes for the same
 * case returns the existing document with duplicate=true — never a second file,
 * never a second row. Returns the document id + where the bytes live.
 */
export function storeDocument(
  db: Database.Database, input: StoreDocumentInput,
  opts: { now?: number; storeRoot?: string } = {},
): StoredDocument {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const root = opts.storeRoot ?? defaultDocStoreRoot()

  let sha: string
  let storedPath: string
  let byteSize: number

  if (input.bytes) {
    sha = sha256Of(input.bytes)
    storedPath = contentPath(root, sha)
    byteSize = input.bytes.length
    if (!existsSync(storedPath)) {
      mkdirSync(dirname(storedPath), { recursive: true })
      writeFileSync(storedPath, input.bytes)
    }
  } else if (input.storedPath) {
    // Adopt a file already on disk (Drive backfill) — hash it in place, don't move it.
    const buf = readFileSync(input.storedPath)
    sha = sha256Of(buf)
    storedPath = input.storedPath
    byteSize = buf.length
  } else {
    throw new Error('storeDocument: either bytes or storedPath is required')
  }

  const caseId = input.caseId ?? null
  const existing = db.prepare(
    `SELECT document_id, stored_path FROM cos_documents WHERE namespace = ? AND sha256 = ? AND IFNULL(case_id,'') = IFNULL(?, '')`
  ).get(input.namespace, sha, caseId) as { document_id: string; stored_path: string } | undefined
  if (existing) {
    return { documentId: existing.document_id, sha256: sha, storedPath: existing.stored_path, duplicate: true }
  }

  // Derive the id from the dedup key (namespace|sha|case) so it is unique per row
  // yet stable: the same bytes in two namespaces, or linked to two cases, are
  // distinct documents with distinct ids (but the on-disk bytes still dedup).
  const documentId = `doc-${createHash('sha256').update(`${input.namespace}|${sha}|${caseId ?? ''}`).digest('hex').slice(0, 16)}`
  db.prepare(
    `INSERT INTO cos_documents
       (document_id, namespace, case_id, source, source_ref, filename, mime_type, byte_size,
        sha256, stored_path, doc_kind, issuer, amount, due_date, extracted_text, sensitivity,
        external_share_allowed, received_at, created_at, updated_at)
     VALUES (@documentId, @namespace, @caseId, @source, @sourceRef, @filename, @mimeType, @byteSize,
        @sha256, @storedPath, @docKind, @issuer, @amount, @dueDate, @extractedText, @sensitivity,
        @externalShareAllowed, @receivedAt, @now, @now)`
  ).run({
    documentId, namespace: input.namespace, caseId, source: input.source,
    sourceRef: input.sourceRef ?? null, filename: input.filename ?? null,
    mimeType: input.mimeType ?? null, byteSize, sha256: sha, storedPath,
    docKind: input.docKind ?? null, issuer: input.issuer ?? null, amount: input.amount ?? null,
    dueDate: input.dueDate ?? null, extractedText: input.extractedText ?? null,
    sensitivity: input.sensitivity ?? 'UNKNOWN',
    externalShareAllowed: input.externalShareAllowed ? 1 : 0,
    receivedAt: input.receivedAt ?? now, now,
  })

  if (caseId) linkDocumentToCase(db, input.namespace, caseId, documentId, now)
  return { documentId, sha256: sha, storedPath, duplicate: false }
}

/** Append a document id to the case's related_document_ids (JSON array), in the
 *  right namespace table. Idempotent — a doc already linked is not duplicated. */
export function linkDocumentToCase(
  db: Database.Database, namespace: DocNamespace, caseId: string, documentId: string,
  now = Math.floor(Date.now() / 1000),
): void {
  const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases'
  const row = db.prepare(`SELECT related_document_ids FROM ${table} WHERE case_id = ?`).get(caseId) as
    { related_document_ids: string | null } | undefined
  if (!row) return  // no such case (doc stays unlinked, still stored)
  let ids: string[] = []
  try { ids = row.related_document_ids ? JSON.parse(row.related_document_ids) : [] } catch { ids = [] }
  if (!Array.isArray(ids)) ids = []
  if (ids.includes(documentId)) return
  ids.push(documentId)
  db.prepare(`UPDATE ${table} SET related_document_ids = ?, updated_at = ? WHERE case_id = ?`)
    .run(JSON.stringify(ids), now, caseId)
}

export interface DocumentRow {
  document_id: string
  namespace: string
  case_id: string | null
  source: string
  filename: string | null
  mime_type: string | null
  byte_size: number | null
  sha256: string
  stored_path: string | null
  doc_kind: string | null
  amount: number | null
  sensitivity: string
  external_share_allowed: number
}

/** List documents for a case (namespace-scoped). */
export function documentsForCase(db: Database.Database, namespace: DocNamespace, caseId: string): DocumentRow[] {
  return db.prepare(
    `SELECT document_id, namespace, case_id, source, filename, mime_type, byte_size, sha256,
       stored_path, doc_kind, amount, sensitivity, external_share_allowed
     FROM cos_documents WHERE namespace = ? AND case_id = ? ORDER BY created_at`
  ).all(namespace, caseId) as DocumentRow[]
}

/** Read a stored document's bytes back (integrity-checked against its sha256).
 *  Throws if the content was purged or the on-disk bytes no longer match. */
export function readDocumentBytes(db: Database.Database, documentId: string): Buffer {
  const row = db.prepare(
    `SELECT sha256, stored_path, content_purged_at FROM cos_documents WHERE document_id = ?`
  ).get(documentId) as { sha256: string; stored_path: string | null; content_purged_at: number | null } | undefined
  if (!row) throw new Error(`no document ${documentId}`)
  if (row.content_purged_at) throw new Error(`document ${documentId} content was purged`)
  if (!row.stored_path || !existsSync(row.stored_path)) throw new Error(`document ${documentId} content missing on disk`)
  const buf = readFileSync(row.stored_path)
  if (sha256Of(buf) !== row.sha256) throw new Error(`document ${documentId} integrity check failed (sha mismatch)`)
  return buf
}
