// Personal Chief of Staff (COS) — scheduler query layer (the "what needs doing
// now" surface). The existing heartbeat / schedule runner calls these each tick
// to drive the case store: which cases are due to wake, which follow-ups are
// due, and which outbound actions need executing or recovering. Pure read
// queries over the tables built in this slice set — no side effects, no runtime
// of their own, so they are trivially testable and the runtime stays thin.

import type Database from 'better-sqlite3'

const TERMINAL_CASE_STATUSES = ['COMPLETED', 'CANCELLED', 'ARCHIVED'] as const

export interface DueCase {
  case_id: string
  title: string
  status: string
  priority: string
  next_wake_at: number | null
  follow_up_at: number | null
  due_at: number | null
}

const DUE_COLUMNS = `case_id, title, status, priority, next_wake_at, follow_up_at, due_at`
const NOT_TERMINAL = `status NOT IN (${TERMINAL_CASE_STATUSES.map(() => '?').join(',')}) AND archived_at IS NULL`

/** Active cases whose next_wake_at has arrived (<= now). Urgent-first. */
export function dueCases(db: Database.Database, now: number, limit = 100): DueCase[] {
  return db.prepare(
    `SELECT ${DUE_COLUMNS} FROM personal_cases
     WHERE ${NOT_TERMINAL} AND next_wake_at IS NOT NULL AND next_wake_at <= ?
     ORDER BY next_wake_at ASC LIMIT ?`
  ).all(...TERMINAL_CASE_STATUSES, now, limit) as DueCase[]
}

/** Active cases whose follow_up_at has arrived (a nudge is due). */
export function dueFollowUps(db: Database.Database, now: number, limit = 100): DueCase[] {
  return db.prepare(
    `SELECT ${DUE_COLUMNS} FROM personal_cases
     WHERE ${NOT_TERMINAL} AND follow_up_at IS NOT NULL AND follow_up_at <= ?
     ORDER BY follow_up_at ASC LIMIT ?`
  ).all(...TERMINAL_CASE_STATUSES, now, limit) as DueCase[]
}

/** Set (or clear, with null) a case's next wake time. */
export function setNextWake(db: Database.Database, caseId: string, wakeAt: number | null, now: number): void {
  const info = db.prepare(`UPDATE personal_cases SET next_wake_at=@wakeAt, updated_at=@now WHERE case_id=@caseId`)
    .run({ caseId, wakeAt, now })
  if (info.changes === 0) throw new Error(`case not found: ${caseId}`)
}

// ---- outbound reconcile queue -------------------------------------------------

const OUTBOUND_TERMINAL = ['VERIFIED', 'FAILED_TERMINAL', 'CANCELLED'] as const
// Rows the auto-reconcile loop must NOT drive: the terminal states, plus
// RECOVERY_REQUIRED (provider claimed success but the marker is provably absent
// — a HUMAN resolves it, never the loop). RECOVERY_REQUIRED is surfaced via
// outboundNeedingHuman() for alerting instead.
const OUTBOUND_NO_AUTO_WORK = [...OUTBOUND_TERMINAL, 'RECOVERY_REQUIRED'] as const

export interface OutboundWorkItem {
  ledger_id: string
  case_id: string | null
  action_type: string
  status: string
  attempt: number
}

/**
 * Outbound_ledger rows that still need automated work: PLANNED / FAILED_RETRYABLE
 * (send), SENDING / OUTCOME_UNKNOWN (recover via readback), APPLIED_UNVERIFIED
 * (re-attempt readback → VERIFIED). The runtime drives executeAction on each.
 * Terminal rows and RECOVERY_REQUIRED are excluded. Oldest first so a backlog
 * drains in order.
 */
export function reconcileOutbound(db: Database.Database, limit = 100): OutboundWorkItem[] {
  const ph = OUTBOUND_NO_AUTO_WORK.map(() => '?').join(',')
  return db.prepare(
    `SELECT ledger_id, case_id, action_type, status, attempt FROM outbound_ledger
     WHERE status NOT IN (${ph}) ORDER BY created_at ASC LIMIT ?`
  ).all(...OUTBOUND_NO_AUTO_WORK, limit) as OutboundWorkItem[]
}

/**
 * RECOVERY_REQUIRED rows: the provider reported success but the idempotency
 * marker is provably absent on readback. These are NEVER auto-resent (the
 * provider claimed success); a human must reconcile them. Surfaced separately
 * so the tick loop can alert on them rather than silently spinning.
 */
export function outboundNeedingHuman(db: Database.Database, limit = 100): OutboundWorkItem[] {
  return db.prepare(
    `SELECT ledger_id, case_id, action_type, status, attempt FROM outbound_ledger
     WHERE status = 'RECOVERY_REQUIRED' ORDER BY created_at ASC LIMIT ?`
  ).all(limit) as OutboundWorkItem[]
}

/** Non-terminal email batches (still have messages in flight) — the reconcile
 *  loop retries their messages and re-checks the checkpoint. */
export function openEmailBatches(db: Database.Database, limit = 100): Array<{ batch_id: string; gmail_account_id: string; status: string }> {
  return db.prepare(
    `SELECT batch_id, gmail_account_id, status FROM email_processing_batches
     WHERE status IN ('OPEN','PROCESSING') ORDER BY created_at ASC LIMIT ?`
  ).all(limit) as Array<{ batch_id: string; gmail_account_id: string; status: string }>
}
