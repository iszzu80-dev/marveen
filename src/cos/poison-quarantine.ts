// Personal Chief of Staff (COS) — poison-message quarantine (v4.2.1 A.1).
//
// A message the system cannot process must not pin the account cursor forever.
// The state and the setter existed and were tested; nothing called them, so in
// practice a poison message would have held its batch open indefinitely and the
// cursor behind it — quietly, because an open batch looks like a busy one.
//
// A.1 does not simply allow quarantining. It allows the cursor to step OVER a
// quarantined message only when five things are true at once:
//   1. the source reference is kept,
//   2. a critical alert went out,
//   3. a manual review task exists,
//   4. the unprocessed state is audited,
//   5. an explicit policy permits the cursor to pass.
// All five are enforced here rather than described in a comment, because the
// whole point of the rule is that skipping a message is allowed only when
// somebody will certainly find out.

import type Database from 'better-sqlite3'
import { quarantineMessage } from './email-ingest.js'

/** Attempts after which a message is considered persistently unprocessable. */
export const POISON_ATTEMPT_THRESHOLD = 3

export interface QuarantineConditions {
  sourceReferenceKept: boolean
  alertRaised: boolean
  reviewTaskCreated: boolean
  audited: boolean
  policyAllowsCursorAdvance: boolean
}

export interface QuarantineResult {
  quarantined: boolean
  /** Which of the five A.1 conditions were not met. Empty when quarantined. */
  missing: string[]
  reason: string
}

/** WHY the cursor is being let past this message. The two are not the same
 *  event and must not carry the same words: a poison message could NOT be
 *  processed, while a source-commit skip WAS processed fully and only failed to
 *  be marked at the source. Reusing the quarantine wording for the second one
 *  told Istvan on 2026-08-11 that a perfectly handled GLS notice was an
 *  "unprocessable message, check it by hand". */
export type CursorPassKind = 'POISON_QUARANTINE' | 'SOURCE_COMMIT_SKIPPED'

export interface QuarantineDeps {
  /** Raise the critical alert (condition 2). Returns false when it could not. */
  raiseAlert: (accountId: string, messageId: string, reason: string, kind: CursorPassKind) => boolean
  /** Create the human review task (condition 3). Returns false when it could not. */
  createReviewTask: (accountId: string, messageId: string, reason: string, kind: CursorPassKind) => boolean
  /** Whether policy permits the cursor to pass a quarantined item (condition 5). */
  policyAllowsCursorAdvance: () => boolean
}

/** Messages that have failed enough times to count as poison. */
export function poisonCandidates(
  db: Database.Database, batchId: string, threshold = POISON_ATTEMPT_THRESHOLD,
): Array<{ gmail_account_id: string; message_id: string; attempt: number; last_error: string | null }> {
  return db.prepare(
    `SELECT gmail_account_id, message_id, attempt, last_error
     FROM email_processing
     WHERE batch_id = ? AND status IN ('RECOVERY_REQUIRED','CLAIMED','DISCOVERED') AND attempt >= ?`
  ).all(batchId, threshold) as never
}

/**
 * Quarantine one poison message, but ONLY with all five A.1 conditions met.
 *
 * When a condition fails the message stays where it is and the batch stays
 * blocked. That is the intended outcome: a stuck cursor is a visible problem,
 * while a cursor that steps over unprocessed mail is an invisible one, and the
 * second is how mail disappears without anybody noticing.
 */
export function quarantinePoison(
  db: Database.Database,
  accountId: string,
  messageId: string,
  reason: string,
  deps: QuarantineDeps,
  now: number,
): QuarantineResult {
  const row = db.prepare(
    `SELECT message_id, thread_id, attempt FROM email_processing
     WHERE gmail_account_id = ? AND message_id = ?`
  ).get(accountId, messageId) as { message_id: string; attempt: number } | undefined

  // THE CHEAP, SIDE-EFFECT-FREE CONDITIONS FIRST.
  //
  // INCIDENT (review 2026-08-13). raiseAlert and createReviewTask used to run
  // BEFORE the full condition set was evaluated, so an attempt that then failed
  // on, say, policyAllowsCursorAdvance had already created the `qtn-<mid>`
  // kanban card. On the next sweep createReviewTask's plain INSERT hit the
  // primary-key conflict, its catch returned false, the condition read "review
  // task NOT created" — and the message could NEVER be quarantined again. The
  // batch was pinned permanently while every sweep inserted one more duplicate
  // CRITICAL alert. A precondition that fails must cost nothing.
  const preconditions: Omit<QuarantineConditions, 'alertRaised' | 'reviewTaskCreated'> = {
    // 1. The source reference is the message id itself, still on the row.
    sourceReferenceKept: !!row?.message_id,
    // 4. Audited: the reason is written to the row, below.
    audited: !!reason && reason.length > 5,
    policyAllowsCursorAdvance: deps.policyAllowsCursorAdvance(),
  }
  if (!row) {
    return { quarantined: false, missing: ['sourceReferenceKept'], reason: `nincs ilyen üzenet: ${messageId}` }
  }
  const failedEarly = (Object.keys(preconditions) as Array<keyof typeof preconditions>)
    .filter((k) => !preconditions[k])
  if (failedEarly.length) {
    return {
      quarantined: false, missing: failedEarly,
      reason: `A.1 feltételek nem teljesültek: ${failedEarly.join(', ')} — az üzenet marad, a köteg blokkolt`,
    }
  }

  // 2/3. Attempted only now; a failure to alert is a failure of the condition.
  const conditions: QuarantineConditions = {
    ...preconditions,
    alertRaised: deps.raiseAlert(accountId, messageId, reason, 'POISON_QUARANTINE'),
    reviewTaskCreated: deps.createReviewTask(accountId, messageId, reason, 'POISON_QUARANTINE'),
  }

  const missing = (Object.keys(conditions) as Array<keyof QuarantineConditions>)
    .filter((k) => !conditions[k])
  if (missing.length) {
    return {
      quarantined: false, missing,
      reason: `A.1 feltételek nem teljesültek: ${missing.join(', ')} — az üzenet marad, a köteg blokkolt`,
    }
  }

  // Condition 4 in practice: the reason and the attempt count go onto the row,
  // so the skip is inspectable long after everyone has forgotten the incident.
  quarantineMessage(db, accountId, messageId, `${reason} (kísérlet: ${row.attempt})`, now)
  return { quarantined: true, missing: [], reason }
}

/** Sweep a batch: quarantine every poison message that satisfies A.1. */
export function quarantineBatchPoison(
  db: Database.Database, batchId: string, deps: QuarantineDeps, now: number,
  threshold = POISON_ATTEMPT_THRESHOLD,
): { examined: number; quarantined: number; blocked: QuarantineResult[] } {
  const cands = poisonCandidates(db, batchId, threshold)
  const blocked: QuarantineResult[] = []
  let quarantined = 0
  for (const c of cands) {
    const r = quarantinePoison(db, c.gmail_account_id, c.message_id,
      c.last_error ?? 'tartósan feldolgozhatatlan üzenet', deps, now)
    if (r.quarantined) quarantined += 1
    else blocked.push(r)
  }
  return { examined: cands.length, quarantined, blocked }
}
