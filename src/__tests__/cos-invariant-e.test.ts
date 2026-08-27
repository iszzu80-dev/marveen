// P4 — confidence and risk, so Invariant E is an invariant rather than a sentence.
//
//     Invariant E: Low-confidence high-risk action nem hajtható végre automatikusan.
//
// The audit's §3.5 finding was NOT that this was being violated. It was that the
// personal side carried neither a confidence nor a risk, so nothing could
// enforce it -- the approval bind and the send ceilings did the protecting, which
// are real but are different rules. "Enforced by something else that happens to
// overlap" and "enforced" are not the same claim.
//
// The acceptance criterion is unusually specific and shapes this file:
//   * a refusal must NAME confidence and risk, and be distinguishable in the log
//     from a refusal by the approval bind -- otherwise a test cannot tell which
//     gate fired;
//   * fill rate on both fields must match the DECISION count, not the refusal
//     count;
//   * the existing protections stay. Third gate, not replacement.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { permits } from '../cos/autonomy-ladder.js'
import {
  assessDecision, assessRisk, assessConfidence, invariantE,
  DECISION_LEVELS, type DecisionSignals,
} from '../cos/decision-confidence.js'

const NOW = 1_700_000_000

const signals = (over: Partial<DecisionSignals> = {}): DecisionSignals => ({
  sideEffect: 'READ_ONLY', capabilityVerdict: 'PROCEED', degradations: 0,
  noProgressRuns: 0, interruptions: 0, hasVerifiedDoD: true,
  financialExposure: null, legalExposure: null, ...over,
})

describe('Invariant E — the gate itself', () => {
  it('HEADLINE: low confidence AND high risk is refused, and names both', () => {
    const r = invariantE({ confidence: 'LOW', risk: 'HIGH' })
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('invariant_e_low_confidence_high_risk')
    expect(r.reason).toMatch(/LOW/)
    expect(r.reason).toMatch(/HIGH/)
  })

  it('the three OTHER corners are allowed -- a gate that always fires is not a gate', () => {
    expect(invariantE({ confidence: 'LOW', risk: 'LOW' }).allowed).toBe(true)
    expect(invariantE({ confidence: 'HIGH', risk: 'HIGH' }).allowed).toBe(true)
    expect(invariantE({ confidence: 'HIGH', risk: 'LOW' }).allowed).toBe(true)
    // and MEDIUM on either axis: the sentence says LOW and HIGH, and widening it
    // here would be a policy change wearing an invariant's name.
    expect(invariantE({ confidence: 'MEDIUM', risk: 'HIGH' }).allowed).toBe(true)
    expect(invariantE({ confidence: 'LOW', risk: 'MEDIUM' }).allowed).toBe(true)
  })

  it('its code is DISTINCT from the ladder\'s codes -- the acceptance criterion', () => {
    // "distinguishable in the log from a refusal by the approval bind, otherwise
    // the test cannot tell which gate fired". Compared against the real ladder,
    // not against a remembered list of its codes.
    initDatabase(':memory:')
    // Widened to Set<string> deliberately. The narrow union would make this a
    // COMPILE error rather than a test -- which sounds stronger and is weaker:
    // it would stop being an assertion the day someone adds the code to the
    // ladder's union, instead of failing and saying why.
    const ladderCodes = new Set<string>([
      permits(getDb(), 'X', 'PAYMENT').code,
      permits(getDb(), 'X', 'SHARE_BEYOND_APPROVED').code,
      permits(getDb(), 'X', 'SEND').code,
      permits(getDb(), 'X', 'OBSERVE').code,
    ])
    expect(ladderCodes.has('invariant_e_low_confidence_high_risk')).toBe(false)
    // ...and the ladder really did answer, so the set is not empty-by-accident.
    expect(ladderCodes.size).toBeGreaterThan(1)
  })
})

describe('Invariant E — how the two numbers are reached', () => {
  it('risk: a read-only step with no exposure is LOW, or the engine would stop', () => {
    expect(assessRisk(signals()).risk).toBe('LOW')
  })

  it('risk: reaching outside is HIGH, mutating locally is MEDIUM', () => {
    expect(assessRisk(signals({ sideEffect: 'MUTATING' })).risk).toBe('MEDIUM')
    expect(assessRisk(signals({ sideEffect: 'HIGH_RISK' })).risk).toBe('HIGH')
  })

  it('risk: money or legal exposure lifts even a read-only step to HIGH', () => {
    expect(assessRisk(signals({ financialExposure: 250_000 })).risk).toBe('HIGH')
    expect(assessRisk(signals({ legalExposure: 'CONTRACT' })).risk).toBe('HIGH')
  })

  it('risk: a null exposure is "not recorded", NOT "zero"', () => {
    // personal_cases has no exposure columns at all -- the audit's §3.5
    // asymmetry. Null must not read as a positive statement that there is none.
    expect(assessRisk(signals({ financialExposure: null })).reasons)
      .not.toContain('financial-exposure:0')
    expect(assessRisk(signals({ financialExposure: 0 })).risk).toBe('LOW')
  })

  it('confidence starts HIGH and is spent by NAMED doubts', () => {
    const clean = assessConfidence(signals())
    expect(clean.confidence).toBe('HIGH')
    expect(clean.reasons).toEqual([])
  })

  it('a missing capability collapses confidence to LOW on its own', () => {
    // Not a doubt: a fact. The engine does not have what the action needs.
    const r = assessConfidence(signals({ capabilityVerdict: 'WAIT_CAPABILITY' }))
    expect(r.confidence).toBe('LOW')
    expect(r.reasons).toContain('capability:MISSING')
  })

  it('doubts accumulate, and each one is named', () => {
    const r = assessConfidence(signals({
      degradations: 2, noProgressRuns: 4, hasVerifiedDoD: false,
    }))
    expect(r.confidence).toBe('LOW')
    expect(r.reasons).toEqual(
      expect.arrayContaining(['degraded:2', 'no-progress:4', 'dod:unverified']),
    )
  })

  it('every level is reachable -- a scale with unreachable values is not a scale', () => {
    const reached = new Set([
      assessConfidence(signals()).confidence,
      assessConfidence(signals({ degradations: 1 })).confidence,
      assessConfidence(signals({ capabilityVerdict: 'DENY_UNDECLARED' })).confidence,
    ])
    for (const l of DECISION_LEVELS) expect(reached.has(l)).toBe(true)
  })

  it('HEADLINE: the combination that Invariant E exists for', () => {
    // An outward-reaching action whose capability is missing. Exactly the shape
    // the sentence forbids, assembled from signals rather than asserted.
    const a = assessDecision(signals({
      sideEffect: 'HIGH_RISK', capabilityVerdict: 'WAIT_CAPABILITY',
    }))
    expect(a.risk).toBe('HIGH')
    expect(a.confidence).toBe('LOW')
    expect(invariantE(a).allowed).toBe(false)
  })
})

describe('Invariant E — recorded on EVERY decision, not only refusals', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function runOne(caseId: string): void {
    const db = getDb()
    createCase(db, { caseId, title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', caseId, NOW - 100)
    runProgressionCycle(db, 'personal', caseId, NOW, { triggerType: 'MANUAL', triggerReference: 't' })
  }

  it('HEADLINE: fill rate matches the DECISION count, not the refusal count', () => {
    // "Fill rate on both fields matches the decision count." A field populated
    // only on refusals would be a refusal log wearing a judgement's name, and
    // every question about thresholds would be unanswerable from data.
    const db = getDb()
    for (const id of ['c1', 'c2', 'c3']) runOne(id)

    const decided = (db.prepare(
      `SELECT COUNT(DISTINCT case_id) AS n FROM case_progression_runs WHERE domain='personal'`,
    ).get() as { n: number }).n
    const filled = (db.prepare(
      `SELECT COUNT(*) AS n FROM case_progression_state
        WHERE domain='personal' AND decision_confidence IS NOT NULL AND decision_risk IS NOT NULL`,
    ).get() as { n: number }).n
    expect(decided).toBe(3)
    expect(filled).toBe(decided)
  })

  it('the recorded values are from the declared vocabulary, and the reasons travel with them', () => {
    runOne('c1')
    const row = getDb().prepare(
      `SELECT decision_confidence AS c, decision_risk AS r, decision_assessment_json AS j
         FROM case_progression_state WHERE domain='personal' AND case_id='c1'`,
    ).get() as { c: string; r: string; j: string }
    expect(DECISION_LEVELS).toContain(row.c)
    expect(DECISION_LEVELS).toContain(row.r)
    const parsed = JSON.parse(row.j)
    expect(parsed).toHaveProperty('reasons')
    expect(parsed).toHaveProperty('signals')
  })
})

describe('Invariant E — a THIRD gate, not a replacement', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the ladder still refuses what it always refused', () => {
    // "The existing protections (approval bind, send ceiling) stay; this is a
    // third gate, not a replacement." Payment was never autonomous and still is
    // not, whatever confidence and risk say about it.
    const db = getDb()
    expect(permits(db, 'X', 'PAYMENT').allowed).toBe(false)
    expect(permits(db, 'X', 'SHARE_BEYOND_APPROVED').allowed).toBe(false)
  })

  it('and Invariant E does not permit anything -- it can only refuse', () => {
    // The direction matters. A gate that could turn a ladder refusal into a
    // pass would be a hole, not a gate.
    for (const c of DECISION_LEVELS) {
      for (const r of DECISION_LEVELS) {
        const v = invariantE({ confidence: c, risk: r })
        expect(typeof v.allowed).toBe('boolean')
        if (v.allowed) expect(v.code).toBe('ok')
      }
    }
    expect(permits(getDb(), 'X', 'PAYMENT').allowed).toBe(false)
  })
})
