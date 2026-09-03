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
import { CASE_EVENT } from './case-event-types.js'
import { ZST_MARKERS, CORPORATE_MARKERS } from './scope-gate.js'

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
export const PERSONAL_STATUS_SETS: CaseStatusSets = {
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
  /** Stage 2G: the triage receipt this case was opened by. */
  triageReceiptId?: string
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
  /** Set by a caller that has ALREADY classified the scope (the Gmail intake
   *  route does). Its presence suppresses the createCase fallback marking, so
   *  the gate's own verdict is never overwritten by the coarser one here. */
  scopeReviewReason?: string
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
  /** Attestation to store on the STATUS_CHANGED event, inside the same
   *  transaction as the status write.
   *
   *  Added 2026-09-02 for the close attestation: which gates passed, which were
   *  NOT_EVALUATED, what the owner acknowledged and when. It rides on THIS
   *  event on purpose -- a separate attestation event written next to the
   *  transition can be lost while the status write stands, and a closure whose
   *  record of what was waived went missing is worse than one that never
   *  claimed to have a record. */
  payload?: Record<string, unknown>
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
  // P1 projection (engine-owned, read-only here). `proj_next_action` is NULL
  // whenever the engine's own text is internal machine vocabulary, which on the
  // live store is every case -- so the KIND is what a reader has to render.
  proj_next_action: string | null
  proj_next_action_kind: string | null
  proj_wait_condition: string | null
  proj_next_review_at: number | null
  last_reconciled_at: number | null
}

export interface ClaimResult {
  acquired: boolean
  ownerRunId: string
  fence: number
}

// Priority sort rank (urgent-first) for the read views.
const PRIORITY_ORDER = `CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`
const LIST_COLUMNS = `case_id, title, case_type, category, status, priority, sensitivity,
  next_action, next_action_owner, waiting_on, due_at, follow_up_at, source_system, updated_at,
  proj_next_action, proj_next_action_kind, proj_wait_condition, proj_next_review_at, last_reconciled_at`
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
  attachToParent(
    db: Database.Database,
    input: { caseId: string; parentCaseId: string; seenVersion: number; actor: string; reason?: string },
    now: number,
  ): number
  setCalendarEvents(
    db: Database.Database,
    input: { caseId: string; eventIds: string[]; seenVersion: number; actor: string; reason?: string },
    now: number,
  ): number
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
        // Stage 2G: the CREATED event names the receipt that opened the case.
        // Until 2026-08-17 this payload was NULL for every email-derived case,
        // which is why the judgement had to be reconstructed from its effect.
        payload: input.triageReceiptId ? { triageReceiptId: input.triageReceiptId } : undefined,
      }, now)

      // THE GATE BELONGS AT THE CHOKE POINT, NOT ON ONE CALLER.
      //
      // classifyScope runs in the Gmail intake route, and it works: the Deepgram
      // DPA that arrived on the private connector on 2026-08-31 was marked
      // "ZST bridge csak explicit emberi jovahagyassal" within the minute. But
      // CORP-SEC-2026-001 and CORP-CLOUD-2026-001 -- both unmistakably ZST --
      // sit in personal_cases with scope_review_reason NULL, because they came
      // in through `scripts/chatgpt-cos-baseline-import.mjs`, a SECOND inbound
      // door that never calls the gate. The health monitor has reported them as
      // a CRITICAL "ceges tartalom a szemelyes tarban" ever since, with no way
      // for anyone to tell a gated case from an ungated one.
      //
      // Every door goes through createCase. So the marking goes here.
      //
      // It MARKS, it does not route. Routing corporate content out of the
      // connector it arrived on would break the boundary the whole namespace
      // split rests on -- connector identity IS the scope, and a private mailbox
      // may not write into the company's store on the strength of some words in
      // a subject line. The bridge stays what it was designed to be: explicit,
      // audited, and a human's decision.
      // A caller that already classified the scope owns the wording; persist it.
      // Without this the field was silently dropped, and a case the intake route
      // HAD gated looked exactly like one nothing had ever looked at.
      if (input.scopeReviewReason !== undefined) {
        db.prepare(`UPDATE ${T.cases} SET scope_review_reason = ? WHERE case_id = ?`)
          .run(input.scopeReviewReason, input.caseId)
      }

      if (T.cases === 'personal_cases' && input.scopeReviewReason === undefined) {
        const text = `${input.title} ${input.description ?? ''}`.toLowerCase()
        const hit = [...ZST_MARKERS, ...CORPORATE_MARKERS].find(m => text.includes(m.toLowerCase()))
        if (hit) {
          const reason = `SCOPE REVIEW — ${ZST_MARKERS.some(m => text.includes(m.toLowerCase())) ? 'ZST_EXCLUDED' : 'CORPORATE_EXCLUDED'}`
            + ` (emberi ellenorzes kell): ceges/ZST tartalom a szemelyes tarban: ${hit};`
            + ' a namespace-et a connector identity donti el, a ZST bridge csak explicit emberi jovahagyassal'
          db.prepare(`UPDATE ${T.cases} SET scope_review_reason = ? WHERE case_id = ?`).run(reason, input.caseId)
          appendCaseEvent(db, {
            caseId: input.caseId, caseVersion: 1, actor,
            eventType: 'SCOPE_REVIEW_FLAGGED', reason,
            payload: { marker: hit, gate: 'createCase' },
          }, now)
        }
      }
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

  /**
   * Hang a case under a parent case.
   *
   * `parent_case_id` has existed as a column since the schema was written and
   * nothing has ever written it: 0 of 79 personal cases, 0 of 42 ZST ones. The
   * READ side, by contrast, is fully built — progression-resolver selects it,
   * counts children, and puts `hasParent`/`hasChildren` into ResolvedContext,
   * which the pipeline carries. No interpreter branch reads those two flags
   * today, so THIS FUNCTION'S FIRST CALL CHANGES ResolvedContext ON EVERY
   * AFFECTED CASE without changing any decision. The day someone branches on
   * them, they inherit whatever we linked here.
   *
   * Two guards, both because a wrong link is worse than no link:
   *
   * - The parent must EXIST. An empty column knows it is empty; a pointer to a
   *   case that was never created is a lie that reads like data.
   * - No cycles. A child cannot be its own ancestor. `hasChildren` is a COUNT
   *   over one level so a loop would not hang it, but a trip that contains
   *   itself is not a fact about any trip.
   *
   * Re-linking to the SAME parent is a no-op returning the unchanged version:
   * a second sweep over the same cluster must not manufacture events.
   */
  function attachToParent(
    db: Database.Database,
    input: { caseId: string; parentCaseId: string; seenVersion: number; actor: string; reason?: string },
    now: number,
  ): number {
    const tx = db.transaction(() => {
      const current = db.prepare(`SELECT version, parent_case_id FROM ${T.cases} WHERE case_id = ?`)
        .get(input.caseId) as { version: number; parent_case_id: string | null } | undefined
      if (!current) throw new Error(`case ${input.caseId} does not exist`)
      if (current.parent_case_id === input.parentCaseId) return current.version

      if (input.parentCaseId === input.caseId) {
        throw new Error(`case ${input.caseId} cannot be its own parent`)
      }
      const parent = db.prepare(`SELECT case_id FROM ${T.cases} WHERE case_id = ?`)
        .get(input.parentCaseId) as { case_id: string } | undefined
      if (!parent) {
        throw new Error(
          `parent case ${input.parentCaseId} does not exist — refusing to write a dangling parent_case_id`
        )
      }
      // Walk up from the proposed parent. Reaching the child means the link
      // would close a loop. Bounded by the walk itself: an already-cyclic table
      // would spin here, so the seen-set stops it.
      const seen = new Set<string>([input.caseId])
      let cursor: string | null = input.parentCaseId
      while (cursor) {
        if (seen.has(cursor)) throw new Error(`linking ${input.caseId} to ${input.parentCaseId} would create a cycle`)
        seen.add(cursor)
        const up = db.prepare(`SELECT parent_case_id FROM ${T.cases} WHERE case_id = ?`)
          .get(cursor) as { parent_case_id: string | null } | undefined
        cursor = up?.parent_case_id ?? null
      }

      const info = db.prepare(
        `UPDATE ${T.cases} SET parent_case_id = @parentCaseId, version = version + 1, updated_at = @now
         WHERE case_id = @caseId AND version = @seenVersion`
      ).run({ caseId: input.caseId, parentCaseId: input.parentCaseId, now, seenVersion: input.seenVersion })
      if (info.changes === 0) throw new CaseConcurrencyError(input.caseId, input.seenVersion)

      const newVersion = input.seenVersion + 1
      appendCaseEvent(db, {
        caseId: input.caseId,
        caseVersion: newVersion,
        actor: input.actor,
        eventType: 'PARENT_LINKED',
        reason: input.reason ?? null,
        payload: { parentCaseId: input.parentCaseId, previousParentCaseId: current.parent_case_id },
      }, now)
      return newVersion
    })
    return tx()
  }

  /**
   * Record which calendar events describe this case.
   *
   * Same shape as the parent column and found the same way: `calendar_event_ids`
   * is 0 of 79 filled while the owner's calendar holds the whole trip as real
   * start/end pairs. The case store could not see what the calendar knew,
   * because nothing ever joined them.
   *
   * Stored as a JSON array, deduplicated and ordered as given. An empty list
   * writes `[]`, not NULL — "checked, none" and "never looked" must not read
   * the same, which is the failure this whole thread keeps finding.
   */
  function setCalendarEvents(
    db: Database.Database,
    input: { caseId: string; eventIds: string[]; seenVersion: number; actor: string; reason?: string },
    now: number,
  ): number {
    const unique = [...new Set(input.eventIds.map(s => s.trim()).filter(Boolean))]
    const tx = db.transaction(() => {
      const current = db.prepare(`SELECT version, calendar_event_ids FROM ${T.cases} WHERE case_id = ?`)
        .get(input.caseId) as { version: number; calendar_event_ids: string | null } | undefined
      if (!current) throw new Error(`case ${input.caseId} does not exist`)
      const next = JSON.stringify(unique)
      if (current.calendar_event_ids === next) return current.version

      const info = db.prepare(
        `UPDATE ${T.cases} SET calendar_event_ids = @ids, version = version + 1, updated_at = @now
         WHERE case_id = @caseId AND version = @seenVersion`
      ).run({ caseId: input.caseId, ids: next, now, seenVersion: input.seenVersion })
      if (info.changes === 0) throw new CaseConcurrencyError(input.caseId, input.seenVersion)

      const newVersion = input.seenVersion + 1
      appendCaseEvent(db, {
        caseId: input.caseId,
        caseVersion: newVersion,
        actor: input.actor,
        eventType: 'CALENDAR_EVENTS_LINKED',
        reason: input.reason ?? null,
        payload: { eventIds: unique, previous: current.calendar_event_ids },
      }, now)
      return newVersion
    })
    return tx()
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
        eventType: CASE_EVENT.STATUS_CHANGED,
        previousStatus: current.status,
        newStatus: input.newStatus,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        payload: input.payload,
      }, now)
      return newVersion
    })
    return tx()
  }

  /**
   * Take (or take over) a claim. The upsert only steals an EXPIRED claim, so a
   * live one held by somebody else answers acquired:false.
   *
   * E2, stated because it is load-bearing and was being relied on backwards: for
   * the SAME owner id this call is RE-ENTRANT. On a live claim the upsert is a
   * no-op (the WHERE excludes it) and the SELECT then reports acquired:true
   * because the owner matches — which is right for a run re-entering its own
   * claim, and useless as mutual exclusion for two concurrent callers that
   * computed the same owner id. A caller using this to serialise concurrent
   * attempts must therefore give each ATTEMPT its own owner id; a caller
   * renewing a run's claim must reuse the run's. send-flow.ts got this wrong by
   * deriving the owner id from the ledger row.
   */
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
    transitionCase, attachToParent, setCalendarEvents, acquireClaim, releaseClaim, tables, defaults,
  }
}
