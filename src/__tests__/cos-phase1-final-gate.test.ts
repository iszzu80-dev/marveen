// Phase 1 final gate, the owner's two closures (2026-08-27).
//
//   1. "Aktív progress_stage=null ne legyen silent green. Ne mapeld őket
//       mesterségesen ACTIONABLE-re."
//   2. "A három régi VERIFIED outbound sor ne kapjon visszamenőleges
//       authorizationt. Ne kapcsold ki vagy gyengítsd a detektort. Rögzítsd
//       őket explicit legacy/pre-policy exceptionként, sorazonosítóhoz kötve."
//
// Both are about the same failure mode from opposite ends: a true finding that
// nobody can see. The first is a state the board reported as an empty cell and
// no counter ever mentioned; the second is a finding so loud, and so
// permanently true, that it would have trained the reader to ignore the whole
// assertion.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import type { CaseStatus } from '../cos/schema.js'
import { stageGapReport, explainStageGap } from '../cos/progress-stage.js'
import { reconcileProjections } from '../cos/case-projection.js'
import { recordPolicyException, isExcused, listPolicyExceptions, exceptionId } from '../cos/policy-exception.js'
import { evaluateSafetyAssertions } from '../cos/progression-eval.js'

const NOW = 1_700_000_000

// ── 1. the null stage is counted, named and explained ───────────────────

describe('an active case with no stage is never a silent green', () => {
  beforeEach(() => { initDatabase(':memory:') })

  /** A case with no progression state at all: nothing to derive a stage from. */
  function unenrolledCase(caseId: string, status: CaseStatus = 'READY'): void {
    createCase(getDb(), {
      caseId, title: caseId, caseType: 'ADMIN', status,
      sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
    }, NOW - 100)
  }

  /** What the projection sweep would write. Called explicitly so the test can
   *  show the counter reading the DURABLE column rather than a fresh
   *  derivation -- the two are different instruments and the owner asked for
   *  the first. */
  const project = (): void => { reconcileProjections(getDb(), NOW) }

  it('HEADLINE: null-stage active cases are counted, named and given a reason', () => {
    unenrolledCase('n1'); unenrolledCase('n2')
    project()

    const r = stageGapReport(getDb(), NOW)
    expect(r.activeStageNullCount).toBe(2)
    expect(r.clean).toBe(false)
    expect(r.cases.map(c => c.caseId).sort()).toEqual(['n1', 'n2'])
    // WHICH progression fact is missing, not merely that one is.
    expect(r.byReason.NOT_ENROLLED).toBe(2)
    expect(r.cases[0]!.detail).toMatch(/nincs case_progression_state/)
  })

  it('the counter FALLS when a null-stage case gets a stage', () => {
    unenrolledCase('n1'); unenrolledCase('n2')
    project()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(2)

    // Closing one gives it a stage (COMPLETED) through the ordinary derivation.
    getDb().prepare(`UPDATE personal_cases SET status='CANCELLED' WHERE case_id='n1'`).run()
    project()

    const r = stageGapReport(getDb(), NOW)
    expect(r.activeStageNullCount).toBe(1)
    expect(r.cases.map(c => c.caseId)).toEqual(['n2'])
  })

  it('the counter RISES when a new null-stage case appears', () => {
    unenrolledCase('n1')
    project()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(1)

    unenrolledCase('n3')
    project()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(2)
  })

  it('the count reads the DURABLE column, not a fresh derivation', () => {
    // The distinction the owner asked for. If the projection stopped writing,
    // this surface must go red -- and it can only do that by reading what was
    // actually written. Here the stored column is forced to a value the live
    // facts do not support: the report follows the STORE.
    unenrolledCase('n1')
    project()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(1)

    getDb().prepare(`UPDATE personal_cases SET proj_progress_stage='ACTIONABLE' WHERE case_id='n1'`).run()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(0)

    getDb().prepare(`UPDATE personal_cases SET proj_progress_stage=NULL WHERE case_id='n1'`).run()
    expect(stageGapReport(getDb(), NOW).activeStageNullCount).toBe(1)
  })

  it('a case that DOES have a stage is not explained away as a gap', () => {
    // The counter-case. A report that names every case is as useless as one
    // that names none.
    unenrolledCase('done1', 'CANCELLED')
    project()
    expect(explainStageGap(getDb(), 'personal', 'done1', NOW)).toBeNull()
    expect(stageGapReport(getDb(), NOW).clean).toBe(true)
  })

  it('closed cases count in the TOTAL but never in the active number', () => {
    unenrolledCase('n1')
    unenrolledCase('closed', 'COMPLETED')
    project()
    // A COMPLETED case with no evidence derives NEEDS_USER, not null, so force
    // the stored column to null: what is being tested is the split between the
    // two counters, not how a closed case gets its stage.
    getDb().prepare(`UPDATE personal_cases SET proj_progress_stage=NULL WHERE case_id='closed'`).run()
    const r = stageGapReport(getDb(), NOW)
    expect(r.totalStageNullCount).toBe(2)
    expect(r.activeStageNullCount).toBe(1)
  })
})

// ── 2. the legacy policy_bypass exception ───────────────────────────────

describe('a historical policy_bypass is recorded, not silenced', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    seq = 0
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
  })

  // A UNIQUE (case, type, sequence) index means each fixture row needs its own
  // sequence number; `id.length` gave two rows the same one.
  let seq = 0
  function ledgerRow(id: string, status = 'VERIFIED'): void {
    seq += 1
    getDb().prepare(
      `INSERT INTO outbound_ledger
        (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
         external_idempotency_marker, status, attempt, created_at, updated_at)
       VALUES (?, 'c1', 'EMAIL_SEND', ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, seq, `k-${id}`, `COS-Ref:${id}`, status, NOW, NOW)
  }

  const bypassFinding = (): string | null => {
    const res = evaluateSafetyAssertions(
      { decision: 'CONTINUE_AUTONOMOUSLY' } as never,
      { db: getDb(), domain: 'personal', caseId: 'c1' } as never,
    )
    const f = res.find(a => a.assertion === 'policy_bypass')
    return f && !f.passed ? String(f.detail ?? 'violated') : null
  }

  const legacy = (id: string) => ({
    assertion: 'policy_bypass', domain: 'personal' as const,
    subjectKind: 'OUTBOUND_LEDGER_ROW', subjectId: id, subjectState: 'VERIFIED',
    reason: 'pre-policy: mail the owner sent by hand before §22.2 tickets existed',
    evidence: 'ledger row created 2026-08-06, first reported by policy_bypass 2026-08-15 19:00',
    recordedBy: 'marveen',
  })

  it('without an exception the detector fires — the guard is not weakened', () => {
    ledgerRow('L1')
    expect(bypassFinding()).toMatch(/L1.*has no action authorization/)
  })

  it('HEADLINE: the recorded legacy row stops alarming, and a NEW one still does', () => {
    ledgerRow('L1')
    recordPolicyException(getDb(), legacy('L1'), NOW)
    expect(bypassFinding()).toBeNull()

    // The fourth row nobody examined. This is the property that makes the
    // exception safe rather than a mute button.
    ledgerRow('L2')
    expect(bypassFinding()).toMatch(/L2/)
  })

  it('the exception is bound to the ROW, not to a rule about rows', () => {
    ledgerRow('L1'); ledgerRow('L2')
    recordPolicyException(getDb(), legacy('L1'), NOW)
    expect(isExcused(getDb(), 'policy_bypass', 'OUTBOUND_LEDGER_ROW', 'L1', 'VERIFIED')).toBe(true)
    expect(isExcused(getDb(), 'policy_bypass', 'OUTBOUND_LEDGER_ROW', 'L2', 'VERIFIED')).toBe(false)
  })

  it('a row that MOVES is no longer the row that was excused', () => {
    // The state is bound too: a legacy row that starts sending again is not the
    // thing anybody looked at, and the alarm comes back on its own.
    ledgerRow('L1')
    recordPolicyException(getDb(), legacy('L1'), NOW)
    expect(bypassFinding()).toBeNull()

    getDb().prepare(`UPDATE outbound_ledger SET status='SENDING' WHERE ledger_id='L1'`).run()
    expect(bypassFinding()).toMatch(/L1.*SENDING/)
  })

  it('an exception for a DIFFERENT assertion excuses nothing here', () => {
    ledgerRow('L1')
    recordPolicyException(getDb(), { ...legacy('L1'), assertion: 'duplicate_external_action' }, NOW)
    expect(bypassFinding()).toMatch(/L1/)
  })

  it('the exceptions are listable, with their evidence and date', () => {
    // An excused finding nobody can see is the same silence the exception exists
    // to avoid: the alarm stops, and so does the knowledge that it was there.
    ledgerRow('L1')
    const id = recordPolicyException(getDb(), legacy('L1'), NOW)
    const list = listPolicyExceptions(getDb())
    expect(list).toHaveLength(1)
    expect(list[0]!.exceptionId).toBe(id)
    expect(list[0]!.exceptionId).toBe(exceptionId(legacy('L1')))
    expect(list[0]!.subjectId).toBe('L1')
    expect(list[0]!.recordedAt).toBe(NOW)
    expect(list[0]!.evidence).toMatch(/2026-08-15/)
  })

  it('recording the same exception twice is a correction, not a duplicate', () => {
    ledgerRow('L1')
    recordPolicyException(getDb(), legacy('L1'), NOW)
    recordPolicyException(getDb(), { ...legacy('L1'), reason: 'corrected wording' }, NOW + 10)
    const list = listPolicyExceptions(getDb())
    expect(list).toHaveLength(1)
    expect(list[0]!.reason).toBe('corrected wording')
    expect(list[0]!.recordedAt).toBe(NOW + 10)
  })
})
