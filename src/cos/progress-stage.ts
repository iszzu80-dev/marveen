/**
 * P3 — the progress STAGE, derived from the canonical progression FACTS.
 *
 * Owner's constraint, restated because it shapes the whole file: *"P3-ban ne
 * próbáld a meglévő 9-10 státuszt négyre összevonni."* The plan says the same in
 * three words -- **derive, do not replace**. The 17 personal and 21 ZST statuses
 * carry operational meaning the owner reads on the board; a stage is a second,
 * coarser question asked of the same row, not a smaller vocabulary put in its
 * place.
 *
 * CORRECTED 2026-08-27 by the owner's P3 closure, and the correction is the
 * whole point of the file: *"progress_stage ne kizárólag status leképezése
 * legyen. A stage a canonical progression facts összegzett állapota legyen. A
 * status lehet egyik bemenet, de nem az egyetlen."*
 *
 * My first version was a pure `status -> stage` table. It passed every test I
 * wrote for it, and it was wrong in a way those tests could not see: two cases
 * with the same business status are NOT in the same place if one has an active
 * typed wait and the other does not, or if one is blocked on an unanswered
 * question. A status is a label the case carries; a stage is a claim about what
 * is actually true of it right now.
 *
 * THE QUESTION A STAGE ANSWERS: *whose move is it, and is anything moving?*
 *
 *   ACTIONABLE   the engine can act now
 *   WAITING      the world owes an answer
 *   NEEDS_USER   Istvan owes an answer
 *   MONITORING   nothing is owed; a clock will bring it back
 *   COMPLETED    closed, by success or otherwise
 *
 * TOTALITY IS ENFORCED BY THE TYPE, not by a default. Both maps are
 * `Record<Status, Stage>` over the exported status unions, so adding a status
 * without a stage FAILS THE BUILD. A lookup with a fallback would make the
 * unmapped status silently indistinguishable from a deliberately-ACTIONABLE one,
 * which is the shape this codebase has paid for repeatedly. There is no default,
 * and `stageFor` cannot invent one.
 *
 * AND THE TYPE IS NOT ENOUGH ON ITS OWN. The compiler checks the map against the
 * TypeScript union; the database checks rows against its own CHECK constraint.
 * Those are two vocabularies that can drift, so the P3 test reads the LIVE
 * constraint out of sqlite_master and asserts every value in it maps -- the
 * acceptance criterion's "reads the live status vocabulary rather than a
 * hard-coded list", applied to the one place a hard-coded list could still hide.
 */

import type Database from 'better-sqlite3'
import { CASE_STATUSES, ZST_CASE_STATUSES, type CaseStatus, type ZstCaseStatus } from './schema.js'
import { canCompleteCase } from './progression-completion.js'
import { activeWaitCondition } from './wait-condition.js'

export const PROGRESS_STAGES = [
  'ACTIONABLE', 'WAITING', 'NEEDS_USER', 'MONITORING', 'COMPLETED',
] as const
export type ProgressStage = (typeof PROGRESS_STAGES)[number]

export type CaseDomain = 'personal' | 'zst'

/**
 * Personal statuses to stages.
 *
 * The two that are worth arguing about, so the argument is here rather than in
 * someone's head later:
 *
 * BLOCKED is NEEDS_USER, not WAITING. A blocked case is stopped on something the
 * engine cannot clear by waiting -- the owner's decision, a missing fact, a
 * refusal. Calling it WAITING would file a case that needs a person under "the
 * world owes an answer", and the board's whole purpose is telling those apart.
 *
 * RECOVERY_REQUIRED is ACTIONABLE, not NEEDS_USER. §19's sentence: a system
 * fault must not read as "needs Istvan". The engine retries and escalates on its
 * own; it reaches the owner through the recovery queue's NEEDS_HUMAN rows, which
 * is a different surface with a different meaning.
 */
export const PERSONAL_STAGE: Record<CaseStatus, ProgressStage> = {
  NEW:                'ACTIONABLE',
  TRIAGE:             'ACTIONABLE',
  READY:              'ACTIONABLE',
  PLANNING:           'ACTIONABLE',
  EXECUTING:          'ACTIONABLE',
  RECOVERY_REQUIRED:  'ACTIONABLE',
  INFO_REQUIRED:      'NEEDS_USER',
  AWAITING_APPROVAL:  'NEEDS_USER',
  AWAITING_SELECTION: 'NEEDS_USER',
  CALL_REQUIRED:      'NEEDS_USER',
  BLOCKED:            'NEEDS_USER',
  WAITING_EXTERNAL:   'WAITING',
  FOLLOW_UP_DUE:      'WAITING',
  SCHEDULED:          'MONITORING',
  COMPLETED:          'COMPLETED',
  CANCELLED:          'COMPLETED',
  ARCHIVED:           'COMPLETED',
}

/**
 * ZST statuses to stages.
 *
 * NOT derived from the personal map by name-matching, deliberately. The
 * spellings differ (INFORMATION_REQUIRED, TRIAGE_REQUIRED) and so do two of the
 * meanings, so a shared table keyed on strings would look like it was saving
 * duplication while quietly asserting the two namespaces mean the same things.
 * Two maps, each total over its own vocabulary.
 *
 * AWAITING_INTERNAL_INPUT is NEEDS_USER: "internal" here means inside ZST, which
 * from the engine's side is a person. FAILED_RECOVERABLE is ACTIONABLE for the
 * same reason RECOVERY_REQUIRED is; FAILED_TERMINAL is COMPLETED because closed
 * is closed, however it closed.
 */
export const ZST_STAGE: Record<ZstCaseStatus, ProgressStage> = {
  NEW:                     'ACTIONABLE',
  TRIAGE_REQUIRED:         'ACTIONABLE',
  READY:                   'ACTIONABLE',
  PLANNING:                'ACTIONABLE',
  EXECUTING:               'ACTIONABLE',
  RECOVERY_REQUIRED:       'ACTIONABLE',
  FAILED_RECOVERABLE:      'ACTIONABLE',
  INFORMATION_REQUIRED:    'NEEDS_USER',
  AWAITING_INTERNAL_INPUT: 'NEEDS_USER',
  AWAITING_APPROVAL:       'NEEDS_USER',
  AWAITING_SELECTION:      'NEEDS_USER',
  REVIEW_REQUIRED:         'NEEDS_USER',
  CALL_REQUIRED:           'NEEDS_USER',
  BLOCKED:                 'NEEDS_USER',
  WAITING_EXTERNAL:        'WAITING',
  FOLLOW_UP_DUE:           'WAITING',
  SCHEDULED:               'MONITORING',
  COMPLETED:               'COMPLETED',
  FAILED_TERMINAL:         'COMPLETED',
  CANCELLED:               'COMPLETED',
  ARCHIVED:                'COMPLETED',
}

// ── The facts a stage is derived from ───────────────────────────────────

/**
 * Everything the precedence below reads. Gathered ONCE, in one place, so the
 * rule is a pure function of stated facts rather than a walk through five
 * tables interleaved with judgement.
 */
export interface StageFacts {
  domain: CaseDomain
  /** The business status. ONE input, never the only one. */
  status: string
  /** Terminal completion backed by evidence -- the DoD gate, asked as the ENGINE
   *  and not as the owner, because the owner branch returns true unconditionally
   *  and would make every closed-looking case COMPLETED by construction. */
  completionEvidence: boolean
  /** An unanswered owner question, or an escalation that is OPEN or merely
   *  ACKNOWLEDGED. Acknowledged is not resolved -- somebody has seen it, which
   *  is not the same as somebody having decided, and treating the two alike is
   *  how a case that still needs him stops saying so. */
  unresolvedOwnerDecision: boolean
  /** A recovery-queue row for this case that has escalated to NEEDS_HUMAN. */
  needsHumanRecovery: boolean
  /** The live typed wait, when there is one. `retryable: false` marks a wait only
   *  a person can end -- a disabled connector, an unknown capability name. */
  activeWait: { kind: string; retryable: boolean } | null
  /** An explicit monitoring state or policy. */
  monitoring: boolean
  /** A next action the engine could actually perform. */
  executableNextAction: boolean
}

/**
 * The owner's precedence, 2026-08-27, in his order.
 *
 * Returns `null` when nothing can be claimed: not closed, nobody owes anything,
 * no wait, not monitored, and no executable next action. That is a real state --
 * a case the engine has nothing to say about -- and it deserves a visibly empty
 * cell rather than a comfortable ACTIONABLE. The same refusal to guess that the
 * unmapped status gets.
 */
export function deriveStage(f: StageFacts): ProgressStage | null {
  // 1. COMPLETED, only with evidence.
  //
  // CANCELLED and ARCHIVED are closed WITHOUT a Definition of Done, because
  // abandoning a case is not completing it and never had criteria to meet.
  // A status of COMPLETED without evidence is the case the owner named
  // explicitly: it must NOT read as done. It falls through to NEEDS_USER below,
  // because a case claiming completion it cannot show is exactly the thing a
  // person has to look at.
  if (f.status === 'CANCELLED' || f.status === 'ARCHIVED') return 'COMPLETED'
  if (f.completionEvidence && isTerminalStatus(f.domain, f.status)) return 'COMPLETED'

  // 2. NEEDS_USER, including the recovery gate.
  //
  // `needsHumanRecovery` is here rather than nowhere BECAUSE of the owner's last
  // counter-example: the detailed recovery surface may be the source of truth
  // for what is stuck, but the case stage must not contradict it by reading
  // ACTIONABLE while a human is the only thing that can move it.
  //
  // A non-retryable capability wait belongs here too, for the same reason: no
  // probe will ever end it.
  if (f.needsHumanRecovery) return 'NEEDS_USER'
  if (f.unresolvedOwnerDecision) return 'NEEDS_USER'
  if (f.activeWait && !f.activeWait.retryable) return 'NEEDS_USER'
  if (statusImpliesOwnerMove(f.domain, f.status)) return 'NEEDS_USER'
  // The claimed-but-unproven completion from step 1.
  if (isTerminalStatus(f.domain, f.status)) return 'NEEDS_USER'

  // 3. WAITING -- an active, unresolved typed wait.
  if (f.activeWait) return 'WAITING'

  // 4. MONITORING -- an explicit monitoring state or policy.
  if (f.monitoring) return 'MONITORING'

  // 5. ACTIONABLE -- and ONLY with something to actually do.
  if (f.executableNextAction) return 'ACTIONABLE'
  return null
}

/** Statuses whose meaning IS "the owner owes something". Status as one input to
 *  the precedence, not as the whole rule: a case can reach NEEDS_USER above
 *  without any of these, and one of these can be overridden by nothing -- they
 *  are the last NEEDS_USER test, not the first. */
function statusImpliesOwnerMove(domain: CaseDomain, status: string): boolean {
  const map = domain === 'personal' ? PERSONAL_STAGE : ZST_STAGE
  return (map as Record<string, ProgressStage>)[status] === 'NEEDS_USER'
}

function isTerminalStatus(domain: CaseDomain, status: string): boolean {
  const map = domain === 'personal' ? PERSONAL_STAGE : ZST_STAGE
  return (map as Record<string, ProgressStage>)[status] === 'COMPLETED'
}

/**
 * The status-only hint, kept because it is still the vocabulary the P3
 * acceptance tests read -- every live status must map to exactly one stage. It
 * is NOT what the board is written from any more; `deriveStage` is.
 *
 * NULL RATHER THAN A GUESS. An unknown status is a deployment or migration fault
 * -- a row the CHECK should have refused, or a vocabulary that moved without this
 * map -- and answering it with a plausible stage would put a fault on the board
 * dressed as a case state. The caller decides what to do about null; this
 * function refuses to pretend.
 */
export function stageFor(domain: CaseDomain, status: string): ProgressStage | null {
  const map: Record<string, ProgressStage> = domain === 'personal' ? PERSONAL_STAGE : ZST_STAGE
  return map[status] ?? null
}

/** The vocabulary a domain's map is total over. Exported so a test can compare
 *  it against the LIVE constraint rather than against another copy of itself. */
export function statusVocabulary(domain: CaseDomain): readonly string[] {
  return domain === 'personal' ? CASE_STATUSES : ZST_CASE_STATUSES
}

// ── Reading the facts off the store ─────────────────────────────────────

/**
 * Gather the canonical facts for one case.
 *
 * EVERY LOOKUP IS WRAPPED. A stage is a board cell; a board cell that throws
 * because an optional table is missing on an older store would take the whole
 * projection down, and the projection is what keeps the board honest. A missing
 * source reads as "that fact is not true", which for every fact here is the
 * conservative direction: it can only move a case DOWN the precedence, never up
 * into a claim the store cannot support -- except `executableNextAction`, whose
 * absence removes the last stage and yields null rather than a false ACTIONABLE.
 */
export function readStageFacts(
  db: Database.Database, domain: CaseDomain, caseId: string, now: number,
): StageFacts {
  const caseTable = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const status: string = safe<string>(() => (db.prepare(
    `SELECT status FROM ${caseTable} WHERE case_id = ?`,
  ).get(caseId) as { status?: string } | undefined)?.status ?? '', '')

  const completionEvidence = safe(
    () => canCompleteCase(db, domain, caseId, 'ENGINE').allowed, false)

  const unansweredQuestion = safe(() => (db.prepare(
    `SELECT 1 FROM cos_owner_questions
      WHERE case_id = ? AND domain = ? AND answered_at IS NULL AND superseded_at IS NULL
      LIMIT 1`,
  ).get(caseId, domain) !== undefined), false)

  const openEscalation = safe(() => (db.prepare(
    `SELECT 1 FROM case_escalations
      WHERE case_id = ? AND domain = ? AND resolution_status IN ('OPEN','ACKNOWLEDGED')
      LIMIT 1`,
  ).get(caseId, domain) !== undefined), false)

  const needsHumanRecovery = safe(() => (db.prepare(
    `SELECT 1 FROM cos_recovery_queue WHERE case_id = ? AND status = 'NEEDS_HUMAN' LIMIT 1`,
  ).get(caseId) !== undefined), false)

  const wait = safe(() => activeWaitCondition(db, domain, caseId), undefined)
  const activeWait = wait
    ? { kind: wait.kind, retryable: capabilityWaitRetryable(wait) }
    : null

  const state = safe(() => db.prepare(
    `SELECT next_best_action_json AS nba, progression_mode AS mode
       FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(domain, caseId) as { nba: string | null; mode: string | null } | undefined, undefined)

  return {
    domain, status,
    completionEvidence,
    unresolvedOwnerDecision: unansweredQuestion || openEscalation,
    needsHumanRecovery,
    activeWait,
    // The one explicit monitoring signal today. Named as a fact rather than
    // read from the status map, so a future monitoring POLICY has somewhere to
    // land that is not a status.
    monitoring: status === 'SCHEDULED',
    executableNextAction: hasExecutableAction(state?.nba ?? null),
  }
}

/** A CAPABILITY wait carries its own retryability in the predicate the arm
 *  wrote. Every other kind ends by clock or event, so it is retryable in the
 *  sense that matters here: something other than a person can end it. */
function capabilityWaitRetryable(w: { kind: string; evidence_predicate_json?: string | null }): boolean {
  if (w.kind !== 'CAPABILITY') return true
  try {
    const p = JSON.parse(w.evidence_predicate_json ?? '{}') as { retryable?: unknown }
    return p.retryable !== false
  } catch { return true }
}

/** Is there a next action the engine could perform? The KIND carries this, not
 *  the description -- the same reason Invariant A leans on the kind. */
function hasExecutableAction(nbaJson: string | null): boolean {
  if (!nbaJson) return false
  try {
    const nba = JSON.parse(nbaJson) as { kind?: unknown }
    return typeof nba.kind === 'string' && nba.kind.length > 0
  } catch { return false }
}

function safe<T>(f: () => T, fallback: T): T {
  try { const v = f(); return v === undefined || v === null ? fallback : v } catch { return fallback }
}

/** The one call the projection makes. */
export function stageForCase(
  db: Database.Database, domain: CaseDomain, caseId: string, now: number,
): ProgressStage | null {
  return deriveStage(readStageFacts(db, domain, caseId, now))
}
