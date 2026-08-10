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
import { reserveQuota, releaseQuota } from './quota.js'

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
  /** F-15. */
  lastError?: string | null
  sendingAt?: number | null
}

export interface ReadbackResult { found: boolean; available?: boolean; externalRef?: string }

export interface OutboundAdapter {
  readonly actionType: string
  send(action: OutboundAction): Promise<{ externalRef: string }>
  /** F-12: `knownRef` is the provider id recorded when the send returned. An
   *  adapter whose marker search is unavailable can use it as the fallback
   *  evidence; one that has no such fallback ignores it. */
  readback(externalIdempotencyMarker: string, knownRef?: string): Promise<ReadbackResult>
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
  last_error: string | null
  sending_at: number | null
}

function toAction(r: Row): OutboundAction {
  return {
    ledgerId: r.ledger_id, caseId: r.case_id, actionType: r.action_type,
    sequenceNumber: r.sequence_number, internalIdempotencyKey: r.internal_idempotency_key,
    externalIdempotencyMarker: r.external_idempotency_marker ?? r.internal_idempotency_key,
    payload: r.payload == null ? null : JSON.parse(r.payload),
    status: r.status, externalRef: r.external_ref, attempt: r.attempt,
    // F-15: the retry ceiling and the backoff both need these, and they were
    // columns nothing surfaced. `attempt` was already here and nothing READ it.
    lastError: r.last_error ?? null, sendingAt: r.sending_at ?? null,
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
  /** F-2 / AC-21: the case version this action was planned against. Passed in
   *  rather than queried, because the executor is bound to a ledger table and
   *  does not know which case table (personal_cases / zst_cases) to read. */
  caseVersion?: number | null
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
  /** F-2 / AC-21: "every outbound action is traceable to an approval, a
   *  campaign, a case+version, a run and a source". These are the run-time half
   *  — the plan-time half (payload hash, case version, campaign, recipient) is
   *  written by planAction. The columns existed and nothing on the personal
   *  branch ever wrote them, which reads as though the trail were being kept. */
  audit?: {
    runId?: string
    campaignVersion?: number | null
    approvalVersion?: number | null
    renderedVariablesHash?: string | null
  }
  /** F-4 / A.2: the claim this send runs under. Verified INSIDE the same
   *  transaction that writes SENDING, so a run whose claim expired and was taken
   *  over by another worker cannot land a late send. The fence is recorded on
   *  the row (outbound_ledger.claim_fence existed and was never written). */
  claim?: { claimKey: string; ownerRunId: string; fence: number }
  /** F-5 / A.4: the per-campaign ceilings, counted inside the SAME transaction
   *  as the SENDING write. Counting outside it is check-then-act: two concurrent
   *  sends both read "there is still room". */
  campaignLimit?: { campaignId: string; maxTotal?: number; kind?: string; maxPerKind?: number }
  /** F-15: how many times a FAILED_RETRYABLE row may be retried before it is
   *  moved to FAILED_TERMINAL, and the base backoff between attempts. `attempt`
   *  was being incremented and nothing read it: a permanently bad recipient was
   *  reattempted on every single tick, forever, burning a quota slot each time
   *  once F-5 wired the quota up. */
  retry?: { maxAttempts?: number; baseBackoffSec?: number }
}

/** F-15 defaults. Five attempts over an exponential backoff reaches ~8 minutes,
 *  which covers a provider blip; past that the failure is not transient and a
 *  human should see it as FAILED_TERMINAL rather than as an endless queue. */
export const DEFAULT_MAX_SEND_ATTEMPTS = 5
export const DEFAULT_SEND_BACKOFF_SEC = 30

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
export function makeExecutor(ledgerTable: string, claimsTable?: string): Executor {
  const T = ledgerTable
  const CLAIMS = claimsTable

  function loadOrThrow(db: Database.Database, ledgerId: string): OutboundAction {
    const r = db.prepare(`SELECT * FROM ${T} WHERE ledger_id = ?`).get(ledgerId) as Row | undefined
    if (!r) throw new Error(`${T} row not found: ${ledgerId}`)
    return toAction(r)
  }

  function setStatus(
    db: Database.Database, ledgerId: string, status: OutboundStatus,
    fields: Partial<Record<'external_ref' | 'last_error' | 'sending_at' | 'applied_at' | 'verified_at' | 'attempt'
      | 'run_id' | 'campaign_version' | 'approval_version' | 'rendered_variables_hash'
      | 'provider_message_id' | 'rfc_message_id', unknown>>,
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
    // F-2: the plan-time half of the audit trail is written HERE, in the same
    // INSERT as the row itself. Filling it in with a later UPDATE (which is how
    // campaign_id and recipient used to arrive) leaves a window where the row
    // exists and is unattributable, and a crash inside that window leaves it
    // unattributable for good.
    db.prepare(
      `INSERT INTO ${T}
         (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
          external_idempotency_marker, status, payload, attempt, created_at, updated_at,
          campaign_id, recipient, rendered_payload_hash, case_version)
       VALUES (@ledgerId, @caseId, @actionType, @sequenceNumber, @key,
          @marker, 'PLANNED', @payload, 0, @now, @now,
          @campaignId, @recipient, @payloadHash, @caseVersion)`
    ).run({
      ledgerId, caseId: input.caseId, actionType: input.actionType, sequenceNumber: input.sequenceNumber,
      key, marker, payload: input.payload === undefined ? null : JSON.stringify(input.payload), now,
      campaignId: input.campaignId ?? null, recipient: input.recipient ?? null,
      payloadHash, caseVersion: input.caseVersion ?? null,
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
    // F-15: a retryable failure is not retryable forever. Checked before the
    // admission block so an exhausted row neither reserves quota nor touches
    // the claim, and BEFORE the backoff so a terminal row stops appearing in the
    // work queue at all.
    if (a.status === 'FAILED_RETRYABLE') {
      const maxAttempts = opts.retry?.maxAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS
      if (a.attempt >= maxAttempts) {
        setStatus(db, ledgerId, 'FAILED_TERMINAL', {
          last_error: `giving up after ${a.attempt} attempts: ${a.lastError ?? 'repeated retryable failure'}`,
        }, now)
        return loadOrThrow(db, ledgerId)
      }
      // Exponential backoff from the last attempt. Without it every tick retried
      // immediately, so "5 attempts" would have been spent inside a minute and
      // a transient provider outage would still exhaust the budget.
      const base = opts.retry?.baseBackoffSec ?? DEFAULT_SEND_BACKOFF_SEC
      const waitUntil = (a.sendingAt ?? 0) + base * Math.pow(2, Math.max(0, a.attempt - 1))
      if (now < waitUntil) return a
    }

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
    // ── A.2 + A.4 (F-4 + F-5): ONE transaction ────────────────────────────
    // The spec asks for BEGIN … verify claim … RESERVE quota … WRITE SENDING …
    // COMMIT. Before this, the three were three separate statements: the fence
    // was never checked at all, the quota reservation had no caller, and the
    // campaign ceiling was a COUNT(*) outside the write, so two concurrent sends
    // both read "there is still room".
    let quotaReserved = false
    const admission = db.transaction((): { ok: true } | { ok: false; reason: string } => {
      if (opts.claim) {
        if (!CLAIMS) return { ok: false, reason: 'a claim was supplied but this executor has no claims table bound' }
        const c = db.prepare(
          `SELECT owner_run_id, claim_fence, claim_expires_at FROM ${CLAIMS} WHERE claim_key = ?`
        ).get(opts.claim.claimKey) as { owner_run_id: string; claim_fence: number; claim_expires_at: number } | undefined
        if (!c) return { ok: false, reason: `claim ${opts.claim.claimKey} no longer exists` }
        if (c.owner_run_id !== opts.claim.ownerRunId) {
          return { ok: false, reason: `claim ${opts.claim.claimKey} is held by ${c.owner_run_id}, not ${opts.claim.ownerRunId}` }
        }
        // The fence is the point: a slow run holding a claim that EXPIRED and was
        // re-acquired by someone else sees its own fence superseded, and its late
        // send is refused instead of landing after the takeover.
        if (c.claim_fence !== opts.claim.fence) {
          return { ok: false, reason: `stale claim fence ${opts.claim.fence}, current is ${c.claim_fence}` }
        }
        if (c.claim_expires_at < now) return { ok: false, reason: `claim ${opts.claim.claimKey} expired at ${c.claim_expires_at}` }
      }

      if (opts.campaignLimit) {
        const L = opts.campaignLimit
        // PLANNED is excluded as well as the dead statuses: a draft that has
        // never been sent is not outbound traffic, and counting it would let a
        // queue of drafts exhaust a campaign's ceiling before a single message
        // left. Counted: everything from SENDING onwards, because those either
        // went out or may have.
        const live = `status NOT IN ('CANCELLED','FAILED_TERMINAL','PLANNED')`
        if (L.maxTotal !== undefined) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE campaign_id=? AND ${live} AND ledger_id<>?`)
            .get(L.campaignId, ledgerId) as { n: number }).n
          if (n >= L.maxTotal) return { ok: false, reason: `campaign ${L.campaignId} is at its total ceiling (${n}/${L.maxTotal})` }
        }
        if (L.maxPerKind !== undefined && L.kind) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE campaign_id=? AND outbound_kind=? AND ${live} AND ledger_id<>?`)
            .get(L.campaignId, L.kind, ledgerId) as { n: number }).n
          if (n >= L.maxPerKind) return { ok: false, reason: `campaign ${L.campaignId} is at its ${L.kind} ceiling (${n}/${L.maxPerKind})` }
        }
      }

      if (opts.quota) {
        const rr = reserveQuota(db, opts.quota.key, opts.quota.maxCount, opts.quota.windowSec, now)
        if (!rr.reserved) return { ok: false, reason: `send quota exceeded for ${opts.quota.key}` }
        quotaReserved = true
      }

      setStatus(db, ledgerId, 'SENDING', {
        sending_at: now, attempt: a.attempt + 1,
        // F-2: written BEFORE the call, with the same reasoning that puts SENDING
        // before the call — if the process dies mid-send, the row still says which
        // run and which approved versions authorised it.
        ...(opts.claim ? { claim_fence: opts.claim.fence } : {}),
        ...(opts.audit?.runId !== undefined ? { run_id: opts.audit.runId } : {}),
        ...(opts.audit?.campaignVersion !== undefined ? { campaign_version: opts.audit.campaignVersion } : {}),
        ...(opts.audit?.approvalVersion !== undefined ? { approval_version: opts.audit.approvalVersion } : {}),
        ...(opts.audit?.renderedVariablesHash !== undefined ? { rendered_variables_hash: opts.audit.renderedVariablesHash } : {}),
      }, now)
      return { ok: true }
    })()

    if (!admission.ok) {
      setStatus(db, ledgerId, 'PLANNED', { last_error: `refused: ${admission.reason}` }, now)
      return loadOrThrow(db, ledgerId)
    }
    let externalRef: string
    try {
      const r = await adapter.send(loadOrThrow(db, ledgerId))
      externalRef = r.externalRef
    } catch (err) {
      const hints = err as Partial<SendErrorHints>
      const msg = String((err as Error)?.message ?? err)
      if (hints?.reachedProvider === false) {
        // F-5: refund. A slot reserved for a send that PROVABLY did not happen
        // must go back, otherwise a retryable failure burns quota on every
        // attempt (PLANNED → SENDING re-reserves) and a healthy campaign
        // throttles itself to a halt. Only on reachedProvider===false: if we
        // cannot tell, the slot stays spent, because refunding a send that may
        // have gone out is the error that lets a duplicate through.
        if (quotaReserved && opts.quota) releaseQuota(db, opts.quota.key, now)
        setStatus(db, ledgerId, hints.terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE', { last_error: msg }, now)
      } else {
        setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: msg }, now)
      }
      return loadOrThrow(db, ledgerId)
    }
    // F-2: provider_message_id existed as a column and was never written, which
    // is a trap — it looks like the provider's own id is on file. external_ref
    // IS that id for every adapter we have; recording it under both names keeps
    // the AC-21 query answerable without guessing which column is real.
    setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', {
      external_ref: externalRef, applied_at: now, provider_message_id: externalRef,
    }, now)
    return verifyAction(db, adapter, ledgerId, now)
  }

  async function verifyAction(
    db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
  ): Promise<OutboundAction> {
    const a = loadOrThrow(db, ledgerId)
    let rb: ReadbackResult
    try {
      rb = await adapter.readback(a.externalIdempotencyMarker, a.externalRef ?? undefined)
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
      rb = await adapter.readback(a.externalIdempotencyMarker, a.externalRef ?? undefined)
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
