// Personal Chief of Staff (COS) — Action Executor (Slice 1 core).
//
// The SINGLE sanctioned writer to the outside world. Every outbound side effect
// goes through outbound_ledger's crash-safe state machine so a crash, retry, or
// restart can NEVER double-send. The one invariant everything else serves:
//   never call adapter.send() twice for the same action without a readback
//   first PROVING the prior attempt did not reach the provider.
//
// State model (spec v4.2.1 P1.1):
//   PLANNED → SENDING (durable BEFORE the call, P0.3 crash window)
//           → APPLIED_UNVERIFIED (provider returned success; readback not yet
//             confirmed) → VERIFIED (readback found the marker).
//   APPLIED_UNVERIFIED is a legitimate RESTING state: the provider accepted the
//   send, so a resend is FORBIDDEN, but we have not yet proven it via readback.
//   The daily reconcile re-attempts readback; it never resends.
//   Any send exception with an UNKNOWN outcome → OUTCOME_UNKNOWN → recovery
//   readback → VERIFIED (it did land) or PLANNED (proven absent, safe resend).
//   A send that PROVABLY never reached the provider → FAILED_RETRYABLE (may be
//   retried) or FAILED_TERMINAL (give up). CANCELLED is a deliberate abort of a
//   not-yet-sent row (e.g. campaign revoked). RECOVERY_REQUIRED is the alarm
//   state: provider reported success but the marker is provably absent — a
//   human must resolve it (never auto-resend, the provider claimed success).
//   DB UNIQUE on the idempotency key and on (case, action_type, sequence) is the
//   last line if app logic is bypassed.
//
// The capability itself lives behind OutboundAdapter — this module holds NO
// send capability of its own, so it is safe to build/test now (with a mock
// adapter) before any real connector (Gmail write) is wired.

import type Database from 'better-sqlite3'
import { reserveQuota } from './quota.js'

export type OutboundStatus =
  | 'PLANNED' | 'SENDING' | 'APPLIED_UNVERIFIED' | 'OUTCOME_UNKNOWN'
  | 'VERIFIED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'CANCELLED'
  | 'RECOVERY_REQUIRED'

/** Terminal — no further executor work. */
export const TERMINAL_STATUSES: readonly OutboundStatus[] = ['VERIFIED', 'FAILED_TERMINAL', 'CANCELLED']
/** Provider was (or may have been) touched → the executor must NEVER blind-resend
 *  these; they resolve only via readback/reconcile or a human. */
export const NON_RESENDABLE_STATUSES: readonly OutboundStatus[] = ['APPLIED_UNVERIFIED', 'RECOVERY_REQUIRED']

export interface OutboundAction {
  ledgerId: string
  caseId: string | null
  actionType: string
  sequenceNumber: number
  internalIdempotencyKey: string
  /** The marker actually embedded in the outbound message and searched on
   *  readback (D.1: external_idempotency_marker). Defaults to the internal key. */
  externalIdempotencyMarker: string
  payload: unknown
  status: OutboundStatus
  externalRef: string | null
  attempt: number
}

/** Readback answer. `found` = the marker is present at the provider. `available`
 *  (default true) = the readback itself could be performed; `available:false`
 *  means we could not determine presence (e.g. Sent search unreachable) and MUST
 *  NOT be read as "absent". A thrown readback is also treated as unavailable. */
export interface ReadbackResult {
  found: boolean
  available?: boolean
  externalRef?: string
}

/** The capability boundary: the ONLY thing that touches the outside world.
 *  send() throws on failure. readback() answers "did the action carrying this
 *  idempotency marker already get applied?" WITHOUT re-sending — it is what
 *  makes recovery safe. A real adapter embeds the marker as a searchable field
 *  in the outbound message (e.g. X-Marveen-Idempotency-Key) so readback can find
 *  it in the Sent folder / provider. */
export interface OutboundAdapter {
  readonly actionType: string
  send(action: OutboundAction): Promise<{ externalRef: string }>
  readback(externalIdempotencyMarker: string): Promise<ReadbackResult>
}

/** A send() failure MAY carry outcome hints. Without them the outcome is treated
 *  as UNKNOWN (the safe default → OUTCOME_UNKNOWN → readback recovery). An
 *  adapter that can PROVE the request never reached the provider sets
 *  reachedProvider:false (+ terminal to pick FAILED_TERMINAL vs FAILED_RETRYABLE). */
export interface SendErrorHints {
  reachedProvider?: boolean
  terminal?: boolean
}
export class SendError extends Error implements SendErrorHints {
  reachedProvider?: boolean
  terminal?: boolean
  constructor(message: string, hints: SendErrorHints = {}) {
    super(message)
    this.name = 'SendError'
    this.reachedProvider = hints.reachedProvider
    this.terminal = hints.terminal
  }
}

/** Deterministic idempotency key: same (case, action, sequence) → same key, so
 *  the marker embedded in the outbound message is reproducible for readback. */
export function idempotencyKey(caseId: string, actionType: string, sequenceNumber: number): string {
  return `mv-${caseId}-${actionType}-${sequenceNumber}`
}

interface Row {
  ledger_id: string
  case_id: string | null
  action_type: string
  sequence_number: number
  internal_idempotency_key: string
  external_idempotency_marker: string | null
  status: OutboundStatus
  payload: string | null
  external_ref: string | null
  attempt: number
}

function toAction(r: Row): OutboundAction {
  return {
    ledgerId: r.ledger_id,
    caseId: r.case_id,
    actionType: r.action_type,
    sequenceNumber: r.sequence_number,
    internalIdempotencyKey: r.internal_idempotency_key,
    externalIdempotencyMarker: r.external_idempotency_marker ?? r.internal_idempotency_key,
    payload: r.payload == null ? null : JSON.parse(r.payload),
    status: r.status,
    externalRef: r.external_ref,
    attempt: r.attempt,
  }
}

function loadOrThrow(db: Database.Database, ledgerId: string): OutboundAction {
  const r = db.prepare(`SELECT * FROM outbound_ledger WHERE ledger_id = ?`).get(ledgerId) as Row | undefined
  if (!r) throw new Error(`outbound_ledger row not found: ${ledgerId}`)
  return toAction(r)
}

function setStatus(
  db: Database.Database, ledgerId: string, status: OutboundStatus,
  fields: Partial<Record<'external_ref' | 'last_error' | 'sending_at' | 'applied_at' | 'verified_at' | 'attempt', unknown>>,
  now: number,
): void {
  const cols = ['status = @status', 'updated_at = @now']
  const params: Record<string, unknown> = { ledgerId, status, now }
  for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = @${k}`); params[k] = v }
  db.prepare(`UPDATE outbound_ledger SET ${cols.join(', ')} WHERE ledger_id = @ledgerId`).run(params)
}

export interface PlanInput {
  caseId: string
  actionType: string
  sequenceNumber: number
  payload?: unknown
  /** Override the external marker; defaults to the deterministic internal key. */
  externalMarker?: string
}

/** Record an intended action as PLANNED. The idempotency key + ledger id are
 *  deterministic, so a duplicate plan trips the UNIQUE constraint rather than
 *  creating a second sendable row. */
export function planAction(db: Database.Database, input: PlanInput, now: number): OutboundAction {
  const key = idempotencyKey(input.caseId, input.actionType, input.sequenceNumber)
  const ledgerId = `ob-${key}`
  const marker = input.externalMarker ?? key
  db.prepare(
    `INSERT INTO outbound_ledger
       (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
        external_idempotency_marker, status, payload, attempt, created_at, updated_at)
     VALUES (@ledgerId, @caseId, @actionType, @sequenceNumber, @key,
        @marker, 'PLANNED', @payload, 0, @now, @now)`
  ).run({
    ledgerId, caseId: input.caseId, actionType: input.actionType, sequenceNumber: input.sequenceNumber,
    key, marker, payload: input.payload === undefined ? null : JSON.stringify(input.payload), now,
  })
  return loadOrThrow(db, ledgerId)
}

/** Optional per-send controls. `quota` gates the send behind an atomic
 *  rolling-window reservation (P0.4): if the window is full the action stays
 *  PLANNED and is NOT sent (it retries in a later window). */
export interface ExecuteOpts {
  quota?: { key: string; maxCount: number; windowSec: number }
}

/**
 * Crash-safe execute. Terminal states are idempotent no-ops. A row the provider
 * may already have (APPLIED_UNVERIFIED, RECOVERY_REQUIRED) is NEVER blind-resent
 * — APPLIED_UNVERIFIED re-attempts readback, RECOVERY_REQUIRED waits for a human.
 * A row already SENDING/OUTCOME_UNKNOWN recovers via readback first. Only a
 * PLANNED (or FAILED_RETRYABLE) row sends, persisting SENDING BEFORE the external
 * call so a crash leaves a durable trail.
 */
export async function executeAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number, opts: ExecuteOpts = {},
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  if (TERMINAL_STATUSES.includes(a.status)) return a
  if (a.status === 'APPLIED_UNVERIFIED') return verifyAction(db, adapter, ledgerId, now)
  if (a.status === 'RECOVERY_REQUIRED') return a
  if (a.status === 'SENDING' || a.status === 'OUTCOME_UNKNOWN') {
    return recoverAction(db, adapter, ledgerId, now)
  }
  // PLANNED or FAILED_RETRYABLE → (re)send.
  // P0.4: atomically reserve a send slot BEFORE anything else. If the window is
  // full, do not send — leave PLANNED to retry once the window frees. A reserved
  // slot is consumed by the attempt (not refunded on OUTCOME_UNKNOWN — it may
  // have reached the provider).
  if (opts.quota) {
    const rr = reserveQuota(db, opts.quota.key, opts.quota.maxCount, opts.quota.windowSec, now)
    if (!rr.reserved) {
      setStatus(db, ledgerId, 'PLANNED', { last_error: `send quota exceeded for ${opts.quota.key}` }, now)
      return loadOrThrow(db, ledgerId)
    }
  }
  // Persist SENDING BEFORE the call (P0.3 crash window).
  setStatus(db, ledgerId, 'SENDING', { sending_at: now, attempt: a.attempt + 1 }, now)
  let externalRef: string
  try {
    const r = await adapter.send(loadOrThrow(db, ledgerId))
    externalRef = r.externalRef
  } catch (err) {
    const hints = err as Partial<SendErrorHints>
    const msg = String((err as Error)?.message ?? err)
    if (hints?.reachedProvider === false) {
      // Provably never reached the provider → a resend cannot double-send.
      setStatus(db, ledgerId, hints.terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE', { last_error: msg }, now)
    } else {
      // Unknown whether it reached the provider → recover via readback later.
      setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: msg }, now)
    }
    return loadOrThrow(db, ledgerId)
  }
  // Provider accepted → APPLIED_UNVERIFIED is durable BEFORE we attempt readback,
  // so even a crash here can never produce a resend (a resend is forbidden from
  // APPLIED_UNVERIFIED).
  setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { external_ref: externalRef, applied_at: now }, now)
  return verifyAction(db, adapter, ledgerId, now)
}

/** Prove an APPLIED_UNVERIFIED action really landed by reading back its marker.
 *  found → VERIFIED. readback unavailable → stays APPLIED_UNVERIFIED (the daily
 *  reconcile retries; a resend is never triggered). provably absent → the alarm
 *  state RECOVERY_REQUIRED (provider claimed success but the marker is gone; a
 *  human resolves it — we do NOT resend on a claimed success). */
export async function verifyAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  let rb: ReadbackResult
  try {
    rb = await adapter.readback(a.externalIdempotencyMarker)
  } catch (err) {
    setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: `readback unavailable: ${String((err as Error)?.message ?? err)}` }, now)
    return loadOrThrow(db, ledgerId)
  }
  if (rb.found) {
    setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now)
  } else if (rb.available === false) {
    setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: 'readback unavailable' }, now)
  } else {
    setStatus(db, ledgerId, 'RECOVERY_REQUIRED', { last_error: 'provider reported success but marker absent on readback' }, now)
  }
  return loadOrThrow(db, ledgerId)
}

/**
 * Recover a SENDING/OUTCOME_UNKNOWN row (crash, restart, or transient error where
 * the outcome is UNKNOWN — no confirmed provider success). Reads back the marker:
 * found → VERIFIED (no resend); provably absent → PLANNED (a resend is now safe);
 * readback unavailable → stays OUTCOME_UNKNOWN (retry recovery later, never a
 * blind resend). This is the gate that prevents double-send.
 */
export async function recoverAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  let rb: ReadbackResult
  try {
    rb = await adapter.readback(a.externalIdempotencyMarker)
  } catch (err) {
    setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: `readback unavailable: ${String((err as Error)?.message ?? err)}` }, now)
    return loadOrThrow(db, ledgerId)
  }
  if (rb.found) {
    setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now)
  } else if (rb.available === false) {
    setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: 'readback unavailable' }, now)
  } else {
    setStatus(db, ledgerId, 'PLANNED', {}, now)
  }
  return loadOrThrow(db, ledgerId)
}

/** Deliberately abort a not-yet-sent action (e.g. its campaign was revoked, or
 *  the plan is abandoned). Only rows that have NOT touched the provider may be
 *  cancelled — attempting to cancel a SENDING/APPLIED_UNVERIFIED/VERIFIED row
 *  throws, because the provider may already have it and CANCELLED would lie. */
export function cancelAction(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
  const a = loadOrThrow(db, ledgerId)
  if (a.status !== 'PLANNED' && a.status !== 'FAILED_RETRYABLE') {
    throw new Error(`cannot cancel ${a.status} action ${ledgerId} (provider may already have it)`)
  }
  setStatus(db, ledgerId, 'CANCELLED', { last_error: reason }, now)
  return loadOrThrow(db, ledgerId)
}
