/**
 * P3 — the progress STAGE, derived from status and never replacing it.
 *
 * Owner's constraint, restated because it shapes the whole file: *"P3-ban ne
 * próbáld a meglévő 9-10 státuszt négyre összevonni."* The plan says the same in
 * three words -- **derive, do not replace**. The 17 personal and 21 ZST statuses
 * carry operational meaning the owner reads on the board; a stage is a second,
 * coarser question asked of the same row, not a smaller vocabulary put in its
 * place.
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

import { CASE_STATUSES, ZST_CASE_STATUSES, type CaseStatus, type ZstCaseStatus } from './schema.js'

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

/**
 * The stage of a status, or `null` when the status is not in the vocabulary.
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
