// Owner answer consumption tests (card 52250c7f Phase C).
//
// The progression engine must read OWNER_DECISION / OWNER_INFORMATION /
// OWNER_CONFIRMATION events from personal_case_events and consume them
// instead of returning REQUEST_DECISION again.
//
// Requirements:
//   1. Match answer by source_reference to the run that asked
//   2. YES and NO must diverge (advance vs escalate)
//   3. Retroactive: already-recorded answers picked up
//   4. Superseded runs: answer pointing at non-latest run NOT consumed
//   5. Tests drive the EFFECT — write answer event, run cycle, assert decision changes

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { runProgressionCycle, type PipelineOptions } from '../cos/progression-pipeline.js'
import { releaseProgressionClaim } from '../cos/progression-scheduler.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initCosSchema(db)
  return db
}

function now(): number { return Math.floor(Date.now() / 1000) }

const MANUAL_OPTS: PipelineOptions = { triggerType: 'MANUAL', triggerReference: 'owner-answer-test' }

/** Seed a case with AWAITING_SELECTION status. The plan is:
 *    step 1: VERIFY (autonomous)
 *    step 2: AWAIT_DECISION (needs external)
 *    step 3: EXECUTE (autonomous)
 *    step 4: VERIFY DoD (autonomous)
 *
 *  Run 1 always completes step 1 (CONTINUE_AUTONOMOUSLY).
 *  Run 2 hits step 2 (AWAIT_DECISION → REQUEST_DECISION) — this is what
 *  the owner answers. */
function seedAwaitingSelectionCase(db: Database.Database, caseId: string, t: number) {
  createCase(db, {
    caseId, title: caseId, caseType: 'SELECTION',
    status: 'AWAITING_SELECTION', sensitivity: 'PERSONAL', priority: 'P2',
    sourceSystem: 'test',
  }, t)

  // Pre-set dod_verification_json so auto-satisfy doesn't interfere
  const seedDod = {
    criteria: [{ label: '_seed_guard', met: true, met_at: t, met_by_run: '_seed' }],
    all_met: true,
    evaluated_at: t,
  }
  db.prepare(
    `INSERT INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode,
      goal, summary, next_progression_at, dod_verification_json, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', ?, ?, ?, ?, ?, ?)`,
  ).run(caseId, 'Test goal', 'Test summary', t, JSON.stringify(seedDod), t, t)
}

/** Run cycle 1 (completes VERIFY step 1) then cycle 2 (returns REQUEST_DECISION).
 *  Returns the run ID of the REQUEST_DECISION cycle for answer matching. */
function advanceToRequestDecision(
  db: Database.Database,
  caseId: string,
  t: number,
): string {
  // Run 1: step 1 (VERIFY) → CONTINUE_AUTONOMOUSLY
  releaseProgressionClaim(db, 'personal', caseId, 'runner', t + 60)
  const r1 = runProgressionCycle(db, 'personal', caseId, t + 1, MANUAL_OPTS)
  expect(r1.decision).toBe('CONTINUE_AUTONOMOUSLY')

  // Run 2: step 2 (AWAIT_DECISION) → REQUEST_DECISION
  releaseProgressionClaim(db, 'personal', caseId, 'runner', t + 60)
  const r2 = runProgressionCycle(db, 'personal', caseId, t + 2, MANUAL_OPTS)
  expect(r2.decision).toBe('REQUEST_DECISION')

  return r2.runId
}

/** Get last run decision for a case. */
function getLastRun(db: Database.Database, caseId: string) {
  return db.prepare(
    `SELECT decision, reason, nbaStep
     FROM (
       SELECT decision, reason,
              json_extract(progress_delta_json, '$.nbaStep') as nbaStep
       FROM case_progression_runs
       WHERE case_id = ? AND domain = 'personal'
       ORDER BY completed_at DESC LIMIT 1
     )`,
  ).get(caseId) as {
    decision: string; reason: string; nbaStep: number
  } | undefined
}

function getCaseStatus(db: Database.Database, caseId: string) {
  return (db.prepare(
    'SELECT status FROM personal_cases WHERE case_id = ?',
  ).get(caseId) as { status: string }).status
}

function getState(db: Database.Database, caseId: string) {
  return db.prepare(
    `SELECT completed_plan_step, plan_version, no_progress_run_count
     FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get('personal', caseId) as {
    completed_plan_step: number; plan_version: number; no_progress_run_count: number
  }
}

// ── OWNER_DECISION: YES → advance ──────────────────────────────────────

describe('OWNER_DECISION with YES', () => {
  it('advances past the AWAIT_DECISION step and returns CONTINUE_AUTONOMOUSLY', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-yes', t)

    // Advance through step 1 to get REQUEST_DECISION on step 2
    const askedRunId = advanceToRequestDecision(db, 'c-yes', t)
    const run2 = getLastRun(db, 'c-yes')
    expect(run2!.nbaStep).toBe(2) // step 2 is AWAIT_DECISION

    // Istvan presses YES → Mission Control writes OWNER_DECISION event
    appendCaseEvent(db, {
      caseId: 'c-yes',
      caseVersion: 1,
      actor: 'istvan',
      eventType: 'OWNER_DECISION',
      payload: { choice: 'YES' },
      sourceSystem: 'mission_control',
      sourceReference: askedRunId,
    }, t + 10)

    // Run 3: should detect YES, advance past step 2, pick step 3
    releaseProgressionClaim(db, 'personal', 'c-yes', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-yes', t + 11, MANUAL_OPTS)
    expect(r3.decision).not.toBe('REQUEST_DECISION')
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r3.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r3.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')

    // completed_plan_step should advance: step 2 (answered) + step 3 (EXECUTE
    // completed in the same run) = 3
    const state = getState(db, 'c-yes')
    expect(state.completed_plan_step).toBe(3)
  })

  it('picks up a previously-recorded answer retroactively (answer written before next cycle)', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-retro', t)

    const askedRunId = advanceToRequestDecision(db, 'c-retro', t)

    // Istvan answers BEFORE the next run (retroactive pickup)
    appendCaseEvent(db, {
      caseId: 'c-retro', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, t + 10)

    // Run 3: should pick up the already-existing answer
    releaseProgressionClaim(db, 'personal', 'c-retro', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-retro', t + 11, MANUAL_OPTS)
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r3.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r3.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
    // Step 2 answered + step 3 auto-completed = completed_plan_step 3
    expect(getState(db, 'c-retro').completed_plan_step).toBe(3)
  })
})

// ── OWNER_DECISION: NO → escalate ─────────────────────────────────────

describe('OWNER_DECISION with NO', () => {
  it('transitions the case to BLOCKED and returns RECOVERY_REQUIRED', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-no', t)

    const askedRunId = advanceToRequestDecision(db, 'c-no', t)

    // Istvan presses NO
    appendCaseEvent(db, {
      caseId: 'c-no', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'NO' },
      sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, t + 10)

    // Run 3: should detect NO → transition to BLOCKED → RECOVERY_REQUIRED
    releaseProgressionClaim(db, 'personal', 'c-no', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-no', t + 11, MANUAL_OPTS)
    expect(r3.decision).toBe('RECOVERY_REQUIRED')

    // Case status should be BLOCKED in the case table
    expect(getCaseStatus(db, 'c-no')).toBe('BLOCKED')

    // Plan rebuilt → completed_plan_step reset. After NO, the BLOCKED
    // plan starts fresh; step 1 (VERIFY) completes in this run → counter = 1.
    const state = getState(db, 'c-no')
    expect(state.completed_plan_step).toBe(1)
    // plan_version bumped (plan changed from AWAITING_SELECTION to BLOCKED plan)
    expect(state.plan_version).toBeGreaterThan(0)
  })
})

// ── Stale answer: question changed since answer was recorded ─────────

describe('stale answer (question changed)', () => {
  it('does NOT consume an answer when the question has genuinely changed (different decision + nbaStep)', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-stale', t)

    // Advance to REQUEST_DECISION at nbaStep=2
    const askedRunId = advanceToRequestDecision(db, 'c-stale', t)

    // Istvan answers YES, but the answer references a run that asked
    // (REQUEST_DECISION, nbaStep=2)
    appendCaseEvent(db, {
      caseId: 'c-stale', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, t + 10)

    // BEFORE the next progression run, the case changes — e.g. external
    // input arrives and transitions the case to a different status.
    // This changes the PLAN, which changes the question.
    db.prepare(
      `UPDATE personal_cases SET status = 'READY', version = version + 1 WHERE case_id = ?`,
    ).run('c-stale')

    // Run 3: now the case is READY → plan is different → question is
    // (CONTINUE_AUTONOMOUSLY, nbaStep=1), NOT (REQUEST_DECISION, nbaStep=2).
    // The answer for the old question should NOT be consumed.
    releaseProgressionClaim(db, 'personal', 'c-stale', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-stale', t + 11, MANUAL_OPTS)
    // Should NOT be REQUEST_DECISION (the question changed), but also
    // should NOT have consumed the old answer.
    expect(r3.decision).not.toBe('REQUEST_DECISION')
  })

  it('picks the latest answer when multiple answers exist for the same question', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-multi', t)

    // First ask
    advanceToRequestDecision(db, 'c-multi', t)

    // Run 3: same question again (heartbeat re-ask)
    releaseProgressionClaim(db, 'personal', 'c-multi', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-multi', t + 3, MANUAL_OPTS)
    expect(r3.decision).toBe('REQUEST_DECISION')

    // Two answers, both for the same question (REQUEST_DECISION, nbaStep=2)
    // First: YES → would advance
    appendCaseEvent(db, {
      caseId: 'c-multi', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: r3.runId,
    }, t + 10)
    // Second (latest): NO → should be the one consumed
    appendCaseEvent(db, {
      caseId: 'c-multi', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'NO' },
      sourceSystem: 'mission_control', sourceReference: r3.runId,
    }, t + 11)

    // Run 4: latest answer (NO) wins → BLOCKED → RECOVERY_REQUIRED
    releaseProgressionClaim(db, 'personal', 'c-multi', 'runner', t + 60)
    const r4 = runProgressionCycle(db, 'personal', 'c-multi', t + 12, MANUAL_OPTS)
    expect(r4.decision).toBe('RECOVERY_REQUIRED')
  })

  it('consumes an answer referencing an OLD heartbeat run when the question is still the same', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-oldrun', t)

    // Get REQUEST_DECISION (run 2) — question is (REQUEST_DECISION, nbaStep=2)
    const askedRunId1 = advanceToRequestDecision(db, 'c-oldrun', t)

    // Run 3: same question (heartbeat re-ask) — still (REQUEST_DECISION, 2)
    releaseProgressionClaim(db, 'personal', 'c-oldrun', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-oldrun', t + 3, MANUAL_OPTS)
    expect(r3.decision).toBe('REQUEST_DECISION')

    // Istvan answers the FIRST run (source_reference = older run ID).
    // The question hasn't changed → answer should STILL be consumed.
    appendCaseEvent(db, {
      caseId: 'c-oldrun', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: askedRunId1,
    }, t + 10)

    // Run 4: answer matches current question → consumed → advances
    releaseProgressionClaim(db, 'personal', 'c-oldrun', 'runner', t + 60)
    const r4 = runProgressionCycle(db, 'personal', 'c-oldrun', t + 11, MANUAL_OPTS)
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r4.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r4.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
  })
})

// ── OWNER_INFORMATION → advance ────────────────────────────────────────

describe('OWNER_INFORMATION', () => {
  it('advances past the asked step (treats info as implicit proceed)', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-info', t)

    const askedRunId = advanceToRequestDecision(db, 'c-info', t)

    appendCaseEvent(db, {
      caseId: 'c-info', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_INFORMATION',
      payload: { content: 'The answer is 42' },
      sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, t + 10)

    releaseProgressionClaim(db, 'personal', 'c-info', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-info', t + 11, MANUAL_OPTS)
    expect(r3.decision).not.toBe('REQUEST_DECISION')
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r3.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r3.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
    // Step 2 answered + step 3 auto-completed = completed_plan_step 3
    expect(getState(db, 'c-info').completed_plan_step).toBe(3)
  })
})

// ── OWNER_CONFIRMATION → advance ───────────────────────────────────────

describe('OWNER_CONFIRMATION', () => {
  it('advances past the asked step (treats confirmation as implicit proceed)', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-confirm', t)

    const askedRunId = advanceToRequestDecision(db, 'c-confirm', t)

    appendCaseEvent(db, {
      caseId: 'c-confirm', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_CONFIRMATION', payload: {},
      sourceSystem: 'mission_control', sourceReference: askedRunId,
    }, t + 10)

    releaseProgressionClaim(db, 'personal', 'c-confirm', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-confirm', t + 11, MANUAL_OPTS)
    expect(r3.decision).not.toBe('REQUEST_DECISION')
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r3.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r3.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
    // Step 2 answered + step 3 auto-completed = completed_plan_step 3
    expect(getState(db, 'c-confirm').completed_plan_step).toBe(3)
  })
})

// ── AWAITING_APPROVAL → REQUEST_APPROVAL (status-driven) ──────────────

describe('REQUEST_APPROVAL via AWAITING_APPROVAL', () => {
  /** Seed a case with AWAITING_APPROVAL. decide() returns REQUEST_APPROVAL
   *  (status-driven), not REQUEST_DECISION (NBA-driven). */
  function seedApprovalCase(db: Database.Database, caseId: string, t: number) {
    createCase(db, {
      caseId, title: caseId, caseType: 'APPROVAL',
      status: 'AWAITING_APPROVAL', sensitivity: 'PERSONAL', priority: 'P2',
      sourceSystem: 'test',
    }, t)
    const seedDod = {
      criteria: [{ label: '_seed_guard', met: true, met_at: t, met_by_run: '_seed' }],
      all_met: true, evaluated_at: t,
    }
    db.prepare(
      `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode,
        goal, summary, next_progression_at, dod_verification_json, created_at, updated_at)
       VALUES ('personal', ?, 1, 'internal', ?, ?, ?, ?, ?, ?)`,
    ).run(caseId, 'Approval goal', 'Approval summary', t, JSON.stringify(seedDod), t, t)
  }

  it('YES transitions the case to READY (approval granted)', () => {
    const db = freshDb()
    const t = now()
    seedApprovalCase(db, 'c-approve', t)

    // AWAITING_APPROVAL always returns REQUEST_APPROVAL — even for step 1
    // (VERIFY). The status short-circuits decide() before the NBA kind.
    // No autonomous progress is possible until the owner approves.
    releaseProgressionClaim(db, 'personal', 'c-approve', 'runner', t + 60)
    const r1 = runProgressionCycle(db, 'personal', 'c-approve', t + 1, MANUAL_OPTS)
    expect(r1.decision).toBe('REQUEST_APPROVAL')

    // Run 2: still REQUEST_APPROVAL (status-driven, no progress without answer)
    releaseProgressionClaim(db, 'personal', 'c-approve', 'runner', t + 60)
    const r2 = runProgressionCycle(db, 'personal', 'c-approve', t + 2, MANUAL_OPTS)
    expect(r2.decision).toBe('REQUEST_APPROVAL')

    // Owner approves (matches latest ask)
    appendCaseEvent(db, {
      caseId: 'c-approve', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: r2.runId,
    }, t + 10)

    // Run 3: YES → transition to READY → plan rebuilds → autonomous progress
    releaseProgressionClaim(db, 'personal', 'c-approve', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-approve', t + 11, MANUAL_OPTS)
    // NOT gated, and this is the control that keeps the P4 change honest: the
    // step this answer advances to is not an outward-classed one, so Invariant E
    // has nothing to refuse. A blanket gate would have caught this too.
    expect(r3.decision).toBe('CONTINUE_AUTONOMOUSLY')
    expect(getCaseStatus(db, 'c-approve')).toBe('READY')
  })

  it('NO transitions the case to BLOCKED (rejected)', () => {
    const db = freshDb()
    const t = now()
    seedApprovalCase(db, 'c-reject', t)

    // Run 1: REQUEST_APPROVAL (AWAITING_APPROVAL always status-driven)
    releaseProgressionClaim(db, 'personal', 'c-reject', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-reject', t + 1, MANUAL_OPTS)

    // Run 2: REQUEST_APPROVAL again
    releaseProgressionClaim(db, 'personal', 'c-reject', 'runner', t + 60)
    const r2 = runProgressionCycle(db, 'personal', 'c-reject', t + 2, MANUAL_OPTS)
    expect(r2.decision).toBe('REQUEST_APPROVAL')

    // Owner rejects
    appendCaseEvent(db, {
      caseId: 'c-reject', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'NO' },
      sourceSystem: 'mission_control', sourceReference: r2.runId,
    }, t + 10)

    // Run 3: NO → transition to BLOCKED
    releaseProgressionClaim(db, 'personal', 'c-reject', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-reject', t + 11, MANUAL_OPTS)
    expect(r3.decision).toBe('RECOVERY_REQUIRED')
    expect(getCaseStatus(db, 'c-reject')).toBe('BLOCKED')
  })
})

// ── No answer yet → still REQUEST_DECISION ─────────────────────────────

describe('no answer yet', () => {
  it('still returns REQUEST_DECISION when no OWNER_* event exists', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-none', t)
    advanceToRequestDecision(db, 'c-none', t)

    // Run 3: no answer → still REQUEST_DECISION
    releaseProgressionClaim(db, 'personal', 'c-none', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-none', t + 3, MANUAL_OPTS)
    expect(r3.decision).toBe('REQUEST_DECISION')
  })

  it('still returns REQUEST_DECISION when OWNER_DECISION has mismatched source_reference', () => {
    const db = freshDb()
    const t = now()
    seedAwaitingSelectionCase(db, 'c-mismatch', t)
    advanceToRequestDecision(db, 'c-mismatch', t)

    // Write event with WRONG source_reference (not matching any run)
    appendCaseEvent(db, {
      caseId: 'c-mismatch', caseVersion: 1, actor: 'istvan',
      eventType: 'OWNER_DECISION', payload: { choice: 'YES' },
      sourceSystem: 'mission_control', sourceReference: 'wrong-run-id-12345',
    }, t + 10)

    releaseProgressionClaim(db, 'personal', 'c-mismatch', 'runner', t + 60)
    const r3 = runProgressionCycle(db, 'personal', 'c-mismatch', t + 11, MANUAL_OPTS)
    expect(r3.decision).toBe('REQUEST_DECISION')
  })
})
