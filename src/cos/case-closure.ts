// Closing a case, from outside the process. The one exit.
//
// WHY THIS FILE EXISTS AT ALL (2026-09-02).
//
// The case engine has had a correct, guarded, version-checked close since it
// was written -- `transitionCase` / `transitionZstCase`, which validate the
// seen version, run `guardCaseCompletion`, write a case event and stamp
// `completed_at`. Nothing outside the process could reach it. There is a
// `/api/cos/cases/reopen` route and no route that closes; the Mission Control
// board has no close control; `owner-action` writes an event and lets the
// engine draw its own conclusion, which for a case whose owner had just said
// "this is finished" produced RECOVERY_REQUIRED and left the status untouched.
//
// The cost was measured before this was written, not guessed: 51 open cases sat
// in the entry state, the oldest 23 days, and across 88 corporate cases exactly
// one had ever reached a terminal status -- zero COMPLETED, zero CANCELLED. It
// read like neglect. It was a missing button.
//
// ONE PATH, AND THIS IS IT. Everything here funnels into the existing
// transition function. No status UPDATE is written in this file; no second
// completion policy is evaluated in this file. If a future caller wants to
// close a case, it calls closeCase, and closeCase calls the engine.
//
// OWNER-REPORTED RESULT IS NOT COMPLETION AUTHORISATION. That distinction is
// the reason the owner-action route did NOT close PRI-FAMILY-2026-002 when the
// owner reported the outcome, and it is kept on purpose: an event that records
// what happened is evidence, and closing is an intent. They arrive on different
// routes because conflating them means any narrative sentence can terminalise a
// case. `intent: 'CLOSE_CASE'` is required here, explicitly, so that no caller
// drifts into a close by passing a payload that happened to fit.

import type Database from 'better-sqlite3'
import { transitionCase, getCase } from './case-store.js'
import { transitionZstCase, getZstCase } from './zst-case-store.js'
import {
  canCompleteCase, completionActor, PrematureCompletionError,
  type CompletionBlocker, type CompletionGate,
} from './progression-completion.js'

export type CloseDomain = 'personal' | 'zst'

export interface CloseCaseInput {
  domain: CloseDomain
  caseId: string
  /** The version the caller believes it is closing. A mismatch is refused, not
   *  reconciled: the caller decided on a state, and if the case moved since,
   *  the decision was made about something else. */
  expectedVersion: number
  /** Why. Required and non-blank -- a terminal status with no stated reason is
   *  the shape a later reader cannot audit, and this is the last write the case
   *  gets. */
  reason: string
  /** Where the decision came from (a Telegram message id, a Mission Control
   *  session, a run id). Required and non-blank for the same reason. */
  provenance: string
  /** Who is closing. Mapped to a CompletionActor by the completion module, so
   *  this file does not get to decide what counts as the engine. */
  actor: string
  /** Explicit intent. Present so that a close cannot be reached by a caller
   *  that merely resembles one. */
  intent: 'CLOSE_CASE'
  /** Refs the caller has seen and accepts. Two kinds live in one list on
   *  purpose: a measured blocker's ref, and a NOT_EVALUATED gate's id.
   *
   *  Closing over either is permitted -- the owner's authority is not in
   *  question -- but only knowingly, and only ITEM BY ITEM. Acknowledging one
   *  never releases another, because the refs differ; a single "yes I accept
   *  the risks" would be exactly the shrug this design is avoiding.
   *
   *  For a NOT_EVALUATED gate the acknowledgement asserts something narrower
   *  than absence: the system could not check this, and the owner is closing in
   *  the knowledge that it could not. */
  acknowledgedBlockers?: readonly string[]
  /** The terminal status. COMPLETED by default; CANCELLED for a case that ends
   *  without being done. Both are terminal and both are the owner's call. */
  newStatus?: 'COMPLETED' | 'CANCELLED'
}

export type CloseRefusalCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BLOCKERS_NOT_ACKNOWLEDGED'
  | 'COMPLETION_GUARD'

export type CloseCaseResult =
  | {
      outcome: 'CLOSED'
      caseId: string
      domain: CloseDomain
      status: 'COMPLETED' | 'CANCELLED'
      version: number
      completedAt: number | null
      /** What was outstanding at the moment of closing, recorded so the cost is
       *  visible afterwards and not only in the dialog that authorised it. */
      acknowledgedBlockers: CompletionBlocker[]
      /** Every gate and its verdict at the moment of closing, NOT_EVALUATED
       *  ones included and still marked NOT_EVALUATED. */
      gates: CompletionGate[]
    }
  | {
      outcome: 'ALREADY_CLOSED'
      caseId: string
      domain: CloseDomain
      status: string
      version: number
      completedAt: number | null
    }
  | {
      outcome: 'REFUSED'
      caseId: string
      domain: CloseDomain
      code: CloseRefusalCode
      reason: string
      /** Present on BLOCKERS_NOT_ACKNOWLEDGED so the caller can show them and
       *  come back with the refs. Empty otherwise. */
      blockers: CompletionBlocker[]
      /** Gate ids that were not acknowledged, when the refusal is about a
       *  NOT_EVALUATED gate rather than a measured blocker. */
      unacknowledgedGates?: CompletionGate[]
      /** Present on VERSION_CONFLICT: what the store actually holds, so the
       *  caller can re-read rather than guess. */
      currentVersion?: number
    }

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED'])

interface CaseSnapshot { version: number; status: string; completed_at: number | null }

function readCase(
  db: Database.Database, domain: CloseDomain, caseId: string,
): CaseSnapshot | undefined {
  // Domain-scoped by construction: two stores, two readers, and neither can
  // return the other's row. A shared "find the case anywhere" helper is exactly
  // how one namespace ends up closing the other's case by implicit routing.
  const row = domain === 'personal' ? getCase(db, caseId) : getZstCase(db, caseId)
  if (!row) return undefined
  const r = row as unknown as { version: number; status: string; completed_at: number | null }
  return { version: r.version, status: r.status, completed_at: r.completed_at ?? null }
}

/**
 * Close a case through the canonical transition.
 *
 * Refuses rather than guesses, in this order:
 *   1. blank reason / provenance / wrong intent  -> INVALID_INPUT
 *   2. no such case IN THIS DOMAIN               -> NOT_FOUND
 *   3. already terminal                          -> ALREADY_CLOSED (idempotent)
 *   4. expectedVersion != stored version         -> VERSION_CONFLICT
 *   5. outstanding blockers not acknowledged     -> BLOCKERS_NOT_ACKNOWLEDGED
 *   6. completion guard refuses                  -> COMPLETION_GUARD
 *
 * Order matters. The already-terminal check sits ABOVE the version check on
 * purpose: a retry of a close that succeeded arrives with the version the
 * caller saw BEFORE the close, so checking the version first would answer
 * "conflict" to the one case where nothing is wrong -- a retry is how a flaky
 * network looks, and it must not read as a race.
 */
export function closeCase(
  db: Database.Database,
  input: CloseCaseInput,
  now: number = Math.floor(Date.now() / 1000),
): CloseCaseResult {
  const { domain, caseId } = input
  const base = { caseId, domain }

  if (input.intent !== 'CLOSE_CASE') {
    return { ...base, outcome: 'REFUSED', code: 'INVALID_INPUT', blockers: [],
      reason: 'explicit intent CLOSE_CASE required' }
  }
  const reason = (input.reason ?? '').trim()
  const provenance = (input.provenance ?? '').trim()
  const actor = (input.actor ?? '').trim()
  if (!reason) {
    return { ...base, outcome: 'REFUSED', code: 'INVALID_INPUT', blockers: [],
      reason: 'reason is required and must not be blank' }
  }
  if (!provenance) {
    return { ...base, outcome: 'REFUSED', code: 'INVALID_INPUT', blockers: [],
      reason: 'provenance is required and must not be blank' }
  }
  if (!actor) {
    return { ...base, outcome: 'REFUSED', code: 'INVALID_INPUT', blockers: [],
      reason: 'actor is required and must not be blank' }
  }
  if (!Number.isInteger(input.expectedVersion)) {
    return { ...base, outcome: 'REFUSED', code: 'INVALID_INPUT', blockers: [],
      reason: 'expectedVersion must be an integer' }
  }
  const newStatus = input.newStatus ?? 'COMPLETED'

  const snapshot = readCase(db, domain, caseId)
  if (!snapshot) {
    return { ...base, outcome: 'REFUSED', code: 'NOT_FOUND', blockers: [],
      reason: `no case ${caseId} in the ${domain} namespace` }
  }

  if (TERMINAL.has(snapshot.status)) {
    return {
      ...base, outcome: 'ALREADY_CLOSED',
      status: snapshot.status, version: snapshot.version, completedAt: snapshot.completed_at,
    }
  }

  if (snapshot.version !== input.expectedVersion) {
    return {
      ...base, outcome: 'REFUSED', code: 'VERSION_CONFLICT', blockers: [],
      reason: `case is at version ${snapshot.version}, the close was decided on version ${input.expectedVersion}`,
      currentVersion: snapshot.version,
    }
  }

  // The gate answers for THIS actor. For an owner it says allowed, and it says
  // what the closure abandons; both halves are used.
  const gate = canCompleteCase(db, domain, caseId, completionActor(actor))
  const acked = new Set(input.acknowledgedBlockers ?? [])

  // EVERYTHING THAT IS NOT A PASS NEEDS A SIGNATURE, and each one its own.
  // A measured blocker and a check that could not run are different claims, but
  // they share this: neither may be waived by silence, and neither may be
  // waived by acknowledging the other. `acked` is a set of exact refs, so the
  // only way through is to name each item.
  const unacknowledged = gate.blockers.filter(b => !acked.has(b.ref))
  const unacknowledgedGates = gate.gates.filter(
    g => g.status === 'NOT_EVALUATED' && !acked.has(g.id))
  if (unacknowledged.length > 0 || unacknowledgedGates.length > 0) {
    const parts: string[] = []
    if (unacknowledged.length) parts.push(`${unacknowledged.length} nyitott tetel`)
    if (unacknowledgedGates.length) parts.push(`${unacknowledgedGates.length} nem ertekelheto kapu`)
    return {
      ...base, outcome: 'REFUSED', code: 'BLOCKERS_NOT_ACKNOWLEDGED',
      reason: `${parts.join(' es ')} nyugtazasa hianyzik a lezarashoz`,
      blockers: unacknowledged,
      unacknowledgedGates,
    }
  }

  // The engine's own close. It re-runs the completion guard (a second read of
  // the same gate, not a second policy) and throws rather than writing when the
  // guard refuses. Catching it here turns the throw into a refusal the caller
  // can render, which is the only reason this is wrapped.
  let version: number
  try {
    const patch = { closure_reason: reason }
    // THE ATTESTATION, written inside the same transaction as the status.
    // It records what was true at the moment of closing and who accepted it --
    // and it keeps a NOT_EVALUATED gate marked NOT_EVALUATED. Nothing here
    // rewrites an unchecked gate into a passed one; a later reader must be able
    // to see that a question went unanswered, not merely that a box was ticked.
    const attestation = {
      closure: {
        reason, provenance, actor, newStatus,
        acknowledgedAt: now,
        gates: gate.gates,
        acknowledgedRefs: [...acked],
        acknowledgedBlockers: gate.blockers,
        notEvaluated: gate.gates.filter(g => g.status === 'NOT_EVALUATED').map(g => g.id),
      },
    }
    const args = {
      caseId, seenVersion: input.expectedVersion, newStatus, actor,
      reason, correlationId: provenance, patch, payload: attestation,
    }
    version = domain === 'personal'
      ? transitionCase(db, args, now)
      : transitionZstCase(db, args, now)
  } catch (err) {
    if (err instanceof PrematureCompletionError) {
      return {
        ...base, outcome: 'REFUSED', code: 'COMPLETION_GUARD',
        reason: err.message, blockers: gate.blockers,
      }
    }
    throw err
  }

  const after = readCase(db, domain, caseId)
  return {
    ...base, outcome: 'CLOSED', status: newStatus, version,
    completedAt: after?.completed_at ?? null,
    acknowledgedBlockers: gate.blockers,
    gates: gate.gates,
  }
}
