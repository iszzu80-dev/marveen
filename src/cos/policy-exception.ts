// Row-bound exceptions to a safety assertion (Phase 1 final gate, 2026-08-27).
//
// WHAT THIS IS FOR, and what it must never become.
//
// The `policy_bypass` assertion reports any non-PLANNED outbound row with no
// consumed §22.2 authorization. Three rows on the live store are exactly that,
// and the assertion is RIGHT about all three: they are mail the owner sent by
// hand from Gmail and the ledger recorded afterwards, from before tickets
// existed. Nothing can produce a ticket for them now.
//
// Three ways to make that alarm stop, and the owner ruled on all three:
//
//   issue an authorization retroactively  REFUSED -- it would put a forged
//                                         authorisation in the audit trail to
//                                         silence a true finding.
//   weaken or disable the detector        REFUSED -- the next real bypass would
//                                         then be invisible too.
//   record the three, explicitly          THIS. Row-bound, with evidence and a
//                                         date, so three known cases stop
//                                         shouting and a fourth still does.
//
// THE TWO PROPERTIES THAT MAKE IT SAFE. It covers a SUBJECT ID, never a rule --
// "rows older than X" would silently cover a row written tomorrow by a bug with
// an old timestamp. And it is bound to the subject's STATE at the time it was
// examined: if the excused row moves, the exception stops applying and the alarm
// comes back, because what was excused is no longer what is in the table.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export interface PolicyException {
  assertion: string
  domain: 'personal' | 'zst'
  subjectKind: string
  subjectId: string
  /** The subject's state when it was examined. Null means "any state", which is
   *  weaker and must be a deliberate choice by the person recording it. */
  subjectState: string | null
  reason: string
  evidence: string
  recordedBy: string
}

/** Deterministic id: the same exception recorded twice is the same row, and the
 *  UNIQUE index means the second write is a correction rather than a duplicate. */
export function exceptionId(e: Pick<PolicyException, 'assertion' | 'subjectKind' | 'subjectId'>): string {
  return createHash('sha256')
    .update([e.assertion, e.subjectKind, e.subjectId].join('\0'))
    .digest('hex')
    .slice(0, 32)
}

export function recordPolicyException(
  db: Database.Database, e: PolicyException, now: number,
): string {
  const id = exceptionId(e)
  db.prepare(
    `INSERT INTO cos_policy_exceptions
       (exception_id, assertion, domain, subject_kind, subject_id, subject_state,
        reason, evidence, recorded_at, recorded_by)
     VALUES (@id, @assertion, @domain, @subjectKind, @subjectId, @subjectState,
        @reason, @evidence, @now, @recordedBy)
     ON CONFLICT (assertion, subject_kind, subject_id) DO UPDATE
       SET subject_state = excluded.subject_state, reason = excluded.reason,
           evidence = excluded.evidence, recorded_at = excluded.recorded_at,
           recorded_by = excluded.recorded_by, revoked_at = NULL`,
  ).run({ id, ...e, now })
  return id
}

/**
 * Is this exact subject, in this exact state, excused from this assertion?
 *
 * FAILS CLOSED IN BOTH DIRECTIONS THAT MATTER. A store with no exceptions table
 * answers "no" (everything is reported, which is the safe answer), and a subject
 * whose state has moved away from the recorded one answers "no" as well.
 */
export function isExcused(
  db: Database.Database, assertion: string, subjectKind: string, subjectId: string,
  subjectState: string | null,
): boolean {
  let row: { subject_state: string | null } | undefined
  try {
    row = db.prepare(
      `SELECT subject_state FROM cos_policy_exceptions
        WHERE assertion = ? AND subject_kind = ? AND subject_id = ? AND revoked_at IS NULL`,
    ).get(assertion, subjectKind, subjectId) as typeof row
  } catch {
    return false
  }
  if (!row) return false
  // A null recorded state is the deliberate "any state" case.
  if (row.subject_state === null) return true
  return row.subject_state === subjectState
}

export interface ExcusedSubject {
  exceptionId: string
  assertion: string
  subjectKind: string
  subjectId: string
  subjectState: string | null
  reason: string
  evidence: string
  recordedAt: number
  recordedBy: string
}

/** Every live exception, for the monitoring surface. An excused finding that
 *  nobody can see is the same silence the exception was meant to avoid -- the
 *  alarm stops, and so does the knowledge that it was ever there. */
export function listPolicyExceptions(db: Database.Database): ExcusedSubject[] {
  try {
    return (db.prepare(
      `SELECT exception_id AS exceptionId, assertion, subject_kind AS subjectKind,
              subject_id AS subjectId, subject_state AS subjectState, reason,
              evidence, recorded_at AS recordedAt, recorded_by AS recordedBy
         FROM cos_policy_exceptions WHERE revoked_at IS NULL
        ORDER BY recorded_at`,
    ).all() as ExcusedSubject[])
  } catch { return [] }
}
