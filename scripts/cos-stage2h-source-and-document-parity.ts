#!/usr/bin/env npx tsx
// Stage 2H-A/B/C/E/F — historical source replay + document parity (Istvan GO, 2026-08-18).
//
// READ-ONLY with respect to production: JSON snapshots and the immutable sidecar
// blobs are the only inputs. Every write goes to an in-memory shadow database and
// a dedicated shadow document root. No correction, no canary, no activation.

import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { initCosSchema } from '../src/cos/schema.js'
import { runHistoricalSourceReplay } from '../src/cos/replay/source-replay.js'
import {
  runThreadDocumentParity, runGmailAttachmentParity, evaluateDocumentReadiness,
  type ProductionDocumentRow, type SidecarAttachment,
} from '../src/cos/replay/document-parity.js'
import type { ProductionCaseSnapshot, ReplayCorpus } from '../src/cos/replay/types.js'

function arg(n: string): string | undefined { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
function required(n: string): string { const v = arg(n); if (!v) throw new Error(`missing required ${n}`); return resolve(v) }

const corpusPath = required('--corpus')
const casesPath = required('--production-cases')
const documentsPath = required('--documents')
const sidecarPath = required('--sidecar')
const sidecarRoot = required('--sidecar-root')
const shadowRoot = required('--shadow-root')
const liveDbPath = required('--live-db')
const out = required('--out')
const NOW = 1_787_000_000

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as ReplayCorpus
const casesRaw = JSON.parse(readFileSync(casesPath, 'utf8')) as
  | ProductionCaseSnapshot[]
  | { capturedAt: number; cases: ProductionCaseSnapshot[] }
// The exporter's shape changed when capturedAt was added. Handle BOTH rather than
// assume: a consumer that silently reads the wrong shape reports an empty
// denominator as a clean run.
const productionCases = Array.isArray(casesRaw) ? casesRaw : casesRaw.cases
const capturedAt = Array.isArray(casesRaw) ? null : casesRaw.capturedAt
if (capturedAt == null) throw new Error('production snapshot carries no capturedAt; cutoff alignment cannot be stated')

const documentsFile = JSON.parse(readFileSync(documentsPath, 'utf8')) as {
  capturedAt: number; documentsTable: string
  crossDomainMoves: Array<{ caseId: string; domain: string; evidence: string; movedAt: number | null }>
  caseDocumentLinks: Record<string, string[]>; documents: ProductionDocumentRow[]
}
if (documentsFile.documentsTable !== 'PRESENT') throw new Error(`cos_documents ${documentsFile.documentsTable}`)

const sidecarFile = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { attachments: Array<Record<string, unknown>> }
const sidecar: SidecarAttachment[] = sidecarFile.attachments.map(a => ({
  sourceAccountId: String(a.sourceAccountId), messageId: String(a.messageId),
  filename: String(a.filename), mimeType: a.mimeType == null ? null : String(a.mimeType),
  sizeBytes: Number(a.sizeBytes), sha256: String(a.sha256),
  blobPath: join(sidecarRoot, String(a.blobPath)),
}))

// Case timestamps for cutoff alignment, read-only from the live DB.
const liveRo = new Database(liveDbPath, { readonly: true, fileMustExist: true })
liveRo.pragma('query_only = ON')
const SAFETY_TABLES = ['personal_cases', 'zst_cases', 'email_processing', 'zst_email_processing',
  'personal_case_events', 'zst_case_events', 'outbound_ledger', 'zst_outbound_ledger',
  'cos_documents', 'cos_case_documents', 'zst_invoices', 'zst_contracts']
function safetyCounts(): Record<string, number | string> {
  const o: Record<string, number | string> = {}
  for (const t of SAFETY_TABLES) {
    const exists = liveRo.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    o[t] = exists ? Number((liveRo.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n) : 'TABLE_ABSENT'
  }
  const tp = liveRo.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cos_triage_provenance'").get()
  o.cos_triage_provenance = tp ? Number((liveRo.prepare(`SELECT COUNT(*) n FROM cos_triage_provenance`).get() as { n: number }).n) : 'TABLE_ABSENT'
  return o
}
const caseTimestamps: Record<string, { createdAt?: number | null; updatedAt?: number | null }> = {}
for (const table of ['personal_cases', 'zst_cases']) {
  for (const r of liveRo.prepare(`SELECT case_id, created_at, updated_at FROM ${table}`).all() as Array<Record<string, unknown>>) {
    caseTimestamps[String(r.case_id)] = {
      createdAt: r.created_at == null ? null : Number(r.created_at),
      updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    }
  }
}
const safetyBefore = safetyCounts()

async function oneRun(tag: string) {
  const root = join(shadowRoot, tag)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initCosSchema(db)
  const source = runHistoricalSourceReplay({
    corpus, productionCases, productionSnapshotCapturedAt: capturedAt!, caseTimestamps,
    crossDomainMoves: (documentsFile.crossDomainMoves ?? []).map(m => ({ caseId: m.caseId, evidence: m.evidence })),
  })
  const thread = await runThreadDocumentParity(
    db, { corpus, productionDocuments: documentsFile.documents, productionCaseDocumentLinks: documentsFile.caseDocumentLinks, crossDomainMovedCases: movedCases }, root, NOW)
  const attachment = runGmailAttachmentParity(
    db, { productionDocuments: documentsFile.documents, sidecar, corpusAnchorEnd: corpus.anchorEnd,
          productionCaseDocumentLinks: documentsFile.caseDocumentLinks, crossDomainMovedCases: movedCases }, root, NOW)
  const docReadiness = evaluateDocumentReadiness({ thread, attachment })
  db.close()
  return { source, thread, attachment, docReadiness }
}

const movedCases: Record<string, string> = {}
for (const m of documentsFile.crossDomainMoves ?? []) movedCases[m.caseId] = m.evidence

const runA = await oneRun('runA')
const runB = await oneRun('runB')
const safetyAfter = safetyCounts()
liveRo.close()

const determinism = {
  corpusManifestHashEqual: runA.source.corpusManifestHash === runB.source.corpusManifestHash,
  sourceRecordDigestEqual: runA.source.sourceRecordDigest === runB.source.sourceRecordDigest,
  corpusManifestHash: runA.source.corpusManifestHash,
  sourceRecordDigest: runA.source.sourceRecordDigest,
  threadRowVerdictsEqual: JSON.stringify(runA.thread.rows.map(r => [r.productionDocumentId, r.verdict]))
    === JSON.stringify(runB.thread.rows.map(r => [r.productionDocumentId, r.verdict])),
  attachmentRowVerdictsEqual: JSON.stringify(runA.attachment.rows.map(r => [r.productionDocumentId, r.verdict]))
    === JSON.stringify(runB.attachment.rows.map(r => [r.productionDocumentId, r.verdict])),
}
const safetyUnchanged = JSON.stringify(safetyBefore) === JSON.stringify(safetyAfter)

const historicalSourceReplayStatus =
  runA.source.outcome === 'PASS'
  && runA.source.unknown === 0
  && runA.source.inputMessages === 2870
  && runA.source.threadCount === 2280
  && determinism.corpusManifestHashEqual
  && determinism.sourceRecordDigestEqual
    ? 'PASS' : 'FAIL'

const report = {
  mode: 'READ_ONLY_SHADOW_DOUBLE_RUN',
  cutoff: {
    corpusAnchorStart: runA.source.anchorStart,
    corpusAnchorEnd: runA.source.anchorEnd,
    productionSnapshotCapturedAt: capturedAt,
    documentsSnapshotCapturedAt: documentsFile.capturedAt,
  },
  historicalSourceReplayStatus,
  sourceReplay: {
    inputMessages: runA.source.inputMessages,
    threadCount: runA.source.threadCount,
    unknown: runA.source.unknown,
    domainComparisons: runA.source.domainComparisons,
    threadsWithoutProductionCase: runA.source.threadsWithoutProductionCase,
    notReplayableFields: runA.source.notReplayableFields,
    findings: runA.source.findings,
  },
  documents: {
    ...runA.docReadiness,
    threadSummary: runA.thread.summary,
    attachmentSummary: runA.attachment.summary,
    threadMismatches: runA.thread.rows.filter(r => r.verdict === 'MISMATCH'),
    attachmentMismatches: runA.attachment.rows.filter(r => r.verdict === 'MISMATCH'),
    unknownRows: [...runA.thread.rows, ...runA.attachment.rows].filter(r => r.verdict === 'UNKNOWN'),
  },
  determinism,
  safety: { unchanged: safetyUnchanged, before: safetyBefore, after: safetyAfter },
}
writeFileSync(out, JSON.stringify({ ...report, threadRows: runA.thread.rows, attachmentRows: runA.attachment.rows }, null, 1) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify(report, null, 1) + '\n')
