// Personal Chief of Staff (COS) Slice 0 -- domain-command layer over the case
// store (src/cos/schema.ts). These are the ONLY sanctioned mutators of
// personal_cases / personal_case_events / case_claims. They bake in the three
// invariants the spec (v4.2.1) requires so no caller can forget them:
//
//   P0.5  optimistic concurrency: a transition carries the version the caller
//         SAW; a lost update is a no-op that throws CaseConcurrencyError, never
//         a silent clobber. The version bump + the audit event are one
//         transaction -- the event stream can never disagree with the row.
//   audit: every mutation appends a personal_case_events row (append-only, DB
//         trigger enforced) with the case_version at the moment of the event.
//   P0.2/P0.3 claims: acquire/takeover is one conditional upsert with a
//         monotonic fence; a live claim cannot be stolen, an expired one can,
//         and the fence proves the takeover.
//
// Every function takes an explicit `db` and `now` (seconds) so it is
// deterministic and unit-testable, following the src/costops/* idiom.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import type { CaseStatus, CaseSensitivity } from './schema.js'

/** Thrown when an optimistic-concurrency transition loses the race (the row's
 *  version moved on since the caller read it). The caller must re-read and retry
 *  -- it MUST NOT assume its intended state was applied. */
export class CaseConcurrencyError extends Error {
  readonly caseId: string
  readonly seenVersion: number
  constructor(caseId: string, seenVersion: number) {
    super(`case ${caseId}: optimistic-concurrency conflict (seen version ${seenVersion} is stale)`)
    this.name = 'CaseConcurrencyError'
    this.caseId = caseId
    this.seenVersion = seenVersion
  }
}

export interface NewCaseInput {
  caseId: string
  title: string
  caseType: string
  description?: string
  category?: string
  status?: CaseStatus
  priority?: string
  sensitivity?: CaseSensitivity
  owner?: string
  actor?: string
  sourceSystem?: string
  sourceReference?: string
}

export interface CaseRow {
  case_id: string
  version: number
  title: string
  status: string
  sensitivity: string
  owner: string
  created_at: number
  updated_at: number
  [k: string]: unknown
}

export interface AppendEventInput {
  caseId: string
  caseVersion: number
  actor: string
  eventType: string
  previousStatus?: string | null
  newStatus?: string | null
  reason?: string | null
  payload?: unknown
  sourceSystem?: string | null
  sourceReference?: string | null
  correlationId?: string | null
}

/** Append one audit event. Append-only is enforced by the DB trigger; this is
 *  the sole writer so payloads are consistently JSON-encoded. Returns event_id. */
export function appendCaseEvent(db: Database.Database, ev: AppendEventInput, now: number): number {
  const info = db.prepare(
    `INSERT INTO personal_case_events
       (case_id, case_version, actor, source_system, source_reference, event_type,
        previous_status, new_status, reason, payload, correlation_id, created_at)
     VALUES (@caseId, @caseVersion, @actor, @sourceSystem, @sourceReference, @eventType,
        @previousStatus, @newStatus, @reason, @payload, @correlationId, @now)`
  ).run({
    caseId: ev.caseId,
    caseVersion: ev.caseVersion,
    actor: ev.actor,
    sourceSystem: ev.sourceSystem ?? null,
    sourceReference: ev.sourceReference ?? null,
    eventType: ev.eventType,
    previousStatus: ev.previousStatus ?? null,
    newStatus: ev.newStatus ?? null,
    reason: ev.reason ?? null,
    payload: ev.payload === undefined ? null : JSON.stringify(ev.payload),
    correlationId: ev.correlationId ?? null,
    now,
  })
  return Number(info.lastInsertRowid)
}

/** Create a case at version 1 and append its CREATED event, atomically. */
export function createCase(db: Database.Database, input: NewCaseInput, now: number): CaseRow {
  const status: CaseStatus = input.status ?? 'NEW'
  const actor = input.actor ?? input.owner ?? 'marveen'
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO personal_cases
         (case_id, version, title, description, case_type, category, status, priority,
          owner, sensitivity, source_system, source_references, created_at, updated_at)
       VALUES (@caseId, 1, @title, @description, @caseType, @category, @status, @priority,
          @owner, @sensitivity, @sourceSystem, @sourceReference, @now, @now)`
    ).run({
      caseId: input.caseId,
      title: input.title,
      description: input.description ?? null,
      caseType: input.caseType,
      category: input.category ?? null,
      status,
      priority: input.priority ?? 'P2',
      owner: input.owner ?? 'marveen',
      sensitivity: input.sensitivity ?? 'PERSONAL',
      sourceSystem: input.sourceSystem ?? null,
      sourceReference: input.sourceReference ?? null,
      now,
    })
    appendCaseEvent(db, {
      caseId: input.caseId,
      caseVersion: 1,
      actor,
      eventType: 'CREATED',
      newStatus: status,
      sourceSystem: input.sourceSystem ?? null,
      sourceReference: input.sourceReference ?? null,
    }, now)
  })
  tx()
  return getCase(db, input.caseId)!
}

export function getCase(db: Database.Database, caseId: string): CaseRow | undefined {
  return db.prepare(`SELECT * FROM personal_cases WHERE case_id = ?`).get(caseId) as CaseRow | undefined
}

// Terminal states — a case here is closed, not "active work".
const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'ARCHIVED'] as const

// Statuses that always warrant owner attention "today", regardless of dates.
const ATTENTION_STATUSES = [
  'INFO_REQUIRED', 'FOLLOW_UP_DUE', 'CALL_REQUIRED', 'AWAITING_SELECTION', 'RECOVERY_REQUIRED',
] as const

// Priority sort rank (urgent-first) for the read views.
const PRIORITY_ORDER = `CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`

export interface CaseListItem {
  case_id: string
  title: string
  case_type: string
  status: string
  priority: string
  sensitivity: string
  next_action: string | null
  next_action_owner: string | null
  waiting_on: string | null
  due_at: number | null
  follow_up_at: number | null
  updated_at: number
}

const LIST_COLUMNS = `case_id, title, case_type, status, priority, sensitivity,
  next_action, next_action_owner, waiting_on, due_at, follow_up_at, updated_at`

// "Ügyek" — all active (non-archived, non-terminal) cases, urgent-first.
export function listActiveCases(db: Database.Database): CaseListItem[] {
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(',')
  return db.prepare(
    `SELECT ${LIST_COLUMNS} FROM personal_cases
     WHERE archived_at IS NULL AND status NOT IN (${placeholders})
     ORDER BY ${PRIORITY_ORDER}, updated_at DESC`
  ).all(...TERMINAL_STATUSES) as CaseListItem[]
}

// "Ma" — active cases that need attention by `horizonSec` (end of today):
// a due/follow-up/wake timestamp at or before the horizon, OR an
// attention-warranting status. `horizonSec` is passed in (end-of-today in the
// app timezone) so this stays pure and testable.
export function listTodayCases(db: Database.Database, horizonSec: number): CaseListItem[] {
  const termPh = TERMINAL_STATUSES.map(() => '?').join(',')
  const attnPh = ATTENTION_STATUSES.map(() => '?').join(',')
  // All-positional binds (better-sqlite3 forbids mixing named + positional):
  // [...terminal, dueHorizon, followHorizon, wakeHorizon, ...attention].
  return db.prepare(
    `SELECT ${LIST_COLUMNS} FROM personal_cases
     WHERE archived_at IS NULL AND status NOT IN (${termPh})
       AND (
         (due_at IS NOT NULL AND due_at <= ?)
         OR (follow_up_at IS NOT NULL AND follow_up_at <= ?)
         OR (next_wake_at IS NOT NULL AND next_wake_at <= ?)
         OR status IN (${attnPh})
       )
     ORDER BY ${PRIORITY_ORDER}, COALESCE(due_at, follow_up_at, next_wake_at, updated_at) ASC`
  ).all(...TERMINAL_STATUSES, horizonSec, horizonSec, horizonSec, ...ATTENTION_STATUSES) as CaseListItem[]
}

export interface TransitionInput {
  caseId: string
  seenVersion: number
  newStatus: CaseStatus
  actor: string
  reason?: string
  correlationId?: string
  /** Optional column patches applied in the same transaction (e.g. next_action,
   *  waiting_on, blocked_reason). Only a fixed allowlist is accepted. */
  patch?: Partial<Record<TransitionPatchKey, string | number | null>>
}

type TransitionPatchKey =
  | 'next_action' | 'next_action_owner' | 'waiting_on' | 'blocked_reason'
  | 'due_at' | 'follow_up_at' | 'next_wake_at' | 'closure_reason'

const PATCHABLE_COLUMNS: readonly TransitionPatchKey[] = [
  'next_action', 'next_action_owner', 'waiting_on', 'blocked_reason',
  'due_at', 'follow_up_at', 'next_wake_at', 'closure_reason',
]

/**
 * Optimistic-concurrency status transition. Updates the row ONLY when its
 * current version equals `seenVersion`, bumping version and appending the audit
 * event in one transaction. Returns the new version. Throws
 * CaseConcurrencyError when the version moved on (lost update) and a plain Error
 * when the case does not exist.
 */
export function transitionCase(db: Database.Database, input: TransitionInput, now: number): number {
  const tx = db.transaction(() => {
    const current = db.prepare(`SELECT version, status FROM personal_cases WHERE case_id = ?`)
      .get(input.caseId) as { version: number; status: string } | undefined
    if (!current) throw new Error(`case ${input.caseId} does not exist`)

    // Build the optimistic UPDATE. The version predicate is the concurrency
    // guard; the patch columns are restricted to a fixed allowlist so a caller
    // can never inject an arbitrary column name.
    const patch = input.patch ?? {}
    const setParts: string[] = ['status = @newStatus', 'version = version + 1', 'updated_at = @now']
    const params: Record<string, unknown> = {
      caseId: input.caseId, newStatus: input.newStatus, now, seenVersion: input.seenVersion,
    }
    if (input.newStatus === 'COMPLETED') setParts.push('completed_at = @now')
    for (const key of PATCHABLE_COLUMNS) {
      if (key in patch) { setParts.push(`${key} = @p_${key}`); params[`p_${key}`] = patch[key] ?? null }
    }
    const info = db.prepare(
      `UPDATE personal_cases SET ${setParts.join(', ')}
       WHERE case_id = @caseId AND version = @seenVersion`
    ).run(params)

    if (info.changes === 0) throw new CaseConcurrencyError(input.caseId, input.seenVersion)

    const newVersion = input.seenVersion + 1
    appendCaseEvent(db, {
      caseId: input.caseId,
      caseVersion: newVersion,
      actor: input.actor,
      eventType: 'STATUS_CHANGED',
      previousStatus: current.status,
      newStatus: input.newStatus,
      reason: input.reason ?? null,
      correlationId: input.correlationId ?? null,
    }, now)
    return newVersion
  })
  return tx()
}

export interface ClaimResult {
  acquired: boolean
  ownerRunId: string
  fence: number
}

/**
 * Atomically acquire or take over a claim (P0.2/P0.3). A live (unexpired) claim
 * held by another worker is NOT stolen; an expired one is, and the fence
 * increments to prove the takeover. Re-claiming your own key refreshes it and
 * bumps the fence. `acquired` is true iff the caller now holds the row.
 */
export function acquireClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; ttlSeconds: number },
  now: number,
): ClaimResult {
  db.prepare(
    `INSERT INTO case_claims (claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
     VALUES (@key, @owner, 1, @now, @expires)
     ON CONFLICT(claim_key) DO UPDATE SET
       owner_run_id = excluded.owner_run_id,
       claim_fence  = case_claims.claim_fence + 1,
       claimed_at   = excluded.claimed_at,
       claim_expires_at = excluded.claim_expires_at
     WHERE case_claims.claim_expires_at < @now`
  ).run({ key: args.claimKey, owner: args.ownerRunId, now, expires: now + args.ttlSeconds })

  const row = db.prepare(`SELECT owner_run_id, claim_fence FROM case_claims WHERE claim_key = ?`)
    .get(args.claimKey) as { owner_run_id: string; claim_fence: number }
  return { acquired: row.owner_run_id === args.ownerRunId, ownerRunId: row.owner_run_id, fence: row.claim_fence }
}

/** Release a claim only if the caller still owns it (fence-safe): a late worker
 *  whose fence has been superseded cannot release the current holder's claim. */
export function releaseClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; fence: number },
): boolean {
  const info = db.prepare(
    `DELETE FROM case_claims WHERE claim_key = @key AND owner_run_id = @owner AND claim_fence = @fence`
  ).run({ key: args.claimKey, owner: args.ownerRunId, fence: args.fence })
  return info.changes > 0
}

/** Convenience wrappers over the live DB for non-test callers. */
export const caseStore = {
  create: (input: NewCaseInput, now: number = Math.floor(Date.now() / 1000)) => createCase(getDb(), input, now),
  get: (caseId: string) => getCase(getDb(), caseId),
  transition: (input: TransitionInput, now: number = Math.floor(Date.now() / 1000)) => transitionCase(getDb(), input, now),
  appendEvent: (ev: AppendEventInput, now: number = Math.floor(Date.now() / 1000)) => appendCaseEvent(getDb(), ev, now),
  acquireClaim: (args: { claimKey: string; ownerRunId: string; ttlSeconds: number }, now: number = Math.floor(Date.now() / 1000)) => acquireClaim(getDb(), args, now),
  releaseClaim: (args: { claimKey: string; ownerRunId: string; fence: number }) => releaseClaim(getDb(), args),
}
