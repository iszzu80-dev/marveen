import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import {
  runShadowReplay, readReplayProjections, ensureShadowReplaySchema,
} from '../cos/replay/shadow-replay.js'
import {
  runConditionalExtractorParity, buildProductionAuthorityOverlays, normaliseSourceReference, parityDigestOf,
  type ProductionInvoiceRow, type ProductionContractRow, type ConditionalExtractorParityInput,
} from '../cos/replay/extractor-parity.js'
import { evaluateReplayReadiness, reconcileReplay, replayReadyForStability } from '../cos/replay/reconcile.js'
import { projectZstOperationalIntake } from '../cos/zst-operational-projector.js'
import { routeZstExtractor } from '../cos/zst-intake.js'
import type {
  CorrectionManifest, ExtractorParityReport, InputBasis, ProductionAuthorityOverlay, ProductionCaseSnapshot,
  ReplayCorpus, ReplayMessage,
} from '../cos/replay/types.js'

const DAY = 86400
const T = Math.floor(Date.UTC(2026, 7, 16) / 1000)

const msg = (over: Partial<ReplayMessage> & Pick<ReplayMessage, 'messageId' | 'threadId'>): ReplayMessage => ({
  sourceAccountId: 'zst', direction: 'INBOUND', occurredAt: T - DAY,
  subject: 'Targy', bodyText: 'Torzs', from: 'partner@example.com', ...over,
})

const corpusOf = (messages: ReplayMessage[]): ReplayCorpus => ({
  generatedAt: T, anchorStart: T - 60 * DAY, anchorEnd: T + DAY, messages,
})

// ── Point 1: the shadow owns no content->type classifier ───────────────────
// Each body below is one branch of the deleted `inferCaseType` regex. Putting
// any of them back makes the corresponding assertion go red, because a
// historical source replay must produce NO type at all.

const OLD_REGEX_BAIT: Array<[string, string]> = [
  ['invoice', 'Szamla erkezett, kerjuk fizet-ni a hatarido elott. invoice'],
  ['contract', 'A szerzodes felmondasi ideje 30 nap; uzletresz atruhazas. contract'],
  ['travel', 'Foglalas visszaigazolva, Hertz autober es repulo jegy. booking hotel'],
  ['home repair', 'A kert medence javit-asa garancia alatt, szerelo kiszall'],
  ['accounting', 'A konyvelo kerte az ado bevallast, NAV hatarido'],
]

describe('Stage 2H point 1 — the deleted inferCaseType stays deleted', () => {
  it.each(OLD_REGEX_BAIT)('a historical replay derives no type from %s content', (_label, bodyText) => {
    const db = new Database(':memory:')
    const r = runShadowReplay(db, corpusOf([msg({ messageId: 'm1', threadId: 't1', bodyText })]), 'run')
    const [p] = readReplayProjections(db, r.runId)
    expect(p.projectionAuthority).toBe('HISTORICAL_SOURCE_REPLAY')
    expect(p.caseType).toBeNull()
    expect(p.title).toBeNull()
    // Everything downstream of the type is absent too: a default status would be
    // a guess in a projection's clothes, and reconcile would compare it.
    expect([p.status, p.nextAction, p.nextActionOwner, p.waitingOn]).toEqual([null, null, null, null])
    expect([p.dueAt, p.followUpAt, p.nextWakeAt]).toEqual([null, null, null])
    // Source-derived identity survives — that is what a historical replay is for.
    expect(p.domain).toBe('zst')
    expect(p.sourceMessageIds).toEqual(['m1'])
    db.close()
  })

  it('an overlaid type wins over content that screams a different one', () => {
    const db = new Database(':memory:')
    const overlays: ProductionAuthorityOverlay[] = [
      { threadId: 't1', productionCaseId: 'zst-zst-m1', caseType: 'CONTRACT' },
    ]
    const bodyText = 'Szamla erkezett, invoice, fizetesi hatarido, brutto 15 484 Ft'
    const r = runShadowReplay(db, corpusOf([msg({ messageId: 'm1', threadId: 't1', bodyText })]), 'run', { overlays })
    const [p] = readReplayProjections(db, r.runId)
    expect(p.caseType).toBe('CONTRACT')
    expect(p.projectionAuthority).toBe('CONDITIONAL_ON_PRODUCTION_TYPE')
    expect(p.productionCaseId).toBe('zst-zst-m1')
    db.close()
  })

  it('the module source carries no type classifier and no case-type literal', () => {
    const src = readFileSync(new URL('../cos/replay/shadow-replay.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/function\s+inferCaseType/)
    for (const literal of ['INVOICE_INCOMING', 'INVOICE_OUTGOING', 'CONTRACT', 'LICENSE_SUBSCRIPTION',
      'HOME_REPAIR', 'TRAVEL', 'ACCOUNTING', 'ADMIN']) {
      expect(src, `case-type literal ${literal} is back in the replay module`).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
  })
})

// ── Point 2: the conditional fields come from the production module ────────

describe('Stage 2H point 2 — the overlay feeds the production projector', () => {
  it('reproduces projectZstOperationalIntake exactly, not a shadow copy', () => {
    const db = new Database(':memory:')
    const m = msg({
      messageId: 'm1', threadId: 't1', direction: 'SENT', subject: 'Szamla egyeztetes',
      bodyText: 'Kikuldve az elszamolas', to: ['konyvelo@example.com'], occurredAt: T - 2 * DAY,
    })
    const overlays: ProductionAuthorityOverlay[] = [
      { threadId: 't1', productionCaseId: 'zst-zst-m1', caseType: 'INVOICE_INCOMING' },
    ]
    const r = runShadowReplay(db, corpusOf([m]), 'run', { overlays })
    const [p] = readReplayProjections(db, r.runId)
    const expected = projectZstOperationalIntake({
      caseType: 'INVOICE_INCOMING', direction: 'OUTBOUND', subject: m.subject,
      body: `${m.subject}\n${m.bodyText}`, from: m.from ?? '', to: m.to?.[0], occurredAt: m.occurredAt,
    })
    expect(p.status).toBe(expected.status)
    expect(p.nextAction).toBe(expected.nextAction)
    expect(p.nextActionOwner).toBe(expected.nextActionOwner)
    expect(p.waitingOn).toBe(expected.waitingOn)
    expect(p.followUpAt).toBe(expected.followUpAt)
    // The title is the other half of the same triage verdict. No overlay lends it.
    expect(p.title).toBeNull()
    expect(r.conditionalCases).toBe(1)
    expect(r.historicalOnlyCases).toBe(0)
    db.close()
  })

  it('names the seam instead of copying it when the domain has no production projector', () => {
    const db = new Database(':memory:')
    const overlays: ProductionAuthorityOverlay[] = [
      { threadId: 't1', productionCaseId: 'case-private-m1', caseType: 'INVOICE_INCOMING' },
    ]
    const r = runShadowReplay(db, corpusOf([
      msg({ messageId: 'm1', threadId: 't1', sourceAccountId: 'private' }),
    ]), 'run', { overlays })
    expect(r.outcome).toBe('FAIL')
    expect(r.reasons.join(' ')).toMatch(/SEAM_BLOCKED/)
    expect(r.reasons.join(' ')).toMatch(/projectZstOperationalIntake/)
    expect(r.projectedCases).toBe(0)
    db.close()
  })

  it('refuses two production cases lending different types to one thread', () => {
    const db = new Database(':memory:')
    expect(() => runShadowReplay(db, corpusOf([msg({ messageId: 'm1', threadId: 't1' })]), 'run', {
      overlays: [
        { threadId: 't1', productionCaseId: 'zst-a', caseType: 'INVOICE_INCOMING' },
        { threadId: 't1', productionCaseId: 'zst-b', caseType: 'CONTRACT' },
      ],
    })).toThrow(/CONFLICTING_OVERLAY/)
    db.close()
  })

  it('refuses a shadow database written by the pre-Stage-2H shape', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE replay_cases (
      replay_case_id TEXT NOT NULL, run_id TEXT NOT NULL, domain TEXT NOT NULL, thread_id TEXT NOT NULL,
      title TEXT NOT NULL, case_type TEXT NOT NULL, status TEXT NOT NULL,
      scope_needs_review INTEGER NOT NULL, source_message_ids_json TEXT NOT NULL,
      latest_source_at INTEGER NOT NULL, actionability_class TEXT NOT NULL, actionability_valid INTEGER NOT NULL,
      PRIMARY KEY(run_id, replay_case_id))`)
    expect(() => ensureShadowReplaySchema(db)).toThrow(/SHADOW_REPLAY_SCHEMA_STALE/)
    db.close()
  })
})

// ── Point 3: the parity surface measures the real extractors, on the input
//    production actually received ────────────────────────────────────────────

const INVOICE_SNIPPET = 'Tisztelt Szabo Istvan! Számlaszám: 2026/0042 Brutto osszeg: 15 484 Ft '
  + 'Kelt: 2026-07-22 Fizetesi hatarido: 2026-08-05'
const CONTRACT_SNIPPET = 'A szerzodes lejarati datuma 2026-09-30. Felmondasi ido 30 nap. Eves dij 120 000 Ft.'
const PLAIN_SNIPPET = 'Koszonjuk a regisztraciot, jo szorakozast kivanunk.'

const prodCase = (over: Partial<ProductionCaseSnapshot> & Pick<ProductionCaseSnapshot, 'caseId'>): ProductionCaseSnapshot => ({
  domain: 'zst', threadIds: [], title: 'Cim', status: 'NEW', ...over,
})

/** Known outcome, measured from the shipped extractors before it was written
 *  down. A fixture whose expected values came from the code under test would
 *  only prove the code equals itself. */
const PROD_INVOICE: ProductionInvoiceRow = {
  caseId: 'zst-zst-inv-1', invoiceNumber: '2026/0042', supplierId: 'Relacio KFT.',
  grossAmount: 15484, currency: 'HUF', issueDate: '2026-07-22', dueDate: '2026-08-05', notes: null,
}
const PROD_CONTRACT: ProductionContractRow = {
  caseId: 'zst-zst-ctr-1', title: 'Elofizetes megujitas ertesito', contractType: null,
  counterpartyId: 'Google Workspace', effectiveDate: null, expiryDate: '2026-09-30',
  renewalType: null, noticePeriodDays: 30, terminationDeadline: '2026-08-31',
  financialCommitment: 120000, currency: 'HUF',
}

const EQUIV: InputBasis = 'HISTORICAL_PROVIDER_SNIPPET_WITH_HEADERS'
const NOT_EQUIV: InputBasis = 'HISTORICAL_INPUT_NOT_EQUIVALENT'

function baseInput(over: Partial<ConditionalExtractorParityInput> = {}): ConditionalExtractorParityInput {
  return {
    overlays: [
      { threadId: 'ti', productionCaseId: 'zst-zst-inv-1', caseType: 'INVOICE_INCOMING' },
      { threadId: 'tc', productionCaseId: 'zst-zst-ctr-1', caseType: 'CONTRACT' },
    ],
    productionCases: [
      prodCase({ caseId: 'zst-zst-inv-1', threadIds: ['ti'], caseType: 'INVOICE_INCOMING', sourceReference: 'inv-1' }),
      prodCase({ caseId: 'zst-zst-ctr-1', threadIds: ['tc'], caseType: 'CONTRACT', sourceReference: 'ctr-1' }),
    ],
    productionInvoices: [PROD_INVOICE],
    productionContracts: [PROD_CONTRACT],
    inputBasisByCase: { 'zst-zst-inv-1': EQUIV, 'zst-zst-ctr-1': EQUIV },
    historicalInputByMessage: {
      'inv-1': { subject: 'Ertesito: szamla erkezett', from: '"Relacio KFT." <relacio.kft@szamlazz.hu>', snippet: INVOICE_SNIPPET },
      'ctr-1': { subject: 'Elofizetes megujitas ertesito', from: '"Google Workspace" <billing@google.com>', snippet: CONTRACT_SNIPPET },
    },
    ...over,
  }
}

function parity(over: Partial<ConditionalExtractorParityInput> = {}, opts?: { currentFullBodyByMessage?: Record<string, string> }): ExtractorParityReport {
  const db = new Database(':memory:')
  try { return runConditionalExtractorParity(db, baseInput(over), T, opts ?? {}) } finally { db.close() }
}

describe('Stage 2H point 1/3 — input basis decides the denominator', () => {
  it('compares only threads whose production input is reproducible', () => {
    const r = parity()
    expect(r.basis).toBe('HISTORICAL')
    expect(r.summary.eligible).toBe(2)
    expect(r.summary.compared).toBe(2)
    expect(r.summary.pass).toBe(2)
    for (const row of r.rows) {
      expect(row.inputBasis).toBe(EQUIV)
      expect(row.extractorAttempted).toBe(true)
      expect(row.inputDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(row.classificationProof).toBe(false)
    }
  })

  it('keeps a not-equivalent thread out of the denominator instead of comparing it', () => {
    const r = parity({ inputBasisByCase: { 'zst-zst-inv-1': NOT_EQUIV, 'zst-zst-ctr-1': EQUIV } })
    const inv = r.rows.find(x => x.productionCaseId === 'zst-zst-inv-1')!
    expect(inv.verdict).toBe('NOT_IN_DENOMINATOR')
    expect(inv.extractorAttempted).toBe(false)
    expect(inv.inputDigest).toBeNull()
    expect(r.summary.eligible).toBe(1)
    expect(r.summary.compared).toBe(1)
    expect(r.summary.inputNotEquivalent).toBe(1)
  })

  it('treats an UNDECLARED basis as not equivalent, never as eligible', () => {
    const r = parity({ inputBasisByCase: { 'zst-zst-ctr-1': EQUIV } })
    const inv = r.rows.find(x => x.productionCaseId === 'zst-zst-inv-1')!
    expect(inv.inputBasis).toBe(NOT_EQUIV)
    expect(inv.verdict).toBe('NOT_IN_DENOMINATOR')
    expect(inv.reasons.join(' ')).toMatch(/no input basis was declared/)
    expect(r.summary.eligible).toBe(1)
  })

  it('a full-body run is stamped CURRENT_FULL_BODY and is never historical parity', () => {
    const r = parity({}, { currentFullBodyByMessage: { 'inv-1': INVOICE_SNIPPET, 'ctr-1': CONTRACT_SNIPPET } })
    expect(r.basis).toBe('CURRENT_ONLY')
    expect(r.rows.every(x => x.inputBasis === 'CURRENT_FULL_BODY')).toBe(true)
    expect(r.summary.eligible).toBe(0)
  })
})

describe('Stage 2H point 2 — "no row" is a result, not a silence', () => {
  it('passes a demonstrated NO_EXTRACTION that matches production', () => {
    const r = parity({
      productionContracts: [],
      historicalInputByMessage: {
        ...baseInput().historicalInputByMessage,
        'ctr-1': { subject: 'Koszonjuk', from: '"Valaki" <a@b.hu>', snippet: PLAIN_SNIPPET },
      },
    })
    const ctr = r.rows.find(x => x.route === 'CONTRACT')!
    expect(ctr.expectedHistorical).toBe('NO_EXTRACTION')
    expect(ctr.replayResult).toBe('NO_EXTRACTION')
    expect(ctr.extractorAttempted).toBe(true)
    expect(ctr.verdict).toBe('PASS')
    expect(ctr.reasons.join(' ')).toMatch(/ran on the historical input and declined it/)
  })

  it('does not let mutual silence pass when the extractor was never run', () => {
    const r = parity({
      productionContracts: [],
      inputBasisByCase: { 'zst-zst-inv-1': EQUIV, 'zst-zst-ctr-1': NOT_EQUIV },
    })
    const ctr = r.rows.find(x => x.route === 'CONTRACT')!
    // production has no row and the replay produced none either -- and it is
    // still NOT a pass, because nothing was demonstrated.
    expect(ctr.expectedHistorical).toBe('NO_EXTRACTION')
    expect(ctr.replayResult).toBeNull()
    expect(ctr.extractorAttempted).toBe(false)
    expect(ctr.verdict).not.toBe('PASS')
  })

  it('records production expectation, fingerprints and full field set on a structured row', () => {
    const r = parity()
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    expect(inv.expectedHistorical).toBe('STRUCTURED_ROW')
    expect(inv.replayResult).toBe('STRUCTURED_ROW')
    expect(inv.productionFingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(inv.replayFingerprint).toMatch(/^[0-9a-f]{32}$/)
    for (const f of ['invoiceNumber', 'supplierId', 'grossAmount', 'currency', 'issueDate', 'dueDate']) {
      expect(inv.comparisons.map(c => c.field)).toContain(f)
    }
    expect(inv.comparisons.find(c => c.field === 'extractionConfidence')?.verdict).toBe('PRODUCTION_NOT_PERSISTED')
  })

  it('flags production-has-row / replay-none as a mismatch, not a pass', () => {
    const r = parity({
      historicalInputByMessage: {
        ...baseInput().historicalInputByMessage,
        'inv-1': { subject: 'Semmi', from: '"X" <x@y.hu>', snippet: 'Nincs itt semmi erdekes.' },
      },
    })
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    expect(inv.expectedHistorical).toBe('STRUCTURED_ROW')
    expect(inv.replayResult).toBe('NO_EXTRACTION')
    expect(inv.verdict).toBe('MISMATCH')
  })

  it('flags replay-row / production-none separately from a value mismatch', () => {
    const r = parity({ productionInvoices: [] })
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    expect(inv.verdict).toBe('PRODUCTION_HAS_NO_ROW')
    expect(r.summary.mismatch).toBe(0)
    expect(r.summary.productionHasNoRow).toBe(1)
  })

  it('goes red when a production amount differs', () => {
    const r = parity({ productionInvoices: [{ ...PROD_INVOICE, grossAmount: 99999 }] })
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    expect(inv.verdict).toBe('MISMATCH')
    expect(inv.comparisons.find(c => c.field === 'grossAmount')?.verdict).toBe('MISMATCH')
  })

  it('writes the extracted rows into the shadow store, so silence cannot pass as agreement', () => {
    const db = new Database(':memory:')
    runConditionalExtractorParity(db, baseInput(), T)
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get() as { n: number }).n).toBe(1)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='zst_contracts'`).get()).toBeDefined()
    db.close()
  })

  it('builds overlays only for threads the production gate would route, inside the corpus', () => {
    const overlays = buildProductionAuthorityOverlays([
      prodCase({ caseId: 'a', threadIds: ['ti'], caseType: 'INVOICE_INCOMING' }),
      prodCase({ caseId: 'b', threadIds: ['tc'], caseType: 'GENERAL_OPERATION' }),
      prodCase({ caseId: 'c', threadIds: ['not-in-corpus'], caseType: 'CONTRACT' }),
      prodCase({ caseId: 'd', threadIds: ['tc'], caseType: null }),
    ], new Set(['ti', 'tc']))
    expect(overlays).toEqual([{ threadId: 'ti', productionCaseId: 'a', caseType: 'INVOICE_INCOMING' }])
    expect(routeZstExtractor('GENERAL_OPERATION')).toBeNull()
  })

  it('reads the production input id from source_references, in either stored shape', () => {
    expect(normaliseSourceReference('19edae46460029b4')).toBe('19edae46460029b4')
    expect(normaliseSourceReference('["19edae46460029b4"]')).toBe('19edae46460029b4')
    expect(normaliseSourceReference('["a","b"]')).toBeNull()
    expect(normaliseSourceReference('[]')).toBeNull()
    expect(normaliseSourceReference(null)).toBeNull()
    expect(normaliseSourceReference('  ')).toBeNull()
    expect(normaliseSourceReference('[not json')).toBeNull()
  })
})

describe('Stage 2H point 3 — determinism on the same immutable input', () => {
  it('two pristine shadow databases produce the same parity digest', () => {
    const a = parity()
    const b = parity()
    expect(a.parityDigest).toBe(b.parityDigest)
    expect(a.rows.map(r => r.verdict)).toEqual(b.rows.map(r => r.verdict))
    expect(a.rows.map(r => r.replayResult)).toEqual(b.rows.map(r => r.replayResult))
  })

  it('the digest carries no timestamp, so a later run still matches', () => {
    const db1 = new Database(':memory:'); const db2 = new Database(':memory:')
    const a = runConditionalExtractorParity(db1, baseInput(), T)
    const b = runConditionalExtractorParity(db2, baseInput(), T + 99_999)
    db1.close(); db2.close()
    expect(a.generatedAt).not.toBe(b.generatedAt)
    expect(a.parityDigest).toBe(b.parityDigest)
  })

  it('a changed input changes the digest', () => {
    const a = parity()
    const b = parity({ productionInvoices: [{ ...PROD_INVOICE, grossAmount: 1 }] })
    expect(a.parityDigest).not.toBe(b.parityDigest)
    expect(parityDigestOf(a.rows)).toBe(a.parityDigest)
  })
})

// ── Point 4: readiness ─────────────────────────────────────────────────────

function manifestWithConditionalMismatch(): CorrectionManifest {
  return reconcileReplay('run', [{
    replayCaseId: 'r1', domain: 'zst', threadId: 't1',
    projectionAuthority: 'CONDITIONAL_ON_PRODUCTION_TYPE', productionCaseId: 'zst-1',
    title: null, caseType: 'INVOICE_INCOMING', status: 'NEW', nextAction: 'mas lepes',
    nextActionOwner: 'ACCOUNTANT', waitingOn: null, dueAt: null, followUpAt: null, nextWakeAt: null,
    scopeNeedsReview: false, sourceMessageIds: ['m1'], latestSourceAt: T,
  }], [prodCase({
    caseId: 'zst-1', threadIds: ['t1'], caseType: 'INVOICE_INCOMING', status: 'NEW',
    nextAction: 'eredeti lepes', nextActionOwner: 'ACCOUNTANT',
  })])
}

function cleanManifest(): CorrectionManifest {
  return reconcileReplay('run', [{
    replayCaseId: 'r1', domain: 'zst', threadId: 't1',
    projectionAuthority: 'CONDITIONAL_ON_PRODUCTION_TYPE', productionCaseId: 'zst-1',
    title: null, caseType: 'INVOICE_INCOMING', status: 'NEW', nextAction: 'ugyanaz',
    nextActionOwner: 'ACCOUNTANT', waitingOn: null, dueAt: null, followUpAt: null, nextWakeAt: null,
    scopeNeedsReview: false, sourceMessageIds: ['m1'], latestSourceAt: T,
  }], [prodCase({
    caseId: 'zst-1', threadIds: ['t1'], caseType: 'INVOICE_INCOMING', status: 'NEW',
    nextAction: 'ugyanaz', nextActionOwner: 'ACCOUNTANT',
  })])
}

const goodRun = () => {
  const r = parity()
  return { extractorParity: r, doubleRun: { digestA: r.parityDigest, digestB: r.parityDigest },
    expectedDenominator: { eligible: 2, inputNotEquivalent: 0 } }
}

describe('Stage 2H point 4 — readiness semantics', () => {
  it('a P2 conditional mismatch no longer passes as green', () => {
    const m = manifestWithConditionalMismatch()
    expect(m.coverage.conditionalMismatched).toBeGreaterThan(0)
    expect(m.summary.p0 + m.summary.p1).toBe(0)
    expect(replayReadyForStability(m)).toBe(false)
  })

  it('a conditional field is not a mismatch when no overlay lent a type', () => {
    const m = reconcileReplay('run', [{
      replayCaseId: 'r1', domain: 'zst', threadId: 't1',
      projectionAuthority: 'HISTORICAL_SOURCE_REPLAY', productionCaseId: null,
      title: null, caseType: null, status: null, nextAction: null, nextActionOwner: null,
      waitingOn: null, dueAt: null, followUpAt: null, nextWakeAt: null,
      scopeNeedsReview: false, sourceMessageIds: ['m1'], latestSourceAt: T,
    }], [prodCase({ caseId: 'zst-1', threadIds: ['t1'], caseType: 'INVOICE_INCOMING', status: 'NEW', nextAction: 'x' })])
    expect(m.coverage.conditionalMismatched).toBe(0)
    expect(m.coverage.conditionalNotAttempted).toBeGreaterThan(0)
    expect(m.coverage.mismatched).toBe(0)
  })

  it('reports four separate surfaces and never calls NOT_RUN a pass', () => {
    const r = evaluateReplayReadiness({ manifest: cleanManifest(), extractorParity: null, documentParity: null })
    expect(r.historicalSourceReplayStatus).toBe('PASS')
    expect(r.conditionalExtractorParityStatus).toBe('NOT_RUN')
    expect(r.documentParityStatus).toBe('NOT_RUN')
    expect(r.historicalTriageReplayStatus).toBe('NOT_REPLAYABLE')
    expect(r.stable).toBe(false)
  })

  it('a run with no eligible historical input is NO_ELIGIBLE_HISTORICAL_INPUT, not FAIL and not NOT_RUN', () => {
    const none = parity({ inputBasisByCase: { 'zst-zst-inv-1': NOT_EQUIV, 'zst-zst-ctr-1': NOT_EQUIV } })
    expect(none.summary.eligible).toBe(0)
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), extractorParity: none, documentParity: { pass: true },
      doubleRun: { digestA: none.parityDigest, digestB: none.parityDigest },
    })
    expect(r.conditionalExtractorParityStatus).toBe('NO_ELIGIBLE_HISTORICAL_INPUT')
    // it found nothing it may measure, so it is not a pass either
    expect(r.stable).toBe(false)
  })

  it('a CURRENT_FULL_BODY report can never satisfy the historical surface', () => {
    const cur = parity({}, { currentFullBodyByMessage: { 'inv-1': INVOICE_SNIPPET, 'ctr-1': CONTRACT_SNIPPET } })
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), extractorParity: cur, documentParity: { pass: true },
      doubleRun: { digestA: cur.parityDigest, digestB: cur.parityDigest },
    })
    expect(r.conditionalExtractorParityStatus).toBe('NOT_RUN')
    expect(r.reasons.join(' ')).toMatch(/never historical parity/)
    expect(r.stable).toBe(false)
  })

  it('refuses to pass without a demonstrated double run', () => {
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), extractorParity: parity(), documentParity: { pass: true },
      expectedDenominator: { eligible: 2, inputNotEquivalent: 0 },
    })
    expect(r.conditionalExtractorParityStatus).toBe('FAIL')
    expect(r.reasons.join(' ')).toMatch(/determinism on the same immutable input is not demonstrated/)
  })

  it('refuses to pass when the two runs disagree', () => {
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), extractorParity: parity(), documentParity: { pass: true },
      doubleRun: { digestA: 'a'.repeat(64), digestB: 'b'.repeat(64) },
    })
    expect(r.conditionalExtractorParityStatus).toBe('FAIL')
    expect(r.reasons.join(' ')).toMatch(/different parity digests/)
  })

  it('refuses to pass when the denominator is not what the audit said', () => {
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), documentParity: { pass: true }, ...goodRun(),
      expectedDenominator: { eligible: 3, inputNotEquivalent: 12 },
    })
    expect(r.conditionalExtractorParityStatus).toBe('FAIL')
    expect(r.reasons.join(' ')).toMatch(/expected 3 eligible/)
  })

  it('is stable only when every mandatory surface passed; the triage limitation stays NOT_REPLAYABLE', () => {
    const r = evaluateReplayReadiness({ manifest: cleanManifest(), documentParity: { pass: true }, ...goodRun() })
    expect(r.historicalSourceReplayStatus).toBe('PASS')
    expect(r.conditionalExtractorParityStatus).toBe('PASS')
    expect(r.documentParityStatus).toBe('PASS')
    expect(r.historicalTriageReplayStatus).toBe('NOT_REPLAYABLE')
    expect(r.stable).toBe(true)
  })

  it('an unresolved conditional mismatch blocks stability on its own', () => {
    const r = evaluateReplayReadiness({ manifest: manifestWithConditionalMismatch(), documentParity: { pass: true }, ...goodRun() })
    expect(r.historicalSourceReplayStatus).toBe('FAIL')
    expect(r.stable).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/unresolved conditional mismatch/)
  })

  it('rejects an aggregate accuracy figure in the report shape', () => {
    expect(JSON.stringify(parity())).not.toMatch(/accuracy|agreementPercent|agreementRate/)
  })
})
