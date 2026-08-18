// Stage 2H — CONDITIONAL extractor parity (Istvan, 2026-08-18).
//
// What this measures: given the production caseType as an EXTERNAL INPUT
// (PRODUCTION_AUTHORITY_OVERLAY), does the real production extractor, fed the
// real production input message at FULL_BODY, produce the structured rows
// production holds?
//
// What this does NOT measure, ever: whether the classification was right. The
// type was borrowed, so `classificationProof` is a literal false on every row.
//
// Everything below runs the production modules themselves — the schema
// initializer, the scope gate, the extractor route, and the two extractors. A
// reimplementation would be a second answer, and the report would be measuring
// the second answer rather than the shipped one. The only thing this file owns
// is the comparison.

import type Database from 'better-sqlite3'
import { initCosSchema } from '../schema.js'
import { classifyScope } from '../scope-gate.js'
import { routeZstExtractor } from '../zst-intake.js'
import { ingestZstInvoiceEmail, SNIPPET_EXTRACTION_NOTE } from '../zst-invoice-extract.js'
import { ingestZstContractEmail } from '../zst-contract-extract.js'
import type {
  ExtractorParityReport, ExtractorParityRow, ExtractorParityVerdict, FieldParity, FieldParityVerdict,
  ProductionAuthorityOverlay, ProductionCaseSnapshot, ReplayMessage,
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

export interface ConditionalExtractorParityInput {
  overlays: readonly ProductionAuthorityOverlay[]
  /** the immutable corpus messages for the target threads */
  messages: readonly ReplayMessage[]
  /** production cases, read for `sourceReference`: the exact input message */
  productionCases: readonly ProductionCaseSnapshot[]
  productionInvoices: readonly ProductionInvoiceRow[]
  productionContracts: readonly ProductionContractRow[]
}

const NOT_PERSISTED = 'PRODUCTION_NOT_PERSISTED' as const

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

/** Run the production extractors on a shadow SQLite for every overlaid thread,
 *  and compare the structured result field by field against production.
 *
 *  `shadowDb` MUST be a shadow handle. This function calls `initCosSchema` on it
 *  and writes extractor rows into it. It never opens, reads or writes the live
 *  store, and it creates no case: the extractors are called with production's
 *  own caseId exactly as production calls them. */
export function runConditionalExtractorParity(
  shadowDb: Database.Database,
  input: ConditionalExtractorParityInput,
  now: number,
): ExtractorParityReport {
  // The real production schema initializer, on the shadow database only. This is
  // the whole point of the fix: the shadow used to hold four private tables and
  // therefore had no row an invoice or a contract could differ in, so the
  // comparison reported agreement out of its own silence.
  initCosSchema(shadowDb)

  // The shadow deliberately holds no zst_cases rows — creating one would need a
  // triage verdict, which is exactly the NOT_REPLAYABLE thing. zst_invoices.case_id
  // references zst_cases (and better-sqlite3 enforces foreign keys by default), so
  // the referent is missing by design.
  //
  // The choice here is between changing the CALL and changing the DATABASE. Passing
  // a null caseId would make the extractor input differ from production's, and an
  // input difference is precisely what this surface must not introduce. So the call
  // stays byte-identical to production's and the shadow drops FK enforcement for the
  // duration — the referent is absent, not the argument.
  const priorFk = Number(shadowDb.pragma('foreign_keys', { simple: true })) === 1
  shadowDb.pragma('foreign_keys = OFF')
  if (Number(shadowDb.pragma('foreign_keys', { simple: true })) === 1) {
    throw new Error(
      'SEAM_BLOCKED: foreign_keys could not be turned off for this shadow handle (a pragma inside an open '
      + 'transaction is a silent no-op). The extractor insert would fail on the missing case_id referent and '
      + 'the failure would be misread as an extraction difference.')
  }
  try {
    return parityRuns()
  } finally {
    if (priorFk) shadowDb.pragma('foreign_keys = ON')
  }

  function parityRuns(): ExtractorParityReport {

  const messagesById = new Map<string, ReplayMessage>()
  for (const m of input.messages) messagesById.set(m.messageId, m)
  const caseById = new Map<string, ProductionCaseSnapshot>()
  for (const c of input.productionCases) caseById.set(c.caseId, c)
  const invoiceByCase = new Map<string, ProductionInvoiceRow>()
  for (const i of input.productionInvoices) if (i.caseId) invoiceByCase.set(i.caseId, i)
  const contractByCase = new Map<string, ProductionContractRow>()
  for (const c of input.productionContracts) if (c.caseId) contractByCase.set(c.caseId, c)

  const rows: ExtractorParityRow[] = []

  for (const overlay of input.overlays) {
    const reasons: string[] = []
    const base = {
      threadId: overlay.threadId,
      productionCaseId: overlay.productionCaseId,
      caseType: overlay.caseType,
      authority: 'CONDITIONAL_ON_PRODUCTION_TYPE' as const,
      classificationProof: false as const,
    }

    const route = routeZstExtractor(overlay.caseType)
    if (!route) {
      rows.push({
        ...base, route: null, sourceMessageId: null, extractionSource: null,
        replayExtractionStatus: 'NOT_ATTEMPTED', replayConfidence: null, replayExtractedFields: [],
        comparisons: [], verdict: 'NOT_ROUTED',
        reasons: [`the production gate (routeZstExtractor) routes '${overlay.caseType}' to no extractor`],
      })
      continue
    }

    const prodCase = caseById.get(overlay.productionCaseId)
    const sourceMessageId = prodCase?.sourceReference ?? null
    const msg = sourceMessageId ? messagesById.get(sourceMessageId) ?? null : null
    if (!msg) {
      rows.push({
        ...base, route, sourceMessageId, extractionSource: null,
        replayExtractionStatus: 'NOT_ATTEMPTED', replayConfidence: null, replayExtractedFields: [],
        comparisons: [], verdict: 'RETRIAGE_INPUT_NOT_EQUIVALENT',
        reasons: [sourceMessageId
          ? `production input message ${sourceMessageId} is not in the corpus; the replay would extract from a different mail`
          : `production case ${overlay.productionCaseId} has no source_reference; the exact production input is unknown`],
      })
      continue
    }

    // The production gate, run rather than assumed.
    const scope = classifyScope({
      text: `${msg.subject}\n${msg.bodyText}`, accountId: msg.sourceAccountId, corporateAccounts: ['zst'],
    })
    if (scope.target !== 'zst') {
      rows.push({
        ...base, route, sourceMessageId, extractionSource: null,
        replayExtractionStatus: 'NOT_ATTEMPTED', replayConfidence: null, replayExtractedFields: [],
        comparisons: [], verdict: 'SEAM_BLOCKED',
        reasons: [`the production scope gate resolves this message to '${scope.target ?? 'SECURITY_BLOCKED'}', not zst; `
          + 'the ZST extractors are not the production path for it'],
      })
      continue
    }
    if (scope.needsReview) reasons.push('the production scope gate flagged this message for review')

    const src = {
      caseId: overlay.productionCaseId,
      from: msg.from ?? '',
      subject: msg.subject,
      body: msg.bodyText,
      extractionSource: 'FULL_BODY' as const,
    }

    let replayConfidence: string | null = null
    let replayExtractedFields: string[] = []
    let replayExtractionStatus: ExtractorParityRow['replayExtractionStatus'] = 'NOT_ATTEMPTED'
    let comparisons: FieldParity[] = []
    let verdict: ExtractorParityVerdict = 'PASS'

    try {
      if (route === 'INVOICE') {
        const prod = invoiceByCase.get(overlay.productionCaseId) ?? null
        if (prod?.notes?.includes(SNIPPET_EXTRACTION_NOTE)) {
          // Production extracted from a 300-character snippet. A FULL_BODY replay
          // is a different input, and every field it finds past character 300 is
          // a difference in the INPUT, not in the extractor.
          rows.push({
            ...base, route, sourceMessageId, extractionSource: null,
            replayExtractionStatus: 'NOT_ATTEMPTED', replayConfidence: null, replayExtractedFields: [],
            comparisons: [], verdict: 'RETRIAGE_INPUT_NOT_EQUIVALENT',
            reasons: [...reasons, `production stored ${SNIPPET_EXTRACTION_NOTE}: it extracted from the snippet, `
              + 'so a FULL_BODY replay is not the same input and its differences are not extractor differences'],
          })
          continue
        }
        const out = ingestZstInvoiceEmail(shadowDb, src, now)
        if (!out) {
          replayExtractionStatus = 'NOT_AN_INVOICE_OR_CONTRACT'
        } else {
          replayExtractionStatus = 'EXTRACTED'
          replayConfidence = out.confidence
          replayExtractedFields = out.extracted
          const r = shadowDb.prepare(
            `SELECT invoice_number, supplier_id, gross_amount, currency, issue_date, due_date, notes
               FROM zst_invoices WHERE invoice_id = ?`
          ).get(out.invoiceId) as Record<string, unknown> | undefined
          comparisons = [
            cmp('invoiceNumber', prod?.invoiceNumber ?? null, r?.invoice_number ?? null),
            cmp('supplierId', prod?.supplierId ?? null, r?.supplier_id ?? null),
            cmp('grossAmount', prod?.grossAmount ?? null, r?.gross_amount ?? null),
            cmp('currency', prod?.currency ?? null, r?.currency ?? null),
            cmp('issueDate', prod?.issueDate ?? null, r?.issue_date ?? null),
            cmp('dueDate', prod?.dueDate ?? null, r?.due_date ?? null),
            // Confidence and the extracted-field list are the extractor's own
            // evidence about its read. Production keeps neither, so they are
            // reported, never scored.
            notPersisted('extractionConfidence', out.confidence),
            notPersisted('extractedFields', out.extracted),
          ]
        }
        if (!prod && replayExtractionStatus === 'EXTRACTED') {
          reasons.push('production holds no zst_invoices row for this case, so every extracted field is PRODUCTION_ABSENT')
        }
      } else {
        const prod = contractByCase.get(overlay.productionCaseId) ?? null
        const out = ingestZstContractEmail(shadowDb, src, now)
        if (!out) {
          replayExtractionStatus = 'NOT_AN_INVOICE_OR_CONTRACT'
        } else {
          replayExtractionStatus = 'EXTRACTED'
          replayConfidence = out.confidence
          replayExtractedFields = out.extracted
          const r = shadowDb.prepare(
            `SELECT title, contract_type, counterparty_id, effective_date, expiry_date, renewal_type,
                    notice_period_days, termination_deadline, financial_commitment, currency
               FROM zst_contracts WHERE contract_id = ?`
          ).get(out.contractId) as Record<string, unknown> | undefined
          comparisons = [
            cmp('title', prod?.title ?? null, r?.title ?? null),
            cmp('contractType', prod?.contractType ?? null, r?.contract_type ?? null),
            cmp('counterpartyId', prod?.counterpartyId ?? null, r?.counterparty_id ?? null),
            cmp('effectiveDate', prod?.effectiveDate ?? null, r?.effective_date ?? null),
            cmp('expiryDate', prod?.expiryDate ?? null, r?.expiry_date ?? null),
            cmp('renewalType', prod?.renewalType ?? null, r?.renewal_type ?? null),
            cmp('noticePeriodDays', prod?.noticePeriodDays ?? null, r?.notice_period_days ?? null),
            cmp('terminationDeadline', prod?.terminationDeadline ?? null, r?.termination_deadline ?? null),
            cmp('financialCommitment', prod?.financialCommitment ?? null, r?.financial_commitment ?? null),
            cmp('currency', prod?.currency ?? null, r?.currency ?? null),
            notPersisted('extractionConfidence', out.confidence),
            notPersisted('extractedFields', out.extracted),
          ]
        }
        // zst_contracts has no notes column, so production keeps no record of
        // whether IT read a snippet or a full body. Stated, not assumed away.
        reasons.push('contract input equivalence cannot be confirmed from the store: zst_contracts persists no extraction-source marker')
        if (!prod && replayExtractionStatus === 'EXTRACTED') {
          reasons.push('production holds no zst_contracts row for this case, so every extracted field is PRODUCTION_ABSENT')
        }
      }
    } catch (err) {
      replayExtractionStatus = 'THREW'
      reasons.push(`the production extractor threw: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (replayExtractionStatus === 'THREW') verdict = 'MISMATCH'
    else if (replayExtractionStatus === 'NOT_AN_INVOICE_OR_CONTRACT') {
      // Production routed this type to the extractor and holds a row; the replay
      // read the same mail and did not recognise it. That is a difference.
      const prodHasRow = route === 'INVOICE'
        ? invoiceByCase.has(overlay.productionCaseId)
        : contractByCase.has(overlay.productionCaseId)
      verdict = prodHasRow ? 'MISMATCH' : 'PASS'
      reasons.push(prodHasRow
        ? 'the production extractor returned nothing for a mail production holds an extracted row for'
        : 'neither side extracted a row from this mail')
    } else if (comparisons.some(c => DIFFERING.has(c.verdict))) verdict = 'MISMATCH'

    rows.push({
      ...base, route, sourceMessageId, extractionSource: 'FULL_BODY',
      replayExtractionStatus, replayConfidence, replayExtractedFields, comparisons, verdict, reasons,
    })
  }

  const fields = rows.flatMap(r => r.comparisons)
  return {
    generatedAt: now,
    authority: 'CONDITIONAL_ON_PRODUCTION_TYPE',
    classificationProof: false,
    rows,
    summary: {
      targets: rows.length,
      pass: rows.filter(r => r.verdict === 'PASS').length,
      mismatch: rows.filter(r => r.verdict === 'MISMATCH').length,
      inputNotEquivalent: rows.filter(r => r.verdict === 'RETRIAGE_INPUT_NOT_EQUIVALENT').length,
      notRouted: rows.filter(r => r.verdict === 'NOT_ROUTED').length,
      seamBlocked: rows.filter(r => r.verdict === 'SEAM_BLOCKED').length,
      fieldsCompared: fields.filter(f => f.verdict === 'PASS' || DIFFERING.has(f.verdict)).length,
      fieldsMatched: fields.filter(f => f.verdict === 'PASS').length,
      fieldsMismatched: fields.filter(f => DIFFERING.has(f.verdict)).length,
      fieldsNotPersistedByProduction: fields.filter(f => f.verdict === NOT_PERSISTED).length,
    },
  }
  }
}

/** Build the overlays for the threads a production case actually claims, limited
 *  to the corpus. Derived at runtime from the snapshot — never from parsing an
 *  identifier: `zst-zst-<messageId>` looks like it carries the input message, and
 *  reading it that way would silently produce a wrong input the day the id shape
 *  changes. */
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
