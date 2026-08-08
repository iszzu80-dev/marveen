// Shared Case Engine core (ZST Slice 0, arch option A: separate table namespace,
// ONE engine). The Personal COS engine (case-store.ts) and the ZST Corporate
// Case Engine (zst-case-store.ts) are the SAME logic over DIFFERENT tables.
// `makeCaseEngine(tables, defaults)` binds the SQL to a table set + default
// values; every function still takes an explicit `db` and `now` so it stays
// deterministic and unit-testable. The three invariants are baked in here so
// neither namespace can forget them:
//
//   optimistic concurrency: a transition carries the version the caller SAW; a
//     lost update throws CaseConcurrencyError, never a silent clobber. The
//     version bump + audit event are one transaction.
//   audit: every mutation appends an events row (append-only, DB-trigger
//     enforced) with the case_version at the moment of the event.
//   claims: acquire/takeover is one conditional upsert with a monotonic fence;
//     a live claim cannot be stolen, an expired one can, and the fence proves it.

import type Database from 'better-sqlite3'

/** The three tables a case namespace owns. */
export interface CaseTables {
  cases: string
  events: string
  claims: string
}

/** Per-namespace default column values applied on create when the caller omits them. */
export interface CaseDefaults {
  status: string
  priority: string
  owner: string
  sensitivity: string
  /** actor recorded on the CREATED event when the caller gives neither actor nor owner. */
  actor: string
}

/** Read-view status semantics. A namespace's status set differs (Personal uses
 *  INFO_REQUIRED; ZST uses INFORMATION_REQUIRED + FAILED_TERMINAL etc.), so which
 *  statuses count as "closed" and which "want attention today" is per-namespace. */
export interface CaseStatusSets {
  /** Closed states — excluded from the active/today read views. */
  terminal: readonly string[]
  /** Statuses that always warrant owner attention "today", regardless of dates. */
  attention: readonly string[]
}

// Personal defaults, used when a caller omits statusSets (keeps existing behaviour).
const PERSONAL_STATUS_SETS: CaseStatusSets = {
  terminal: ['COMPLETED', 'CANCELLED', 'ARCHIVED'],
  attention: ['INFO_REQUIRED', 'FOLLOW_UP_DUE', 'CALL_REQUIRED', 'AWAITING_SELECTION', 'RECOVERY_REQUIRED'],
}

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
  status?: string
  priority?: string
  sensitivity?: string
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

export type TransitionPatchKey =
  | 'next_action' | 'next_action_owner' | 'waiting_on' | 'blocked_reason'
  | 'due_at' | 'follow_up_at' | 'next_wake_at' | 'closure_reason'

export interface TransitionInput {
  caseId: string
  seenVersion: number
  newStatus: string
  actor: string
  reason?: string
  correlationId?: string
  patch?: Partial<Record<TransitionPatchKey, string | number | null>>
}

export interface CaseListItem {
  case_id: string
  title: string
  case_type: string
  category: string | null
  status: string
  priority: string
  sensitivity: string
  next_action: string | null
  next_action_owner: string | null
  waiting_on: string | null
  due_at: number | null
  follow_up_at: number | null
  source_system: string | null
  updated_at: number
}

export interface ClaimResult {
  acquired: boolean
  ownerRunId: string
  fence: number
}

// Priority sort rank (urgent-first) for the read views.
const PRIORITY_ORDER = `CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`
const LIST_COLUMNS = `case_id, title, case_type, category, status, priority, sensitivity,
  next_action, next_action_owner, waiting_on, due_at, follow_up_at, source_system, updated_at`
const PATCHABLE_COLUMNS: readonly TransitionPatchKey[] = [
  'next_action', 'next_action_owner', 'waiting_on', 'blocked_reason',
  'due_at', 'follow_up_at', 'next_wake_at', 'closure_reason',
]

export interface CaseEngine {
  appendCaseEvent(db: Database.Database, ev: AppendEventInput, now: number): number
  createCase(db: Database.Database, input: NewCaseInput, now: number): CaseRow
  getCase(db: Database.Database, caseId: string): CaseRow | undefined
  listActiveCases(db: Database.Database): CaseListItem[]
  listTodayCases(db: Database.Database, horizonSec: number): CaseListItem[]
  transitionCase(db: Database.Database, input: TransitionInput, now: number): number
  acquireClaim(db: Database.Database, args: { claimKey: string; ownerRunId: string; ttlSeconds: number }, now: number): ClaimResult
  releaseClaim(db: Database.Database, args: { claimKey: string; ownerRunId: string; fence: number }): boolean
  readonly tables: CaseTables
  readonly defaults: CaseDefaults
}

/** Build a case engine bound to one table namespace + its default column values.
 *  `statusSets` defaults to the Personal terminal/attention semantics. */
export function makeCaseEngine(
  tables: CaseTables,
  defaults: CaseDefaults,
  statusSets: CaseStatusSets = PERSONAL_STATUS_SETS,
): CaseEngine {
  const T = tables
  const TERMINAL_STATUSES = statusSets.terminal
  const ATTENTION_STATUSES = statusSets.attention

  function appendCaseEvent(db: Database.Database, ev: AppendEventInput, now: number): number {
    const info = db.prepare(
      `INSERT INTO ${T.events}
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

  function getCase(db: Database.Database, caseId: string): CaseRow | undefined {
    return db.prepare(`SELECT * FROM ${T.cases} WHERE case_id = ?`).get(caseId) as CaseRow | undefined
  }

  function createCase(db: Database.Database, input: NewCaseInput, now: number): CaseRow {
    const status = input.status ?? defaults.status
    const actor = input.actor ?? input.owner ?? defaults.actor
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO ${T.cases}
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
        priority: input.priority ?? defaults.priority,
        owner: input.owner ?? defaults.owner,
        sensitivity: input.sensitivity ?? defaults.sensitivity,
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

  function listActiveCases(db: Database.Database): CaseListItem[] {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',')
    return db.prepare(
      `SELECT ${LIST_COLUMNS} FROM ${T.cases}
       WHERE archived_at IS NULL AND status NOT IN (${placeholders})
       ORDER BY ${PRIORITY_ORDER}, updated_at DESC`
    ).all(...TERMINAL_STATUSES) as CaseListItem[]
  }

  function listTodayCases(db: Database.Database, horizonSec: number): CaseListItem[] {
    const termPh = TERMINAL_STATUSES.map(() => '?').join(',')
    const attnPh = ATTENTION_STATUSES.map(() => '?').join(',')
    return db.prepare(
      `SELECT ${LIST_COLUMNS} FROM ${T.cases}
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

  function transitionCase(db: Database.Database, input: TransitionInput, now: number): number {
    const tx = db.transaction(() => {
      const current = db.prepare(`SELECT version, status FROM ${T.cases} WHERE case_id = ?`)
        .get(input.caseId) as { version: number; status: string } | undefined
      if (!current) throw new Error(`case ${input.caseId} does not exist`)

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
        `UPDATE ${T.cases} SET ${setParts.join(', ')}
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

  function acquireClaim(
    db: Database.Database,
    args: { claimKey: string; ownerRunId: string; ttlSeconds: number },
    now: number,
  ): ClaimResult {
    db.prepare(
      `INSERT INTO ${T.claims} (claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
       VALUES (@key, @owner, 1, @now, @expires)
       ON CONFLICT(claim_key) DO UPDATE SET
         owner_run_id = excluded.owner_run_id,
         claim_fence  = ${T.claims}.claim_fence + 1,
         claimed_at   = excluded.claimed_at,
         claim_expires_at = excluded.claim_expires_at
       WHERE ${T.claims}.claim_expires_at < @now`
    ).run({ key: args.claimKey, owner: args.ownerRunId, now, expires: now + args.ttlSeconds })

    const row = db.prepare(`SELECT owner_run_id, claim_fence FROM ${T.claims} WHERE claim_key = ?`)
      .get(args.claimKey) as { owner_run_id: string; claim_fence: number }
    return { acquired: row.owner_run_id === args.ownerRunId, ownerRunId: row.owner_run_id, fence: row.claim_fence }
  }

  function releaseClaim(
    db: Database.Database,
    args: { claimKey: string; ownerRunId: string; fence: number },
  ): boolean {
    const info = db.prepare(
      `DELETE FROM ${T.claims} WHERE claim_key = @key AND owner_run_id = @owner AND claim_fence = @fence`
    ).run({ key: args.claimKey, owner: args.ownerRunId, fence: args.fence })
    return info.changes > 0
  }

  return {
    appendCaseEvent, createCase, getCase, listActiveCases, listTodayCases,
    transitionCase, acquireClaim, releaseClaim, tables, defaults,
  }
}
