// P4 closure — a human answer is three different things, and only one of them
// authorises an action.
//
// Owner's correction, 2026-08-27:
//
//   "A human answer önmagában NEM teszi az utána következő high-risk actiont
//    non-autonomous / exempt állapotúvá."
//
// My version exempted a step whenever the run consumed ANY owner answer. This
// file is his separation, and every one of his six mandatory counter-examples is
// a test below, by name.
//
// NO PARALLEL APPROVAL SYSTEM -- his instruction, and there was no need for one:
// `action_authorizations` (§22.2) already carries the action, the target, the
// payload hash, the case, single-use consumption, an expiry and a revocation
// column. The approval is looked up and CONSUMED, not asserted.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import {
  classifyHumanAnswer, approvalReferenceOf, resolveHumanAnswer,
  progressionActionIdentity, progressionPayloadHash, APPROVAL_CANNOT_WAIVE,
  type ApprovalCheckContext,
} from '../cos/human-answer-class.js'
import { policyEvaluationHash, type AuthorizationContext } from '../cos/action-authorization.js'
import { invariantE } from '../cos/decision-confidence.js'

const NOW = 1_700_000_000
const CASE = 'ha1'
const STEP = 3
const DESC = 'Act on the received decision'

// ── The classifier ──────────────────────────────────────────────────────

describe('what the owner said is three different things', () => {
  it('COUNTER-EXAMPLE: "Igen, a cím 12/B." is INFORMATION, not approval', () => {
    expect(classifyHumanAnswer({
      eventType: 'OWNER_INFORMATION', choice: null, intent: 'INFORM', payload: null,
    })).toBe('HUMAN_INFORMATION')
  })

  it('COUNTER-EXAMPLE: "Az A opciót választom." is a DECISION, not approval', () => {
    expect(classifyHumanAnswer({
      eventType: 'OWNER_DECISION', choice: 'YES', intent: 'PROCEED', payload: null,
    })).toBe('HUMAN_DECISION')
  })

  it('the INTENT decides, not the event label -- a labelled INFORMATION with a real choice is a decision', () => {
    // The engine's standing rule is that the choice decides when there is one.
    // This is also the test the mutation harness demanded: without it, the
    // eventType branch and the intent branch covered the same cases and deleting
    // either changed nothing observable.
    expect(classifyHumanAnswer({
      eventType: 'OWNER_INFORMATION', choice: 'YES', intent: 'PROCEED', payload: null,
    })).toBe('HUMAN_DECISION')
    expect(classifyHumanAnswer({
      eventType: 'OWNER_DECISION', choice: null, intent: 'INFORM', payload: null,
    })).toBe('HUMAN_INFORMATION')
  })

  it('a choice the engine has no meaning for is not a decision either', () => {
    // UNMAPPED exists to deny a value weight. Calling it a decision would give it
    // exactly the weight the name refuses.
    expect(classifyHumanAnswer({
      eventType: 'OWNER_DECISION', choice: 'WHATEVER', intent: 'UNMAPPED', payload: null,
    })).toBe('HUMAN_INFORMATION')
  })

  it('the classifier NEVER returns an approval -- a claim is not a check', () => {
    const claim = JSON.stringify({ choice: 'YES', authorizationId: 'a'.repeat(64) })
    expect(classifyHumanAnswer({
      eventType: 'OWNER_DECISION', choice: 'YES', intent: 'PROCEED', payload: claim,
    })).toBe('HUMAN_DECISION')
    expect(approvalReferenceOf(claim)).toBe('a'.repeat(64))
  })

  it('an unreadable payload yields no approval reference', () => {
    expect(approvalReferenceOf('{not json')).toBe(null)
    expect(approvalReferenceOf(null)).toBe(null)
  })
})

// ── The scoped approval, against the real ticket store ──────────────────

describe('an action approval is a ticket that exists, binds and is spent', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const ctx = (over: Partial<ApprovalCheckContext> = {}): ApprovalCheckContext => ({
    domain: 'personal', caseId: CASE, caseVersion: 1, goalVersion: 0,
    planStep: STEP, description: DESC, actionType: 'EXECUTE', recipient: null,
    riskClasses: ['IRREVERSIBLE_EXTERNAL'], ...over,
  })

  const answer = (authorizationId?: string) => ({
    eventType: 'OWNER_DECISION', choice: 'YES', intent: 'PROCEED',
    payload: JSON.stringify(authorizationId ? { choice: 'YES', authorizationId } : { choice: 'YES' }),
  })

  /** Issue a ticket the way the gate would, bound to this progression step.
   *  Written directly because `issueAuthorization` requires a gate permit the
   *  progression path has no business minting -- and the point of this test is
   *  the CONSUMPTION rules, which are the same either way. */
  let ticketSeq = 0
  function issueTicket(over: Partial<AuthorizationContext> = {}, opts: { expiresAt?: number } = {}): string {
    // Unique per call: a fixed id turns the loop below into one ticket reused
    // four times, which is a different test than the one it claims to be.
    const id = (String(++ticketSeq).padStart(4, '0')).repeat(16)
    const bound: AuthorizationContext = {
      domain: 'personal', caseId: CASE, caseVersion: 1, goalVersion: 0,
      actionId: progressionActionIdentity('personal', CASE, STEP),
      actionType: 'EXECUTE', intent: 'PROGRESSION_STEP',
      targetReference: CASE, recipient: null,
      payloadHash: progressionPayloadHash(DESC), approvalId: null, ...over,
    }
    getDb().prepare(
      `INSERT INTO action_authorizations
         (authorization_id, domain, case_id, case_version, goal_version, action_id,
          action_type, intent, target_reference, recipient, payload_hash,
          policy_evaluation_hash, approval_id, delegation_envelope_id,
          issued_at, expires_at, single_use, nonce)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,1,'n')`,
    ).run(id, bound.domain, bound.caseId, bound.caseVersion, bound.goalVersion,
      bound.actionId, bound.actionType, bound.intent, bound.targetReference,
      bound.recipient, bound.payloadHash, policyEvaluationHash(bound),
      NOW - 10, opts.expiresAt ?? NOW + 600)
    return id
  }

  it('COUNTER-EXAMPLE: an exact approval matching the action executes ONCE', () => {
    const id = issueTicket()
    const v = resolveHumanAnswer(getDb(), answer(id), ctx(), NOW)
    expect(v.answerClass).toBe('HUMAN_ACTION_APPROVAL')
    expect(v.executionExemption).toBe(true)
    expect(v.authorizationId).toBe(id)
  })

  it('COUNTER-EXAMPLE: the SAME approval a second time is DENIED', () => {
    const id = issueTicket()
    expect(resolveHumanAnswer(getDb(), answer(id), ctx(), NOW).executionExemption).toBe(true)
    const second = resolveHumanAnswer(getDb(), answer(id), ctx(), NOW)
    expect(second.executionExemption).toBe(false)
    expect(second.answerClass).toBe('HUMAN_DECISION')
    expect(second.reason).toMatch(/consumed/)
  })

  it('COUNTER-EXAMPLE: the approval is invalid when the PAYLOAD changes', () => {
    const id = issueTicket()
    const v = resolveHumanAnswer(getDb(), answer(id), ctx({ description: 'Send a different letter' }), NOW)
    expect(v.executionExemption).toBe(false)
    expect(v.reason).toMatch(/hash mismatch|changed after authorization/)
  })

  it('COUNTER-EXAMPLE: the approval is invalid when the TARGET changes', () => {
    const id = issueTicket()
    const v = resolveHumanAnswer(getDb(), answer(id), ctx({ recipient: 'someone@else.hu' }), NOW)
    expect(v.executionExemption).toBe(false)
  })

  it('an approval for a DIFFERENT step of the same case does not carry over', () => {
    const id = issueTicket({ actionId: progressionActionIdentity('personal', CASE, 2) })
    expect(resolveHumanAnswer(getDb(), answer(id), ctx(), NOW).executionExemption).toBe(false)
  })

  it('an expired approval authorises nothing', () => {
    const id = issueTicket({}, { expiresAt: NOW - 1 })
    const v = resolveHumanAnswer(getDb(), answer(id), ctx(), NOW)
    expect(v.executionExemption).toBe(false)
    expect(v.reason).toMatch(/expired/)
  })

  it('a fabricated ticket id is simply absent -- that is the point of 32 random bytes', () => {
    const v = resolveHumanAnswer(getDb(), answer('0'.repeat(64)), ctx(), NOW)
    expect(v.executionExemption).toBe(false)
    expect(v.reason).toMatch(/unknown authorization/)
  })

  it('a DECISION with no ticket is a decision, and says so', () => {
    const v = resolveHumanAnswer(getDb(), answer(), ctx(), NOW)
    expect(v.answerClass).toBe('HUMAN_DECISION')
    expect(v.executionExemption).toBe(false)
    expect(v.reason).toMatch(/bizalomba/)
  })

  it('an INFORMATION answer carrying a valid ticket is STILL not an approval', () => {
    // "Igen, a cím 12/B" does not become permission because a field was attached.
    const id = issueTicket()
    const v = resolveHumanAnswer(getDb(), {
      eventType: 'OWNER_INFORMATION', choice: null, intent: 'INFORM',
      payload: JSON.stringify({ authorizationId: id }),
    }, ctx(), NOW)
    expect(v.answerClass).toBe('HUMAN_INFORMATION')
    expect(v.executionExemption).toBe(false)
  })

  it('the STRICTER rules cannot be waived by an approval -- each class, one at a time', () => {
    // "A meglévő strictebb PAYMENT / legal / contractual / SHARE_BEYOND_APPROVED
    //  szabályokat ez se írhatja felül."
    for (const cls of APPROVAL_CANNOT_WAIVE) {
      const id = issueTicket()
      const v = resolveHumanAnswer(getDb(), answer(id), ctx({ riskClasses: [cls] }), NOW)
      expect(v.executionExemption, cls).toBe(false)
      expect(v.reason, cls).toMatch(new RegExp(cls))
    }
  })

  it('and the ticket is NOT spent by a refusal it never reached', () => {
    // The control for the test above: a blocked class must refuse BEFORE
    // consumption, or a payment attempt would silently burn the owner's approval
    // and the next legitimate use would find it gone.
    const id = issueTicket()
    resolveHumanAnswer(getDb(), answer(id), ctx({ riskClasses: ['FINANCIAL_CONTRACTUAL'] }), NOW)
    expect(resolveHumanAnswer(getDb(), answer(id), ctx(), NOW).executionExemption).toBe(true)
  })
})

// ── End to end, through the pipeline ────────────────────────────────────

describe('through the pipeline: an answer does not open the gate', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function seedAwaitingSelection(caseId: string): void {
    const db = getDb()
    createCase(db, {
      caseId, title: caseId, caseType: 'SELECTION', status: 'AWAITING_SELECTION',
      sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
    }, NOW - 100)
    // A QUEUED SEND, so the EXECUTE step this suite walks to is an action that
    // genuinely reaches outside. Without it the step is INTERNAL under the
    // 2026-08-28 classifier and Invariant E has nothing to refuse -- which
    // would leave these counter-examples asserting that an answer does not open
    // a gate that was never shut. The counter-examples only mean something
    // against a real high-risk action.
    db.prepare(
      `INSERT INTO outbound_ledger
         (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
          status, created_at, updated_at)
       VALUES (?, ?, 'EMAIL_SEND', 1, ?, 'PLANNED', ?, ?)`,
    ).run(`led-${caseId}`, caseId, `idem-${caseId}`, NOW - 100, NOW - 100)
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

  function answerWith(caseId: string, payload: Record<string, unknown>, at: number, type = 'OWNER_DECISION'): void {
    const askedRunId = (getDb().prepare(
      `SELECT progression_run_id AS id FROM case_progression_runs
        WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(caseId) as { id: string }).id
    appendCaseEvent(getDb(), {
      caseId, caseVersion: 1, actor: 'istvan', eventType: type,
      payload, sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, at)
  }

  const lastRun = (caseId: string): { decision: string; sa: string } =>
    getDb().prepare(
      `SELECT decision, safety_assertions_json AS sa FROM case_progression_runs
        WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(caseId) as { decision: string; sa: string }

  function driveToAnsweredExecute(caseId: string, payload: Record<string, unknown>, type?: string): void {
    const db = getDb()
    seedAwaitingSelection(caseId)
    runProgressionCycle(db, 'personal', caseId, NOW, { triggerType: 'MANUAL', triggerReference: 't0' })
    runProgressionCycle(db, 'personal', caseId, NOW + 10, { triggerType: 'MANUAL', triggerReference: 't1' })
    answerWith(caseId, payload, NOW + 30, type)
    runProgressionCycle(db, 'personal', caseId, NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
  }

  it('COUNTER-EXAMPLE: human INFORMATION + high-risk EXECUTE -> Invariant E still applies', () => {
    driveToAnsweredExecute('p-info', { note: 'a cím 12/B' }, 'OWNER_INFORMATION')
    const row = lastRun('p-info')
    expect(row.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(row.sa).toMatch(/INVARIANT_E_REFUSAL/)
    expect(row.sa).toMatch(/HUMAN_ANSWER_NOT_APPROVAL/)
    expect(row.sa).toMatch(/HUMAN_INFORMATION/)
  })

  it('COUNTER-EXAMPLE: human DECISION on a different external action stays gated', () => {
    driveToAnsweredExecute('p-dec', { choice: 'YES' })
    const row = lastRun('p-dec')
    expect(row.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(row.sa).toMatch(/HUMAN_DECISION/)
    expect(row.sa).toMatch(/INVARIANT_E_REFUSAL/)
  })

  it('COUNTER-EXAMPLE: the run AFTER an answer, with no approval, is ordinary Invariant E', () => {
    driveToAnsweredExecute('p-next', { choice: 'YES' })
    getDb().prepare(
      `UPDATE case_progression_state SET completed_plan_step = 2 WHERE domain='personal' AND case_id='p-next'`,
    ).run()
    runProgressionCycle(getDb(), 'personal', 'p-next', NOW + 120, { triggerType: 'MANUAL', triggerReference: 't3' })
    const row = lastRun('p-next')
    expect(row.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(row.sa).toMatch(/INVARIANT_E_REFUSAL/)
    // No answer was consumed by this run, so no class is recorded on it at all.
    expect(row.sa).not.toMatch(/HUMAN_ANSWER_NOT_APPROVAL/)
  })

  it('the class is recorded on every answered run, exempt or not', () => {
    driveToAnsweredExecute('p-rec', { choice: 'YES' })
    const sa = JSON.parse(lastRun('p-rec').sa) as Array<{ assertion: string; detail?: string }>
    const cls = sa.find(a => a.assertion === 'HUMAN_ANSWER_NOT_APPROVAL')
    expect(cls?.detail).toMatch(/HUMAN_DECISION/)
    expect(cls?.detail).toMatch(/confidence=/)
  })
})

// ── The contradiction blocker ───────────────────────────────────────────

describe('unresolved contradictory evidence blocks execution, not reasoning', () => {
  const conflict = [{ input: 'evidence_non_conflicting' as const, status: 'FAIL' as const, detail: 'reader vs policy' }]

  it('a MUTATING action is refused while the contradiction stands', () => {
    const r = invariantE({
      confidence: 'HIGH', risk: 'MEDIUM', sideEffect: 'MUTATING', requiredInputs: conflict,
    })
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('invariant_e_unresolved_contradiction')
  })

  it('a HIGH_RISK action is refused even at HIGH confidence and the code says WHY', () => {
    // The distinguishing test: at HIGH/HIGH the confidence rule would have
    // allowed it, so a pass here would mean the contradiction rule never ran.
    const r = invariantE({
      confidence: 'HIGH', risk: 'HIGH', sideEffect: 'HIGH_RISK', requiredInputs: conflict,
    })
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('invariant_e_unresolved_contradiction')
  })

  it('READ_ONLY reasoning continues -- the owner\'s explicit carve-out', () => {
    const r = invariantE({
      confidence: 'MEDIUM', risk: 'LOW', sideEffect: 'READ_ONLY', requiredInputs: conflict,
    })
    expect(r.allowed).toBe(true)
  })

  it('a RESOLVED contradiction does not block -- the control', () => {
    const r = invariantE({
      confidence: 'HIGH', risk: 'HIGH', sideEffect: 'HIGH_RISK',
      requiredInputs: [{ input: 'evidence_non_conflicting', status: 'PASS', detail: 'ok' }],
    })
    expect(r.allowed).toBe(true)
  })
})
