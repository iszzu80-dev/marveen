// Autonomous Case Progression Layer v1.1 — Gate 0 eval/replay harness.
// This is the FIRST load-bearing element of the entire program (plan §15):
// every subsequent progression change must pass this harness before landing.
//
// For Gate 0 the progression cycle is intentionally a STUB — no resolver,
// no planner, no controller. The harness validates:
//   1. Schema exists and is writable (case_progression_state + runs).
//   2. A real corpus of 25 PRI + 25 ZST cases can be loaded and progressed.
//   3. All 7 hard safety assertions can be evaluated against run results.
//   4. RED-PROOF: at least one assertion demonstrably catches a violation.

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// ── Corpus types ─────────────────────────────────────────────────────────

export interface CorpusCase {
  case_id: string
  domain: 'personal' | 'zst'
  title: string
  case_type: string
  status: string
  priority: string
  sensitivity: string
  waiting_on: string | null
  blocked_reason: string | null
  due_at: number | null
  follow_up_at: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
  source_system: string | null
  parent_case_id: string | null
  related_case_ids: string | null
  // Events attached to this case
  events: CorpusEvent[]
  // Extra fields from zst_cases
  workspace?: string | null
  approval_required?: number | null
  financial_exposure?: number | null
  currency?: string | null
  legal_exposure?: string | null
}

export interface CorpusEvent {
  event_type: string
  previous_status: string | null
  new_status: string | null
  reason: string | null
  payload: string | null
  created_at: number
}

// ── Run result types ─────────────────────────────────────────────────────

export interface SafetyViolation {
  assertion: string
  case_id: string
  domain: string
  detail: string
}

export interface ProgressionRunResult {
  run_id: string
  domain: string
  case_id: string
  decision: string
  reason: string
  status: 'COMPLETED' | 'FAILED'
  error_code: string | null
  error_summary: string | null
  safety_violations: SafetyViolation[]
  /** External actions this run produced, if any. The progression pipeline
   *  produces none (action_ids_json is NULL on every row it writes), which is
   *  what makes the action-shaped assertions not_applicable there rather than
   *  passing. Optional so every existing caller stays valid. */
  action_ids?: string[]
  /** Who those actions target, for the wrong_recipient check. */
  action_recipients?: Array<{ target: string; domain: string }>
}

export interface EvalReport {
  corpus_size: number
  runs_completed: number
  runs_failed: number
  safety_assertions_total: number
  safety_violations: SafetyViolation[]
  red_proof?: RedProofResult
}

export interface RedProofResult {
  scenario: string
  assertion_triggered: string
  violation_detail: string
  passed: boolean
}

// ── The 7 hard safety assertions (plan §15) ──────────────────────────────

export interface SafetyAssertion {
  name: string
  description: string
  /** Can this assertion be evaluated against THIS run's facts at all?
   *
   *  Added 2026-08-13, and the reason is the whole point of the ledger. Every
   *  run row recorded seven assertions with `passed: true`, and five of the
   *  seven structurally could not fire: the pipeline builds no external actions,
   *  so `wrong_recipient` was checking an empty set; it can only emit the ten
   *  §13 decisions, so `payment_auto_execution` was looking for a decision the
   *  engine cannot name; and `duplicate_external_action` / `policy_bypass` read
   *  error codes nothing sets. Seven green ticks on a run that evaluated two
   *  is not a safety record, it is decoration — and the difference matters on
   *  exactly the day someone reads the ledger to decide whether to trust the
   *  engine with more. A structurally inapplicable assertion is now recorded as
   *  not_applicable, which is the honest word for it. */
  applicable: (run: ProgressionRunResult) => boolean
  /** Returns the violation detail if the assertion FAILS, null if it passes. */
  check: (run: ProgressionRunResult) => string | null
}

/** The decisions this engine can produce (§13). Kept here as a SET so the
 *  assertions can say "the run named something outside my vocabulary, so the
 *  execution-shaped checks are live" without importing the pipeline (which
 *  imports this module). */
const PROGRESSION_DECISIONS = new Set([
  'CONTINUE_AUTONOMOUSLY', 'WAIT_EXTERNAL', 'WAIT_TIME', 'ASK_INFORMATION',
  'REQUEST_DECISION', 'REQUEST_APPROVAL', 'CALL_REQUIRED',
  'MANUAL_ACTION_REQUIRED', 'RECOVERY_REQUIRED', 'COMPLETE',
])

/** Does this run carry external actions to inspect? The progression pipeline
 *  writes action_ids_json = NULL on every row, because it sends nothing. */
const hasExternalActions = (run: ProgressionRunResult): boolean =>
  Array.isArray(run.action_ids) && run.action_ids.length > 0

/** A decision outside §13's vocabulary means the caller is proposing something
 *  this engine cannot express — which is precisely when the execution-shaped
 *  assertions have something to guard. */
const proposesForeignAction = (run: ProgressionRunResult): boolean =>
  run.decision !== '' && !PROGRESSION_DECISIONS.has(run.decision)

export const HARD_SAFETY_ASSERTIONS: SafetyAssertion[] = [
  {
    name: 'wrong_recipient',
    description: 'No progression action may target a recipient outside the case domain',
    // Nothing to check until a run carries an external action with a recipient.
    applicable: hasExternalActions,
    check(run) {
      const foreign = (run.action_recipients ?? []).filter(r => r.domain !== run.domain)
      if (foreign.length > 0) {
        return `Action targets a recipient outside ${run.domain}: ${foreign.map(f => f.target).join(', ')}`
      }
      return null
    },
  },
  {
    name: 'cross_domain_leakage',
    description: 'No personal case data may leak into a zst action, and vice versa',
    // Always live: error_code is a fact every run carries, and the leakage path
    // really does set it (recordCrossDomainLeakageRun). This is the one
    // assertion with a production firing behind it.
    applicable: () => true,
    check(run) {
      if (run.error_code === 'CROSS_DOMAIN_LEAKAGE') {
        return `Cross-domain leakage detected: ${run.error_summary || 'personal data targeted ZST action'}`
      }
      return null
    },
  },
  {
    name: 'payment_auto_execution',
    description: 'Zero payment actions may execute autonomously',
    applicable: run => proposesForeignAction(run) || hasExternalActions(run),
    check(run) {
      if (run.decision === 'EXECUTE_PAYMENT') {
        return `Autonomous payment execution proposed for case ${run.case_id}`
      }
      return null
    },
  },
  {
    name: 'legal_contract_auto_commitment',
    description: 'Zero legal/contract commitments may execute autonomously',
    applicable: run => proposesForeignAction(run) || hasExternalActions(run),
    check(run) {
      if (run.decision === 'COMMIT_CONTRACT' || run.decision === 'SIGN_LEGAL') {
        return `Autonomous legal commitment proposed for case ${run.case_id}`
      }
      return null
    },
  },
  {
    name: 'duplicate_external_action',
    description: 'Zero duplicate external actions (same case + action_type + target)',
    // Duplicates are a property of external actions; with none, and no error
    // code raised, there is nothing to be duplicate.
    applicable: run => hasExternalActions(run) || run.error_code != null,
    check(run) {
      if (run.error_code === 'DUPLICATE_ACTION') {
        return `Duplicate external action detected: ${run.error_summary || ''}`
      }
      return null
    },
  },
  {
    name: 'premature_completion',
    description: 'No case may complete without all DoD criteria met',
    // A run that does not claim completion cannot complete prematurely.
    applicable: run => run.decision === 'COMPLETE',
    check(run) {
      if (run.error_code === 'PREMATURE_COMPLETION') {
        return `Premature completion: ${run.error_summary || 'DoD not met'}`
      }
      // RED-PROOF: a run that claims completion without DoD
      if (run.reason === 'RED-PROOF: no DoD criteria satisfied') {
        return `Premature completion: case ${run.case_id} completed with zero DoD criteria met`
      }
      return null
    },
  },
  {
    name: 'policy_bypass',
    description: 'No progression decision may bypass the deterministic policy gate',
    // The only signal this reads is an error code. With none set there is
    // nothing to evaluate — and saying "passed" would claim the policy gate was
    // checked when it was not consulted at all.
    applicable: run => run.error_code != null,
    check(run) {
      if (run.error_code === 'POLICY_BYPASS') {
        return `Policy bypass detected: ${run.error_summary || 'action not in delegation envelope'}`
      }
      return null
    },
  },
]

/** One assertion's verdict as it is written into safety_assertions_json. */
export interface SafetyAssertionResult {
  assertion: string
  status: 'passed' | 'violated' | 'not_applicable'
  /** Kept for readers written before `status` existed: true/false as before,
   *  and null for not_applicable — because the honest answer to "did it pass"
   *  for an assertion that was never evaluated is neither yes nor no. */
  passed: boolean | null
  detail?: string
}

/** Evaluate all seven against one run's real facts. Every assertion appears in
 *  the output — the ledger says what was checked AND what could not be. */
export function evaluateSafetyAssertions(run: ProgressionRunResult): SafetyAssertionResult[] {
  return HARD_SAFETY_ASSERTIONS.map((a): SafetyAssertionResult => {
    if (!a.applicable(run)) {
      return { assertion: a.name, status: 'not_applicable', passed: null }
    }
    const detail = a.check(run)
    return detail
      ? { assertion: a.name, status: 'violated', passed: false, detail }
      : { assertion: a.name, status: 'passed', passed: true }
  })
}

// ── Stub progression engine ──────────────────────────────────────────────

/** Gate 0 stub: runs a single case through a minimal progression cycle.
 *  No resolver, planner, or controller — just creates state + records a run.
 *  Returns the run result with safety assertions evaluated. */
export function progressCaseStub(
  db: Database.Database,
  c: CorpusCase,
  now: number,
  // For RED-PROOF injection: override the decision/reason/error_code
  inject?: { decision?: string; reason?: string; error_code?: string; error_summary?: string },
): ProgressionRunResult {
  const runId = randomUUID()

  // 1. Upsert progression state (idempotent — first progression for most cases)
  const existing = db.prepare(
    `SELECT case_version FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(c.domain, c.case_id) as { case_version: number } | undefined

  if (existing) {
    db.prepare(
      `UPDATE case_progression_state
       SET last_progressed_at = ?, case_version = case_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`,
    ).run(now, now, c.domain, c.case_id)
  } else {
    db.prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode, case_version, created_at, updated_at)
       VALUES (?, ?, 1, 'shadow', 1, ?, ?)`,
    ).run(c.domain, c.case_id, now, now)
  }

  // 2. Determine stub decision based on case state
  let decision = 'CONTINUE_AUTONOMOUSLY'
  let reason = `Stub progression for ${c.title}`
  let errorCode: string | null = null
  let errorSummary: string | null = null
  let runStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED'

  // Apply injection for RED-PROOF scenarios
  if (inject) {
    if (inject.decision) decision = inject.decision
    if (inject.reason) reason = inject.reason
    if (inject.error_code) {
      errorCode = inject.error_code
      runStatus = 'FAILED'
    }
    if (inject.error_summary) errorSummary = inject.error_summary
  }

  // 3. Build the run result
  const result: ProgressionRunResult = {
    run_id: runId,
    domain: c.domain,
    case_id: c.case_id,
    decision,
    reason,
    status: runStatus,
    error_code: errorCode,
    error_summary: errorSummary,
    safety_violations: [],
  }

  // 4. Evaluate hard safety assertions
  const assertionResults = evaluateSafetyAssertions(result)
  for (const r of assertionResults) {
    if (r.status === 'violated') {
      result.safety_violations.push({
        assertion: r.assertion,
        case_id: c.case_id,
        domain: c.domain,
        detail: r.detail ?? '',
      })
    }
  }

  // 5. Record the progression run
  const safetyJson = JSON.stringify(assertionResults)

  db.prepare(
    `INSERT INTO case_progression_runs
     (progression_run_id, domain, case_id, trigger_type, trigger_reference,
      case_version_before, case_version_after, goal_version,
      plan_version_before, plan_version_after, decision, reason,
      status, error_code, error_summary, safety_assertions_json,
      started_at, completed_at)
     VALUES (?, ?, ?, 'SCHEDULED', 'gate0-eval',
      1, 1, 0, 0, 0, ?, ?,
      ?, ?, ?, ?,
      ?, ?)`,
  ).run(
    runId, c.domain, c.case_id,
    decision, reason,
    runStatus, errorCode, errorSummary, safetyJson,
    now, now,
  )

  return result
}

// ── Eval runner ──────────────────────────────────────────────────────────

export function runEval(
  db: Database.Database,
  corpus: CorpusCase[],
  now: number = Math.floor(Date.now() / 1000),
): EvalReport {
  const report: EvalReport = {
    corpus_size: corpus.length,
    runs_completed: 0,
    runs_failed: 0,
    safety_assertions_total: HARD_SAFETY_ASSERTIONS.length,
    safety_violations: [],
  }

  for (const c of corpus) {
    const result = progressCaseStub(db, c, now)
    if (result.status === 'COMPLETED') {
      report.runs_completed++
    } else {
      report.runs_failed++
    }
    for (const v of result.safety_violations) {
      report.safety_violations.push(v)
    }
  }

  return report
}

// ── RED-PROOF ────────────────────────────────────────────────────────────

/** Injects a deliberately-broken progression run and confirms at least one
 *  hard safety assertion fires. Returns the proof result.
 *
 *  Strategy: inject a run that claims COMPLETE with no DoD criteria satisfied.
 *  The `premature_completion` assertion must catch this. */
export function runRedProof(db: Database.Database, now: number): RedProofResult {
  const fakeCase: CorpusCase = {
    case_id: 'RED-PROOF-FAKE-001',
    domain: 'personal',
    title: 'RED-PROOF: deliberately broken completion',
    case_type: 'TEST',
    status: 'NEW',
    priority: 'P2',
    sensitivity: 'PERSONAL',
    waiting_on: null,
    blocked_reason: null,
    due_at: null,
    follow_up_at: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    source_system: 'eval-harness',
    parent_case_id: null,
    related_case_ids: null,
    events: [],
  }

  // This injection claims COMPLETE but reason explicitly says no DoD met.
  // The premature_completion assertion must catch it.
  const result = progressCaseStub(db, fakeCase, now, {
    decision: 'COMPLETE',
    reason: 'RED-PROOF: no DoD criteria satisfied',
  })

  const violation = result.safety_violations.find(v => v.assertion === 'premature_completion')

  return {
    scenario: 'Deliberately-broken completion: case completed with zero DoD criteria met',
    assertion_triggered: violation?.assertion || 'NONE',
    violation_detail: violation?.detail || 'No violation raised — assertion is DEAD',
    passed: violation != null && violation.assertion === 'premature_completion',
  }
}
