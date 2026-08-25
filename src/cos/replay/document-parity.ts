// Stage 2H-C/D/E — DOCUMENT PARITY, split into the surfaces it actually has
// (Istvan, 2026-08-18). One vague "document PASS" would hide which half was
// measured, so nothing here reports a single boolean.
//
// C1 rendered thread documents: the production path is
// `storeCaseThread` -> `renderThread` + `storeDocument(docKind='email_thread')`.
// It is RUN here, unchanged, with the immutable corpus standing in for the Gmail
// transport.
//
// C2 raw Gmail attachments: the same production `storeDocument`, fed the
// immutable sidecar bytes, into a SEPARATE shadow document root. Only the proven
// Gmail-ingest path enters the denominator: the Drive-migrated documents are not
// email parity, and the attachments production never ingested are production's
// actual behaviour, not a gap for the shadow to fill.
//
// D docKind: classified by the shared normative ruleset both the production
// Python ingest and this module read. No shadow copy.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { storeDocument } from '../cos-documents.js'
import { storeCaseThread, type ThreadMessage } from '../gmail-thread-read.js'
import { classifyDocumentKind } from '../document-kind.js'
import { cutoffAlignment, type CutoffAlignment } from './source-replay.js'
import type { ParitySurfaceStatus, ReplayCorpus } from './types.js'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** The production linker (`linkDocumentToCase`) is a deliberate NO-OP when the
 *  case row is absent -- the document is stored, just unlinked. The shadow holds
 *  no cases, so without a seed the link could never be established and the
 *  comparison would report "absent" for every row while proving nothing.
 *
 *  This seeds an id-only row so the REAL linker has something to update. The
 *  seeded columns are sentinels and are NEVER compared; only the resulting link
 *  is. Seeding the shadow is not case creation: no production table is touched. */
export const SHADOW_SEED_SENTINEL = 'SHADOW_SEED_NOT_COMPARED'
export function seedShadowCaseRow(db: Database.Database, namespace: 'personal' | 'zst', caseId: string, now: number): void {
  const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases'
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE case_id = ?`).get(caseId)
  if (exists) return
  db.prepare(
    `INSERT INTO ${table} (case_id, title, case_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(caseId, SHADOW_SEED_SENTINEL, SHADOW_SEED_SENTINEL, 'NEW', now, now)
}

function linkedInShadow(db: Database.Database, namespace: 'personal' | 'zst', caseId: string, documentId: string): boolean {
  const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases'
  const row = db.prepare(`SELECT related_document_ids FROM ${table} WHERE case_id = ?`).get(caseId) as { related_document_ids: string | null } | undefined
  if (!row?.related_document_ids) return false
  try { const ids = JSON.parse(row.related_document_ids); return Array.isArray(ids) && ids.includes(documentId) } catch { return false }
}
const shaText = (s: string) => createHash('sha256').update(s).digest('hex')

/** A production `cos_documents` row, read-only from the live store. */
export interface ProductionDocumentRow {
  documentId: string
  namespace: 'personal' | 'zst'
  caseId: string | null
  source: string
  sourceRef: string | null
  filename: string | null
  mimeType: string | null
  byteSize: number | null
  sha256: string | null
  docKind: string | null
  createdAt: number | null
  updatedAt: number | null
}

/** One sidecar attachment: immutable bytes retrieved once, addressed by sha256. */
export interface SidecarAttachment {
  sourceAccountId: string
  messageId: string
  filename: string
  mimeType: string | null
  sizeBytes: number
  sha256: string
  /** absolute path to the retrieved bytes */
  blobPath: string
}

export type FieldVerdict = 'MATCH' | 'MISMATCH' | 'NOT_REPLAYABLE' | 'BOTH_ABSENT'

export interface DocumentFieldParity {
  field: string
  productionValue: unknown
  replayValue: unknown
  verdict: FieldVerdict
}

export interface DocumentParityRow {
  productionDocumentId: string
  namespace: string
  sourceRef: string | null
  docKindProduction: string | null
  cutoff: CutoffAlignment
  eligible: boolean
  replayAttempted: boolean
  replayDocumentId: string | null
  fields: DocumentFieldParity[]
  verdict: 'PASS' | 'MISMATCH' | 'POST_CUTOFF' | 'NOT_ELIGIBLE' | 'UNKNOWN' | 'CROSS_DOMAIN_MOVE_EXCLUDED'
  reasons: string[]
}

export interface DocumentSurfaceSummary {
  eligible: number
  compared: number
  matched: number
  mismatched: number
  notReplayable: number
  postCutoff: number
  crossDomainMoveExcluded: number
  unknown: number
}

function summarise(rows: DocumentParityRow[]): DocumentSurfaceSummary {
  return {
    eligible: rows.filter(r => r.eligible).length,
    compared: rows.filter(r => r.replayAttempted).length,
    matched: rows.filter(r => r.verdict === 'PASS').length,
    mismatched: rows.filter(r => r.verdict === 'MISMATCH').length,
    notReplayable: rows.flatMap(r => r.fields).filter(f => f.verdict === 'NOT_REPLAYABLE').length,
    postCutoff: rows.filter(r => r.verdict === 'POST_CUTOFF').length,
    crossDomainMoveExcluded: rows.filter(r => r.verdict === 'CROSS_DOMAIN_MOVE_EXCLUDED').length,
    unknown: rows.filter(r => r.verdict === 'UNKNOWN').length,
  }
}
function statusOf(s: DocumentSurfaceSummary): ParitySurfaceStatus {
  if (s.eligible === 0) return 'NO_ELIGIBLE_HISTORICAL_INPUT'
  if (s.unknown > 0 || s.mismatched > 0 || s.matched !== s.compared) return 'FAIL'
  return 'PASS'
}

function cmp(field: string, p: unknown, r: unknown): DocumentFieldParity {
  const pv = p ?? null, rv = r ?? null
  const verdict: FieldVerdict = pv === null && rv === null ? 'BOTH_ABSENT'
    : JSON.stringify(pv) === JSON.stringify(rv) ? 'MATCH' : 'MISMATCH'
  return { field, productionValue: pv, replayValue: rv, verdict }
}
function notReplayable(field: string, p: unknown, why: string): DocumentFieldParity {
  return { field, productionValue: p ?? null, replayValue: `NOT_REPLAYABLE: ${why}`, verdict: 'NOT_REPLAYABLE' }
}

// ── C1 ─────────────────────────────────────────────────────────────────────

/** MEASURED 2026-08-18, not assumed: rendering 40 corpus threads through the
 *  production renderer reproduced 0 of 40 production digests, and the residual
 *  was 7-13 bytes PER MESSAGE — the raw `Date:` header string the renderer
 *  embeds. The corpus normalised provider time to an epoch and did not retain
 *  that header, so the content digest of a rendered thread is not derivable from
 *  this corpus. It is declared, not silently skipped, and it is not a PASS. */
export const THREAD_CONTENT_NOT_REPLAYABLE_REASON =
  'the renderer embeds the raw provider Date header; the corpus keeps provider time as an epoch only '
  + '(measured: 0/40 digests reproduced, residual 7-13 bytes per message)'

export interface ThreadDocumentParityInput {
  corpus: ReplayCorpus
  productionDocuments: readonly ProductionDocumentRow[]
  /** caseId -> documentIds, from `{personal,zst}_cases.related_document_ids` */
  productionCaseDocumentLinks: Readonly<Record<string, string[]>>
  /** caseIds whose namespace was deliberately moved, with ledger evidence */
  crossDomainMovedCases?: Readonly<Record<string, string>>
}

export async function runThreadDocumentParity(
  shadowDb: Database.Database,
  input: ThreadDocumentParityInput,
  shadowStoreRoot: string,
  now: number,
): Promise<{ rows: DocumentParityRow[]; summary: DocumentSurfaceSummary; identityStatus: ParitySurfaceStatus; contentStatus: ParitySurfaceStatus }> {
  const byThread = new Map<string, ReplayCorpus['messages']>()
  for (const m of input.corpus.messages) {
    const l = byThread.get(m.threadId) ?? []; l.push(m); byThread.set(m.threadId, l)
  }
  const rows: DocumentParityRow[] = []

  for (const doc of input.productionDocuments) {
    if (doc.docKind !== 'email_thread') continue
    const base = {
      productionDocumentId: doc.documentId, namespace: doc.namespace, sourceRef: doc.sourceRef,
      docKindProduction: doc.docKind,
    }
    const cutoff = cutoffAlignment(doc, input.corpus.anchorEnd)
    if (cutoff === 'CUTOFF_ALIGNMENT_UNKNOWN') {
      throw new Error(`CUTOFF_ALIGNMENT_UNKNOWN: document ${doc.documentId} carries no usable timestamps`)
    }
    if (cutoff === 'POST_CUTOFF_PRODUCTION_STATE') {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'POST_CUTOFF', reasons: ['this document was created or last modified after the corpus cutoff'] })
      continue
    }
    const moveEvidence = doc.caseId ? input.crossDomainMovedCases?.[doc.caseId] : undefined
    if (moveEvidence) {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'CROSS_DOMAIN_MOVE_EXCLUDED',
        reasons: [`the owning case was deliberately moved between namespaces; ledger evidence: ${moveEvidence}`] })
      continue
    }
    const msgs = doc.sourceRef ? byThread.get(doc.sourceRef) : undefined
    if (!msgs?.length) {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'NOT_ELIGIBLE', reasons: ['the thread this document renders is not in the corpus'] })
      continue
    }

    if (doc.caseId) seedShadowCaseRow(shadowDb, doc.namespace, doc.caseId, now)
    const ordered = msgs.slice().sort((a, b) => a.occurredAt - b.occurredAt || a.messageId.localeCompare(b.messageId))
    const threadMessages: ThreadMessage[] = ordered.map(m => ({
      id: m.messageId, from: m.from ?? '', to: (m.to ?? []).join(', '),
      date: new Date(m.occurredAt * 1000).toISOString(), subject: m.subject ?? '', body: m.bodyText ?? '',
    }))
    // The production function, run — not a re-implementation of its composition.
    const result = await storeCaseThread(
      shadowDb, { fetchThread: async () => threadMessages },
      doc.caseId ?? `shadow-case-${doc.documentId}`, doc.sourceRef!,
      doc.namespace, now,
    )
    const replayRow = result.documentId
      ? shadowDb.prepare(`SELECT document_id, namespace, source, source_ref, doc_kind, case_id, filename, mime_type
                            FROM cos_documents WHERE document_id = ?`).get(result.documentId) as Record<string, unknown> | undefined
      : undefined
    const linked = doc.caseId && result.documentId
      ? linkedInShadow(shadowDb, doc.namespace, doc.caseId, result.documentId) : null

    const fields: DocumentFieldParity[] = [
      cmp('source', doc.source, replayRow?.source ?? null),
      cmp('sourceRef', doc.sourceRef, replayRow?.source_ref ?? null),
      cmp('namespace', doc.namespace, replayRow?.namespace ?? null),
      cmp('docKind', doc.docKind, replayRow?.doc_kind ?? null),
      cmp('caseDocumentLink',
        doc.caseId ? (input.productionCaseDocumentLinks[doc.caseId] ?? []).includes(doc.documentId) : null,
        doc.caseId ? linked : null),
      notReplayable('sha256', doc.sha256, THREAD_CONTENT_NOT_REPLAYABLE_REASON),
      notReplayable('byteSize', doc.byteSize, THREAD_CONTENT_NOT_REPLAYABLE_REASON),
    ]
    const mismatched = fields.some(f => f.verdict === 'MISMATCH')
    rows.push({
      ...base, cutoff, eligible: true, replayAttempted: true,
      replayDocumentId: result.documentId ?? null, fields,
      verdict: result.stored ? (mismatched ? 'MISMATCH' : 'PASS') : 'UNKNOWN',
      reasons: result.stored ? [] : [`the production store path did not store: ${result.reason}`],
    })
  }

  const summary = summarise(rows)
  return {
    rows, summary,
    identityStatus: statusOf(summary),
    // The content half never becomes PASS on this corpus. Naming it is the point.
    contentStatus: 'NOT_REPLAYABLE',
  }
}

// ── C2 ─────────────────────────────────────────────────────────────────────

export interface AttachmentParityInput {
  productionDocuments: readonly ProductionDocumentRow[]
  sidecar: readonly SidecarAttachment[]
  corpusAnchorEnd: number
  productionCaseDocumentLinks: Readonly<Record<string, string[]>>
  crossDomainMovedCases?: Readonly<Record<string, string>>
}

export function runGmailAttachmentParity(
  shadowDb: Database.Database,
  input: AttachmentParityInput,
  shadowStoreRoot: string,
  now: number,
): { rows: DocumentParityRow[]; summary: DocumentSurfaceSummary; identityStatus: ParitySurfaceStatus; docKindStatus: ParitySurfaceStatus } {
  // Denominator: the PROVEN Gmail-ingest path only. `source='email'`, not a
  // rendered thread, and a sourceRef the sidecar actually holds bytes for.
  const sidecarByMessage = new Map<string, SidecarAttachment[]>()
  for (const a of input.sidecar) {
    const l = sidecarByMessage.get(a.messageId) ?? []; l.push(a); sidecarByMessage.set(a.messageId, l)
  }
  const rows: DocumentParityRow[] = []

  for (const doc of input.productionDocuments) {
    if (doc.source !== 'email' || doc.docKind === 'email_thread') continue
    const base = {
      productionDocumentId: doc.documentId, namespace: doc.namespace, sourceRef: doc.sourceRef,
      docKindProduction: doc.docKind,
    }
    const cutoff = cutoffAlignment(doc, input.corpusAnchorEnd)
    if (cutoff === 'CUTOFF_ALIGNMENT_UNKNOWN') {
      throw new Error(`CUTOFF_ALIGNMENT_UNKNOWN: document ${doc.documentId} carries no usable timestamps`)
    }
    if (cutoff === 'POST_CUTOFF_PRODUCTION_STATE') {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'POST_CUTOFF', reasons: ['created or last modified after the corpus cutoff'] })
      continue
    }
    const moveEvidence = doc.caseId ? input.crossDomainMovedCases?.[doc.caseId] : undefined
    if (moveEvidence) {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'CROSS_DOMAIN_MOVE_EXCLUDED',
        reasons: [`the owning case was deliberately moved between namespaces; ledger evidence: ${moveEvidence}`] })
      continue
    }
    const candidates = doc.sourceRef ? sidecarByMessage.get(doc.sourceRef) ?? [] : []
    // Identity is the sha256: the Gmail attachmentId is in-flight only.
    const match = candidates.find(a => a.sha256 === doc.sha256)
      ?? candidates.find(a => a.filename === doc.filename)
    if (!match) {
      rows.push({ ...base, cutoff, eligible: false, replayAttempted: false, replayDocumentId: null, fields: [],
        verdict: 'NOT_ELIGIBLE',
        reasons: [doc.sourceRef
          ? 'the sidecar holds no retrieved attachment for this message; the Gmail-ingest path is not proven for it'
          : 'the production document names no source message'] })
      continue
    }

    if (doc.caseId) seedShadowCaseRow(shadowDb, doc.namespace, doc.caseId, now)
    const bytes = readFileSync(match.blobPath)
    const stored = storeDocument(shadowDb, {
      namespace: doc.namespace, caseId: doc.caseId ?? undefined, source: 'email', sourceRef: match.messageId,
      filename: match.filename, mimeType: match.mimeType ?? undefined, bytes,
      docKind: classifyDocumentKind(match.filename),
    }, { now, storeRoot: shadowStoreRoot })
    const replayRow = shadowDb.prepare(
      `SELECT document_id, namespace, source, source_ref, filename, mime_type, byte_size, sha256, doc_kind, case_id
         FROM cos_documents WHERE document_id = ?`).get(stored.documentId) as Record<string, unknown> | undefined
    const linked = doc.caseId ? linkedInShadow(shadowDb, doc.namespace, doc.caseId, stored.documentId) : null

    const fields: DocumentFieldParity[] = [
      cmp('sha256', doc.sha256, replayRow?.sha256 ?? null),
      cmp('byteSize', doc.byteSize, replayRow?.byte_size ?? null),
      cmp('namespace', doc.namespace, replayRow?.namespace ?? null),
      cmp('source', doc.source, replayRow?.source ?? null),
      cmp('sourceRef', doc.sourceRef, replayRow?.source_ref ?? null),
      cmp('documentIdentity', doc.documentId, stored.documentId),
      cmp('caseDocumentLink',
        doc.caseId ? (input.productionCaseDocumentLinks[doc.caseId] ?? []).includes(doc.documentId) : null,
        doc.caseId ? linked : null),
      cmp('docKind', doc.docKind, replayRow?.doc_kind ?? null),
      // The bytes themselves, verified rather than trusted: the sidecar blob is
      // re-hashed here, so a corrupted blob cannot pass as an agreement.
      cmp('sidecarByteDigest', doc.sha256, sha256(bytes)),
    ]
    const mismatched = fields.some(f => f.verdict === 'MISMATCH')
    rows.push({
      ...base, cutoff, eligible: true, replayAttempted: true, replayDocumentId: stored.documentId,
      fields, verdict: mismatched ? 'MISMATCH' : 'PASS', reasons: [],
    })
  }

  const summary = summarise(rows)
  const docKindRows = rows.filter(r => r.eligible)
  const docKindMismatch = docKindRows.some(r => r.fields.some(f => f.field === 'docKind' && f.verdict === 'MISMATCH'))
  return {
    rows, summary,
    identityStatus: statusOf(summary),
    docKindStatus: docKindRows.length === 0 ? 'NO_ELIGIBLE_HISTORICAL_INPUT' : docKindMismatch ? 'FAIL' : 'PASS',
  }
}

export interface DocumentReadiness {
  threadDocumentParityStatus: ParitySurfaceStatus
  threadDocumentContentStatus: ParitySurfaceStatus
  gmailAttachmentIdentityParityStatus: ParitySurfaceStatus
  attachmentDocKindParityStatus: ParitySurfaceStatus
  documentParityStatus: ParitySurfaceStatus
  coverageLimitations: string[]
  reasons: string[]
  totals: DocumentSurfaceSummary
}

/** documentParityStatus is PASS only when every MANDATORY replayable surface
 *  passed and nothing is UNKNOWN. A declared NOT_REPLAYABLE surface is a coverage
 *  limitation: it is listed, and it never counts as a pass. */
export function evaluateDocumentReadiness(inputs: {
  thread: { summary: DocumentSurfaceSummary; identityStatus: ParitySurfaceStatus; contentStatus: ParitySurfaceStatus }
  attachment: { summary: DocumentSurfaceSummary; identityStatus: ParitySurfaceStatus; docKindStatus: ParitySurfaceStatus }
}): DocumentReadiness {
  const reasons: string[] = []
  const coverageLimitations: string[] = []
  const mandatory: Array<[string, ParitySurfaceStatus]> = [
    ['threadDocumentParityStatus', inputs.thread.identityStatus],
    ['gmailAttachmentIdentityParityStatus', inputs.attachment.identityStatus],
    ['attachmentDocKindParityStatus', inputs.attachment.docKindStatus],
  ]
  for (const [name, st] of mandatory) if (st !== 'PASS') reasons.push(`${name} = ${st}`)
  if (inputs.thread.contentStatus === 'NOT_REPLAYABLE') {
    coverageLimitations.push(
      'rendered thread CONTENT (sha256, byteSize) is NOT_REPLAYABLE from this corpus; the identity half was compared')
  }
  const totals: DocumentSurfaceSummary = {
    eligible: inputs.thread.summary.eligible + inputs.attachment.summary.eligible,
    compared: inputs.thread.summary.compared + inputs.attachment.summary.compared,
    matched: inputs.thread.summary.matched + inputs.attachment.summary.matched,
    mismatched: inputs.thread.summary.mismatched + inputs.attachment.summary.mismatched,
    notReplayable: inputs.thread.summary.notReplayable + inputs.attachment.summary.notReplayable,
    postCutoff: inputs.thread.summary.postCutoff + inputs.attachment.summary.postCutoff,
    crossDomainMoveExcluded: inputs.thread.summary.crossDomainMoveExcluded + inputs.attachment.summary.crossDomainMoveExcluded,
    unknown: inputs.thread.summary.unknown + inputs.attachment.summary.unknown,
  }
  if (totals.unknown > 0) reasons.push(`${totals.unknown} document(s) with an undetermined result`)
  return {
    threadDocumentParityStatus: inputs.thread.identityStatus,
    threadDocumentContentStatus: inputs.thread.contentStatus,
    gmailAttachmentIdentityParityStatus: inputs.attachment.identityStatus,
    attachmentDocKindParityStatus: inputs.attachment.docKindStatus,
    documentParityStatus: reasons.length ? 'FAIL' : 'PASS',
    coverageLimitations, reasons, totals,
  }
}

export { shaText }
