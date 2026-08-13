import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { extractContract, ingestZstContractEmail } from '../cos/zst-contract-extract.js'
import { ingestTriagedZstEmail } from '../cos/zst-intake.js'

const T0 = 1_700_000_000

// Auto-renewing subscription notice with an explicit renewal date + notice period.
const RENEWAL = {
  from: '"Adobe Systems" <billing@adobe.com>',
  subject: 'Az előfizetésed hamarosan megújul',
  body: 'Tisztelt Ügyfelünk!\nAz előfizetésed automatikusan megújul: 2026-09-30.\nFelmondási idő: 30 nap.\nÉves díj: 240 000 Ft.\nKöszönjük.',
}

describe('ZST contract/renewal extractor (v1 heuristic)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('extracts counterparty, expiry, notice period, renewal type, amount', () => {
    const ex = extractContract(RENEWAL)!
    expect(ex).not.toBeNull()
    expect(ex.counterpartyId).toBe('Adobe Systems')
    expect(ex.expiryDate).toBe('2026-09-30')
    expect(ex.noticePeriodDays).toBe(30)
    expect(ex.renewalType).toBe('AUTOMATIC')
    expect(ex.financialCommitment).toBe(240000)
    expect(ex.contractType).toBe('SUBSCRIPTION')
    expect(ex.confidence).toBe('HIGH') // expiry + counterparty
  })

  it('derives termination_deadline = expiry - notice period (only when both known)', () => {
    const ex = extractContract(RENEWAL)!
    expect(ex.terminationDeadline).toBe('2026-08-31') // 2026-09-30 minus 30 days
  })

  it('never derives a termination deadline from one field alone', () => {
    const ex = extractContract({
      from: 'x@vendor.hu', subject: 'Szerződés lejár',
      body: 'A szerződés lejár: 2026-12-01. (nincs megadva felmondási idő)',
    })!
    expect(ex.expiryDate).toBe('2026-12-01')
    expect(ex.noticePeriodDays).toBeUndefined()
    expect(ex.terminationDeadline).toBeUndefined()
  })

  it('returns null for an email with no contract cue', () => {
    expect(extractContract({ from: 'a@b.hu', subject: 'Ebéd?', body: 'Mit szólsz a péntekhez?' })).toBeNull()
  })

  it('does honest partial extraction — unparseable fields stay null', () => {
    const ex = extractContract({ from: 'x@y.hu', subject: 'Szerződés tervezet', body: 'Csatolva a szerződés tervezete.' })!
    expect(ex).not.toBeNull() // "szerződés" cue
    expect(ex.expiryDate).toBeUndefined()
    expect(ex.financialCommitment).toBeUndefined()
    expect(ex.confidence).toBe('PARTIAL') // counterparty only (domain)
  })

  it('registers the contract idempotently and keeps it UNDER_REVIEW (never auto-signed)', () => {
    const db = getDb()
    const r1 = ingestZstContractEmail(db, RENEWAL, T0)!
    expect(r1.duplicate).toBe(false)
    const r2 = ingestZstContractEmail(db, RENEWAL, T0 + 5)!
    expect(r2.duplicate).toBe(true) // dedup
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_contracts`).get() as any).n).toBe(1)
    const c: any = db.prepare(`SELECT status FROM zst_contracts WHERE contract_id=?`).get(r1.contractId)
    expect(c.status).toBe('UNDER_REVIEW')
  })

  it('end-to-end: a ZST renewal email through intake creates a case AND a zst_contract', () => {
    const db = getDb()
    const r = ingestTriagedZstEmail(db, {
      accountId: 'zst', messageId: 'ctr-msg-1', threadId: 'ctr-t1',
      from: RENEWAL.from, subject: RENEWAL.subject, snippet: RENEWAL.body,
      actionable: true, caseType: 'LICENSE_SUBSCRIPTION',
    }, T0)
    expect(r.outcome).toBe('CASE_CREATED')
    const c: any = db.prepare(`SELECT contract_id, expiry_date, case_id FROM zst_contracts`).get()
    expect(c.expiry_date).toBe('2026-09-30')
    expect(c.case_id).toBe(r.caseId) // linked to the case
  })
})

describe('ZST contract extractor — separators and honest nulls', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an NBSP-grouped fee is the whole fee, not zero', () => {
    // This file's copy of parseHufAmounts never grew the NO-BREAK SPACE the
    // invoice copy had, so the fallback `\d{3,}` matched the LAST group —
    // "000" — and a 1.2M contract was recorded with a financial commitment of 0.
    const ex = extractContract({
      from: '"X Kft." <a@x.hu>', subject: 'Szerződés megújítás',
      body: 'A szerződés lejár: 2026-09-30. Éves díj: 1 200 000 Ft.',
    })!
    expect(ex.financialCommitment).toBe(1200000)
  })

  it('leaves contract_type NULL when nothing in the mail says what kind it is', () => {
    // 'SERVICE' used to be the else-branch of a two-way test, so every renewal
    // notice without a licence cue was filed as a service contract on no
    // evidence — in a module whose stated contract is that unparseable fields
    // stay null.
    const ex = extractContract({
      from: '"X Kft." <a@x.hu>', subject: 'Szerződés meghosszabbítása',
      body: 'A megállapodás lejár: 2026-09-30.',
    })!
    expect(ex.contractType).toBeUndefined()
    expect(ex.extracted).not.toContain('contract_type')
  })
})
