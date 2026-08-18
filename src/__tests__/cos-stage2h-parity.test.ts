import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import {
  runShadowReplay, readReplayProjections, ensureShadowReplaySchema,
} from '../cos/replay/shadow-replay.js'
import {
  runConditionalExtractorParity, buildProductionAuthorityOverlays,
  type ProductionInvoiceRow, type ProductionContractRow,
} from '../cos/replay/extractor-parity.js'
import { evaluateReplayReadiness, reconcileReplay, replayReadyForStability } from '../cos/replay/reconcile.js'
import { projectZstOperationalIntake } from '../cos/zst-operational-projector.js'
import { routeZstExtractor } from '../cos/zst-intake.js'
import type {
  CorrectionManifest, ExtractorParityReport, ProductionAuthorityOverlay, ProductionCaseSnapshot,
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

// ── Point 3: the parity surface measures the real extractors ───────────────

const INVOICE_BODY = 'Tisztelt Szabo Istvan!\nSzámlaszám: 2026/0042\nBrutto osszeg: 15 484 Ft\n'
  + 'Kelt: 2026-07-22\nFizetesi hatarido: 2026-08-05\n'
const CONTRACT_BODY = 'A szerzodes lejarati datuma 2026-09-30. Felmondasi ido 30 nap. Eves dij 120 000 Ft.\n'

const invoiceMsg = msg({
  messageId: 'inv-1', threadId: 'ti', subject: 'Ertesito: szamla erkezett',
  from: '"Relacio KFT." <relacio.kft@szamlazz.hu>', bodyText: INVOICE_BODY,
})
const contractMsg = msg({
  messageId: 'ctr-1', threadId: 'tc', subject: 'Elofizetes megujitas ertesito',
  from: '"Google Workspace" <billing@google.com>', bodyText: CONTRACT_BODY,
})

const prodCase = (over: Partial<ProductionCaseSnapshot> & Pick<ProductionCaseSnapshot, 'caseId'>): ProductionCaseSnapshot => ({
  domain: 'zst', threadIds: [], title: 'Cim', status: 'NEW', ...over,
})

/** Known outcome, measured from the shipped extractors before it was written
 *  down. A parity fixture whose expected values were produced by the code under
 *  test would only prove the code equals itself. */
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

function parity(over: Partial<Parameters<typeof runConditionalExtractorParity>[1]> = {}): ExtractorParityReport {
  const db = new Database(':memory:')
  try {
    return runConditionalExtractorParity(db, {
      overlays: [
        { threadId: 'ti', productionCaseId: 'zst-zst-inv-1', caseType: 'INVOICE_INCOMING' },
        { threadId: 'tc', productionCaseId: 'zst-zst-ctr-1', caseType: 'CONTRACT' },
      ],
      messages: [invoiceMsg, contractMsg],
      productionCases: [
        prodCase({ caseId: 'zst-zst-inv-1', threadIds: ['ti'], caseType: 'INVOICE_INCOMING', sourceReference: 'inv-1' }),
        prodCase({ caseId: 'zst-zst-ctr-1', threadIds: ['tc'], caseType: 'CONTRACT', sourceReference: 'ctr-1' }),
      ],
      productionInvoices: [PROD_INVOICE],
      productionContracts: [PROD_CONTRACT],
      ...over,
    }, T)
  } finally { db.close() }
}

describe('Stage 2H point 3 — conditional extractor parity', () => {
  it('runs the real extractors on the real schema and passes on agreement', () => {
    const r = parity()
    expect(r.summary.targets).toBe(2)
    expect(r.summary.pass).toBe(2)
    expect(r.summary.mismatch).toBe(0)
    expect(r.summary.fieldsMismatched).toBe(0)
    expect(r.summary.fieldsCompared).toBeGreaterThan(10)
    for (const row of r.rows) {
      expect(row.authority).toBe('CONDITIONAL_ON_PRODUCTION_TYPE')
      expect(row.classificationProof).toBe(false)
      expect(row.extractionSource).toBe('FULL_BODY')
      expect(row.replayExtractionStatus).toBe('EXTRACTED')
    }
    expect(r.classificationProof).toBe(false)
  })

  it('compares the extractor result, not the case status', () => {
    const r = parity()
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    const fields = inv.comparisons.map(c => c.field)
    for (const required of ['invoiceNumber', 'supplierId', 'grossAmount', 'currency', 'dueDate']) {
      expect(fields, `invoice parity must compare ${required}`).toContain(required)
    }
    expect(fields).toContain('extractionConfidence')
    expect(inv.comparisons.find(c => c.field === 'extractionConfidence')?.verdict).toBe('PRODUCTION_NOT_PERSISTED')
    expect(inv.replayConfidence).toBe('HIGH')
    expect(inv.replayExtractedFields).toContain('invoice_number')

    const ctr = r.rows.find(x => x.route === 'CONTRACT')!
    for (const required of ['counterpartyId', 'expiryDate', 'noticePeriodDays', 'financialCommitment', 'currency']) {
      expect(ctr.comparisons.map(c => c.field), `contract parity must compare ${required}`).toContain(required)
    }
  })

  it('goes red when a production amount differs', () => {
    const r = parity({ productionInvoices: [{ ...PROD_INVOICE, grossAmount: 99999 }] })
    const inv = r.rows.find(x => x.route === 'INVOICE')!
    expect(inv.verdict).toBe('MISMATCH')
    expect(inv.comparisons.find(c => c.field === 'grossAmount')?.verdict).toBe('MISMATCH')
    expect(r.summary.mismatch).toBe(1)
    expect(r.summary.fieldsMismatched).toBeGreaterThan(0)
  })

  it('does not mix a snippet-extracted production row into the pass count', () => {
    const r = parity({ productionInvoices: [{ ...PROD_INVOICE, notes: 'extraction_source=SNIPPET' }] })
    const inv = r.rows.find(x => x.productionCaseId === 'zst-zst-inv-1')!
    expect(inv.verdict).toBe('RETRIAGE_INPUT_NOT_EQUIVALENT')
    expect(inv.comparisons).toHaveLength(0)
    expect(r.summary.pass).toBe(1)
    expect(r.summary.inputNotEquivalent).toBe(1)
  })

  it('marks a thread whose production input message is not in the corpus', () => {
    const r = parity({
      productionCases: [
        prodCase({ caseId: 'zst-zst-inv-1', threadIds: ['ti'], caseType: 'INVOICE_INCOMING', sourceReference: 'gone' }),
        prodCase({ caseId: 'zst-zst-ctr-1', threadIds: ['tc'], caseType: 'CONTRACT', sourceReference: 'ctr-1' }),
      ],
    })
    const inv = r.rows.find(x => x.productionCaseId === 'zst-zst-inv-1')!
    expect(inv.verdict).toBe('RETRIAGE_INPUT_NOT_EQUIVALENT')
    expect(inv.reasons.join(' ')).toMatch(/not in the corpus/)
  })

  it('reports a type the production gate routes nowhere as NOT_ROUTED', () => {
    const r = parity({
      overlays: [{ threadId: 'ti', productionCaseId: 'zst-zst-inv-1', caseType: 'GENERAL_OPERATION' }],
    })
    expect(r.rows[0].verdict).toBe('NOT_ROUTED')
    expect(r.rows[0].route).toBeNull()
    expect(routeZstExtractor('GENERAL_OPERATION')).toBeNull()
  })

  it('writes the extracted rows into the shadow store, so silence cannot pass as agreement', () => {
    const db = new Database(':memory:')
    runConditionalExtractorParity(db, {
      overlays: [{ threadId: 'ti', productionCaseId: 'zst-zst-inv-1', caseType: 'INVOICE_INCOMING' }],
      messages: [invoiceMsg],
      productionCases: [prodCase({ caseId: 'zst-zst-inv-1', threadIds: ['ti'], caseType: 'INVOICE_INCOMING', sourceReference: 'inv-1' })],
      productionInvoices: [PROD_INVOICE], productionContracts: [],
    }, T)
    const n = (db.prepare(`SELECT COUNT(*) n FROM zst_invoices`).get() as { n: number }).n
    expect(n).toBe(1)
    // the real production schema, not four private replay tables
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
  })
})

// ── Point 4: readiness is four named surfaces, not one boolean ─────────────

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

describe('Stage 2H point 4 — readiness semantics', () => {
  it('a P2 conditional mismatch no longer passes as green', () => {
    const m = manifestWithConditionalMismatch()
    expect(m.coverage.conditionalMismatched).toBeGreaterThan(0)
    expect(m.summary.p0 + m.summary.p1).toBe(0)   // the old gate saw only these
    expect(replayReadyForStability(m)).toBe(false)
  })

  it('a conditional field is not counted as a mismatch when no overlay lent a type', () => {
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
    expect(r.reasons.join(' ')).toMatch(/conditional extractor parity has not been run/)
  })

  it('an extractor parity report with zero targets is NOT_RUN, not PASS', () => {
    const empty = parity({ overlays: [] })
    const r = evaluateReplayReadiness({ manifest: cleanManifest(), extractorParity: empty, documentParity: { pass: true } })
    expect(empty.summary.targets).toBe(0)
    expect(r.conditionalExtractorParityStatus).toBe('NOT_RUN')
    expect(r.stable).toBe(false)
  })

  it('an extractor mismatch fails the surface even though the historical one passed', () => {
    const bad = parity({ productionInvoices: [{ ...PROD_INVOICE, grossAmount: 1 }] })
    const r = evaluateReplayReadiness({ manifest: cleanManifest(), extractorParity: bad, documentParity: { pass: true } })
    expect(r.historicalSourceReplayStatus).toBe('PASS')
    expect(r.conditionalExtractorParityStatus).toBe('FAIL')
    expect(r.stable).toBe(false)
  })

  it('is stable only when every mandatory surface passed; the triage limitation stays NOT_REPLAYABLE', () => {
    const r = evaluateReplayReadiness({
      manifest: cleanManifest(), extractorParity: parity(), documentParity: { pass: true },
    })
    expect(r.historicalSourceReplayStatus).toBe('PASS')
    expect(r.conditionalExtractorParityStatus).toBe('PASS')
    expect(r.documentParityStatus).toBe('PASS')
    expect(r.historicalTriageReplayStatus).toBe('NOT_REPLAYABLE')
    expect(r.stable).toBe(true)
  })

  it('an unresolved conditional mismatch blocks stability on its own', () => {
    const r = evaluateReplayReadiness({
      manifest: manifestWithConditionalMismatch(), extractorParity: parity(), documentParity: { pass: true },
    })
    expect(r.historicalSourceReplayStatus).toBe('FAIL')
    expect(r.stable).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/unresolved conditional mismatch/)
  })
})
