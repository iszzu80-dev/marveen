// ZST Radio Kft. Corporate Case Engine (Slice 0). Binds the SHARED case engine
// (case-engine-core.ts) to the ZST table namespace + the ZST status set + ZST
// defaults. Same three invariants as Personal (optimistic concurrency,
// append-only audit, claim fencing) — the logic is not duplicated, it is the
// same core over different tables (arch option A). Slice 0 = case engine only:
// no external writers, no send. `workspace` (OPERATIONS | PRODUCT_LAB) is the
// thin routing tag; it routes work, it does not enforce isolation (the separate
// ZST Google account already does that).

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import {
  makeCaseEngine,
  type CaseTables,
  type CaseDefaults,
  type CaseStatusSets,
  type CaseRow,
  type AppendEventInput,
  type CaseListItem,
  type ClaimResult,
  type NewCaseInput as CoreNewCaseInput,
  type TransitionInput,
} from './case-engine-core.js'
import { guardCaseCompletion, completionActor } from './progression-completion.js'

export type ZstWorkspace = 'OPERATIONS' | 'PRODUCT_LAB'

export interface NewZstCaseInput extends CoreNewCaseInput {
  /** Operations vs Product Lab routing tag (defaults to OPERATIONS). */
  workspace?: ZstWorkspace
  /** Optional product portfolio link (zst_products.product_id). */
  productId?: string
}

export type { TransitionInput, CaseRow, AppendEventInput, CaseListItem, ClaimResult }

const ZST_TABLES: CaseTables = {
  cases: 'zst_cases',
  events: 'zst_case_events',
  claims: 'zst_case_claims',
}
const ZST_DEFAULTS: CaseDefaults = {
  status: 'NEW', priority: 'P2', owner: 'marveen', sensitivity: 'ZST_INTERNAL', actor: 'marveen',
}
// ZST status semantics (spec §8.3): FAILED_TERMINAL is closed; INFORMATION_REQUIRED
// / REVIEW_REQUIRED / AWAITING_INTERNAL_INPUT want attention (note the different
// spelling from Personal's INFO_REQUIRED — this is why the read-view sets are
// per-namespace).
export const ZST_STATUS_SETS: CaseStatusSets = {
  terminal: ['COMPLETED', 'CANCELLED', 'ARCHIVED', 'FAILED_TERMINAL'],
  attention: ['INFORMATION_REQUIRED', 'FOLLOW_UP_DUE', 'CALL_REQUIRED', 'AWAITING_SELECTION',
    'RECOVERY_REQUIRED', 'REVIEW_REQUIRED', 'AWAITING_INTERNAL_INPUT'],
}

const engine = makeCaseEngine(ZST_TABLES, ZST_DEFAULTS, ZST_STATUS_SETS)

/** Create a ZST case (core create) and set its routing tag / product link. The
 *  routing columns default safely (workspace=OPERATIONS) so a create without
 *  them is a valid Operations case. */
export function createZstCase(db: Database.Database, input: NewZstCaseInput, now: number): CaseRow {
  const row = engine.createCase(db, input, now)
  if (input.workspace || input.productId) {
    db.prepare(
      `UPDATE zst_cases SET workspace = COALESCE(@w, workspace), product_id = COALESCE(@p, product_id)
       WHERE case_id = @id`
    ).run({ w: input.workspace ?? null, p: input.productId ?? null, id: input.caseId })
    return engine.getCase(db, input.caseId)!
  }
  return row
}

export function appendZstCaseEvent(db: Database.Database, ev: AppendEventInput, now: number): number {
  return engine.appendCaseEvent(db, ev, now)
}
export function getZstCase(db: Database.Database, caseId: string): CaseRow | undefined {
  return engine.getCase(db, caseId)
}
export function listActiveZstCases(db: Database.Database): CaseListItem[] {
  return engine.listActiveCases(db)
}
export function listTodayZstCases(db: Database.Database, horizonSec: number): CaseListItem[] {
  return engine.listTodayCases(db, horizonSec)
}
export function transitionZstCase(db: Database.Database, input: TransitionInput, now: number): number {
  // Checkpoint E.4 completion guard: for progression-enabled ZST cases,
  // DoD must be met before the case can transition to COMPLETED.
  if (input.newStatus === 'COMPLETED') {
    guardCaseCompletion(db, 'zst', input.caseId, completionActor(input.actor))
  }
  return engine.transitionCase(db, input, now)
}
/** Link a ZST case under a parent ZST case. The guards live in the core; the
 *  namespace boundary holds here as everywhere: a personal case can never be
 *  the parent of a company one, because each store is bound to its own tables. */
export function attachZstCaseToParent(
  db: Database.Database,
  input: { caseId: string; parentCaseId: string; seenVersion: number; actor: string; reason?: string },
  now: number,
): number {
  return engine.attachToParent(db, input, now)
}
/** Record which calendar events describe this ZST case. */
export function setZstCalendarEvents(
  db: Database.Database,
  input: { caseId: string; eventIds: string[]; seenVersion: number; actor: string; reason?: string },
  now: number,
): number {
  return engine.setCalendarEvents(db, input, now)
}
export function acquireZstClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; ttlSeconds: number },
  now: number,
): ClaimResult {
  return engine.acquireClaim(db, args, now)
}
export function releaseZstClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; fence: number },
): boolean {
  return engine.releaseClaim(db, args)
}

/** Convenience wrappers over the live DB for non-test callers. */
export const zstCaseStore = {
  create: (input: NewZstCaseInput, now: number = Math.floor(Date.now() / 1000)) => createZstCase(getDb(), input, now),
  get: (caseId: string) => getZstCase(getDb(), caseId),
  listActive: () => listActiveZstCases(getDb()),
  listToday: (horizonSec: number) => listTodayZstCases(getDb(), horizonSec),
  transition: (input: TransitionInput, now: number = Math.floor(Date.now() / 1000)) => transitionZstCase(getDb(), input, now),
  appendEvent: (ev: AppendEventInput, now: number = Math.floor(Date.now() / 1000)) => appendZstCaseEvent(getDb(), ev, now),
  acquireClaim: (args: { claimKey: string; ownerRunId: string; ttlSeconds: number }, now: number = Math.floor(Date.now() / 1000)) => acquireZstClaim(getDb(), args, now),
  releaseClaim: (args: { claimKey: string; ownerRunId: string; fence: number }) => releaseZstClaim(getDb(), args),
}
