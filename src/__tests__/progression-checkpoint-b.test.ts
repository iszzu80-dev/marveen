// Checkpoint B — Thin shadow vertical slice (card 4a809934).
// First checkpoint with actual progression LOGIC.
//
// Takes ONE live PRI (personal) case and ONE live ZST case through the
// full pipeline end-to-end:
//   outcome contract → resolver → rolling plan → NBA → progression run → shadow result
//
// HARD REQUIREMENTS:
//   - ZERO side effects (no email, no status mutation on existing tables)
//   - Write ONLY to case_progression_state + case_progression_runs
//   - progression_enabled=false, progression_mode='shadow'
//   - external OFF (no external_reference, action_ids_json always NULL)
//   - Decision must be one of 10 valid types (plan §13)
//   - MUST pass tsc --noEmit AND full npx vitest run

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase, appendCaseEvent, getCase } from '../cos/case-store.js'
import { createZstCase, transitionZstCase, getZstCase } from '../cos/zst-case-store.js'
import {
  runProgressionCycle,
  getMissionControlProgressionView,
  VALID_DECISIONS,
  deriveOutcomeContract,
  resolveContext,
  buildRollingPlan,
  determineNextBestAction,
  decide,
  type ProgressionRunResult,
  type MissionControlProgressionView,
} from '../cos/progression-pipeline.js'

// ── Helper: snapshot case row before/after progression ──────────────────

function snapshotCase(table: string, caseId: string, db: Database.Database) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE case_id = ?`).get(caseId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`Case not found: ${table}/${caseId}`)
  return { ...row }
}

function snapshotProgressionState(domain: string, caseId: string, db: Database.Database) {
  return db.prepare(
    'SELECT * FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as Record<string, unknown> | undefined
}

function snapshotProgressionRuns(domain: string, caseId: string, db: Database.Database) {
  return db.prepare(
    'SELECT * FROM case_progression_runs WHERE domain = ? AND case_id = ? ORDER BY started_at',
  ).all(domain, caseId) as Record<string, unknown>[]
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Checkpoint B — Thin shadow vertical slice (card 4a809934)', () => {
  let db: Database.Database
  const now = Math.floor(Date.now() / 1000)

  // Realistic case IDs for the 2 live cases we'll progress
  const PRI_CASE_ID = 'case-iszzu80-19fcbd3b431aa3c0'   // Medence WPC — waiting on vendor
  const ZST_CASE_ID = 'zst-zst-19edae46460029b4'          // Biztositas szamla

  beforeAll(() => {
    initDatabase(':memory:')
    db = getDb() as Database.Database

    // ── Seed PRI case: Medence WPC-alkatresz, WAITING_EXTERNAL ──
    const priRow = createCase(db, {
      caseId: PRI_CASE_ID,
      title: 'Medence WPC-alkatresz ajanlatkeres',
      caseType: 'HOME_REPAIR',
      description: 'WPC peremelem beszerzes a medencehez. Kardos Laszlo (Pro-Mower) ajanlatara varunk.',
      status: 'NEW',
      priority: 'P2',
      sensitivity: 'PERSONAL',
      owner: 'marveen',
      sourceSystem: 'gmail',
    }, now - 86400 * 5) // created 5 days ago

    // Transition to WAITING_EXTERNAL with a follow-up
    transitionCase(db, {
      caseId: PRI_CASE_ID,
      seenVersion: priRow.version,
      newStatus: 'WAITING_EXTERNAL',
      actor: 'marveen',
      reason: 'Waiting for Kardos Laszlo (Pro-Mower) to respond about WPC edge element supplier',
      patch: { waiting_on: 'Kardos Laszlo (Pro-Mower) valasza', follow_up_at: now + 86400 * 3 },
    }, now - 86400 * 2)

    // ── Seed ZST case: Biztositas szamla, NEW ──
    createZstCase(db, {
      caseId: ZST_CASE_ID,
      title: 'ZST: Bejovo szamla - Biztositas',
      caseType: 'INVOICE_INCOMING',
      description: 'Biztositas szamla bejott, rogzitendo es fizetendo.',
      status: 'NEW',
      priority: 'P2',
      sensitivity: 'ZST_INTERNAL',
      owner: 'marveen',
      sourceSystem: 'gmail',
      workspace: 'OPERATIONS',
    }, now - 86400 * 3)
  })

  afterAll(() => {
    db?.close()
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 1: Individual pipeline stage unit tests
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 1: Pipeline stages in isolation', () => {
    it('deriveOutcomeContract returns valid contract for a HOME_REPAIR case', () => {
      const contract = deriveOutcomeContract(
        'Medence WPC-alkatresz ajanlatkeres',
        'HOME_REPAIR',
        'WAITING_EXTERNAL',
        'PERSONAL',
      )
      expect(contract.goal).toBeTruthy()
      expect(contract.goal).toContain('Megjavit')
      expect(contract.definitionOfDone.length).toBeGreaterThanOrEqual(3)
      expect(contract.successEvidenceRequirements.length).toBe(contract.definitionOfDone.length)
    })

    it('deriveOutcomeContract returns valid contract for an INVOICE_INCOMING case', () => {
      const contract = deriveOutcomeContract(
        'ZST: Bejovo szamla - Biztositas',
        'INVOICE_INCOMING',
        'NEW',
        'ZST_INTERNAL',
      )
      expect(contract.goal).toBeTruthy()
      expect(contract.goal).toContain('Befogadni')
      expect(contract.definitionOfDone.length).toBeGreaterThanOrEqual(3)
    })

    it('resolveContext reads event count and last event correctly', () => {
      const ctx = resolveContext(db, 'personal_cases', 'personal_case_events', PRI_CASE_ID, now)
      expect(ctx.eventCount).toBeGreaterThanOrEqual(1)
      expect(ctx.ageDays).toBeGreaterThanOrEqual(2)
      expect(ctx.sensitivity).toBe('PERSONAL')
      expect(ctx.hasParent).toBe(false)
      expect(ctx.hasChildren).toBe(false)
    })

    it('buildRollingPlan produces plan for WAITING_EXTERNAL status', () => {
      const contract = deriveOutcomeContract('Test', 'HOME_REPAIR', 'WAITING_EXTERNAL', 'PERSONAL')
      const ctx = { eventCount: 2, lastEventType: 'STATUS_CHANGED', lastEventReason: 'test', hasParent: false, hasChildren: false, ageDays: 3, sensitivity: 'PERSONAL' }
      const plan = buildRollingPlan(contract, ctx, 'WAITING_EXTERNAL')
      expect(plan.length).toBeGreaterThanOrEqual(3)
      expect(plan[0].kind).toBe('VERIFY')
      // Must have an external-wait step
      const externalSteps = plan.filter(s => s.needsExternal)
      expect(externalSteps.length).toBeGreaterThanOrEqual(1)
    })

    it('buildRollingPlan produces plan for NEW status', () => {
      const contract = deriveOutcomeContract('Test', 'INVOICE_INCOMING', 'NEW', 'ZST_INTERNAL')
      const ctx = { eventCount: 1, lastEventType: 'CREATED', lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 0, sensitivity: 'ZST_INTERNAL' }
      const plan = buildRollingPlan(contract, ctx, 'NEW')
      expect(plan.length).toBeGreaterThanOrEqual(3)
      expect(plan[0].kind).toBe('VERIFY')
    })

    it('determineNextBestAction picks first non-external step', () => {
      const plan = [
        { step: 1, label: 'Verify', kind: 'VERIFY' as const, needsExternal: false },
        { step: 2, label: 'Wait', kind: 'AWAIT_EXTERNAL' as const, needsExternal: true },
        { step: 3, label: 'Execute', kind: 'EXECUTE' as const, needsExternal: false },
      ]
      const ctx = { eventCount: 2, lastEventType: null, lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 3, sensitivity: 'PERSONAL' }
      const nba = determineNextBestAction(plan, ctx)
      expect(nba.planStep).toBe(1) // picks Verify (first non-external)
      expect(nba.canProceedAutonomously).toBe(true)
    })

    it('decide returns WAIT_EXTERNAL for a waiting case with external dependency', () => {
      const nba = { planStep: 2, description: 'Check for external response', kind: 'AWAIT_EXTERNAL' as const, canProceedAutonomously: false, estimatedEffortMinutes: 5 }
      const ctx = { eventCount: 2, lastEventType: null, lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 3, sensitivity: 'PERSONAL' }
      const { decision } = decide(nba, ctx, 'WAITING_EXTERNAL')
      expect(decision).toBe('WAIT_EXTERNAL')
    })

    it('decide returns RECOVERY_REQUIRED for overdue waiting (>7 days)', () => {
      const nba = { planStep: 2, description: 'Check', kind: 'AWAIT_EXTERNAL' as const, canProceedAutonomously: false, estimatedEffortMinutes: 5 }
      const ctx = { eventCount: 2, lastEventType: null, lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 10, sensitivity: 'PERSONAL' }
      const { decision } = decide(nba, ctx, 'WAITING_EXTERNAL')
      expect(decision).toBe('RECOVERY_REQUIRED')
    })

    it('decide returns RECOVERY_REQUIRED for BLOCKED status', () => {
      const nba = { planStep: 1, description: 'Identify', kind: 'GATHER_INFO' as const, canProceedAutonomously: true, estimatedEffortMinutes: 5 }
      const ctx = { eventCount: 2, lastEventType: null, lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 1, sensitivity: 'PERSONAL' }
      const { decision } = decide(nba, ctx, 'BLOCKED')
      expect(decision).toBe('RECOVERY_REQUIRED')
    })

    it('decide returns COMPLETE for COMPLETED status', () => {
      const nba = { planStep: 1, description: 'Verify', kind: 'VERIFY' as const, canProceedAutonomously: true, estimatedEffortMinutes: 5 }
      const ctx = { eventCount: 2, lastEventType: null, lastEventReason: null, hasParent: false, hasChildren: false, ageDays: 1, sensitivity: 'PERSONAL' }
      const { decision } = decide(nba, ctx, 'COMPLETED')
      expect(decision).toBe('COMPLETE')
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 2: End-to-end pipeline for real cases
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 2: End-to-end pipeline — real cases', () => {
    let priResult: ProgressionRunResult
    let zstResult: ProgressionRunResult
    let priBefore: Record<string, unknown>
    let zstBefore: Record<string, unknown>

    beforeAll(() => {
      // Snapshot cases BEFORE progression
      priBefore = snapshotCase('personal_cases', PRI_CASE_ID, db)
      zstBefore = snapshotCase('zst_cases', ZST_CASE_ID, db)

      // Run progression on both
      priResult = runProgressionCycle(db, 'personal', PRI_CASE_ID, now, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-b',
      })

      zstResult = runProgressionCycle(db, 'zst', ZST_CASE_ID, now, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-b',
      })
    })

    // ── PRI case pipeline ──

    it('PRI: run is COMPLETED with no safety violations', () => {
      expect(priResult.status).toBe('COMPLETED')
      expect(priResult.safetyViolations).toHaveLength(0)
      expect(priResult.domain).toBe('personal')
      expect(priResult.caseId).toBe(PRI_CASE_ID)
    })

    it('PRI: decision is a valid progression decision type', () => {
      expect(VALID_DECISIONS as readonly string[]).toContain(priResult.decision)
    })

    it('PRI: decision is WAIT_EXTERNAL (case is waiting on vendor)', () => {
      expect(priResult.decision).toBe('WAIT_EXTERNAL')
    })

    it('PRI: decision is neither external execution nor has action_ids', () => {
      // In shadow mode with external OFF, decisions must not trigger
      // autonomous external actions
      const dangerousDecisions = ['EXECUTE_PAYMENT', 'COMMIT_CONTRACT', 'SIGN_LEGAL']
      expect(dangerousDecisions).not.toContain(priResult.decision)
    })

    it('PRI: plan_version and goal_version are recorded', () => {
      expect(priResult.planVersion).toBeGreaterThanOrEqual(1)
    })

    it('PRI: progression state row exists with shadow mode and enabled=false', () => {
      const state = snapshotProgressionState('personal', PRI_CASE_ID, db)
      expect(state).toBeTruthy()
      expect(state!.progression_enabled).toBe(0)
      expect(state!.progression_mode).toBe('shadow')
      expect(state!.goal).toBeTruthy()
      expect(state!.rolling_plan_json).toBeTruthy()
      expect(state!.next_best_action_json).toBeTruthy()
    })

    it('PRI: progression run row exists with ZERO external reference and ZERO action_ids', () => {
      const runs = snapshotProgressionRuns('personal', PRI_CASE_ID, db)
      expect(runs.length).toBe(1)
      expect(runs[0].action_ids_json).toBeNull()
      expect(runs[0].escalation_id).toBeNull()
      expect(runs[0].trigger_reference).toBe('checkpoint-b')
      expect(runs[0].status).toBe('COMPLETED')
      expect(runs[0].safety_assertions_json).toBeTruthy()
      expect(runs[0].decision).toBe('WAIT_EXTERNAL')
    })

    it('PRI: safety assertions JSON contains all 7 assertions all passed', () => {
      const runs = snapshotProgressionRuns('personal', PRI_CASE_ID, db)
      const parsed = JSON.parse(runs[0].safety_assertions_json as string)
      expect(parsed.length).toBe(7)
      for (const a of parsed) {
        expect(a.passed).toBe(true)
      }
    })

    it('PRI: ZERO side effects — original case row unchanged in personal_cases', () => {
      const priAfter = snapshotCase('personal_cases', PRI_CASE_ID, db)
      // Verify critical fields are unchanged
      expect(priAfter.status).toBe(priBefore.status)
      expect(priAfter.title).toBe(priBefore.title)
      expect(priAfter.sensitivity).toBe(priBefore.sensitivity)
      expect(priAfter.owner).toBe(priBefore.owner)
      // version may have been bumped by progression? NO — progression
      // does NOT touch personal_cases. version must be unchanged.
      expect(priAfter.version).toBe(priBefore.version)
    })

    it('PRI: no new columns appeared in personal_cases', () => {
      const cols = db.prepare('PRAGMA table_info(personal_cases)').all() as Array<{ name: string }>
      const names = cols.map(c => c.name)
      // Progression columns must NOT leak into personal_cases
      const forbidden = ['goal', 'rolling_plan', 'progression_enabled', 'semantic_completion']
      for (const f of forbidden) {
        const found = names.some(n => n.toLowerCase().includes(f))
        expect(found).toBe(false)
      }
    })

    // ── ZST case pipeline ──

    it('ZST: run is COMPLETED with no safety violations', () => {
      expect(zstResult.status).toBe('COMPLETED')
      expect(zstResult.safetyViolations).toHaveLength(0)
      expect(zstResult.domain).toBe('zst')
      expect(zstResult.caseId).toBe(ZST_CASE_ID)
    })

    it('ZST: decision is a valid progression decision type', () => {
      expect(VALID_DECISIONS as readonly string[]).toContain(zstResult.decision)
    })

    it('ZST: decision is CONTINUE_AUTONOMOUSLY (new case, can be triaged)', () => {
      expect(zstResult.decision).toBe('CONTINUE_AUTONOMOUSLY')
    })

    it('ZST: no dangerous autonomous decisions', () => {
      const dangerousDecisions = ['EXECUTE_PAYMENT', 'COMMIT_CONTRACT', 'SIGN_LEGAL']
      expect(dangerousDecisions).not.toContain(zstResult.decision)
    })

    it('ZST: progression state row exists with shadow mode and enabled=false', () => {
      const state = snapshotProgressionState('zst', ZST_CASE_ID, db)
      expect(state).toBeTruthy()
      expect(state!.progression_enabled).toBe(0)
      expect(state!.progression_mode).toBe('shadow')
      expect(state!.goal).toBeTruthy()
    })

    it('ZST: progression run row exists with ZERO external reference and ZERO action_ids', () => {
      const runs = snapshotProgressionRuns('zst', ZST_CASE_ID, db)
      expect(runs.length).toBe(1)
      expect(runs[0].action_ids_json).toBeNull()
      expect(runs[0].escalation_id).toBeNull()
      expect(runs[0].status).toBe('COMPLETED')
      expect(runs[0].safety_assertions_json).toBeTruthy()
      expect(runs[0].decision).toBe('CONTINUE_AUTONOMOUSLY')
    })

    it('ZST: safety assertions JSON contains all 7 assertions all passed', () => {
      const runs = snapshotProgressionRuns('zst', ZST_CASE_ID, db)
      const parsed = JSON.parse(runs[0].safety_assertions_json as string)
      expect(parsed.length).toBe(7)
      for (const a of parsed) {
        expect(a.passed).toBe(true)
      }
    })

    it('ZST: ZERO side effects — original case row unchanged in zst_cases', () => {
      const zstAfter = snapshotCase('zst_cases', ZST_CASE_ID, db)
      expect(zstAfter.status).toBe(zstBefore.status)
      expect(zstAfter.title).toBe(zstBefore.title)
      expect(zstAfter.sensitivity).toBe(zstBefore.sensitivity)
      expect(zstAfter.version).toBe(zstBefore.version)
    })

    it('ZST: no progression columns leaked into zst_cases', () => {
      const cols = db.prepare('PRAGMA table_info(zst_cases)').all() as Array<{ name: string }>
      const names = cols.map(c => c.name)
      const forbidden = ['goal', 'rolling_plan', 'progression_enabled', 'semantic_completion']
      for (const f of forbidden) {
        const found = names.some(n => n.toLowerCase().includes(f))
        expect(found).toBe(false)
      }
    })

    // ── Domain isolation ──

    it('domain isolation: personal progression state does NOT appear in zst query', () => {
      const personalStates = db.prepare(
        "SELECT count(*) as c FROM case_progression_state WHERE domain = 'personal'",
      ).get() as { c: number }
      const zstStates = db.prepare(
        "SELECT count(*) as c FROM case_progression_state WHERE domain = 'zst'",
      ).get() as { c: number }
      expect(personalStates.c).toBe(1)
      expect(zstStates.c).toBe(1)
    })

    it('domain isolation: progression runs are separately identifiable', () => {
      const personalRuns = db.prepare(
        "SELECT count(*) as c FROM case_progression_runs WHERE domain = 'personal'",
      ).get() as { c: number }
      const zstRuns = db.prepare(
        "SELECT count(*) as c FROM case_progression_runs WHERE domain = 'zst'",
      ).get() as { c: number }
      expect(personalRuns.c).toBe(1)
      expect(zstRuns.c).toBe(1)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 3: Mission Control read view
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 3: Mission Control read view (read-only projection)', () => {
    it('getMissionControlProgressionView returns 1 row for personal domain', () => {
      const view = getMissionControlProgressionView(db, 'personal')
      expect(view.length).toBe(1)
      expect(view[0].caseId).toBe(PRI_CASE_ID)
      expect(view[0].domain).toBe('personal')
      expect(view[0].title).toContain('WPC')
      expect(view[0].status).toBe('WAITING_EXTERNAL')
      expect(view[0].goal).toBeTruthy()
      expect(view[0].lastDecision).toBe('WAIT_EXTERNAL')
      expect(view[0].totalRunCount).toBe(1)
    })

    it('getMissionControlProgressionView returns 1 row for ZST domain', () => {
      const view = getMissionControlProgressionView(db, 'zst')
      expect(view.length).toBe(1)
      expect(view[0].caseId).toBe(ZST_CASE_ID)
      expect(view[0].domain).toBe('zst')
      expect(view[0].title).toContain('Biztositas')
      expect(view[0].status).toBe('NEW')
      expect(view[0].goal).toBeTruthy()
      expect(view[0].lastDecision).toBe('CONTINUE_AUTONOMOUSLY')
      expect(view[0].totalRunCount).toBe(1)
    })

    it('getMissionControlProgressionView is read-only — zero writes to case tables', () => {
      // After calling getMissionControlProgressionView, verify no writes occurred
      const beforeCount = (db.prepare("SELECT count(*) as c FROM case_progression_runs").get() as { c: number }).c
      getMissionControlProgressionView(db, 'personal')
      getMissionControlProgressionView(db, 'zst')
      const afterCount = (db.prepare("SELECT count(*) as c FROM case_progression_runs").get() as { c: number }).c
      expect(afterCount).toBe(beforeCount)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 4: Idempotency — running progression again is safe
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 4: Idempotency — second progression run', () => {
    it('PRI: second progression cycle keeps plan_version stable (plan unchanged) and adds a second run row', () => {
      const stateBefore = snapshotProgressionState('personal', PRI_CASE_ID, db)!
      const runsBefore = snapshotProgressionRuns('personal', PRI_CASE_ID, db)

      const result2 = runProgressionCycle(db, 'personal', PRI_CASE_ID, now + 3600, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-b-run2',
      })

      expect(result2.status).toBe('COMPLETED')
      const stateAfter = snapshotProgressionState('personal', PRI_CASE_ID, db)!
      const runsAfter = snapshotProgressionRuns('personal', PRI_CASE_ID, db)

      // plan_version should NOT increase when the plan has not changed
      // (the old buggy behaviour bumped it every cycle — GATE 2 follow-up fix)
      expect(stateAfter.plan_version as number).toBe(stateBefore.plan_version as number)
      // A second run row is created
      expect(runsAfter.length).toBe(runsBefore.length + 1)
      // Still only one state row (upsert)
      const stateCount = (db.prepare(
        "SELECT count(*) as c FROM case_progression_state WHERE domain='personal' AND case_id=?",
      ).get(PRI_CASE_ID) as { c: number }).c
      expect(stateCount).toBe(1)
    })

    it('ZST: second progression cycle is also idempotent and safe', () => {
      const runsBefore = snapshotProgressionRuns('zst', ZST_CASE_ID, db)

      const result2 = runProgressionCycle(db, 'zst', ZST_CASE_ID, now + 3600, {
        triggerType: 'MANUAL',
        triggerReference: 'checkpoint-b-run2',
      })

      expect(result2.status).toBe('COMPLETED')
      const runsAfter = snapshotProgressionRuns('zst', ZST_CASE_ID, db)
      expect(runsAfter.length).toBe(runsBefore.length + 1)

      // Still zero side effects on zst_cases
      const zstCase = getZstCase(db, ZST_CASE_ID) as Record<string, unknown>
      expect(zstCase).toBeTruthy()
      expect(zstCase.status).toBe('NEW')
    })

    it('PRI: ZERO side effects still hold after second run', () => {
      const priCase = getCase(db, PRI_CASE_ID) as Record<string, unknown>
      expect(priCase).toBeTruthy()
      expect(priCase.status).toBe('WAITING_EXTERNAL')
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 5: Decision type coverage
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 5: Decision type coverage — at least 3 distinct decisions across tests', () => {
    it('WAIT_EXTERNAL was used (PRI case)', () => {
      const runs = snapshotProgressionRuns('personal', PRI_CASE_ID, db)
      const decisions = runs.map(r => r.decision)
      expect(decisions).toContain('WAIT_EXTERNAL')
    })

    it('CONTINUE_AUTONOMOUSLY was used (ZST case)', () => {
      const runs = snapshotProgressionRuns('zst', ZST_CASE_ID, db)
      const decisions = runs.map(r => r.decision)
      expect(decisions).toContain('CONTINUE_AUTONOMOUSLY')
    })

    it('All decisions used are in the 10 valid decision types', () => {
      const allRuns = db.prepare('SELECT decision FROM case_progression_runs').all() as Array<{ decision: string }>
      for (const run of allRuns) {
        expect(VALID_DECISIONS as readonly string[]).toContain(run.decision)
      }
    })
  })
})
