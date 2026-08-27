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
// THE OWNER'S CLOSURE, 2026-08-27, shapes the second half of this file:
//   * HIGH confidence must be EARNED by a proven-complete input set; "we found no
//     doubt flag" is not evidence of certainty;
//   * HIGH risk is five classes, not two;
//   * the execution rules widened, and each has its own code so a test can tell
//     which one fired;
//   * and every one of his counter-examples is a test below, by name.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { permits, type ActionKind } from '../cos/autonomy-ladder.js'
import { PAYMENT_ACTION_TYPES, LEGAL_ACTION_TYPES } from '../cos/progression-eval.js'
import {
  assessDecision, assessRisk, assessConfidence, invariantE, gatherRequiredInputs,
  riskClassOfActionType, DECISION_LEVELS, REQUIRED_INPUTS, RISK_CLASS_ACTION_TYPES,
  type DecisionSignals, type RequiredInputFact, type RiskClass,
} from '../cos/decision-confidence.js'

const NOW = 1_700_000_000

/** A complete, positively-proven input set. Everything below that wants a HIGH
 *  confidence has to start from this, which is the point of the closure: the
 *  proof set is a thing a caller must SUPPLY, not a thing it gets by default. */
const proven = (over: Partial<Record<string, RequiredInputFact['status']>> = {}): RequiredInputFact[] =>
  REQUIRED_INPUTS.map(input => ({
    input, status: over[input] ?? 'PASS', detail: 'test',
  }))

const signals = (over: Partial<DecisionSignals> = {}): DecisionSignals => ({
  sideEffect: 'READ_ONLY', capabilityVerdict: 'PROCEED', degradations: 0,
  noProgressRuns: 0, interruptions: 0, hasVerifiedDoD: true,
  financialExposure: null, legalExposure: null,
  pendingActionTypes: [], sensitivity: null,
  requiredInputs: proven(), ...over,
})

// ── The gate ────────────────────────────────────────────────────────────

describe('Invariant E — the gate itself', () => {
  it('HEADLINE: high risk with confidence that is not HIGH is refused, and names both', () => {
    const r = invariantE({ confidence: 'MEDIUM', risk: 'HIGH', sideEffect: 'HIGH_RISK' })
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('invariant_e_high_risk_unproven_confidence')
    expect(r.reason).toMatch(/MEDIUM/)
    expect(r.reason).toMatch(/HIGH/)
  })

  it('the two refusal rules carry DIFFERENT codes, so a test can tell them apart', () => {
    // Without this, "Invariant E refused" is one fact where there are two, and
    // a regression in one rule hides behind the other passing.
    const a = invariantE({ confidence: 'MEDIUM', risk: 'HIGH', sideEffect: 'HIGH_RISK' })
    const b = invariantE({ confidence: 'LOW', risk: 'MEDIUM', sideEffect: 'MUTATING' })
    expect(a.allowed).toBe(false)
    expect(b.allowed).toBe(false)
    expect(b.code).toBe('invariant_e_low_confidence_side_effect')
    expect(a.code).not.toBe(b.code)
  })

  it('COUNTER-EXAMPLE: low-risk low-confidence READ_ONLY may continue -- restricted', () => {
    // "read-only low-confidence reasoning folytatódhat, ha más gate nem tiltja,
    //  de ne váljon bizonyítatlan completionné vagy external factual assertionné."
    const r = invariantE({ confidence: 'LOW', risk: 'LOW', sideEffect: 'READ_ONLY' })
    expect(r.allowed).toBe(true)
    expect(r.assertionRestricted).toBe(true)
  })

  it('COUNTER-EXAMPLE: high-risk + high-confidence passes THIS gate -- and only this one', () => {
    // "high-risk + high-confidence + minden más gate PASS -> csak akkor halad,
    //  ha az adott action policyja egyébként engedi."
    const r = invariantE({ confidence: 'HIGH', risk: 'HIGH', sideEffect: 'HIGH_RISK' })
    expect(r.allowed).toBe(true)
    expect(r.assertionRestricted).toBe(false)
  })

  it('a MEDIUM-confidence mutating action is not refused by the LOW rule', () => {
    // The control for the rule above: the second rule is about LOW, and a
    // rule that fired on MEDIUM too would make the first rule unobservable.
    const r = invariantE({ confidence: 'MEDIUM', risk: 'MEDIUM', sideEffect: 'MUTATING' })
    expect(r.allowed).toBe(true)
  })
})

// ── Confidence: HIGH is earned, not assumed ─────────────────────────────

describe('Invariant E — confidence must be PROVEN, not merely undoubted', () => {
  it('HEADLINE: a complete PASS proof set with no doubts is HIGH', () => {
    const r = assessConfidence(signals())
    expect(r.confidence).toBe('HIGH')
    expect(r.reasons).toEqual([])
  })

  it('HEADLINE: the SAME signals with an unchecked input are NOT high', () => {
    // The closure in one assertion. Nothing here is wrong -- no doubt flag
    // fired, no check failed. One question simply was not asked, and the old
    // model scored that identically to having asked it and got a good answer.
    const missingOne = proven().filter(f => f.input !== 'external_outcome_settled')
    const r = assessConfidence(signals({ requiredInputs: missingOne }))
    expect(r.confidence).not.toBe('HIGH')
    expect(r.reasons).toContain('unproven:external_outcome_settled:not-checked')
  })

  it('an EMPTY proof set is not certainty -- it is nothing proven', () => {
    const r = assessConfidence(signals({ requiredInputs: [] }))
    expect(r.confidence).toBe('MEDIUM')
    expect(r.reasons.length).toBe(REQUIRED_INPUTS.length)
  })

  it('EVERY required input, one at a time, blocks HIGH when it FAILS', () => {
    // The owner named six things that must reduce or block HIGH. Each maps to
    // one input; driving them one at a time is what proves none is decorative.
    for (const input of REQUIRED_INPUTS) {
      const r = assessConfidence(signals({ requiredInputs: proven({ [input]: 'FAIL' }) }))
      expect(r.confidence, `${input} must block HIGH`).not.toBe('HIGH')
      expect(r.reasons).toContain(`failed:${input}`)
    }
  })

  it('UNKNOWN caps like FAIL but does NOT spend a point -- they are different facts', () => {
    // Two unknowns and two failures land in different places. Collapsing them
    // would make "we could not check" and "we checked and it is bad" the same
    // sentence in the record, which is the confusion this whole packet is about.
    const twoUnknown = assessConfidence(signals({
      requiredInputs: proven({ canonical_state_fresh: 'UNKNOWN', evidence_non_conflicting: 'UNKNOWN' }),
    }))
    const twoFailed = assessConfidence(signals({
      requiredInputs: proven({ canonical_state_fresh: 'FAIL', evidence_non_conflicting: 'FAIL' }),
    }))
    expect(twoUnknown.confidence).toBe('MEDIUM')
    expect(twoFailed.confidence).toBe('LOW')
    expect(twoUnknown.reasons).toContain('unproven:canonical_state_fresh')
    expect(twoFailed.reasons).toContain('failed:canonical_state_fresh')
  })

  it('the named doubts still spend points on top of the proof set', () => {
    const r = assessConfidence(signals({ capabilityVerdict: 'WAIT_CAPABILITY' }))
    expect(r.confidence).toBe('LOW')
    expect(r.reasons).toContain('capability:MISSING')
  })

  it('all three levels are reachable -- a scale with an unreachable end is a boolean', () => {
    const reached = new Set(DECISION_LEVELS.map(() => '')); reached.clear()
    reached.add(assessConfidence(signals()).confidence)
    reached.add(assessConfidence(signals({ requiredInputs: [] })).confidence)
    reached.add(assessConfidence(signals({ capabilityVerdict: 'DENY_UNDECLARED' })).confidence)
    for (const l of DECISION_LEVELS) expect(reached.has(l)).toBe(true)
  })
})

// ── Risk: five classes ──────────────────────────────────────────────────

describe('Invariant E — risk coverage is the Phase 0 policy surface, not just money', () => {
  it('a READ_ONLY step in no risk class is LOW, or the gate would stop the engine', () => {
    expect(assessRisk(signals()).risk).toBe('LOW')
  })

  it('EVERY risk class, one at a time, reaches HIGH and says which class it was', () => {
    const cases: Array<[RiskClass, Partial<DecisionSignals>]> = [
      ['IRREVERSIBLE_EXTERNAL', { sideEffect: 'HIGH_RISK' }],
      ['FINANCIAL_CONTRACTUAL', { financialExposure: 250_000 }],
      ['FINANCIAL_CONTRACTUAL', { legalExposure: 'CONTRACT' }],
      ['CREDENTIAL_SECURITY', { sensitivity: 'CREDENTIAL' }],
      ['CREDENTIAL_SECURITY', { pendingActionTypes: ['CREDENTIAL_ROTATE'] }],
      ['DESTRUCTIVE', { pendingActionTypes: ['DATA_ERASE'] }],
      ['ACCESS_CONTROL', { pendingActionTypes: ['REVOKE_ACCESS'] }],
    ]
    for (const [cls, over] of cases) {
      const r = assessRisk(signals(over))
      expect(r.risk, JSON.stringify(over)).toBe('HIGH')
      expect(r.riskClasses, JSON.stringify(over)).toContain(cls)
    }
  })

  it('MUTATING alone is MEDIUM -- a floor, not a class', () => {
    const r = assessRisk(signals({ sideEffect: 'MUTATING' }))
    expect(r.risk).toBe('MEDIUM')
    expect(r.riskClasses).toEqual([])
  })

  it('a null exposure is "this namespace does not record it", not "there is none"', () => {
    expect(assessRisk(signals({ financialExposure: null })).reasons)
      .not.toContain('financial-exposure:null')
    expect(assessRisk(signals({ financialExposure: 0 })).risk).toBe('LOW')
  })

  it('the financial class IS §24\'s two lists -- not a second spelling of them', () => {
    // Two vocabularies for one policy is how the ladder and the assertions
    // drifted apart before. This asserts there is only one.
    for (const t of [...PAYMENT_ACTION_TYPES, ...LEGAL_ACTION_TYPES]) {
      expect(riskClassOfActionType(t)).toBe('FINANCIAL_CONTRACTUAL')
    }
    expect(RISK_CLASS_ACTION_TYPES.FINANCIAL_CONTRACTUAL.length)
      .toBe(PAYMENT_ACTION_TYPES.length + LEGAL_ACTION_TYPES.length)
  })

  it('the ladder\'s own never-autonomous kinds are classified, not unknown to us', () => {
    // SHARE_BEYOND_APPROVED is an ActionKind the ladder refuses by name. If the
    // risk table did not know it, the two gates would disagree about what the
    // riskiest thing in the system is.
    const kinds: ActionKind[] = ['PAYMENT', 'SHARE_BEYOND_APPROVED']
    expect(riskClassOfActionType(kinds[0])).toBe('FINANCIAL_CONTRACTUAL')
    expect(riskClassOfActionType(kinds[1])).toBe('ACCESS_CONTROL')
  })

  it('an ordinary send is in no class by action type -- its risk comes from the step kind', () => {
    // The honest state: the executor only ever writes EMAIL_SEND today, so the
    // action-type table matches nothing in production. It is READY, not
    // exercised, and this test says so rather than letting a green suite imply
    // coverage that does not exist yet.
    expect(riskClassOfActionType('EMAIL_SEND')).toBe(null)
    expect(assessRisk(signals({ sideEffect: 'HIGH_RISK', pendingActionTypes: ['EMAIL_SEND'] })).risk)
      .toBe('HIGH')
  })
})

// ── The proof set, gathered from a real store ───────────────────────────

describe('Invariant E — the proof set comes from the store, and cannot fail open', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('every required input is answered, even when nothing about the case exists', () => {
    const facts = gatherRequiredInputs(getDb(), 'personal', 'ghost',
      { verdict: 'PROCEED', degradations: 0 }, NOW)
    expect(facts.map(f => f.input).sort()).toEqual([...REQUIRED_INPUTS].sort())
  })

  it('a case nobody has read is UNKNOWN-fresh, which is not PASS', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    const facts = gatherRequiredInputs(db, 'personal', 'c1',
      { verdict: 'PROCEED', degradations: 0 }, NOW)
    const fresh = facts.find(f => f.input === 'canonical_state_fresh')
    expect(fresh?.status).toBe('UNKNOWN')
    expect(assessConfidence(signals({ requiredInputs: facts })).confidence).not.toBe('HIGH')
  })

  it('an unsettled outbound action FAILS the settled check', () => {
    const db = getDb()
    createCase(db, { caseId: 'c2', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c2', NOW - 100)
    db.prepare(
      `INSERT INTO outbound_ledger
         (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
          status, payload, created_at, updated_at)
       VALUES ('L1','c2','EMAIL_SEND',1,'k1','APPLIED_UNVERIFIED','{}',?,?)`,
    ).run(NOW - 50, NOW - 50)
    const facts = gatherRequiredInputs(db, 'personal', 'c2',
      { verdict: 'PROCEED', degradations: 0 }, NOW)
    expect(facts.find(f => f.input === 'external_outcome_settled')?.status).toBe('FAIL')
  })

  it('a degraded capability FAILS the capability check even when the verdict PROCEEDs', () => {
    const facts = gatherRequiredInputs(getDb(), 'personal', 'c3',
      { verdict: 'PROCEED', degradations: 2 }, NOW)
    expect(facts.find(f => f.input === 'required_capabilities_known')?.status).toBe('FAIL')
  })
})

// ── The pipeline: the verdict has to be DURABLE ─────────────────────────

describe('Invariant E — the refusal reaches the durable record', () => {
  beforeEach(() => { initDatabase(':memory:') })

  /** Drive a case to an EXECUTE next-best-action: run once so the plan settles,
   *  then step the cursor past the VERIFY step. A first run rebuilds the plan
   *  and resets the cursor, so the second run is the one that matters. */
  function driveToExecute(caseId: string): void {
    const db = getDb()
    createCase(db, { caseId, title: 'T', caseType: 'X' }, NOW - 100)
    db.prepare(`UPDATE personal_cases SET status='READY' WHERE case_id=?`).run(caseId)
    seedCaseProgressionState(db, 'personal', caseId, NOW - 100)
    runProgressionCycle(db, 'personal', caseId, NOW, { triggerType: 'MANUAL', triggerReference: 't0' })
    db.prepare(
      `UPDATE case_progression_state SET completed_plan_step = 1
        WHERE domain='personal' AND case_id=?`,
    ).run(caseId)
    runProgressionCycle(db, 'personal', caseId, NOW + 60, { triggerType: 'MANUAL', triggerReference: 't1' })
  }

  /** A case parked on an owner decision, with its DoD pre-seeded so the
   *  auto-satisfy path does not interfere -- the same seed the owner-answer
   *  suite uses, so the two files exercise one shape and not two. */
  function seedAwaitingSelection(caseId: string): void {
    const db = getDb()
    createCase(db, {
      caseId, title: caseId, caseType: 'SELECTION', status: 'AWAITING_SELECTION',
      sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
    }, NOW - 100)
    db.prepare(
      `INSERT INTO case_progression_state
        (domain, case_id, progression_enabled, progression_mode, goal, summary,
         next_progression_at, dod_verification_json, created_at, updated_at)
       VALUES ('personal', ?, 1, 'internal', 'Test goal', 'Test summary', ?, ?, ?, ?)`,
    ).run(caseId, NOW - 100, JSON.stringify({
      criteria: [{ label: '_seed_guard', met: true, met_at: NOW - 100, met_by_run: '_seed' }],
      all_met: true, evaluated_at: NOW - 100,
    }), NOW - 100, NOW - 100)
  }

  /** Istvan presses YES in Mission Control. */
  function recordOwnerAnswer(caseId: string, at: number): void {
    const askedRunId = (getDb().prepare(
      `SELECT progression_run_id AS id FROM case_progression_runs
        WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(caseId) as { id: string }).id
    appendCaseEvent(getDb(), {
      caseId, caseVersion: 1, actor: 'istvan', eventType: 'OWNER_DECISION',
      payload: { choice: 'YES' }, sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, at)
  }

  const lastRun = (caseId: string): { decision: string; reason: string; sa: string; status: string } =>
    getDb().prepare(
      `SELECT decision, reason, safety_assertions_json AS sa, status
         FROM case_progression_runs WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(caseId) as { decision: string; reason: string; sa: string; status: string }

  it('HEADLINE: a refused run SAYS SO in case_progression_runs, not only in its return value', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Measured before the fix: the returned
    // object said MANUAL_ACTION_REQUIRED with an INVARIANT_E_REFUSAL violation,
    // and the durable row said CONTINUE_AUTONOMOUSLY with no violation at all --
    // while the production caller discards the return value entirely. The gate
    // fired into a variable that nothing read.
    driveToExecute('r1')
    const row = lastRun('r1')
    expect(row.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(row.reason).toMatch(/Invariáns E/)
    expect(row.sa).toMatch(/INVARIANT_E_REFUSAL/)
  })

  it('the refusal names confidence and risk, so the log says WHICH gate stopped it', () => {
    driveToExecute('r2')
    const sa = JSON.parse(lastRun('r2').sa) as Array<{ assertion: string; detail?: string }>
    const e = sa.find(a => a.assertion === 'INVARIANT_E_REFUSAL')
    expect(e?.detail).toMatch(/invariant_e_/)
    expect(e?.detail).toMatch(/confidence=/)
    expect(e?.detail).toMatch(/risk=/)
  })

  it('a refusal is not a FAILED run -- correct behaviour must not raise an alarm', () => {
    driveToExecute('r3')
    expect(lastRun('r3').status).toBe('COMPLETED')
  })

  it('COUNTER-EXAMPLE: confidence and risk are stored on an ordinary PROCEED too, and read back', () => {
    // "decision confidence/risk normál PROCEED esetben is tartósan bekerül a
    //  DB-be, és readbackkel bizonyított." A field written only on refusals
    //  would be a refusal log wearing a judgement's name.
    const db = getDb()
    createCase(db, { caseId: 'ok1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'ok1', NOW - 100)
    runProgressionCycle(db, 'personal', 'ok1', NOW, { triggerType: 'MANUAL', triggerReference: 't' })
    const run = lastRun('ok1')
    expect(run.decision).not.toBe('MANUAL_ACTION_REQUIRED')
    const row = db.prepare(
      `SELECT decision_confidence AS c, decision_risk AS r, decision_assessment_json AS j
         FROM case_progression_state WHERE domain='personal' AND case_id='ok1'`,
    ).get() as { c: string; r: string; j: string }
    expect(DECISION_LEVELS).toContain(row.c)
    expect(DECISION_LEVELS).toContain(row.r)
    const parsed = JSON.parse(row.j) as Record<string, unknown>
    expect(parsed).toHaveProperty('reasons')
    expect(parsed).toHaveProperty('signals')
    expect(parsed).toHaveProperty('gate')
    expect(parsed).toHaveProperty('riskClasses')
  })

  it('a step the owner just authorised is NOT refused -- and the record says so', () => {
    // Found by the suite, not by my reasoning: widening the gate made six tests
    // red, all of them "engine asks -> Istvan answers -> engine refuses because
    // a person must decide". The person had just decided. An action running on
    // an answer consumed by this run is not autonomous, so the gate does not
    // apply to it -- and the fact that it did not is written down.
    const db = getDb()
    seedAwaitingSelection('oa1')
    runProgressionCycle(db, 'personal', 'oa1', NOW, { triggerType: 'MANUAL', triggerReference: 't0' })
    runProgressionCycle(db, 'personal', 'oa1', NOW + 10, { triggerType: 'MANUAL', triggerReference: 't1' })
    const asked = lastRun('oa1')
    expect(asked.decision).toBe('REQUEST_DECISION')

    recordOwnerAnswer('oa1', NOW + 30)
    runProgressionCycle(db, 'personal', 'oa1', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
    const acted = lastRun('oa1')
    expect(acted.decision).not.toBe('MANUAL_ACTION_REQUIRED')
    expect(acted.sa).toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
  })

  it('and the exemption is SINGLE-USE -- the next run with no fresh answer is refused', () => {
    // The control for the test above. Without it, "the owner answered once" and
    // "the owner is answering every step" would be the same state, and one
    // answer would buy permanent autonomy on a case.
    const db = getDb()
    seedAwaitingSelection('oa2')
    runProgressionCycle(db, 'personal', 'oa2', NOW, { triggerType: 'MANUAL', triggerReference: 't0' })
    runProgressionCycle(db, 'personal', 'oa2', NOW + 10, { triggerType: 'MANUAL', triggerReference: 't1' })
    recordOwnerAnswer('oa2', NOW + 30)
    runProgressionCycle(db, 'personal', 'oa2', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
    // One more turn of the same case with NO new answer: the same EXECUTE-class
    // work, now genuinely autonomous.
    db.prepare(
      `UPDATE case_progression_state SET completed_plan_step = 2 WHERE domain='personal' AND case_id='oa2'`,
    ).run()
    runProgressionCycle(db, 'personal', 'oa2', NOW + 120, { triggerType: 'MANUAL', triggerReference: 't3' })
    const row = lastRun('oa2')
    expect(row.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(row.sa).toMatch(/INVARIANT_E_REFUSAL/)
  })

  it('fill rate matches the DECISION count, not the refusal count', () => {
    const db = getDb()
    for (const id of ['f1', 'f2', 'f3']) {
      createCase(db, { caseId: id, title: 'T', caseType: 'X' }, NOW - 100)
      seedCaseProgressionState(db, 'personal', id, NOW - 100)
      runProgressionCycle(db, 'personal', id, NOW, { triggerType: 'MANUAL', triggerReference: 't' })
    }
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
})

// ── A third gate, not a replacement ─────────────────────────────────────

describe('Invariant E — a THIRD gate, not a replacement', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('COUNTER-EXAMPLE: a high-confidence PAYMENT is still DENIED', () => {
    // "high-confidence PAYMENT -> továbbra is DENY." Confidence is not a permit.
    const db = getDb()
    expect(invariantE({ confidence: 'HIGH', risk: 'HIGH', sideEffect: 'HIGH_RISK' }).allowed).toBe(true)
    expect(permits(db, 'X', 'PAYMENT').allowed).toBe(false)
    expect(permits(db, 'X', 'SHARE_BEYOND_APPROVED').allowed).toBe(false)
  })

  it('Invariant E does not permit anything -- it can only refuse', () => {
    for (const c of DECISION_LEVELS) {
      for (const r of DECISION_LEVELS) {
        for (const se of ['READ_ONLY', 'MUTATING', 'HIGH_RISK'] as const) {
          const v = invariantE({ confidence: c, risk: r, sideEffect: se })
          if (v.allowed) expect(v.code).toBe('ok')
          else expect(v.code).not.toBe('ok')
        }
      }
    }
    expect(permits(getDb(), 'X', 'PAYMENT').allowed).toBe(false)
  })

  it('its refusal codes are its own -- no ladder code collides with them', () => {
    const db = getDb()
    // Read off the REAL ladder rather than a remembered list -- the acceptance
    // asks that a refusal be distinguishable in the log, and a hard-coded set of
    // "the codes I think it has" would keep passing after the ladder renamed one.
    const ladderCodes = new Set<string>(
      (['OBSERVE', 'DRAFT', 'SEND', 'PAYMENT', 'SHARE_BEYOND_APPROVED'] as ActionKind[])
        .map(k => String(permits(db, 'X', k).code)),
    )
    const eCodes = ['invariant_e_high_risk_unproven_confidence', 'invariant_e_low_confidence_side_effect']
    for (const c of eCodes) expect(ladderCodes.has(c)).toBe(false)
    expect(ladderCodes.size).toBeGreaterThan(1)
  })

  it('a full assessment refuses end to end, with both numbers on it', () => {
    const a = assessDecision(signals({ sideEffect: 'HIGH_RISK', requiredInputs: [] }))
    expect(a.risk).toBe('HIGH')
    expect(a.confidence).toBe('MEDIUM')
    expect(a.riskClasses).toContain('IRREVERSIBLE_EXTERNAL')
    expect(invariantE({ ...a, sideEffect: 'HIGH_RISK' }).allowed).toBe(false)
  })
})
