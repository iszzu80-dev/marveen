#!/usr/bin/env npx tsx
// Stage 2H — conditional extractor parity runner (Istvan GO, 2026-08-18).
//
// READ-ONLY with respect to production: it reads JSON snapshots only. Both runs
// happen in pristine in-memory shadow databases. No production write path is
// imported, no Gmail writer, no case creation, no correction, no canary.
//
// The input basis is EVIDENCE, supplied here from the 2026-08-18 provenance
// audit, not inferred by the comparison. Only the threads whose production input
// is reproducible per thread enter the denominator.

import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  runConditionalExtractorParity, buildProductionAuthorityOverlays,
  type ProductionInvoiceRow, type ProductionContractRow, type HistoricalInput,
} from '../src/cos/replay/extractor-parity.js'
import { evaluateReplayReadiness } from '../src/cos/replay/reconcile.js'
import type { CorrectionManifest, InputBasis, ProductionCaseSnapshot } from '../src/cos/replay/types.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function required(name: string): string {
  const v = arg(name); if (!v) throw new Error(`missing required ${name}`); return resolve(v)
}

const productionCasesPath = required('--production-cases')
const financePath = required('--finance')
const historicalInputPath = required('--historical-input')
const corpusPath = required('--corpus')
const out = required('--out')

const productionCases = JSON.parse(readFileSync(productionCasesPath, 'utf8')) as ProductionCaseSnapshot[]
const finance = JSON.parse(readFileSync(financePath, 'utf8')) as {
  invoicesTable: string; contractsTable: string
  invoices: ProductionInvoiceRow[]; contracts: ProductionContractRow[]
}
const rawInput = JSON.parse(readFileSync(historicalInputPath, 'utf8')) as Record<string, Record<string, unknown>>
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { messages: Array<{ threadId: string }> }

if (finance.invoicesTable !== 'PRESENT' || finance.contractsTable !== 'PRESENT') {
  throw new Error(`production finance tables not both PRESENT: ${finance.invoicesTable}/${finance.contractsTable}`)
}

const historicalInputByMessage: Record<string, HistoricalInput> = {}
for (const [messageId, v] of Object.entries(rawInput)) {
  if (v.fetch !== 'OK') continue
  historicalInputByMessage[messageId] = {
    subject: String(v.subject ?? ''), from: String(v.from ?? ''), snippet: String(v.snippet ?? ''),
  }
}

const corpusThreadIds = new Set(corpus.messages.map(m => m.threadId))
const overlays = buildProductionAuthorityOverlays(productionCases, corpusThreadIds)

// The 2026-08-18 provenance audit: the 2026-08-09 batches reached the extractor
// WITH real From/Subject (proven by the exact reproduction of
// zst-ctr-8fa1cad34e7a), the 2026-08-07 batch did not (proven by the exact
// reproduction of zst-inv-be5be69f55e9 and zst-ctr-676a89754d19 only under a
// headerless input). Batch-1 threads are therefore not reproducible per thread.
const EQUIVALENT_CASES = new Set([
  'zst-zst-19fe22a42031867a',
  'zst-zst-19fe2dc16448b92a',
  'zst-zst-19fe8546ea244250',
])
const inputBasisByCase: Record<string, InputBasis> = {}
for (const o of overlays) {
  inputBasisByCase[o.productionCaseId] = EQUIVALENT_CASES.has(o.productionCaseId)
    ? 'HISTORICAL_PROVIDER_SNIPPET_WITH_HEADERS'
    : 'HISTORICAL_INPUT_NOT_EQUIVALENT'
}

const parityInput = {
  overlays, productionCases,
  productionInvoices: finance.invoices, productionContracts: finance.contracts,
  inputBasisByCase, historicalInputByMessage,
}

// Two pristine shadow databases, same immutable input, same production snapshot.
const dbA = new Database(':memory:')
const runA = runConditionalExtractorParity(dbA, parityInput, 1_787_000_000)
dbA.close()
const dbB = new Database(':memory:')
const runB = runConditionalExtractorParity(dbB, parityInput, 1_787_000_001)
dbB.close()

const perThreadEqual = runA.rows.length === runB.rows.length && runA.rows.every((a, i) => {
  const b = runB.rows[i]
  return a.productionCaseId === b.productionCaseId && a.verdict === b.verdict
    && a.replayResult === b.replayResult && a.expectedHistorical === b.expectedHistorical
    && a.inputDigest === b.inputDigest && a.replayFingerprint === b.replayFingerprint
    && JSON.stringify(a.comparisons) === JSON.stringify(b.comparisons)
})

// The historical source-replay surface is not re-run here; an empty manifest
// would fake a pass, so the readiness call is fed the manifest the caller
// supplies or, absent one, a manifest-shaped placeholder that cannot pass.
const emptyManifest: CorrectionManifest = {
  generatedAt: 0, replayRunId: 'not-run', autoApplyAllowed: false, findings: [],
  summary: { total: 0, p0: 0, p1: 1, p2: 0, p3: 0, unclassified: 0 },
  coverage: {
    eligible: 0, compared: 0, matched: 0, mismatched: 0, conditional: 0,
    conditionalMismatched: 0, notReplayable: 0, conditionalNotAttempted: 0, unknown: 0,
  },
}
const readiness = evaluateReplayReadiness({
  manifest: emptyManifest,
  extractorParity: runA,
  doubleRun: { digestA: runA.parityDigest, digestB: runB.parityDigest },
  expectedDenominator: { eligible: 3, inputNotEquivalent: 12 },
  documentParity: null,
})

const report = {
  generatedAtNote: 'timestamps deliberately fixed; the parity digest carries none',
  mode: 'READ_ONLY_SHADOW_DOUBLE_RUN',
  targets: overlays.length,
  determinism: {
    perThreadResultKindEqual: perThreadEqual,
    digestA: runA.parityDigest,
    digestB: runB.parityDigest,
    digestsEqual: runA.parityDigest === runB.parityDigest,
  },
  summary: runA.summary,
  conditionalExtractorParityStatus: readiness.conditionalExtractorParityStatus,
  readinessReasons: readiness.reasons,
  rows: runA.rows,
}
writeFileSync(out, JSON.stringify(report, null, 1) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({
  targets: report.targets,
  eligible: runA.summary.eligible, compared: runA.summary.compared,
  pass: runA.summary.pass, mismatch: runA.summary.mismatch,
  productionHasNoRow: runA.summary.productionHasNoRow,
  inputNotEquivalent: runA.summary.inputNotEquivalent,
  notRouted: runA.summary.notRouted, seamBlocked: runA.summary.seamBlocked,
  unknown: runA.summary.unknown,
  determinism: report.determinism,
  conditionalExtractorParityStatus: report.conditionalExtractorParityStatus,
  readinessReasons: readiness.reasons,
  out,
}, null, 1) + '\n')
