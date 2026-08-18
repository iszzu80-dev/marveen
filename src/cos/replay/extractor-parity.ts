// Stage 2H — CONDITIONAL extractor parity (Istvan, 2026-08-18).
//
// What this measures: given the production caseType as an EXTERNAL INPUT
// (PRODUCTION_AUTHORITY_OVERLAY), does the real production extractor, fed the
// input production actually received, reproduce the structured state production
// holds?
//
// What this does NOT measure, ever: whether the classification was right. The
// type was borrowed, so `classificationProof` is a literal false on every row.
//
// The input basis is the whole argument. The 2026-08-18 provenance audit measured
// that production extracted from the ~200-character provider snippet in all 15
// cases, and that the 2026-08-07 batch reached the extractor with no From and no
// Subject at all. So:
//   - a FULL_BODY replay has ZERO historical targets. It is a current-extractor
//     evaluation, never historical parity;
//   - only threads whose production input is reproducible per thread may enter
//     the denominator, and that judgement is EVIDENCE supplied by the caller,
//     not something this module infers.
//
// Everything below runs the production modules themselves — the schema
// initializer, the scope gate, the extractor route, and the two extractors. The
// only thing this file owns is the comparison.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { initCosSchema } from '../schema.js'
import { classifyScope } from '../scope-gate.js'
import { routeZstExtractor } from '../zst-intake.js'
import { ingestZstInvoiceEmail, SNIPPET_EXTRACTION_NOTE } from '../zst-invoice-extract.js'
import { ingestZstContractEmail } from '../zst-contract-extract.js'
import { normaliseSourceReference } from './source-reference.js'
import type {
  ExtractionOutcome, ExtractorParityReport, ExtractorParityRow, ExtractorParityVerdict,
  FieldParity, FieldParityVerdict, InputBasis, ProductionAuthorityOverlay, ProductionCaseSnapshot,
} from './types.js'

/** The production `zst_invoices` row, as exported read-only from the live store. */
export interface ProductionInvoiceRow {
  caseId: string | null
  invoiceNumber: string | null
  supplierId: string | null
  grossAmount: number | null
  currency: string | null
  issueDate: string | null
  dueDate: string | null
  /** carries SNIPPET_EXTRACTION_NOTE when production extracted from a snippet */
  notes: string | null
}

/** The production `zst_contracts` row, as exported read-only from the live store. */
export interface ProductionContractRow {
  caseId: string | null
  title: string | null
  contractType: string | null
  counterpartyId: string | null
  effectiveDate: string | null
  expiryDate: string | null
  renewalType: string | null
  noticePeriodDays: number | null
  terminationDeadline: string | null
  financialCommitment: number | null
  currency: string | null
}

/** The exact input production is known to have received for one message. */
export interface HistoricalInput {
  subject: string
  from: string
  /** the provider snippet: what production passed as the extractor body */
  snippet: string
}

export interface ConditionalExtractorParityInput {
  overlays: readonly ProductionAuthorityOverlay[]
  productionCases: readonly ProductionCaseSnapshot[]
  productionInvoices: readonly ProductionInvoiceRow[]
  productionContracts: readonly ProductionContractRow[]
  /** keyed by production caseId. A target with no entry is refused, never
   *  defaulted to eligible: an undeclared basis is an unknown one. */
  inputBasisByCase: Readonly<Record<string, InputBasis>>
  /** keyed by messageId (the production `source_reference`) */
  historicalInputByMessage: Readonly<Record<string, HistoricalInput>>
}

const NOT_PERSISTED = 'PRODUCTION_NOT_PERSISTED' as const
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function cmp(field: string, productionValue: unknown, replayValue: unknown): FieldParity {
  const p = productionValue ?? null
  const r = replayValue ?? null
  let verdict: FieldParityVerdict
  if (p === null && r === null) verdict = 'BOTH_ABSENT'
  else if (p === null) verdict = 'PRODUCTION_ABSENT'
  else if (r === null) verdict = 'REPLAY_ABSENT'
  else verdict = JSON.stringify(p) === JSON.stringify(r) ? 'PASS' : 'MISMATCH'
  return { field, productionValue: p, replayValue: r, verdict }
}
function notPersisted(field: string, replayValue: unknown): FieldParity {
  return { field, productionValue: NOT_PERSISTED, replayValue: replayValue ?? null, verdict: NOT_PERSISTED }
}
const DIFFERING: ReadonlySet<FieldParityVerdict> = new Set(['MISMATCH', 'PRODUCTION_ABSENT', 'REPLAY_ABSENT'])

/** Deterministic projection of a run. Deliberately excludes every timestamp and
 *  every free-text reason: two runs on the same immutable input must hash the
 *  same, and a digest that moved because a clock moved proves nothing. */
export function parityDigestOf(rows: readonly ExtractorParityRow[]): string {
  const projection = rows
    .map(r => ({
      threadId: r.threadId, productionCaseId: r.productionCaseId, caseType: r.caseType,
      route: r.route, sourceMessageId: r.sourceMessageId, inputBasis: r.inputBasis,
      inputDigest: r.inputDigest, extractorAttempted: r.extractorAttempted,
      expectedHistorical: r.expectedHistorical, replayResult: r.replayResult,
      productionFingerprint: r.productionFingerprint, replayFingerprint: r.replayFingerprint,
      replayConfidence: r.replayConfidence, replayExtractedFields: [...r.replayExtractedFields].sort(),
      comparisons: r.comparisons.map(c => [c.field, c.verdict, JSON.stringify(c.productionValue ?? null), JSON.stringify(c.replayValue ?? null)]),
      verdict: r.verdict,
    }))
    .sort((a, b) => a.productionCaseId.localeCompare(b.productionCaseId))
  return sha(JSON.stringify(projection))
}

interface RunOptions {
  /** CURRENT_FULL_BODY diagnostics: bodies keyed by messageId. When present the
   *  run is a current-extractor evaluation and every row is stamped as such. */
  currentFullBodyByMessage?: Readonly<Record<string, string>>
}

export function runConditionalExtractorParity(
  shadowDb: Database.Database,
  input: ConditionalExtractorParityInput,
  now: number,
  options: RunOptions = {},
): ExtractorParityReport {
  // The real production schema initializer, on the shadow database only.
  initCosSchema(shadowDb)

  // The shadow deliberately holds no zst_cases rows, and zst_invoices.case_id
  // references them. The call stays byte-identical to production's; the shadow
  // drops FK enforcement instead, so the referent is absent, not the argument.
  const priorFk = Number(shadowDb.pragma('foreign_keys', { simple: true })) === 1
  shadowDb.pragma('foreign_keys = OFF')
  if (Number(shadowDb.pragma('foreign_keys', { simple: true })) === 1) {
    throw new Error(
      'SEAM_BLOCKED: foreign_keys could not be turned off for this shadow handle (a pragma inside an open '
      + 'transaction is a silent no-op).')
  }
  try {
    return run()
  } finally {
    if (priorFk) shadowDb.pragma('foreign_keys = ON')
  }

  function run(): ExtractorParityReport {
    const currentOnly = options.currentFullBodyByMessage != null
    const caseById = new Map<string, ProductionCaseSnapshot>()
    for (const c of input.productionCases) caseById.set(c.caseId, c)
    const invoiceByCase = new Map<string, ProductionInvoiceRow>()
    for (const i of input.productionInvoices) if (i.caseId) invoiceByCase.set(i.caseId, i)
    const contractByCase = new Map<string, ProductionContractRow>()
    for (const c of input.productionContracts) if (c.caseId) contractByCase.set(c.caseId, c)

    const rows: ExtractorParityRow[] = []

    for (const overlay of input.overlays) {
      const reasons: string[] = []
      const declared = input.inputBasisByCase[overlay.productionCaseId]
      const basis: InputBasis = currentOnly ? 'CURRENT_FULL_BODY' : declared ?? 'HISTORICAL_INPUT_NOT_EQUIVALENT'
      if (!currentOnly && !declared) {
        reasons.push('no input basis was declared for this case; an undeclared basis is treated as not equivalent, '
          + 'never as eligible')
      }
      const route = routeZstExtractor(overlay.caseType)
      const prodCase = caseById.get(overlay.productionCaseId)
      const sourceMessageId = normaliseSourceReference(prodCase?.sourceReference)
      const prodInvoice = invoiceByCase.get(overlay.productionCaseId) ?? null
      const prodContract = contractByCase.get(overlay.productionCaseId) ?? null
      const productionHasRow = route === 'INVOICE' ? prodInvoice != null : prodContract != null
      // Production's own stored state is the expectation. It is read, not guessed.
      const expectedHistorical: ExtractionOutcome = productionHasRow ? 'STRUCTURED_ROW' : 'NO_EXTRACTION'
      const productionFingerprint = route === 'INVOICE'
        ? (prodInvoice ? invoiceFingerprint(prodInvoice) : null)
        : (prodContract ? contractFingerprint(prodContract) : null)

      const base = {
        threadId: overlay.threadId, productionCaseId: overlay.productionCaseId, caseType: overlay.caseType,
        route, sourceMessageId, inputBasis: basis,
        authority: 'CONDITIONAL_ON_PRODUCTION_TYPE' as const, classificationProof: false as const,
        expectedHistorical, productionFingerprint,
      }
      const excluded = (verdict: ExtractorParityVerdict, why: string): ExtractorParityRow => ({
        ...base, inputDigest: null, extractorAttempted: false, replayResult: null,
        replayFingerprint: null, replayConfidence: null, replayExtractedFields: [], comparisons: [],
        verdict, reasons: [...reasons, why],
      })

      if (!route) { rows.push(excluded('NOT_ROUTED', `the production gate routes '${overlay.caseType}' to no extractor`)); continue }
      if (basis === 'HISTORICAL_INPUT_NOT_EQUIVALENT') {
        rows.push(excluded('NOT_IN_DENOMINATOR',
          'the production input for this thread is not reproducible; it is excluded from the parity denominator '
          + 'rather than compared against a substitute')); continue
      }
      if (!sourceMessageId) {
        rows.push(excluded('RETRIAGE_INPUT_NOT_EQUIVALENT',
          `production case ${overlay.productionCaseId} names no single source message`)); continue
      }

      // Assemble the exact input.
      let subject: string, from: string, body: string
      if (currentOnly) {
        const hist = input.historicalInputByMessage[sourceMessageId]
        const full = options.currentFullBodyByMessage![sourceMessageId]
        if (!hist || full == null) { rows.push(excluded('RETRIAGE_INPUT_NOT_EQUIVALENT', 'no full body available for this message')); continue }
        subject = hist.subject; from = hist.from; body = full
      } else {
        const hist = input.historicalInputByMessage[sourceMessageId]
        if (!hist) { rows.push(excluded('RETRIAGE_INPUT_NOT_EQUIVALENT', `no historical input recorded for message ${sourceMessageId}`)); continue }
        subject = hist.subject; from = hist.from; body = hist.snippet
      }

      if (route === 'INVOICE' && prodInvoice?.notes?.includes(SNIPPET_EXTRACTION_NOTE) && currentOnly) {
        rows.push(excluded('RETRIAGE_INPUT_NOT_EQUIVALENT',
          `production stored ${SNIPPET_EXTRACTION_NOTE}: a full-body run is a different input`)); continue
      }

      // The production gate, run rather than assumed.
      const scope = classifyScope({ text: `${subject}\n${body}`, accountId: 'zst', corporateAccounts: ['zst'] })
      if (scope.target !== 'zst') {
        rows.push(excluded('SEAM_BLOCKED',
          `the production scope gate resolves this message to '${scope.target ?? 'SECURITY_BLOCKED'}', not zst`)); continue
      }
      if (scope.needsReview) reasons.push('the production scope gate flagged this message for review')

      const src = {
        caseId: overlay.productionCaseId, from, subject, body,
        extractionSource: (currentOnly ? 'FULL_BODY' : 'SNIPPET') as 'FULL_BODY' | 'SNIPPET',
      }
      const inputDigest = sha(JSON.stringify([src.caseId, src.from, src.subject, src.body, src.extractionSource]))

      let replayResult: ExtractionOutcome
      let replayFingerprint: string | null = null
      let replayConfidence: string | null = null
      let replayExtractedFields: string[] = []
      let comparisons: FieldParity[] = []

      try {
        if (route === 'INVOICE') {
          const out = ingestZstInvoiceEmail(shadowDb, src, now)
          if (!out) replayResult = 'NO_EXTRACTION'
          else {
            replayResult = 'STRUCTURED_ROW'
            replayConfidence = out.confidence; replayExtractedFields = out.extracted
            const r = shadowDb.prepare(
              `SELECT invoice_number, supplier_id, gross_amount, currency, issue_date, due_date, duplicate_hash
                 FROM zst_invoices WHERE invoice_id = ?`).get(out.invoiceId) as Record<string, unknown> | undefined
            replayFingerprint = r?.duplicate_hash == null ? null : String(r.duplicate_hash)
            comparisons = [
              cmp('invoiceNumber', prodInvoice?.invoiceNumber ?? null, r?.invoice_number ?? null),
              cmp('supplierId', prodInvoice?.supplierId ?? null, r?.supplier_id ?? null),
              cmp('grossAmount', prodInvoice?.grossAmount ?? null, r?.gross_amount ?? null),
              cmp('currency', prodInvoice?.currency ?? null, r?.currency ?? null),
              cmp('issueDate', prodInvoice?.issueDate ?? null, r?.issue_date ?? null),
              cmp('dueDate', prodInvoice?.dueDate ?? null, r?.due_date ?? null),
              notPersisted('extractionConfidence', out.confidence),
              notPersisted('extractedFields', out.extracted),
            ]
          }
        } else {
          const out = ingestZstContractEmail(shadowDb, src, now)
          if (!out) replayResult = 'NO_EXTRACTION'
          else {
            replayResult = 'STRUCTURED_ROW'
            replayConfidence = out.confidence; replayExtractedFields = out.extracted
            const r = shadowDb.prepare(
              `SELECT title, contract_type, counterparty_id, effective_date, expiry_date, renewal_type,
                      notice_period_days, termination_deadline, financial_commitment, currency
                 FROM zst_contracts WHERE contract_id = ?`).get(out.contractId) as Record<string, unknown> | undefined
            replayFingerprint = out.contractId
            comparisons = [
              cmp('title', prodContract?.title ?? null, r?.title ?? null),
              cmp('contractType', prodContract?.contractType ?? null, r?.contract_type ?? null),
              cmp('counterpartyId', prodContract?.counterpartyId ?? null, r?.counterparty_id ?? null),
              cmp('effectiveDate', prodContract?.effectiveDate ?? null, r?.effective_date ?? null),
              cmp('expiryDate', prodContract?.expiryDate ?? null, r?.expiry_date ?? null),
              cmp('renewalType', prodContract?.renewalType ?? null, r?.renewal_type ?? null),
              cmp('noticePeriodDays', prodContract?.noticePeriodDays ?? null, r?.notice_period_days ?? null),
              cmp('terminationDeadline', prodContract?.terminationDeadline ?? null, r?.termination_deadline ?? null),
              cmp('financialCommitment', prodContract?.financialCommitment ?? null, r?.financial_commitment ?? null),
              cmp('currency', prodContract?.currency ?? null, r?.currency ?? null),
              notPersisted('extractionConfidence', out.confidence),
              notPersisted('extractedFields', out.extracted),
            ]
          }
        }
      } catch (err) {
        rows.push({
          ...base, inputDigest, extractorAttempted: true, replayResult: null,
          replayFingerprint: null, replayConfidence: null, replayExtractedFields: [], comparisons: [],
          verdict: 'MISMATCH', reasons: [...reasons, `the production extractor threw: ${err instanceof Error ? err.message : String(err)}`],
        })
        continue
      }

      // A missing row passes ONLY as a demonstrated NO_EXTRACTION that matches
      // production's own outcome. "Neither side has a row" is not agreement
      // unless the replay actually ran and declined.
      let verdict: ExtractorParityVerdict
      if (replayResult !== expectedHistorical) {
        verdict = expectedHistorical === 'STRUCTURED_ROW' ? 'MISMATCH' : 'PRODUCTION_HAS_NO_ROW'
        reasons.push(expectedHistorical === 'STRUCTURED_ROW'
          ? 'production holds a structured row and the replay extracted none from the same input'
          : 'the replay extracted a row production holds none of')
      } else if (replayResult === 'NO_EXTRACTION') {
        verdict = 'PASS'
        reasons.push('the extractor ran on the historical input and declined it, matching production')
      } else if (comparisons.some(c => DIFFERING.has(c.verdict))) {
        verdict = 'MISMATCH'
      } else {
        verdict = 'PASS'
      }

      rows.push({
        ...base, inputDigest, extractorAttempted: true, replayResult,
        replayFingerprint, replayConfidence, replayExtractedFields, comparisons, verdict, reasons,
      })
    }

    const fields = rows.flatMap(r => r.comparisons)
    const eligible = rows.filter(r => r.inputBasis === 'HISTORICAL_PROVIDER_SNIPPET_WITH_HEADERS').length
    const compared = rows.filter(r => r.extractorAttempted && r.inputBasis !== 'HISTORICAL_INPUT_NOT_EQUIVALENT').length
    return {
      generatedAt: now,
      authority: 'CONDITIONAL_ON_PRODUCTION_TYPE',
      classificationProof: false,
      basis: currentOnly ? 'CURRENT_ONLY' : 'HISTORICAL',
      rows,
      parityDigest: parityDigestOf(rows),
      summary: {
        targets: rows.length,
        eligible,
        compared,
        pass: rows.filter(r => r.verdict === 'PASS').length,
        mismatch: rows.filter(r => r.verdict === 'MISMATCH').length,
        productionHasNoRow: rows.filter(r => r.verdict === 'PRODUCTION_HAS_NO_ROW').length,
        inputNotEquivalent: rows.filter(r => r.verdict === 'NOT_IN_DENOMINATOR' || r.verdict === 'RETRIAGE_INPUT_NOT_EQUIVALENT').length,
        notRouted: rows.filter(r => r.verdict === 'NOT_ROUTED').length,
        seamBlocked: rows.filter(r => r.verdict === 'SEAM_BLOCKED').length,
        unknown: rows.filter(r => r.extractorAttempted && r.replayResult == null).length,
        fieldsCompared: fields.filter(f => f.verdict === 'PASS' || DIFFERING.has(f.verdict)).length,
        fieldsMatched: fields.filter(f => f.verdict === 'PASS').length,
        fieldsMismatched: fields.filter(f => DIFFERING.has(f.verdict)).length,
        fieldsNotPersistedByProduction: fields.filter(f => f.verdict === NOT_PERSISTED).length,
      },
    }
  }
}

function invoiceFingerprint(i: ProductionInvoiceRow): string {
  return sha([i.supplierId ?? '', i.invoiceNumber ?? '', i.grossAmount ?? '', i.issueDate ?? ''].join('|')).slice(0, 32)
}
function contractFingerprint(c: ProductionContractRow): string {
  return 'zst-ctr-' + sha([c.counterpartyId ?? '', c.title ?? '', c.expiryDate ?? ''].join('|')).slice(0, 12)
}

/** Build the overlays for the threads a production case actually claims, limited
 *  to the corpus. Derived at runtime from the snapshot — never from parsing an
 *  identifier. */
export function buildProductionAuthorityOverlays(
  productionCases: readonly ProductionCaseSnapshot[],
  corpusThreadIds: ReadonlySet<string>,
): ProductionAuthorityOverlay[] {
  const overlays: ProductionAuthorityOverlay[] = []
  for (const c of productionCases) {
    if (!c.caseType) continue
    if (!routeZstExtractor(c.caseType)) continue
    for (const threadId of c.threadIds) {
      if (!corpusThreadIds.has(threadId)) continue
      overlays.push({ threadId, productionCaseId: c.caseId, caseType: c.caseType })
    }
  }
  return overlays
}

export { normaliseSourceReference }
