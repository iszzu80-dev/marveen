// Shared Action Executor core. The crash-safe outbound state machine is the SAME
// for the Personal COS (`outbound_ledger`) and the ZST executor
// (`zst_outbound_ledger`) — only the ledger table name differs.
// `makeExecutor(ledgerTable)` binds it; the state-machine logic below is
// byte-for-byte the proven personal executor (its 15 tests are the safety net).
// The one invariant everything serves: never call adapter.send() twice for the
// same action without a readback first PROVING the prior attempt did not reach
// the provider.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { reserveQuota } from './quota.js'

export type OutboundStatus =
  | 'PLANNED' | 'SENDING' | 'APPLIED_UNVERIFIED' | 'OUTCOME_UNKNOWN'
  | 'VERIFIED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'CANCELLED'
  | 'RECOVERY_REQUIRED'

export const TERMINAL_STATUSES: readonly OutboundStatus[] = ['VERIFIED', 'FAILED_TERMINAL', 'CANCELLED']
export const NON_RESENDABLE_STATUSES: readonly OutboundStatus[] = ['APPLIED_UNVERIFIED', 'RECOVERY_REQUIRED']

export interface OutboundAction {
  ledgerId: string
  caseId: string | null
  actionType: string
  sequenceNumber: number
  internalIdempotencyKey: string
  externalIdempotencyMarker: string
  payload: unknown
  status: OutboundStatus
  externalRef: string | null
  attempt: number
}

export interface ReadbackResult { found: boolean; available?: boolean; externalRef?: string }

export interface OutboundAdapter {
  readonly actionType: string
  send(action: OutboundAction): Promise<{ externalRef: string }>
  readback(externalIdempotencyMarker: string): Promise<ReadbackResult>
}

export interface SendErrorHints { reachedProvider?: boolean; terminal?: boolean }
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

/**
 * F-1 / §7.1. The idempotency key is
 *   sha256(campaign_id + recipient + action_type + sequence_number + rendered_payload_hash)
 *
 * The old key was `mv-<case>-<action>-<seq>`. What it protected was "the same
 * case + action type + sequence number", NOT "the same message to the same
 * person" — the two things §7.1 exists to bind. Two sends planned for different
 * recipients under the same case differed only by `seq`, and a payload edited
 * after approval and replanned on the same `seq` kept an unchanged key, so the
 * system read a different message as the same action.
 *
 * Fields that do not apply to a given action type (a calendar entry has no
 * recipient) are joined as empty, which is still strictly stronger than the old
 * key because the payload hash is always present. The `mv-` prefix is kept so a
 * key is recognisable at a glance in a log line.
 *
 * Keys already written keep their old form. That is safe: UNIQUE only has to
 * hold, not follow one formula, and nothing derives an existing row's identity
 * by recomputing its key — the one deriver, `ob-${key}`, runs at plan time.
 */
export interface IdempotencyKeyParts {
  caseId: string
  actionType: string
  sequenceNumber: number
  campaignId?: string | null
  recipient?: string | null
  renderedPayloadHash?: string | null
}

export function idempotencyKey(parts: IdempotencyKeyParts): string {
  const canonical = [
    parts.campaignId ?? '',
    parts.recipient ?? '',
    parts.actionType,
    String(parts.sequenceNumber),
    parts.renderedPayloadHash ?? '',
    // Not in the spec formula, and deliberately kept: without it two different
    // cases that share a campaign, recipient, type, seq and body would collide,
    // and a collision here is a SILENTLY dropped send, not an error.
    parts.caseId,
  ].join('\u0000')
  return `mv-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
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
    ledgerId: r.ledger_id, caseId: r.case_id, actionType: r.action_type,
    sequenceNumber: r.sequence_number, internalIdempotencyKey: r.internal_idempotency_key,
    externalIdempotencyMarker: r.external_idempotency_marker ?? r.internal_idempotency_key,
    payload: r.payload == null ? null : JSON.parse(r.payload),
    status: r.status, externalRef: r.external_ref, attempt: r.attempt,
  }
}

export interface PlanInput {
  caseId: string
  actionType: string
  sequenceNumber: number
  payload?: unknown
  externalMarker?: string
  /** F-1 / §7.1: the three fields the idempotency key must bind besides case,
   *  type and sequence. Absent for action types that genuinely have no campaign
   *  or recipient; the payload hash is derived from `payload` when not given. */
  campaignId?: string | null
  recipient?: string | null
  renderedPayloadHash?: string | null
}

export interface ExecuteOpts {
  quota?: { key: string; maxCount: number; windowSec: number }
  /** F-7: the caller states that it has ALREADY evaluated the dispatch gate for
   *  this row (§7.3: approval hash + template version + rendered payload + scope
   *  + budget + quota, before every execution). Required to start a FIRST send,
   *  i.e. to leave PLANNED. Recovery of an already-started row does not need it,
   *  because the decision that authorized it was made before it left PLANNED.
   *
   *  This is a caller ASSERTION, not proof — a caller could pass true without
   *  having evaluated anything. What it buys is that the permission is no longer
   *  the silent default: a new call site has to write the word down, and the one
   *  loop that was driving PLANNED rows with no gate at all (cosTick) now
   *  refuses instead of sending. The gate itself stays where it belongs, in
   *  dispatchApprovedSend / dispatchZstSend. */
  authorizedByDispatchGate?: boolean
}

export interface Executor {
  planAction(db: Database.Database, input: PlanInput, now: number): OutboundAction
  executeAction(db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number, opts?: ExecuteOpts): Promise<OutboundAction>
  verifyAction(db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number): Promise<OutboundAction>
  recoverAction(db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number): Promise<OutboundAction>
  cancelAction(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction
  readonly ledgerTable: string
}

/** Build an executor bound to one outbound-ledger table. Logic is identical to
 *  the proven personal executor. */
export function makeExecutor(ledgerTable: string): Executor {
  const T = ledgerTable

  function loadOrThrow(db: Database.Database, ledgerId: string): OutboundAction {
    const r = db.prepare(`SELECT * FROM ${T} WHERE ledger_id = ?`).get(ledgerId) as Row | undefined
    if (!r) throw new Error(`${T} row not found: ${ledgerId}`)
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
    db.prepare(`UPDATE ${T} SET ${cols.join(', ')} WHERE ledger_id = @ledgerId`).run(params)
  }

  function planAction(db: Database.Database, input: PlanInput, now: number): OutboundAction {
    // Derive the payload hash when the caller did not supply one, so the key
    // binds the CONTENT even for callers that predate F-1. A caller-supplied
    // hash wins: send-flow already computed the canonical rendered hash that the
    // approval binds to, and the key must agree with the approval, not with a
    // second hashing of the same object.
    const payloadHash = input.renderedPayloadHash
      ?? (input.payload === undefined ? null
        : createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'))
    const key = idempotencyKey({
      caseId: input.caseId, actionType: input.actionType, sequenceNumber: input.sequenceNumber,
      campaignId: input.campaignId, recipient: input.recipient, renderedPayloadHash: payloadHash,
    })
    const ledgerId = `ob-${key}`
    const marker = input.externalMarker ?? key
    db.prepare(
      `INSERT INTO ${T}
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

  async function executeAction(
    db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number, opts: ExecuteOpts = {},
  ): Promise<OutboundAction> {
    const a = loadOrThrow(db, ledgerId)
    if (TERMINAL_STATUSES.includes(a.status)) return a
    if (a.status === 'APPLIED_UNVERIFIED') return verifyAction(db, adapter, ledgerId, now)
    if (a.status === 'RECOVERY_REQUIRED') return a
    if (a.status === 'SENDING' || a.status === 'OUTCOME_UNKNOWN') return recoverAction(db, adapter, ledgerId, now)
    // F-7. Below this line a FIRST delivery happens. Every early return above is
    // recovery of a row that already left PLANNED under a decision. §7.3 requires
    // a check before execution, and the check lives in the dispatch gate — so a
    // caller that has not run it may not start a send. cosTick used to arrive
    // here with PLANNED rows and no gate whatsoever; the only thing standing
    // between it and an unapproved send was an unwired adapter.
    if (a.status === 'PLANNED' && !opts.authorizedByDispatchGate) {
      setStatus(db, ledgerId, 'PLANNED', {
        last_error: 'refused: a first send requires an evaluated dispatch decision (ExecuteOpts.authorizedByDispatchGate)',
      }, now)
      return loadOrThrow(db, ledgerId)
    }
    if (opts.quota) {
      const rr = reserveQuota(db, opts.quota.key, opts.quota.maxCount, opts.quota.windowSec, now)
      if (!rr.reserved) {
        setStatus(db, ledgerId, 'PLANNED', { last_error: `send quota exceeded for ${opts.quota.key}` }, now)
        return loadOrThrow(db, ledgerId)
      }
    }
    setStatus(db, ledgerId, 'SENDING', { sending_at: now, attempt: a.attempt + 1 }, now)
    let externalRef: string
    try {
      const r = await adapter.send(loadOrThrow(db, ledgerId))
      externalRef = r.externalRef
    } catch (err) {
      const hints = err as Partial<SendErrorHints>
      const msg = String((err as Error)?.message ?? err)
      if (hints?.reachedProvider === false) {
        setStatus(db, ledgerId, hints.terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE', { last_error: msg }, now)
      } else {
        setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: msg }, now)
      }
      return loadOrThrow(db, ledgerId)
    }
    setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { external_ref: externalRef, applied_at: now }, now)
    return verifyAction(db, adapter, ledgerId, now)
  }

  async function verifyAction(
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

  async function recoverAction(
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

  function cancelAction(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
    const a = loadOrThrow(db, ledgerId)
    if (a.status !== 'PLANNED' && a.status !== 'FAILED_RETRYABLE') {
      throw new Error(`cannot cancel ${a.status} action ${ledgerId} (provider may already have it)`)
    }
    setStatus(db, ledgerId, 'CANCELLED', { last_error: reason }, now)
    return loadOrThrow(db, ledgerId)
  }

  return { planAction, executeAction, verifyAction, recoverAction, cancelAction, ledgerTable: T }
}
