// Personal Chief of Staff (COS) — Action Executor (Slice 1 core).
//
// The SINGLE sanctioned writer to the outside world. Every outbound side effect
// goes through outbound_ledger's crash-safe state machine so a crash, retry, or
// restart can NEVER double-send. The one invariant everything else serves:
//   never call adapter.send() twice for the same action without a readback
//   first PROVING the prior attempt did not reach the provider.
//
// States: PLANNED → SENDING (durable BEFORE the call) → APPLIED → VERIFIED;
// any error → OUTCOME_UNKNOWN → recovery readback → VERIFIED (it did land) or
// PLANNED (proven absent, safe to resend). DB UNIQUE on the idempotency key and
// on (case, action_type, sequence) is the last line if app logic is bypassed.
//
// The capability itself lives behind OutboundAdapter — this module holds NO
// send capability of its own, so it is safe to build/test now (with a mock
// adapter) before any real connector (Gmail write) is wired.

import type Database from 'better-sqlite3'

export type OutboundStatus =
  | 'PLANNED' | 'SENDING' | 'APPLIED' | 'OUTCOME_UNKNOWN'
  | 'VERIFIED' | 'FAILED' | 'RECOVERY_REQUIRED'

export interface OutboundAction {
  ledgerId: string
  caseId: string | null
  actionType: string
  sequenceNumber: number
  internalIdempotencyKey: string
  payload: unknown
  status: OutboundStatus
  externalRef: string | null
  attempt: number
}

/** The capability boundary: the ONLY thing that touches the outside world.
 *  send() throws on failure. readback() answers "did the action carrying this
 *  idempotency marker already get applied?" WITHOUT re-sending — it is what
 *  makes recovery safe. A real adapter embeds the key as a searchable marker in
 *  the outbound message (e.g. X-Marveen-Idempotency-Key) so readback can find
 *  it in the Sent folder / provider. */
export interface OutboundAdapter {
  readonly actionType: string
  send(action: OutboundAction): Promise<{ externalRef: string }>
  readback(internalIdempotencyKey: string): Promise<{ found: boolean; externalRef?: string }>
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
}

/** Record an intended action as PLANNED. The idempotency key + ledger id are
 *  deterministic, so a duplicate plan trips the UNIQUE constraint rather than
 *  creating a second sendable row. */
export function planAction(db: Database.Database, input: PlanInput, now: number): OutboundAction {
  const key = idempotencyKey(input.caseId, input.actionType, input.sequenceNumber)
  const ledgerId = `ob-${key}`
  db.prepare(
    `INSERT INTO outbound_ledger
       (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
        status, payload, attempt, created_at, updated_at)
     VALUES (@ledgerId, @caseId, @actionType, @sequenceNumber, @key, 'PLANNED', @payload, 0, @now, @now)`
  ).run({
    ledgerId, caseId: input.caseId, actionType: input.actionType, sequenceNumber: input.sequenceNumber,
    key, payload: input.payload === undefined ? null : JSON.stringify(input.payload), now,
  })
  return loadOrThrow(db, ledgerId)
}

/**
 * Crash-safe execute. Terminal states are idempotent no-ops. A row already
 * SENDING/OUTCOME_UNKNOWN (a prior attempt may have reached the provider) is
 * NEVER blind-resent — it recovers via readback first. Only a PLANNED row sends,
 * and it persists SENDING BEFORE the external call so a crash leaves a durable
 * trail. After a successful send it VERIFIES via readback rather than assuming.
 */
export async function executeAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  if (a.status === 'VERIFIED' || a.status === 'FAILED') return a
  if (a.status === 'SENDING' || a.status === 'OUTCOME_UNKNOWN') {
    return recoverAction(db, adapter, ledgerId, now)
  }
  // PLANNED: persist SENDING BEFORE the call (P0.3 crash window).
  setStatus(db, ledgerId, 'SENDING', { sending_at: now, attempt: a.attempt + 1 }, now)
  let externalRef: string
  try {
    const r = await adapter.send(loadOrThrow(db, ledgerId))
    externalRef = r.externalRef
  } catch (err) {
    // We do NOT know whether it reached the provider → OUTCOME_UNKNOWN, recover later.
    setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: String((err as Error)?.message ?? err) }, now)
    return loadOrThrow(db, ledgerId)
  }
  setStatus(db, ledgerId, 'APPLIED', { external_ref: externalRef, applied_at: now }, now)
  return verifyAction(db, adapter, ledgerId, now)
}

/** Prove an APPLIED action really landed by reading back its marker. */
export async function verifyAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  const rb = await adapter.readback(a.internalIdempotencyKey)
  if (rb.found) {
    setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now)
  } else {
    setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: 'readback did not find marker after APPLIED' }, now)
  }
  return loadOrThrow(db, ledgerId)
}

/**
 * Recover a SENDING/OUTCOME_UNKNOWN row (crash, restart, or transient error).
 * Reads back the idempotency marker: if the provider already has it → VERIFIED
 * (no resend); if proven absent → PLANNED (a resend is now safe). This is the
 * gate that prevents double-send.
 */
export async function recoverAction(
  db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
): Promise<OutboundAction> {
  const a = loadOrThrow(db, ledgerId)
  const rb = await adapter.readback(a.internalIdempotencyKey)
  if (rb.found) {
    setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now)
  } else {
    setStatus(db, ledgerId, 'PLANNED', {}, now)
  }
  return loadOrThrow(db, ledgerId)
}
