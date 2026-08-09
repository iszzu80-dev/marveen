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

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initCosSchema(db)
  return db
}

function now(): number { return Math.floor(Date.now() / 1000) }

const MANUAL_OPTS: PipelineOptions = { triggerType: 'MANUAL', triggerReference: 'stagnation-test' }

/** Seed a case with progression state, WITHOUT running initial progression.
 *  Pre-exhausts DoD criteria so auto-satisfy doesn't interfere with stagnation
 *  measurement. */
function seedCaseWithoutInitialRun(db: Database.Database, caseId: string, status: 'NEW' | 'WAITING_EXTERNAL', t: number) {
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN',
    status, sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
  }, t)

  // Seed state directly — do NOT run initial progression.
  // Pre-set dod_verification_json with a pre-met criterion so
  // initializeDoDVerification returns early (criteria.length > 0 guard) and
  // autoSatisfyNextDoDCriterion finds nothing unmet (returns -1).
  const seedDod = {
    criteria: [{ label: '_seed_guard', met: true, met_at: t, met_by_run: '_seed' }],
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

  it('resets completed_plan_step when all plan steps are exhausted', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-exhaust', 'NEW', t)

    // NEW status plan: step 1 VERIFY, step 2 GATHER_INFO, step 3 EXECUTE, step 4 VERIFY DoD
    // After 4 CONTINUE_AUTONOMOUSLY runs, all steps should be exhausted.
    for (let i = 0; i < 4; i++) {
      releaseProgressionClaim(db, 'personal', 'c-exhaust', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-exhaust', t + i + 1, MANUAL_OPTS)
      const s = getState(db, 'c-exhaust')
      console.log(`  cycle ${i}: completed_step=${s.completed_plan_step} plan_ver=${s.plan_version}`)
    }

    // After exhausting step 4, completed_plan_step resets to 0.
    // Next run will have planChanged=true (completed_plan_step reset),
    // bump plan_version, rebuild plan, and start at step 1.
    const final = getState(db, 'c-exhaust')
    expect(final.completed_plan_step).toBe(0) // reset after exhaustion
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

  it('resets no_progress_run_count to 0 when DoD criterion is newly met', () => {
    const db = freshDb()
    const t = now()
    seedCaseWithoutInitialRun(db, 'c-dodreset', 'NEW', t)

    // First, accumulate no-op runs
    for (let i = 0; i < 12; i++) {
      releaseProgressionClaim(db, 'personal', 'c-dodreset', 'runner', t + 60)
      runProgressionCycle(db, 'personal', 'c-dodreset', t + i + 1, MANUAL_OPTS)
    }

    const mid = getState(db, 'c-dodreset')
    console.log(`  after 12 cycles: no_progress=${mid.no_progress_run_count}`)

    // Manually inject an unmet DoD criterion so the next run satisfies it
    const dodVerification = {
      criteria: [
        { label: 'Verify', met: false, met_by_run_id: null, met_at: null },
      ],
    }
    db.prepare(
      'UPDATE case_progression_state SET dod_verification_json = ? WHERE domain = ? AND case_id = ?',
    ).run(JSON.stringify(dodVerification), 'personal', 'c-dodreset')

    releaseProgressionClaim(db, 'personal', 'c-dodreset', 'runner', t + 60)
    runProgressionCycle(db, 'personal', 'c-dodreset', t + 20, MANUAL_OPTS)

    const after = getState(db, 'c-dodreset')
    console.log(`  after DoD injection + 1 run: no_progress=${after.no_progress_run_count}`)

    // After a DoD criterion is satisfied (real progress), counter must reset to 0
    expect(after.no_progress_run_count).toBe(0)
  })
})
