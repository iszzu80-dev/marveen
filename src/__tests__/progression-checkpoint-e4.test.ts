// Progression Checkpoint E.4 tests — Semantic Completion (card 25e06d97).
// HIGHEST STAKES: DoD-based completion detection. A wrong COMPLETED silently
// closes a live case.
//
// Covers:
//   Stage 1: initializeDoDVerification — init + idempotent re-init
//   Stage 2: satisfyDoDCriterion — mark criterion met + idempotent no-op
//   Stage 3: evaluateDoDCompleteness — read DoD state
//   Stage 4: canCompleteCase — gate logic (no state, disabled, met, unmet)
//   Stage 5: RED-PROOF — DoD not met → cannot complete (3 criteria, 2 met → blocked)
//   Stage 6: RED-PROOF — Completion is idempotent (complete→complete still allowed)
//   Stage 7: RED-PROOF — Case close path guarded (transitionCase/transitionZstCase)
//   Stage 8: RED-PROOF — Progression pipeline downgrades COMPLETE to CONTINUE_AUTONOMOUSLY
//   Stage 9: Integration — full completion cycle (runs → gradual DoD → final complete)
//   Stage 10: Schema — dod_verification_json column
//   Stage 11: Domain-scoped — CrossDomainReadError
//
// ACCEPTANCE CRITERION: premature_completion = 0. Every RED-PROOF test must
// fail LOUD (throw / assert failure) on violation.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import {
  initializeDoDVerification,
  satisfyDoDCriterion,
  satisfyNextDoDCriterionWithEvidence,
  evaluateDoDCompleteness,
  canCompleteCase,
  guardCaseCompletion,
  completionActor,
  PrematureCompletionError,
  type DoDVerification,
  type CompletionGateResult,
  type DoDProvenance,
} from '../cos/progression-completion.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { CrossDomainReadError } from '../cos/progression-resolver.js'
import { transitionCase, type TransitionInput } from '../cos/case-store.js'
import { transitionZstCase } from '../cos/zst-case-store.js'

// ── Test helpers ──────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function seedProgressionState(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  overrides: {
    progression_enabled?: number
    progression_mode?: string
    definition_of_done_json?: string | null
    dod_verification_json?: string | null
    goal?: string | null
  } = {},
): void {
  const t = now()
  db.prepare(
    `INSERT INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode,
      definition_of_done_json, dod_verification_json,
      goal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    domain, caseId,
    overrides.progression_enabled ?? 1,
    overrides.progression_mode ?? 'shadow',
    overrides.definition_of_done_json ?? null,
    overrides.dod_verification_json ?? null,
    overrides.goal ?? null,
    t, t,
  )
}

function seedCase(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  status = 'NEW',
): void {
  const t = now()
  if (domain === 'personal') {
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
       VALUES (?, 'Test case', 'ADMIN', ?, 'PERSONAL', 1, ?, ?)`,
    ).run(caseId, status, t, t)
  } else {
    db.prepare(
      `INSERT INTO zst_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
       VALUES (?, 'Test case', 'ADMIN', ?, 'ZST_INTERNAL', 1, ?, ?)`,
    ).run(caseId, status, t, t)
  }
}

function seedCaseWithProgression(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  overrides: Parameters<typeof seedProgressionState>[3] = {},
): void {
  seedCase(db, domain, caseId)
  seedProgressionState(db, domain, caseId, overrides)
}

// ── Post-2026-08-10 shims ─────────────────────────────────────────────────
//
// This suite was written against the old signatures: a DoD had no provenance
// and a criterion needed no evidence. Those two absences ARE the bug that
// closed 26 live cases, so the signatures gained a required argument each.
//
// Rather than thread the new arguments through eighty call sites, the suite
// states its default once: unless a test says otherwise, it is exercising a
// real CASE_SPECIFIC contract whose criteria are met against real evidence —
// which is what every assertion below always meant. The tests that care about
// the new distinctions pass the arguments explicitly, and they are the ones
// added at the end of this file.
//
// The shims deliberately do NOT default the production functions. A default in
// the shim only relaxes this file; a default in the module would relax every
// future caller, which is precisely how the engine came to close cases on
// criteria nobody had checked.

function initDoD(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  criteria: string[],
  t: number,
  provenance: DoDProvenance = 'CASE_SPECIFIC',
): DoDVerification {
  return initializeDoDVerification(db, domain, caseId, criteria, provenance, t)
}

function satisfy(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  idx: number,
  runId: string,
  t: number,
  evidence = `case_event:${runId}-${idx}`,
): boolean {
  return satisfyDoDCriterion(db, domain, caseId, idx, runId, evidence, t)
}

function satisfyNext(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  runId: string,
  t: number,
  evidence = `case_event:${runId}`,
): number {
  return satisfyNextDoDCriterionWithEvidence(db, domain, caseId, runId, evidence, t)
}

// ── Stage 1: initializeDoDVerification ────────────────────────────────────

describe('Checkpoint E.4 — Semantic Completion', () => {
  describe('initializeDoDVerification()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('creates dod_verification_json with all criteria as unmet', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001')
      const criteria = ['Case triaged', 'Actions identified', 'Owner assigned']

      const verification = initDoD(db, 'personal', 'pri-001', criteria, t)

      expect(verification.criteria.length).toBe(3)
      expect(verification.criteria.every(c => c.met === false)).toBe(true)
      expect(verification.all_met).toBe(false)
      expect(verification.evaluated_at).toBe(t)
      expect(verification.evaluated_by_run).toBeNull()

      // Verify DB persistence
      const row = db.prepare(
        'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { dod_verification_json: string }

      const parsed = JSON.parse(row.dod_verification_json) as DoDVerification
      expect(parsed.criteria.length).toBe(3)
      expect(parsed.all_met).toBe(false)
    })

    it('is idempotent — second call returns existing verification unchanged', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002')
      const criteria = ['Step 1', 'Step 2']

      const v1 = initDoD(db, 'personal', 'pri-002', criteria, t)
      // Mark a criterion as met via satisfyDoDCriterion
      satisfy(db, 'personal', 'pri-002', 0, 'run-1', t + 1)

      // Second init should return existing state (not reset)
      const v2 = initDoD(db, 'personal', 'pri-002', ['Different'], t + 10)

      expect(v2.criteria.length).toBe(2) // original criteria, not the new ones
      expect(v2.criteria[0].met).toBe(true) // preserved
      expect(v2.criteria[0].met_by_run).toBe('run-1')
      expect(v2.criteria[1].met).toBe(false)
    })

    it('works for ZST domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-001')
      const criteria = ['ZST task done']

      initDoD(db, 'zst', 'zst-001', criteria, t)

      const row = db.prepare(
        'SELECT dod_verification_json FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('zst', 'zst-001') as { dod_verification_json: string }

      expect(JSON.parse(row.dod_verification_json).criteria.length).toBe(1)
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      seedCaseWithProgression(db, 'zst', 'zst-cross')
      expect(() =>
        initDoD(db, 'personal', 'zst-cross', ['Test'], now()),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 2: satisfyDoDCriterion ────────────────────────────────────────

  describe('satisfyDoDCriterion()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('marks a single criterion as met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001')
      initDoD(db, 'personal', 'pri-001', ['A', 'B', 'C'], t)

      const changed = satisfy(db, 'personal', 'pri-001', 0, 'run-1', t + 1)

      expect(changed).toBe(true)

      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-001')
      expect(comp.metCriteria).toBe(1)
      expect(comp.unmetCriteria).toEqual(['B', 'C'])
      expect(comp.allMet).toBe(false)
    })

    it('is idempotent — marking the same criterion twice is a no-op', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002')
      initDoD(db, 'personal', 'pri-002', ['A', 'B'], t)

      const first = satisfy(db, 'personal', 'pri-002', 0, 'run-1', t + 1)
      expect(first).toBe(true)

      const second = satisfy(db, 'personal', 'pri-002', 0, 'run-2', t + 2)
      expect(second).toBe(false) // no change

      // met_at and met_by_run should be from first call
      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-002')
      expect(comp.metCriteria).toBe(1)
      expect(comp.verification!.criteria[0].met_by_run).toBe('run-1')
      expect(comp.verification!.criteria[0].met_at).toBe(t + 1)
    })

    it('returns false when no dod_verification_json exists', () => {
      seedCaseWithProgression(db, 'personal', 'pri-003')
      const result = satisfy(db, 'personal', 'pri-003', 0, 'run-1', now())
      expect(result).toBe(false)
    })

    it('returns false for out-of-bounds criterion index', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-004')
      initDoD(db, 'personal', 'pri-004', ['A'], t)

      expect(satisfy(db, 'personal', 'pri-004', -1, 'run-1', t)).toBe(false)
      expect(satisfy(db, 'personal', 'pri-004', 5, 'run-1', t)).toBe(false)
    })

    it('sets all_met=true when the last unmet criterion is satisfied', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-005')
      initDoD(db, 'personal', 'pri-005', ['A', 'B'], t)

      satisfy(db, 'personal', 'pri-005', 0, 'run-1', t + 1)
      expect(evaluateDoDCompleteness(db, 'personal', 'pri-005').allMet).toBe(false)

      satisfy(db, 'personal', 'pri-005', 1, 'run-2', t + 2)
      expect(evaluateDoDCompleteness(db, 'personal', 'pri-005').allMet).toBe(true)
    })

    it('works for ZST domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-001')
      initDoD(db, 'zst', 'zst-001', ['ZST A', 'ZST B'], t)

      satisfy(db, 'zst', 'zst-001', 1, 'run-z', t + 1)

      const comp = evaluateDoDCompleteness(db, 'zst', 'zst-001')
      expect(comp.metCriteria).toBe(1)
      expect(comp.unmetCriteria).toEqual(['ZST A'])
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-cross')
      initDoD(db, 'zst', 'zst-cross', ['Test'], t)
      expect(() =>
        satisfy(db, 'personal', 'zst-cross', 0, 'run-1', t),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 2b: autoSatisfyNextDoDCriterion ───────────────────────────────

  describe('autoSatisfyNextDoDCriterion()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('satisfies the first unmet criterion on each call', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001')
      initDoD(db, 'personal', 'pri-001', ['A', 'B', 'C'], t)

      const idx1 = satisfyNext(db, 'personal', 'pri-001', 'r1', t + 1)
      expect(idx1).toBe(0)

      const idx2 = satisfyNext(db, 'personal', 'pri-001', 'r2', t + 2)
      expect(idx2).toBe(1)

      const idx3 = satisfyNext(db, 'personal', 'pri-001', 'r3', t + 3)
      expect(idx3).toBe(2)

      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-001')
      expect(comp.allMet).toBe(true)
    })

    it('returns -1 when all criteria are already met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002')
      initDoD(db, 'personal', 'pri-002', ['A'], t)
      satisfyNext(db, 'personal', 'pri-002', 'r1', t + 1)

      const idx = satisfyNext(db, 'personal', 'pri-002', 'r2', t + 2)
      expect(idx).toBe(-1)
    })

    it('returns -1 when no dod_verification exists', () => {
      seedCaseWithProgression(db, 'personal', 'pri-003')
      const idx = satisfyNext(db, 'personal', 'pri-003', 'r1', now())
      expect(idx).toBe(-1)
    })
  })

  // ── Stage 3: evaluateDoDCompleteness ─────────────────────────────────────

  describe('evaluateDoDCompleteness()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    // Changed 2026-08-10. This used to assert allMet=true, on the reasoning
    // "no criteria = nothing blocking completion". That reads an empty result
    // as a pass, which is the same shape of mistake as the auto-satisfier: an
    // absence of verification is not a successful verification. Nothing was
    // checked, so allMet is false, and canCompleteCase decides what to do
    // about it (owner: fine; engine: refuse).
    it('reports nothing verified — not everything satisfied — when no DoD set up', () => {
      seedCaseWithProgression(db, 'personal', 'pri-001')

      const result = evaluateDoDCompleteness(db, 'personal', 'pri-001')

      expect(result.totalCriteria).toBe(0)
      expect(result.allMet).toBe(false)
      expect(result.verification).toBeNull()
    })

    it('returns correct counts when some criteria are met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002')
      initDoD(db, 'personal', 'pri-002', ['A', 'B', 'C', 'D'], t)
      satisfy(db, 'personal', 'pri-002', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-002', 2, 'r2', t + 2)

      const result = evaluateDoDCompleteness(db, 'personal', 'pri-002')

      expect(result.totalCriteria).toBe(4)
      expect(result.metCriteria).toBe(2)
      expect(result.unmetCriteria).toEqual(['B', 'D'])
      expect(result.allMet).toBe(false)
    })

    it('returns allMet=true when all criteria satisfied', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-003')
      initDoD(db, 'personal', 'pri-003', ['X', 'Y'], t)
      satisfy(db, 'personal', 'pri-003', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-003', 1, 'r2', t + 2)

      const result = evaluateDoDCompleteness(db, 'personal', 'pri-003')

      expect(result.allMet).toBe(true)
      expect(result.metCriteria).toBe(2)
      expect(result.unmetCriteria).toEqual([])
    })
  })

  // ── Stage 4: canCompleteCase ─────────────────────────────────────────────

  describe('canCompleteCase()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('allows completion when no progression state exists (not progression-controlled)', () => {
      seedCase(db, 'personal', 'pri-001')

      const gate = canCompleteCase(db, 'personal', 'pri-001')

      expect(gate.allowed).toBe(true)
      expect(gate.reason).toContain('not under progression control')
    })

    it('allows completion when progression is disabled (enabled=0)', () => {
      seedCaseWithProgression(db, 'personal', 'pri-002', { progression_enabled: 0 })

      const gate = canCompleteCase(db, 'personal', 'pri-002')

      expect(gate.allowed).toBe(true)
      expect(gate.reason).toContain('disabled')
    })

    it('allows completion when all DoD criteria are met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-003')
      initDoD(db, 'personal', 'pri-003', ['A', 'B'], t)
      satisfy(db, 'personal', 'pri-003', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-003', 1, 'r2', t + 2)

      const gate = canCompleteCase(db, 'personal', 'pri-003')

      expect(gate.allowed).toBe(true)
      expect(gate.unmet).toEqual([])
    })

    // The old version of this test is worth keeping in view: its NAME said
    // "blocks completion", its assertion said allowed=true, and its comment
    // argued itself into that answer out loud ("But wait — the case IS
    // progression-enabled. Should it be blocked?"). It was right to hesitate.
    // A progression-enabled case with no DoD is a case the engine has verified
    // nothing about, and it closed on exactly that basis. The name was correct
    // and the assertion was not; the assertion has been brought into line.
    it('blocks the ENGINE when progression-enabled but DoD not yet initialised', () => {
      seedCaseWithProgression(db, 'personal', 'pri-004')

      const gate = canCompleteCase(db, 'personal', 'pri-004', 'ENGINE')

      expect(gate.allowed).toBe(false)
      expect(gate.reason).toMatch(/generic status template|nothing was verified/i)

      // The owner is not blocked by any of this. A case with no DoD is still a
      // case Istvan can declare finished.
      expect(canCompleteCase(db, 'personal', 'pri-004', 'OWNER').allowed).toBe(true)
    })

    it('blocks completion when some DoD criteria are unmet (2 of 3 met)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-005')
      initDoD(db, 'personal', 'pri-005', ['Do A', 'Do B', 'Do C'], t)
      satisfy(db, 'personal', 'pri-005', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-005', 2, 'r2', t + 2)
      // 'Do B' is still unmet

      const gate = canCompleteCase(db, 'personal', 'pri-005')

      expect(gate.allowed).toBe(false)
      expect(gate.reason).toContain('2/3')
      expect(gate.reason).toContain('Do B')
      expect(gate.unmet).toEqual(['Do B'])
    })

    it('blocks completion when ZERO DoD criteria are met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-006')
      initDoD(db, 'personal', 'pri-006', ['Task 1', 'Task 2', 'Task 3'], t)

      const gate = canCompleteCase(db, 'personal', 'pri-006')

      expect(gate.allowed).toBe(false)
      expect(gate.reason).toContain('0/3')
      expect(gate.unmet.length).toBe(3)
    })

    it('works for ZST domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-001')
      initDoD(db, 'zst', 'zst-001', ['ZST step'], t)
      satisfy(db, 'zst', 'zst-001', 0, 'rz', t + 1)

      const gate = canCompleteCase(db, 'zst', 'zst-001')
      expect(gate.allowed).toBe(true)
    })
  })

  // ── Stage 5: RED-PROOF — DoD not met → cannot complete ──────────────────

  describe('RED-PROOF: DoD not met → cannot complete', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('3 criteria, 2 met — canCompleteCase returns false', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-red-1')
      initDoD(db, 'personal', 'pri-red-1',
        ['Evidence A produced', 'Evidence B verified', 'Stakeholder C notified'], t)
      satisfy(db, 'personal', 'pri-red-1', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-red-1', 1, 'r2', t + 2)
      // Criterion 2 (Stakeholder C notified) is still unmet

      const gate = canCompleteCase(db, 'personal', 'pri-red-1')

      // MUST be blocked — this is the core safety invariant
      expect(gate.allowed).toBe(false)
      expect(gate.unmet).toEqual(['Stakeholder C notified'])
    })

    it('3 criteria, 3 met — canCompleteCase returns true', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-red-2')
      initDoD(db, 'personal', 'pri-red-2',
        ['Evidence A produced', 'Evidence B verified', 'Stakeholder C notified'], t)
      satisfy(db, 'personal', 'pri-red-2', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-red-2', 1, 'r2', t + 2)
      satisfy(db, 'personal', 'pri-red-2', 2, 'r3', t + 3)

      const gate = canCompleteCase(db, 'personal', 'pri-red-2')

      expect(gate.allowed).toBe(true)
      expect(gate.unmet).toEqual([])
    })

    it('guardCaseCompletion throws when DoD not met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-red-3')
      initDoD(db, 'personal', 'pri-red-3', ['A', 'B'], t)
      satisfy(db, 'personal', 'pri-red-3', 0, 'r1', t + 1)
      // B still unmet

      expect(() =>
        guardCaseCompletion(db, 'personal', 'pri-red-3'),
      ).toThrow(PrematureCompletionError)
    })

    it('guardCaseCompletion does NOT throw when DoD is met', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-red-4')
      initDoD(db, 'personal', 'pri-red-4', ['A'], t)
      satisfy(db, 'personal', 'pri-red-4', 0, 'r1', t + 1)

      expect(() =>
        guardCaseCompletion(db, 'personal', 'pri-red-4'),
      ).not.toThrow()
    })

    it('RED-PROOF: single unmet criterion among 5 blocks completion', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-red-5')
      initDoD(db, 'personal', 'pri-red-5',
        ['C1', 'C2', 'C3', 'C4', 'C5'], t)

      // Satisfy 4 of 5
      satisfy(db, 'personal', 'pri-red-5', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-red-5', 1, 'r2', t + 2)
      satisfy(db, 'personal', 'pri-red-5', 2, 'r3', t + 3)
      satisfy(db, 'personal', 'pri-red-5', 3, 'r4', t + 4)
      // C5 is still unmet

      const gate = canCompleteCase(db, 'personal', 'pri-red-5')
      expect(gate.allowed).toBe(false)
      expect(gate.unmet).toEqual(['C5'])

      // Cross-check with evaluateDoDCompleteness for the detail
      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-red-5')
      expect(comp.metCriteria).toBe(4)
      expect(comp.totalCriteria).toBe(5)
    })
  })

  // ── Stage 6: RED-PROOF — Completion is idempotent ───────────────────────

  describe('RED-PROOF: Completion is idempotent', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('once all DoD met, calling canCompleteCase twice returns the same answer', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-idem-1')
      initDoD(db, 'personal', 'pri-idem-1', ['Step 1', 'Step 2'], t)
      satisfy(db, 'personal', 'pri-idem-1', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-idem-1', 1, 'r2', t + 2)

      const gate1 = canCompleteCase(db, 'personal', 'pri-idem-1')
      const gate2 = canCompleteCase(db, 'personal', 'pri-idem-1')

      expect(gate1.allowed).toBe(true)
      expect(gate2.allowed).toBe(true)
      expect(gate1.reason).toBe(gate2.reason)
    })

    it('once all DoD met, guardCaseCompletion does not throw on repeated calls', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-idem-2')
      initDoD(db, 'personal', 'pri-idem-2', ['Task'], t)
      satisfy(db, 'personal', 'pri-idem-2', 0, 'r1', t + 1)

      // Multiple calls — all must pass without error
      expect(() => guardCaseCompletion(db, 'personal', 'pri-idem-2')).not.toThrow()
      expect(() => guardCaseCompletion(db, 'personal', 'pri-idem-2')).not.toThrow()
      expect(() => guardCaseCompletion(db, 'personal', 'pri-idem-2')).not.toThrow()
    })

    it('evaluateDoDCompleteness returns same result after repeated calls', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-idem-3')
      initDoD(db, 'personal', 'pri-idem-3', ['A', 'B'], t)

      const r1 = evaluateDoDCompleteness(db, 'personal', 'pri-idem-3')
      const r2 = evaluateDoDCompleteness(db, 'personal', 'pri-idem-3')

      expect(r1.allMet).toBe(r2.allMet)
      expect(r1.metCriteria).toBe(r2.metCriteria)
      expect(r1.unmetCriteria).toEqual(r2.unmetCriteria)
    })
  })

  // ── Stage 7: RED-PROOF — Case close path guarded ────────────────────────

  describe('RED-PROOF: Case close path guarded (transitionCase/transitionZstCase)', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    // Changed 2026-08-10: the actor now decides. This test used to close as
    // actor 'test' and expect a throw, which made the guard a wall in front of
    // the owner as well as the engine — and once the auto-satisfier was gone,
    // that wall would have stood in front of EVERY human close forever, since
    // nothing satisfies criteria any more. The engine is what must be stopped.
    it('transitionCase blocks the ENGINE closing on an unmet DoD', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-close-1', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-close-1', ['A', 'B'], t)
      satisfy(db, 'personal', 'pri-close-1', 0, 'r1', t + 1)
      // 'B' is still unmet

      expect(() =>
        transitionCase(db, {
          caseId: 'pri-close-1',
          newStatus: 'COMPLETED',
          actor: 'progression-engine',
          seenVersion: 1,
        }, t + 10),
      ).toThrow(PrematureCompletionError)
    })

    it('transitionCase lets the OWNER close the very same case', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-close-1b', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-close-1b', ['A', 'B'], t)
      // nothing satisfied at all — the owner still decides

      expect(() =>
        transitionCase(db, {
          caseId: 'pri-close-1b',
          newStatus: 'COMPLETED',
          actor: 'istvan',
          seenVersion: 1,
        }, t + 10),
      ).not.toThrow()
    })

    it('transitionCase allows COMPLETED when DoD is met (progression-enabled case)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-close-2', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-close-2', ['A', 'B'], t)
      satisfy(db, 'personal', 'pri-close-2', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-close-2', 1, 'r2', t + 2)

      const newVersion = transitionCase(db, {
        caseId: 'pri-close-2',
        newStatus: 'COMPLETED',
        actor: 'test',
        seenVersion: 1,
      }, t + 10)

      expect(newVersion).toBe(2)

      // Verify case is now COMPLETED
      const row = db.prepare(
        'SELECT status, completed_at FROM personal_cases WHERE case_id = ?',
      ).get('pri-close-2') as { status: string; completed_at: number | null }

      expect(row.status).toBe('COMPLETED')
      expect(row.completed_at).not.toBeNull()
    })

    it('transitionCase allows COMPLETED when progression is disabled (legacy path)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-close-3', {
        progression_enabled: 0,
      })

      // Legacy close should work regardless of DoD state
      const newVersion = transitionCase(db, {
        caseId: 'pri-close-3',
        newStatus: 'COMPLETED',
        actor: 'test',
        seenVersion: 1,
      }, t)

      expect(newVersion).toBe(2)
    })

    it('transitionCase allows COMPLETED when no progression state exists', () => {
      const t = now()
      seedCase(db, 'personal', 'pri-close-4')

      const newVersion = transitionCase(db, {
        caseId: 'pri-close-4',
        newStatus: 'COMPLETED',
        actor: 'test',
        seenVersion: 1,
      }, t)

      expect(newVersion).toBe(2)
    })

    it('transitionCase does NOT block non-COMPLETED transitions (e.g. BLOCKED)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-close-5', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-close-5', ['A'], t)
      // DoD not met, but we're not transitioning to COMPLETED — allowed

      expect(() =>
        transitionCase(db, {
          caseId: 'pri-close-5',
          newStatus: 'BLOCKED',
          actor: 'test',
          seenVersion: 1,
        }, t + 10),
      ).not.toThrow()
    })

    it('transitionZstCase blocks the ENGINE closing on an unmet DoD (ZST)', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-close-1', {
        progression_enabled: 1,
      })
      initDoD(db, 'zst', 'zst-close-1', ['ZST A', 'ZST B'], t)
      satisfy(db, 'zst', 'zst-close-1', 0, 'rz1', t + 1)
      // 'ZST B' unmet

      expect(() =>
        transitionZstCase(db, {
          caseId: 'zst-close-1',
          newStatus: 'COMPLETED',
          actor: 'progression-engine',
          seenVersion: 1,
        }, t + 10),
      ).toThrow(PrematureCompletionError)
    })

    it('transitionZstCase allows COMPLETED when DoD is met (ZST)', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-close-2', {
        progression_enabled: 1,
      })
      initDoD(db, 'zst', 'zst-close-2', ['ZST task'], t)
      satisfy(db, 'zst', 'zst-close-2', 0, 'rz1', t + 1)

      const newVersion = transitionZstCase(db, {
        caseId: 'zst-close-2',
        newStatus: 'COMPLETED',
        actor: 'test',
        seenVersion: 1,
      }, t + 10)

      expect(newVersion).toBe(2)
    })
  })

  // ── Stage 8: RED-PROOF — Pipeline downgrades COMPLETE ───────────────────

  describe('RED-PROOF: Pipeline downgrades COMPLETE when DoD not met', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('runProgressionCycle downgrades COMPLETE decision to CONTINUE_AUTONOMOUSLY when DoD unmet', () => {
      const t = now()
      // Seed case directly with COMPLETED status so decide() returns COMPLETE
      seedCase(db, 'personal', 'pri-pipe-1', 'COMPLETED')
      seedProgressionState(db, 'personal', 'pri-pipe-1', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-pipe-1', ['A', 'B', 'C'], t)
      satisfy(db, 'personal', 'pri-pipe-1', 0, 'r1', t + 1)
      // B and C are unmet

      const result = runProgressionCycle(db, 'personal', 'pri-pipe-1', t + 10)

      // The decision should be downgraded from COMPLETE to CONTINUE_AUTONOMOUSLY
      expect(result.decision).toBe('CONTINUE_AUTONOMOUSLY')
      expect(result.reason).toContain('DoD not met')
      expect(result.status).toBe('COMPLETED') // the run itself was successful, just the decision was downgraded
    })

    it('runProgressionCycle allows COMPLETE when DoD is met for COMPLETED-status case', () => {
      const t = now()
      seedCase(db, 'personal', 'pri-pipe-2', 'COMPLETED')
      seedProgressionState(db, 'personal', 'pri-pipe-2', {
        progression_enabled: 1,
      })
      initDoD(db, 'personal', 'pri-pipe-2', ['A', 'B'], t)
      satisfy(db, 'personal', 'pri-pipe-2', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-pipe-2', 1, 'r2', t + 2)

      const result = runProgressionCycle(db, 'personal', 'pri-pipe-2', t + 10)

      // DoD is met — COMPLETE should be allowed
      expect(result.decision).toBe('COMPLETE')
    })
  })

  // ── Stage 9: Integration — full completion cycle ────────────────────────

  describe('Integration: full completion cycle', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    // REPLACED 2026-08-10, and this is the most important edit in the change.
    //
    // This test used to be called "case goes through gradual DoD satisfaction
    // → eventually completes", and it was green every day. It drove three
    // progression cycles and asserted metCriteria 1, then 2, then 3, then
    // COMPLETE. Every assertion held. The suite therefore certified, run after
    // run, that a case closes itself after three wake-ups with nothing done to
    // it — because the test asked whether the counter went up, and the counter
    // going up WAS the bug. A test can only catch what it thinks to ask.
    //
    // What replaces it asks the opposite question, and it is the regression
    // test for the 2026-08-09 incident: drive the engine repeatedly over a case
    // it has no contract for, and require that nothing closes, however long it
    // runs.
    it('REGRESSION 2026-08-09: repeated cycles never close a case on a generic DoD', () => {
      const t = now()
      seedCase(db, 'personal', 'pri-full', 'COMPLETED')
      seedProgressionState(db, 'personal', 'pri-full', {
        progression_enabled: 1,
      })

      // Six cycles: two more than the four it took live to close all 27
      // corporate cases in the backup-copy dry run.
      for (let i = 0; i < 6; i++) {
        const r = runProgressionCycle(db, 'personal', 'pri-full', t + i)
        expect(r.status).toBe('COMPLETED')          // the RUN succeeds
        expect(r.decision).not.toBe('COMPLETE')     // the CASE does not close
      }

      // Nothing was ever ticked off, because nothing produced evidence.
      const after = evaluateDoDCompleteness(db, 'personal', 'pri-full')
      expect(after.metCriteria).toBe(0)
      expect(after.allMet).toBe(false)
      expect(after.verification?.provenance).toBe('GENERIC_STATUS_TEMPLATE')

      // And the gate refuses the engine for the reason that matters: the DoD
      // is not this case's DoD. Even ticking every criterion by hand would not
      // change that answer.
      const gate = canCompleteCase(db, 'personal', 'pri-full', 'ENGINE')
      expect(gate.allowed).toBe(false)
      expect(gate.reason).toMatch(/generic status template/i)
    })

    it('a fully satisfied GENERIC DoD still does not let the engine close', () => {
      // The provenance gate is not a stand-in for unmet criteria — it is a
      // separate refusal. Satisfying every criterion with real evidence must
      // not buy a template-derived contract its way past it, or the fix would
      // last exactly as long as it takes something to start satisfying them.
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-generic-full')
      initDoD(db, 'personal', 'pri-generic-full', ['A', 'B'], t, 'GENERIC_STATUS_TEMPLATE')
      expect(satisfy(db, 'personal', 'pri-generic-full', 0, 'r1', t + 1)).toBe(true)
      expect(satisfy(db, 'personal', 'pri-generic-full', 1, 'r2', t + 2)).toBe(true)

      expect(evaluateDoDCompleteness(db, 'personal', 'pri-generic-full').allMet).toBe(true)
      expect(canCompleteCase(db, 'personal', 'pri-generic-full', 'ENGINE').allowed).toBe(false)
      // …and the same state under a case-specific contract DOES pass, so the
      // refusal above is the provenance and nothing else.
      seedCaseWithProgression(db, 'personal', 'pri-specific-full')
      initDoD(db, 'personal', 'pri-specific-full', ['A', 'B'], t, 'CASE_SPECIFIC')
      satisfy(db, 'personal', 'pri-specific-full', 0, 'r1', t + 1)
      satisfy(db, 'personal', 'pri-specific-full', 1, 'r2', t + 2)
      expect(canCompleteCase(db, 'personal', 'pri-specific-full', 'ENGINE').allowed).toBe(true)
    })

    it('case without progression state can still be closed (backward compatible)', () => {
      const t = now()
      seedCase(db, 'personal', 'pri-legacy')

      const newVersion = transitionCase(db, {
        caseId: 'pri-legacy',
        newStatus: 'COMPLETED',
        actor: 'test',
        seenVersion: 1,
      }, t)

      expect(newVersion).toBe(2)

      const row = db.prepare('SELECT status FROM personal_cases WHERE case_id = ?')
        .get('pri-legacy') as { status: string }
      expect(row.status).toBe('COMPLETED')
    })
  })

  // ── Stage 10: Schema — dod_verification_json column ─────────────────────

  describe('Schema — dod_verification_json column', () => {
    it('dod_verification_json column exists after initProgressionSchema', () => {
      const db = freshDb()
      const cols = db.prepare('PRAGMA table_info(case_progression_state)').all() as Array<{ name: string }>
      const col = cols.find(c => c.name === 'dod_verification_json')

      expect(col).toBeDefined()
    })

    it('ensureColumns adds dod_verification_json to existing table without the column', () => {
      const db = freshDb()

      // Simulate an old DB without dod_verification_json.
      // Must include columns referenced by CREATE INDEX in initProgressionSchema
      // (next_progression_at, progression_claimed_by, progression_claim_expires_at)
      // so the migration can run without "no such column" errors.
      db.exec(`DROP TABLE IF EXISTS case_progression_state`)
      db.exec(`
        CREATE TABLE case_progression_state (
          domain TEXT NOT NULL,
          case_id TEXT NOT NULL,
          goal TEXT,
          definition_of_done_json TEXT,
          success_evidence_requirements_json TEXT,
          semantic_completion_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
          rolling_plan_json TEXT,
          plan_version INTEGER NOT NULL DEFAULT 0,
          next_best_action_json TEXT,
          progression_enabled INTEGER NOT NULL DEFAULT 0,
          progression_mode TEXT NOT NULL DEFAULT 'off',
          next_progression_at INTEGER,
          last_progressed_at INTEGER,
          progression_claimed_by TEXT,
          progression_claim_expires_at INTEGER,
          blocked_reason TEXT,
          waiting_on TEXT,
          interruption_count INTEGER NOT NULL DEFAULT 0,
          no_progress_run_count INTEGER NOT NULL DEFAULT 0,
          goal_version INTEGER NOT NULL DEFAULT 0,
          case_version INTEGER NOT NULL DEFAULT 0,
          resolution_audit_json TEXT,
          summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (domain, case_id)
        )
      `)

      // Column not present
      let cols = db.prepare('PRAGMA table_info(case_progression_state)').all() as Array<{ name: string }>
      expect(cols.some(c => c.name === 'dod_verification_json')).toBe(false)

      // Run migration
      initProgressionSchema(db)

      // Column now present
      cols = db.prepare('PRAGMA table_info(case_progression_state)').all() as Array<{ name: string }>
      expect(cols.some(c => c.name === 'dod_verification_json')).toBe(true)
    })
  })

  // ── Stage 11: Domain-scoped — CrossDomainReadError ──────────────────────

  describe('Domain-scoped — CrossDomainReadError', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('initializeDoDVerification throws CrossDomainReadError for cross-domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-dod-err')
      expect(() =>
        initDoD(db, 'personal', 'zst-dod-err', ['Test'], t),
      ).toThrow(CrossDomainReadError)
    })

    it('satisfyDoDCriterion throws CrossDomainReadError for cross-domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-dod-err2')
      initDoD(db, 'zst', 'zst-dod-err2', ['Test'], t)
      expect(() =>
        satisfy(db, 'personal', 'zst-dod-err2', 0, 'r1', t),
      ).toThrow(CrossDomainReadError)
    })

    it('evaluateDoDCompleteness throws CrossDomainReadError for cross-domain', () => {
      seedCaseWithProgression(db, 'zst', 'zst-eval-err')
      expect(() =>
        evaluateDoDCompleteness(db, 'personal', 'zst-eval-err'),
      ).toThrow(CrossDomainReadError)
    })

    it('canCompleteCase throws CrossDomainReadError for cross-domain', () => {
      seedCaseWithProgression(db, 'zst', 'zst-gate-err')
      expect(() =>
        canCompleteCase(db, 'personal', 'zst-gate-err'),
      ).toThrow(CrossDomainReadError)
    })

    it('satisfyNextDoDCriterionWithEvidence throws CrossDomainReadError for cross-domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-auto-err')
      initDoD(db, 'zst', 'zst-auto-err', ['Test'], t)
      expect(() =>
        satisfyNext(db, 'personal', 'zst-auto-err', 'r1', t),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 12: the 2026-08-09 defects, one test each ─────────────────────
  //
  // Every test in this group fails on the code as it stood on 2026-08-09. That
  // is the bar: a regression test that also passes against the broken version
  // documents a preference, not a defect.

  describe('evidence is required to satisfy a criterion', () => {
    let db: Database.Database
    beforeEach(() => { db = freshDb() })

    it('refuses a criterion with no evidence reference, and writes nothing', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-ev-1')
      initDoD(db, 'personal', 'pri-ev-1', ['A'], t)

      // Empty and whitespace-only are both refusals, not "close enough".
      expect(satisfyDoDCriterion(db, 'personal', 'pri-ev-1', 0, 'r1', '', t + 1)).toBe(false)
      expect(satisfyDoDCriterion(db, 'personal', 'pri-ev-1', 0, 'r1', '   ', t + 2)).toBe(false)

      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-ev-1')
      expect(comp.metCriteria).toBe(0)
      expect(comp.verification?.criteria[0].met).toBe(false)
    })

    it('records what proved it when evidence is given', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-ev-2')
      initDoD(db, 'personal', 'pri-ev-2', ['A'], t)

      expect(satisfyDoDCriterion(db, 'personal', 'pri-ev-2', 0, 'r1', 'case_event:4711', t + 1)).toBe(true)

      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-ev-2')
      expect(comp.verification?.criteria[0].met_by_evidence).toBe('case_event:4711')
      expect(comp.verification?.criteria[0].met_by_run).toBe('r1')
    })

    it('satisfyNext refuses without evidence and touches nothing', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-ev-3')
      initDoD(db, 'personal', 'pri-ev-3', ['A', 'B'], t)

      expect(satisfyNextDoDCriterionWithEvidence(db, 'personal', 'pri-ev-3', 'r1', '', t + 1)).toBe(-1)
      expect(evaluateDoDCompleteness(db, 'personal', 'pri-ev-3').metCriteria).toBe(0)
    })
  })

  describe('rows written before the fix do not read as verified', () => {
    let db: Database.Database
    beforeEach(() => { db = freshDb() })

    // This is the live data as of 2026-08-10: 58 progression rows whose
    // verification JSON has no provenance field and whose criteria were ticked
    // with no evidence. If the fix trusted those fields, every one of them
    // would still be closeable, and re-enabling the engine would finish the
    // job the incident started.
    const LEGACY_JSON = JSON.stringify({
      criteria: [
        { label: 'Case triaged', met: true, met_at: 1, met_by_run: 'r1' },
        { label: 'Required actions identified', met: true, met_at: 2, met_by_run: 'r2' },
        { label: 'Owner assigned', met: true, met_at: 3, met_by_run: 'r3' },
      ],
      all_met: true,
      evaluated_at: 3,
      evaluated_by_run: 'r3',
    })

    it('a pre-fix all_met=true row is not enough for the engine to close', () => {
      seedCaseWithProgression(db, 'personal', 'pri-legacy-1', {
        dod_verification_json: LEGACY_JSON,
      })

      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-legacy-1')
      expect(comp.totalCriteria).toBe(3)
      expect(comp.metCriteria).toBe(0)      // ticked, but nothing proves any of them
      expect(comp.allMet).toBe(false)       // despite all_met:true in the stored JSON

      expect(canCompleteCase(db, 'personal', 'pri-legacy-1', 'ENGINE').allowed).toBe(false)
      expect(canCompleteCase(db, 'personal', 'pri-legacy-1', 'OWNER').allowed).toBe(true)
    })

    it('a missing provenance field reads as generic, not as case-specific', () => {
      seedCaseWithProgression(db, 'personal', 'pri-legacy-2', {
        dod_verification_json: LEGACY_JSON,
      })
      const comp = evaluateDoDCompleteness(db, 'personal', 'pri-legacy-2')
      expect(comp.verification?.provenance).toBe('GENERIC_STATUS_TEMPLATE')
    })
  })

  describe('completionActor maps the case-event actor to a gate side', () => {
    it('only the progression engine is the engine', () => {
      expect(completionActor('progression-engine')).toBe('ENGINE')
      expect(completionActor('istvan')).toBe('OWNER')
      expect(completionActor('marveen')).toBe('OWNER')
      expect(completionActor(null)).toBe('OWNER')
      expect(completionActor(undefined)).toBe('OWNER')
      // A near-miss must not be read as the engine — the mapping is exact, so
      // a renamed engine actor fails open to OWNER (visible) rather than
      // silently granting itself the engine's exemption from nothing.
      expect(completionActor('progression-engine-v2')).toBe('OWNER')
    })
  })
})
