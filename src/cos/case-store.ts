// Personal Chief of Staff (COS) domain-command layer. As of ZST Slice 0 the
// engine logic lives in case-engine-core.ts (shared with the ZST Corporate Case
// Engine, arch option A); this module binds that engine to the PERSONAL table
// namespace (personal_cases / personal_case_events / case_claims) and its
// default column values, and re-exports the same public surface as before so
// every existing caller and test is unchanged. The three invariants (optimistic
// concurrency, append-only audit, claim fencing) are enforced in the core.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import type { CaseStatus, CaseSensitivity } from './schema.js'
import {
  makeCaseEngine,
  CaseConcurrencyError,
  type CaseTables,
  type CaseDefaults,
  type CaseRow,
  type AppendEventInput,
  type CaseListItem,
  type ClaimResult,
  type NewCaseInput as CoreNewCaseInput,
  type TransitionInput as CoreTransitionInput,
  type TransitionPatchKey,
} from './case-engine-core.js'
import { guardCaseCompletion } from './progression-completion.js'

export { CaseConcurrencyError }
export type { CaseRow, AppendEventInput, CaseListItem, ClaimResult }

// Personal namespace keeps its stricter compile-time status/sensitivity types by
// narrowing the core's string-typed inputs (CaseStatus/CaseSensitivity ⊆ string).
export interface NewCaseInput extends Omit<CoreNewCaseInput, 'status' | 'sensitivity'> {
  status?: CaseStatus
  sensitivity?: CaseSensitivity
}
export interface TransitionInput extends Omit<CoreTransitionInput, 'newStatus'> {
  newStatus: CaseStatus
}
export type { TransitionPatchKey }

const PERSONAL_TABLES: CaseTables = {
  cases: 'personal_cases',
  events: 'personal_case_events',
  claims: 'case_claims',
}
const PERSONAL_DEFAULTS: CaseDefaults = {
  status: 'NEW', priority: 'P2', owner: 'marveen', sensitivity: 'PERSONAL', actor: 'marveen',
}

const engine = makeCaseEngine(PERSONAL_TABLES, PERSONAL_DEFAULTS)

export function appendCaseEvent(db: Database.Database, ev: AppendEventInput, now: number): number {
  return engine.appendCaseEvent(db, ev, now)
}
export function createCase(db: Database.Database, input: NewCaseInput, now: number): CaseRow {
  return engine.createCase(db, input, now)
}
export function getCase(db: Database.Database, caseId: string): CaseRow | undefined {
  return engine.getCase(db, caseId)
}
export function listActiveCases(db: Database.Database): CaseListItem[] {
  return engine.listActiveCases(db)
}
export function listTodayCases(db: Database.Database, horizonSec: number): CaseListItem[] {
  return engine.listTodayCases(db, horizonSec)
}
export function transitionCase(db: Database.Database, input: TransitionInput, now: number): number {
  // Checkpoint E.4 completion guard: for progression-enabled cases, DoD must
  // be met before the case can transition to COMPLETED.
  if (input.newStatus === 'COMPLETED') {
    guardCaseCompletion(db, 'personal', input.caseId)
  }
  return engine.transitionCase(db, input, now)
}
export function acquireClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; ttlSeconds: number },
  now: number,
): ClaimResult {
  return engine.acquireClaim(db, args, now)
}
export function releaseClaim(
  db: Database.Database,
  args: { claimKey: string; ownerRunId: string; fence: number },
): boolean {
  return engine.releaseClaim(db, args)
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
