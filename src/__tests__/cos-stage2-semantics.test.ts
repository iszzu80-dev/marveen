import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { reconcileReplay, classifyField, replayReadyForStability } from '../cos/replay/reconcile.js'
import {
  recordTriageReceipt, requireTriageReceipt, triageReceiptId, triageReceiptsFor,
  triageProvenanceCoverage, UNDECLARED,
} from '../cos/triage-provenance.js'
import type { ProductionCaseSnapshot, ReplayCaseProjection } from '../cos/replay/types.js'

// Stage 2H / 2G semantics (Istvan, 2026-08-17). The audit of the same day proved
// the triage judgement is persisted nowhere and has no deterministic classifier,
// so a replay may neither claim agreement nor allege a mismatch on it.

const prod = (over: Partial<ProductionCaseSnapshot> = {}): ProductionCaseSnapshot => ({
  caseId: 'zst-zst-m1', domain: 'zst', threadIds: ['t1'], title: 'Szamla erkezett',
  caseType: 'INVOICE_INCOMING', status: 'NEW', nextAction: 'fizetes ellenorzese',
  nextActionOwner: 'istvan', waitingOn: null, dueAt: null, followUpAt: 100, nextWakeAt: null,
  hasHumanAuthorityEvent: false, hasExternalReceipt: false, ...over,
} as ProductionCaseSnapshot)

const replay = (over: Partial<ReplayCaseProjection> = {}): ReplayCaseProjection => ({
  replayCaseId: 'r1', domain: 'zst', threadId: 't1', title: 'valami mas',
  caseType: 'ADMIN', status: 'NEW', nextAction: 'fizetes ellenorzese',
  nextActionOwner: 'istvan', waitingOn: null, dueAt: null, followUpAt: 100, nextWakeAt: null,
  ...over,
} as ReplayCaseProjection)

describe('Stage 2H — what a replay may claim', () => {
  it('never labels the triage-derived fields SOURCE_DERIVED', () => {
    for (const f of ['caseType', 'title', 'priority', 'workspace', 'declaredSensitivity', 'actionable']) {
      expect(classifyField(f, prod())).toBe('NOT_REPLAYABLE')
    }
  })

  it('counts a differing caseType as coverage, not as a mismatch', () => {
    const m = reconcileReplay('run1', [replay()], [prod()])
    const ct = m.findings.filter(f => f.field === 'caseType')
    expect(ct).toHaveLength(1)
    expect(ct[0].authority).toBe('NOT_REPLAYABLE')
    expect(ct[0].replayValue).toBeNull()
    expect(m.coverage.notReplayable).toBeGreaterThanOrEqual(2) // caseType + title
    // The differing type must not have moved the match/mismatch counters.
    expect(m.coverage.matched + m.coverage.mismatched).toBe(m.coverage.compared)
  })

  it('counts an IDENTICAL caseType as coverage too — a coincidence is not evidence', () => {
    const m = reconcileReplay('run1', [replay({ caseType: 'INVOICE_INCOMING', title: 'Szamla erkezett' })], [prod()])
    const ct = m.findings.find(f => f.field === 'caseType')
    expect(ct?.authority).toBe('NOT_REPLAYABLE')
    expect(m.coverage.matched).toBe(m.coverage.compared - m.coverage.mismatched)
    expect(m.findings.some(f => f.field === 'caseType' && f.authority === 'SOURCE_DERIVED')).toBe(false)
  })

  it('marks everything downstream of caseType CONDITIONAL, never source-derived', () => {
    for (const f of ['status', 'nextAction', 'nextActionOwner', 'waitingOn', 'dueAt', 'followUpAt', 'nextWakeAt']) {
      expect(classifyField(f, prod())).toBe('CONDITIONAL_ON_PRODUCTION_TYPE')
    }
    const m = reconcileReplay('run1', [replay({ nextAction: 'valami mas' })], [prod()])
    const na = m.findings.find(f => f.field === 'nextAction')
    expect(na?.authority).toBe('CONDITIONAL_ON_PRODUCTION_TYPE')
    expect(na?.reason).toContain('PRODUCTION_AUTHORITY_OVERLAY')
    expect(m.coverage.conditional).toBeGreaterThan(0)
  })

  it('keeps connector/thread identity source-derived', () => {
    expect(classifyField('domain', prod())).toBe('SOURCE_DERIVED')
    const m = reconcileReplay('run1', [replay({ domain: 'personal' })], [prod()])
    const d = m.findings.find(f => f.field === 'domain')
    expect(d?.severity).toBe('P1')
  })

  it('lets a human/receipt-backed status stay authoritative', () => {
    expect(classifyField('status', prod({ hasHumanAuthorityEvent: true }))).toBe('PRODUCTION_AUTHORITATIVE')
  })

  it('reports the seven Stage 2H counters and no aggregate agreement figure', () => {
    const m = reconcileReplay('run1', [replay()], [prod()])
    expect(Object.keys(m.coverage).sort()).toEqual(
      ['compared', 'conditional', 'eligible', 'matched', 'mismatched', 'notReplayable', 'unknown'])
    expect(m.coverage.eligible).toBe(m.coverage.compared + m.coverage.notReplayable)
    expect(JSON.stringify(m)).not.toMatch(/agreementPercent|agreementRate|"agreement"/)
  })

  it('an unmapped thread is UNKNOWN and blocks stability, not a silent zero', () => {
    const m = reconcileReplay('run1', [replay()], [])
    expect(m.coverage.unknown).toBe(1)
    expect(replayReadyForStability(m)).toBe(false)
  })
})

describe('Stage 2G — triage provenance receipts', () => {
  let db: Database.Database
  const base = {
    accountId: 'zst', messageId: 'm1', threadId: 't1', actionable: true,
    caseType: 'INVOICE_INCOMING', title: 'Szamla', workspace: 'OPERATIONS',
    priority: 'P2', declaredSensitivity: 'ZST_INTERNAL',
    actor: 'marveen', model: 'claude-opus-5', promptFingerprint: 'sha:abc123',
    sourceManifestHash: 'sha256:deadbeef',
  }
  beforeEach(() => { db = new Database(':memory:') })

  it('records every required field', () => {
    recordTriageReceipt(db, base, 500)
    const [r] = triageReceiptsFor(db, 'zst', 'm1')
    for (const col of ['account_id', 'message_id', 'thread_id', 'source_manifest_hash', 'actionable',
      'case_type', 'title', 'workspace', 'priority', 'declared_sensitivity',
      'actor', 'model', 'prompt_fingerprint', 'decided_at', 'schema_version']) {
      expect(r[col], col).not.toBeUndefined()
    }
    expect(r.decided_at).toBe(500)
    expect(r.schema_version).toBe(1)
  })

  it('is idempotent for the same verdict and append-only for a changed one', () => {
    const a = recordTriageReceipt(db, base, 500)
    const b = recordTriageReceipt(db, base, 900)
    expect(b.receiptId).toBe(a.receiptId)
    expect(b.created).toBe(false)
    expect(triageReceiptsFor(db, 'zst', 'm1')).toHaveLength(1)

    const c = recordTriageReceipt(db, { ...base, caseType: 'CONTRACT' }, 900)
    expect(c.receiptId).not.toBe(a.receiptId)
    expect(triageReceiptsFor(db, 'zst', 'm1')).toHaveLength(2)
    // the original verdict is still there, unmodified
    const first = triageReceiptsFor(db, 'zst', 'm1').find(r => r.receipt_id === a.receiptId)
    expect(first?.case_type).toBe('INVOICE_INCOMING')
  })

  it('records an undeclared producer as UNDECLARED instead of dropping it', () => {
    recordTriageReceipt(db, { ...base, actor: null, model: null, promptFingerprint: null }, 500)
    const [r] = triageReceiptsFor(db, 'zst', 'm1')
    expect(r.actor).toBe(UNDECLARED)
    expect(r.model).toBe(UNDECLARED)
    expect(r.prompt_fingerprint).toBe(UNDECLARED)
    const cov = triageProvenanceCoverage(db)
    expect(cov.receipts).toBe(1)
    expect(cov.withModel).toBe(0)
    expect(cov.withPromptFingerprint).toBe(0)
  })

  it('the gate refuses a case with no receipt, and passes once there is one', () => {
    expect(() => requireTriageReceipt(db, 'zst', 'ghost')).toThrow(/TRIAGE_PROVENANCE_MISSING/)
    recordTriageReceipt(db, base, 500)
    expect(() => requireTriageReceipt(db, 'zst', 'm1')).not.toThrow()
  })

  it('the receipt id is the verdict fingerprint, so two stores agree without coordination', () => {
    expect(triageReceiptId(base)).toBe(triageReceiptId({ ...base }))
    expect(triageReceiptId(base)).not.toBe(triageReceiptId({ ...base, actionable: false }))
    expect(triageReceiptId(base)).not.toBe(triageReceiptId({ ...base, actor: 'someone-else' }))
  })
})
