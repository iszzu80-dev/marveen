// Stagnation detector + plan-step advancement regression tests.
// Card 52250c7f GATE 2 follow-up — fixes two defects found in live loop:
//   1. no_progress_run_count never incremented (dead column)
//   2. Plan step never advances (always lands on step 1)
//
// RED-first: these tests must FAIL against the unfixed code.
//   - Before fix: no_progress_run_count stays 0 forever, NBA always step 1
//   - After fix: counter increments on no-op runs, NBA advances past step 1

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { runProgressionCycle, type PipelineOptions } from '../cos/progression-pipeline.js'
import { seedProgressionState } from '../cos/progression-migrate.js'
import { releaseProgressionClaim } from '../cos/progression-scheduler.js'
import { satisfyDoDCriterion } from '../cos/progression-completion.js'
import { recordOwnerAnswer } from '../cos/owner-question.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initCosSchema(db)
  return db
}

function now(): number { return Math.floor(Date.now() / 1000) }

const MANUAL_OPTS: PipelineOptions = { triggerType: 'MANUAL', triggerReference: 'stagnation-test' }

/** Seed a case with progression state, WITHOUT running initial progression.
 *  Pre-satisfies the DoD so completion is never what these tests are measuring
 *  — they are about the stagnation counter and plan-step advancement. */
/** Grant the approval the engine is now waiting on, through the real path.
 *
 *  BLOCKER CLOSURE, 2026-08-27. Both tests below used to walk the plan to
 *  exhaustion in four uninterrupted cycles. They could, because
 *  `completed_plan_step` was advanced BEFORE Invariant E ran: the engine refused
 *  the HIGH-risk EXECUTE step and recorded it as completed in the same run, so
 *  the next cycle picked the step after it. One of these tests then asserted
 *  COMPLETE -- a case reaching completion by walking straight through a refusal.
 *
 *  The cursor now stops at the refusal, which is the correct behaviour and also
 *  the reason the refusal needed a door. So the plan reaches exhaustion the way
 *  it will in production: Istvan approves the step, the approval becomes a
 *  single-use §22.2 ticket, and the engine proceeds. */
function approveTheOpenRequest(db: Database.Database, caseId: string, at: number): void {
  const req = db.prepare(
    `SELECT question_hash AS h FROM cos_action_approval_requests
      WHERE case_id = ? AND decided_at IS NULL`,
  ).get(caseId) as { h: string } | undefined
  if (!req) throw new Error(`no approval request open for ${caseId}`)
  db.prepare(
    `UPDATE cos_owner_questions SET channel='telegram:cos', channel_target='chat:1'
      WHERE case_id = ? AND question_hash = ?`,
  ).run(caseId, req.h)
  const rec = recordOwnerAnswer(db, {
    caseId, domain: 'personal', text: 'igen', now: at,
    channel: { channel: 'telegram:cos', target: 'chat' },
  })
  if (!rec) throw new Error(`the approval answer was not recorded for ${caseId}`)
}

function seedCaseWithoutInitialRun(db: Database.Database, caseId: string, status: 'NEW' | 'WAITING_EXTERNAL', t: number) {
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN',
    status, sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
  }, t)

  // Seed state directly — do NOT run initial progression.
  // The pre-set dod_verification_json makes initializeDoDVerification return
  // early (criteria.length > 0 guard), so the pipeline's contract never
  // overwrites it.
  //
  // Updated 2026-08-10: this seed used to be a bare `met: true` with all_met
  // true, which after the completion fix means nothing — a tick with no
  // evidence is not satisfaction, and a DoD with no provenance is generic.
  // These tests need a case that CAN complete so that plan exhaustion is the
  // only variable, so the seed now says so explicitly: a case-specific
  // contract, satisfied against a named piece of evidence.
  const seedDod = {
    provenance: 'CASE_SPECIFIC',
    criteria: [{
      label: '_seed_guard', met: true, met_at: t,
      met_by_run: '_seed', met_by_evidence: 'test_seed:_seed_guard',
    }],
    all_met: true,
    evaluated_at: t,
  }
  db.prepare(
    `INSERT INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode,
      next_progression_at, dod_verification_json, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', ?, ?, ?, ?)`,
  ).run(caseId, t, JSON.stringify(seedDod), t, t)
}

function getState(db: Database.Database, caseId: string) {
  return db.prepare(
    'SELECT no_progress_run_count, completed_plan_step, plan_version, next_best_action_json, rolling_plan_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get('personal', caseId) as {
    no_progress_run_count: number; completed_plan_step: number; plan_version: number
    next_best_action_json: string | null; rolling_plan_json: string | null
  }
}

function getLastRun(db: Database.Database, caseId: string) {
  return db.prepare(
    `SELECT decision, reason, plan_version_before, plan_version_after, nbaStep
     FROM (
       SELECT decision, reason,
              plan_version_before, plan_version_after,
              json_extract(progress_delta_json, '$.nbaStep') as nbaStep
       FROM case_progression_runs
       WHERE case_id = ? AND domain = 'personal'
       ORDER BY started_at DESC LIMIT 1
     )`,
  ).get(caseId) as {
    decision: string; reason: string
    plan_version_before: number; plan_version_after: number
    nbaStep: number
  } | undefined
}

describe('plan step advancement (completed_plan_step)', () => {
  it('advances past step 1 after a CONTINUE_AUTONOMOUSLY run', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-advance', 'NEW', t)

    // Run 1: should pick step 1 (no completed steps yet)
    releaseProgressionClaim(db, 'personal', 'c-advance', 'runner', t + 60)
    const run1 = runProgressionCycle(db, 'personal', 'c-advance', t + 1, MANUAL_OPTS)
    expect(run1.decision).toBe('CONTINUE_AUTONOMOUSLY')

    const state1 = getState(db, 'c-advance')
    expect(state1.completed_plan_step).toBe(1) // step 1 was completed

    const nba1 = JSON.parse(state1.next_best_action_json!) as { planStep: number }
    expect(nba1.planStep).toBe(1) // run 1 picked step 1

    // Run 2: should pick step 2 (step 1 already completed, same plan)
    releaseProgressionClaim(db, 'personal', 'c-advance', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-advance', t + 2, MANUAL_OPTS)

    const state2 = getState(db, 'c-advance')
    expect(state2.plan_version).toBe(state1.plan_version) // plan unchanged
    expect(state2.completed_plan_step).toBe(2) // step 2 completed

    const nba2 = JSON.parse(state2.next_best_action_json!) as { planStep: number }
    expect(nba2.planStep).toBe(2) // run 2 picked step 2
  })

  it('does NOT bump plan_version when the plan has not changed', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-stable', 'NEW', t)

    releaseProgressionClaim(db, 'personal', 'c-stable', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-stable', t + 1, MANUAL_OPTS)
    const v1 = getState(db, 'c-stable').plan_version

    releaseProgressionClaim(db, 'personal', 'c-stable', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-stable', t + 2, MANUAL_OPTS)
    const v2 = getState(db, 'c-stable').plan_version

    // Same plan → same plan_version (not bumped every cycle)
    expect(v2).toBe(v1)
  })

  it('completes the case when plan is exhausted and DoD is met (NO wrap-around)', () => {
    const db = freshDb()
    const t = now()
    // seedCaseWithoutInitialRun pre-sets dod_verification_json with a
    // CASE_SPECIFIC _seed_guard criterion already met against evidence, so
    // canCompleteCase() returns allowed=true and plan exhaustion is the only
    // variable this test moves.
    seedCaseWithoutInitialRun(db, 'c-complete', 'NEW', t)

    // Steps 1 and 2 run autonomously; step 3 is the HIGH-risk EXECUTE and
    // Invariant E refuses it. The cursor STOPS there -- it no longer walks past.
    for (let i = 0; i < 3; i++) {
      releaseProgressionClaim(db, 'personal', 'c-complete', 'runner', t + 60)
      const r = runProgressionCycle(db, 'personal', 'c-complete', t + i + 1, MANUAL_OPTS)
      if (i === 2) expect(r.decision).toBe('MANUAL_ACTION_REQUIRED')
    }
    expect(getState(db, 'c-complete').completed_plan_step).toBe(2)

    // The door: Istvan approves that exact step, and the engine proceeds.
    approveTheOpenRequest(db, 'c-complete', t + 10)
    let completedRun = false
    for (let i = 0; i < 2; i++) {
      releaseProgressionClaim(db, 'personal', 'c-complete', 'runner', t + 60)
      const r = runProgressionCycle(db, 'personal', 'c-complete', t + 20 + i, MANUAL_OPTS)
      if (r.decision === 'COMPLETE') completedRun = true
    }
    expect(completedRun).toBe(true)

    // completed_plan_step stays at maxStep (4) — case IS done, not reset
    const final = getState(db, 'c-complete')
    expect(final.completed_plan_step).toBe(4)
    // progression_enabled should be 0 after auto-completion
    const state = db.prepare(
      'SELECT progression_enabled FROM case_progression_state WHERE domain = ? AND case_id = ?',
    ).get('personal', 'c-complete') as { progression_enabled: number }
    expect(state.progression_enabled).toBe(0)
  })

  it('resets completed_plan_step when all plan steps are exhausted but DoD is NOT met', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-wrap', 'NEW', t)

    // Override the seed's DoD with 5 unmet criteria. Nothing satisfies them —
    // as of 2026-08-10 the pipeline satisfies nothing at all. canCompleteCase
    // returns allowed=false → plan wraps around instead of completing.
    db.prepare(
      `UPDATE case_progression_state SET dod_verification_json = ? WHERE domain = ? AND case_id = ?`,
    ).run(JSON.stringify({
      criteria: [
        { label: 'Task 1', met: false, met_at: null, met_by_run: null },
        { label: 'Task 2', met: false, met_at: null, met_by_run: null },
        { label: 'Task 3', met: false, met_at: null, met_by_run: null },
        { label: 'Task 4', met: false, met_at: null, met_by_run: null },
        { label: 'Task 5', met: false, met_at: null, met_by_run: null },
      ],
      all_met: false,
      evaluated_at: t,
    }), 'personal', 'c-wrap')

    for (let i = 0; i < 3; i++) {
      releaseProgressionClaim(db, 'personal', 'c-wrap', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-wrap', t + i + 1, MANUAL_OPTS)
    }
    // Same gate as above: the plan cannot be exhausted until the refused step is
    // approved, so the wrap-around cannot be reached by walking past it.
    expect(getState(db, 'c-wrap').completed_plan_step).toBe(2)
    approveTheOpenRequest(db, 'c-wrap', t + 10)
    for (let i = 0; i < 2; i++) {
      releaseProgressionClaim(db, 'personal', 'c-wrap', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-wrap', t + 20 + i, MANUAL_OPTS)
    }

    // DoD unmet → plan wraps around, completed_plan_step resets to 0
    const final = getState(db, 'c-wrap')
    expect(final.completed_plan_step).toBe(0)
  })
})

describe('stagnation detector (no_progress_run_count)', () => {
  it('increments when the NBA step does not advance (WAITING_EXTERNAL case)', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-waiting', 'WAITING_EXTERNAL', t)

    // WAITING_EXTERNAL plan: step 1 VERIFY (needsExternal=false),
    // step 2: Check external response (needsExternal=true),
    // step 3: Process response (needsExternal=false),
    // step 4: Review DoD
    //
    // Run 1: step 1 → CONTINUE_AUTONOMOUSLY → completed=1
    // Run 2: step 2 → WAIT_EXTERNAL (needsExternal=true) → completed STAYS at 1
    // Run 3: step 2 again → WAIT_EXTERNAL → completed STILL 1, counter++
    // Run 4: step 2 again → WAIT_EXTERNAL → counter++

    // Run 1: step 1, advances
    releaseProgressionClaim(db, 'personal', 'c-waiting', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-waiting', t + 1, MANUAL_OPTS)
    let s = getState(db, 'c-waiting')
    expect(s.completed_plan_step).toBe(1)
    expect(s.no_progress_run_count).toBe(0)

    // Run 2: step 2, WAIT_EXTERNAL — no advancement
    releaseProgressionClaim(db, 'personal', 'c-waiting', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-waiting', t + 2, MANUAL_OPTS)
    s = getState(db, 'c-waiting')
    expect(s.completed_plan_step).toBe(1) // not advanced
    expect(s.no_progress_run_count).toBe(1) // ONE no-op

    // Run 3: step 2 again — counter increments
    releaseProgressionClaim(db, 'personal', 'c-waiting', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-waiting', t + 3, MANUAL_OPTS)
    s = getState(db, 'c-waiting')
    expect(s.completed_plan_step).toBe(1)
    expect(s.no_progress_run_count).toBe(2)

    // Run 4: step 2 again — counter keeps incrementing
    releaseProgressionClaim(db, 'personal', 'c-waiting', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-waiting', t + 4, MANUAL_OPTS)
    s = getState(db, 'c-waiting')
    expect(s.completed_plan_step).toBe(1)
    expect(s.no_progress_run_count).toBe(3)
  })

  it('PROVES counter goes RED: 5 consecutive no-advance runs → counter = 5', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-red', 'WAITING_EXTERNAL', t)

    // Complete step 1 first
    releaseProgressionClaim(db, 'personal', 'c-red', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-red', t + 1, MANUAL_OPTS)

    // Now run 5 times, each landing on step 2 (WAIT_EXTERNAL)
    for (let i = 0; i < 5; i++) {
      releaseProgressionClaim(db, 'personal', 'c-red', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-red', t + 2 + i, MANUAL_OPTS)
    }

    const final = getState(db, 'c-red')
    // After 5 runs stuck on step 2, counter must be 5
    expect(final.no_progress_run_count).toBe(5)
  })

  // REPLACED 2026-08-10. The old test here was called "resets
  // no_progress_run_count to 0 when DoD criterion is newly met": it injected an
  // unmet criterion, ran one cycle, and asserted the stagnation counter was 0.
  //
  // Two things were wrong with it. It asserted 0 after a run that had already
  // left the counter at 0, so it would have passed with the mechanism ripped
  // out — and the mechanism it described was the auto-satisfier, which counted
  // its own bookkeeping as progress. A run that ticks a box it invented and
  // then resets the stagnation counter because a box got ticked cannot ever
  // look stagnant. That is why 26 live cases sat still for hours with a
  // stagnation counter of zero.
  //
  // What replaces it pins the new rule: satisfying a criterion is not progress
  // by itself, and a case the engine cannot actually move keeps counting up.
  it('a satisfied DoD criterion alone does NOT reset the stagnation counter', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-dodreset', 'WAITING_EXTERNAL', t)

    // WAITING_EXTERNAL: the engine cannot proceed autonomously, so every cycle
    // is genuinely a no-op and the counter climbs.
    for (let i = 0; i < 5; i++) {
      releaseProgressionClaim(db, 'personal', 'c-dodreset', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-dodreset', t + i + 1, MANUAL_OPTS)
    }
    const mid = getState(db, 'c-dodreset').no_progress_run_count
    expect(mid).toBeGreaterThan(0)

    // Satisfy a criterion out of band, with evidence, then run one more cycle.
    db.prepare(
      'UPDATE case_progression_state SET dod_verification_json = ? WHERE domain = ? AND case_id = ?',
    ).run(JSON.stringify({
      provenance: 'CASE_SPECIFIC',
      criteria: [{ label: 'Verify', met: false, met_at: null, met_by_run: null, met_by_evidence: null }],
      all_met: false,
      evaluated_at: t,
    }), 'personal', 'c-dodreset')
    satisfyDoDCriterion(db, 'personal', 'c-dodreset', 0, 'out-of-band', 'case_event:99', t + 19)

    releaseProgressionClaim(db, 'personal', 'c-dodreset', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-dodreset', t + 20, MANUAL_OPTS)

    // The case still has not moved, so the counter still has not reset.
    expect(getState(db, 'c-dodreset').no_progress_run_count).toBeGreaterThan(mid)
  })
})
