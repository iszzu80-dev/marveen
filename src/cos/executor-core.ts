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
import { consumeAuthorization, type AuthorizationContext } from './action-authorization.js'
import { killSwitchRefusal } from './kill-switch.js'
import { assertOutboundEvidenceFresh } from './outbound-evidence-freshness.js'
import {
  getRetryPolicy, DEFAULT_MAX_SEND_ATTEMPTS as SEED_MAX_SEND_ATTEMPTS,
  DEFAULT_SEND_BACKOFF_SEC as SEED_SEND_BACKOFF_SEC, type RetryPolicy,
} from './recovery-queue.js'

/** Used when a caller supplies a ticket but no context: the hash will not match
 *  anything the gate issued, so the send is refused. Deliberately NOT a
 *  permissive default — a missing context must fail closed. */
const EMPTY_AUTH_CONTEXT: AuthorizationContext = {
  domain: 'personal', caseId: null, caseVersion: null, goalVersion: null,
  actionId: '', actionType: '', intent: '', targetReference: null,
  recipient: null, payloadHash: null, approvalId: null,
}

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
  /** E1/E5: the two clocks the grace windows below are measured against. Both
   *  were columns the state machine wrote and never read back. */
  appliedAt?: number | null
  updatedAt?: number
}

/** E1 (review 2026-08-13). How long a row may sit in SENDING before anything is
 *  allowed to treat it as abandoned.
 *
 *  SENDING is written BEFORE `await adapter.send(...)` on purpose, so a crash
 *  leaves a trail. The price is that an in-flight row and a crashed one look
 *  identical. With no floor on the age, a concurrent tick picked up a row whose
 *  send was still in the provider's hands, read back a marker the provider had
 *  not indexed yet, concluded "absent" and reset the row to PLANNED — which is
 *  the one door through which the same message goes out twice.
 *
 *  Fifteen minutes is longer than any send call this system makes (the Gmail
 *  transport gives up far below it) and short enough that a genuinely crashed
 *  run is still picked up on the next reconcile cycle. */
export const SENDING_RECOVERY_GRACE_SEC = 15 * 60

/** E5. How long the provider is given to make an accepted message findable
 *  before its absence counts as proof.
 *
 *  A readback that misses on the FIRST probe is the normal state of a mail
 *  provider indexing a message it accepted a second ago. Treating that first
 *  miss as proof pinned perfectly delivered letters in RECOVERY_REQUIRED — a
 *  state nothing ever re-checks and only a human can leave. */
export const READBACK_ABSENT_GRACE_SEC = 10 * 60

export interface ReadbackResult { found: boolean; available?: boolean; externalRef?: string }

export interface OutboundAdapter {
  readonly actionType: string
  /** `threadRef` is the provider conversation the action landed in, when the
   *  adapter knows it. Persisted to the ledger so a reply arriving later can be
   *  matched to the case that sent the letter. */
  send(action: OutboundAction): Promise<{ externalRef: string; threadRef?: string }>
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
  applied_at: number | null
  updated_at: number
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
    appliedAt: r.applied_at ?? null, updatedAt: r.updated_at,
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
  /** §22.2: the ticket the deterministic gate issued for THIS action. Required
   *  to start a first delivery (leaving PLANNED or FAILED_RETRYABLE).
   *
   *  This REPLACES the `authorizedByDispatchGate: true` boolean that used to sit
   *  here. That boolean was a caller assertion — I wrote it, and its own comment
   *  admitted it was not proof. §22.2 names that model and forbids it: any code
   *  path able to reach executeAction was equally able to write `true`, so it
   *  constrained only the callers that were going to behave anyway. The ticket
   *  cannot be fabricated (32 random bytes that must exist in the table), cannot
   *  be replayed (consumption is an atomic conditional UPDATE) and cannot be
   *  aimed elsewhere (consumption re-checks the bound context). */
  authorizationId?: string
  /** The action context the ticket must still match at execution time. Passed
   *  separately from the ticket on purpose: the executor re-derives the hash
   *  from what is about to happen NOW, and compares it with what was authorised
   *  THEN. A ticket proves the gate said yes once, not that it would say yes
   *  now. */
  authorizationContext?: AuthorizationContext
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

/** F-15 defaults, now owned by the POLICY module and re-exported here so
 *  existing importers keep working. See recovery-queue.ts for why they moved:
 *  the same two numbers used to exist twice, and an operator editing the policy
 *  row moved one of them. */
export { DEFAULT_MAX_SEND_ATTEMPTS, DEFAULT_SEND_BACKOFF_SEC } from './recovery-queue.js'

/**
 * The send retry policy in force, read from `cos_retry_policy`.
 *
 * Falls back to the seed constants when the row is absent, and says so in the
 * log rather than silently. The fallback is NOT a second definition: the seed
 * IS these constants (recovery-queue.ts seeds the row from them), so the two
 * paths cannot disagree on a value — the fallback only covers a store whose
 * policy table was never created, where refusing to send at all would be a
 * bigger failure than sending with the shipped default.
 */
function sendRetryPolicy(db: Database.Database): Pick<RetryPolicy, 'maxAttempts' | 'baseBackoffSec'> {
  try {
    return getRetryPolicy(db, 'OUTBOUND_SEND')
  } catch {
    return { maxAttempts: SEED_MAX_SEND_ATTEMPTS, baseBackoffSec: SEED_SEND_BACKOFF_SEC }
  }
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
export function makeExecutor(ledgerTable: string, claimsTable?: string): Executor {
  const T = ledgerTable
  const CLAIMS = claimsTable

  function loadOrThrow(db: Database.Database, ledgerId: string): OutboundAction {
    const r = db.prepare(`SELECT * FROM ${T} WHERE ledger_id = ?`).get(ledgerId) as Row | undefined
    if (!r) throw new Error(`${T} row not found: ${ledgerId}`)
    return toAction(r)
  }

  /**
   * E1. A status write is a COMPARE-AND-SWAP on the status we believe the row is
   * in, not an unconditional `WHERE ledger_id = ?`.
   *
   * Unconditional was the shape that let the last writer win regardless of what
   * happened to the row in between: a send that took thirty seconds could come
   * back and stamp APPLIED_UNVERIFIED over a recovery that had already settled
   * the row — or, worse, over a row a recovery had put back in the send queue,
   * hiding the fact that the same message now had two owners.
   *
   * Returns false when the row moved under us. No call site may drop that
   * answer on the floor; each one below says what it does with a conflict.
   */
  function setStatus(
    db: Database.Database, ledgerId: string, status: OutboundStatus,
    fields: Partial<Record<'external_ref' | 'last_error' | 'sending_at' | 'applied_at' | 'verified_at' | 'attempt'
      | 'run_id' | 'campaign_version' | 'approval_version' | 'rendered_variables_hash'
      | 'provider_message_id' | 'rfc_message_id' | 'thread_ref' | 'claim_fence', unknown>>,
    now: number,
    expected?: OutboundStatus,
  ): boolean {
    const cols = ['status = @status', 'updated_at = @now']
    const params: Record<string, unknown> = { ledgerId, status, now }
    for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = @${k}`); params[k] = v }
    let where = 'ledger_id = @ledgerId'
    if (expected !== undefined) { where += ' AND status = @expectedStatus'; params.expectedStatus = expected }
    return db.prepare(`UPDATE ${T} SET ${cols.join(', ')} WHERE ${where}`).run(params).changes > 0
  }

  /** Thrown inside the admission transaction so the whole thing ROLLS BACK — a
   *  quota slot reserved for a send that is not going to happen must not stay
   *  spent. Never escapes executeAction. */
  class AdmissionConflict extends Error {}

  /**
   * E1. The row left SENDING while our call was in the provider's hands. This is
   * the one conflict that can end in a second delivery, so it is never
   * swallowed: a row that has already SETTLED keeps its settlement (a recovery
   * that verified it was right, and nothing further will be sent from a terminal
   * row), and a row that is back in the send queue is pinned for a human rather
   * than left to be sent again by the next tick.
   */
  function pinSendConflict(db: Database.Database, ledgerId: string, note: string, now: number): OutboundAction {
    const cur = loadOrThrow(db, ledgerId)
    if (TERMINAL_STATUSES.includes(cur.status)) return cur
    setStatus(db, ledgerId, 'RECOVERY_REQUIRED', { last_error: note }, now, cur.status)
    return loadOrThrow(db, ledgerId)
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
      // W12 closure (Istvan, 2026-08-25): the ceiling comes from the POLICY
      // TABLE, so `cos_retry_policy.OUTBOUND_SEND` is the one place that decides
      // it. An explicit opts.retry still wins — that is a caller stating a
      // narrower budget for one send, not a second definition of the default.
      const policy = sendRetryPolicy(db)
      const maxAttempts = opts.retry?.maxAttempts ?? policy.maxAttempts
      if (a.attempt >= maxAttempts) {
        // Conflict = another worker already moved the row on; its decision is as
        // current as ours and the reloaded row is the answer either way.
        setStatus(db, ledgerId, 'FAILED_TERMINAL', {
          last_error: `giving up after ${a.attempt} attempts: ${a.lastError ?? 'repeated retryable failure'}`,
        }, now, a.status)
        return loadOrThrow(db, ledgerId)
      }
      // Exponential backoff from the last attempt. Without it every tick retried
      // immediately, so "5 attempts" would have been spent inside a minute and
      // a transient provider outage would still exhaust the budget.
      const base = opts.retry?.baseBackoffSec ?? policy.baseBackoffSec
      const waitUntil = (a.sendingAt ?? 0) + base * Math.pow(2, Math.max(0, a.attempt - 1))
      if (now < waitUntil) return a
    }

    // F-7. Below this line a FIRST delivery happens. Every early return above is
    // recovery of a row that already left PLANNED under a decision. §7.3 requires
    // a check before execution, and the check lives in the dispatch gate — so a
    // caller that has not run it may not start a send. cosTick used to arrive
    // here with PLANNED rows and no gate whatsoever; the only thing standing
    // between it and an unapproved send was an unwired adapter.
    // N-3 (second review): FAILED_RETRYABLE belongs here too. That status means
    // the adapter PROVED the request never reached the provider, so a retry is a
    // FIRST delivery, not a recovery — and between the failure and the retry the
    // campaign may have been revoked or paused, the approval may have expired
    // (a real field since F-16), the connector may have dropped to READ_ONLY,
    // the autonomy rung may have been lowered, and the case's sensitivity may
    // have risen. §7.3 puts the CHECK before EVERY execution, not only the
    // first. My original guard read `PLANNED` only, which quietly exempted every
    // retry.
    if (a.status === 'PLANNED' || a.status === 'FAILED_RETRYABLE') {
      // §22 kill switch, at the choke point. `permits()` already refuses at the
      // gate, but the gate ran earlier: this is the last line before a first
      // delivery, and a stop engaged in between has to catch it here. Recovery
      // paths returned above are untouched on purpose — they send nothing, and
      // freezing them would leave a stopped system full of rows nobody can ever
      // settle.
      const stopped = killSwitchRefusal(db)
      if (stopped) {
        // E4: the entry status is KEPT. Writing PLANNED here reset a row that had
        // already failed N times into a fresh one: the F-15 ceiling counts only
        // from FAILED_RETRYABLE, so a refusal on every attempt meant the ceiling
        // could never fire and the backoff never applied. A refusal is not
        // progress, and it must not look like progress.
        setStatus(db, ledgerId, a.status, { last_error: `refused: ${stopped}` }, now, a.status)
        return loadOrThrow(db, ledgerId)
      }
      // Authorization identity is checked before evidence diagnostics. A missing
      // ticket is refused by the canonical primitive without consuming anything.
      if (!opts.authorizationId) {
        const missing = consumeAuthorization(
          db, undefined,
          opts.authorizationContext ?? { ...EMPTY_AUTH_CONTEXT, actionId: ledgerId, actionType: a.actionType },
          now,
        )
        if (!missing.ok) {
          setStatus(db, ledgerId, a.status, { last_error: `refused: ${missing.reason}` }, now, a.status)
          return loadOrThrow(db, ledgerId)
        }
      }
      // ACP v1.4.5 OUTBOUND_EVIDENCE_FRESHNESS. Recovery states returned
      // above; this is the common Personal/ZST first-or-retry delivery door.
      // Evidence is revalidated BEFORE the ticket is consumed, so a stale
      // payload neither calls the provider nor burns otherwise valid authority.
      if (a.actionType === 'EMAIL_SEND') {
        const evidenceDomain = T === 'outbound_ledger' ? 'personal'
          : T === 'zst_outbound_ledger' ? 'zst' : null
        if (!evidenceDomain) {
          setStatus(db, ledgerId, a.status, { last_error: `refused: unknown email ledger ${T}` }, now, a.status)
          return loadOrThrow(db, ledgerId)
        }
        try {
          assertOutboundEvidenceFresh(db, evidenceDomain, ledgerId)
        } catch (err) {
          setStatus(db, ledgerId, a.status, { last_error: `refused: ${String((err as Error)?.message ?? err)}` }, now, a.status)
          return loadOrThrow(db, ledgerId)
        }
      }
      // §22.2. Consumed HERE, not at the door: between the gate's decision and
      // this line the process may have been restarted, the row re-queued, or the
      // payload edited. Consumption is the moment the authority is actually
      // spent, so it belongs where the send begins.
      const consumed = consumeAuthorization(
        db, opts.authorizationId,
        opts.authorizationContext ?? { ...EMPTY_AUTH_CONTEXT, actionId: ledgerId, actionType: a.actionType },
        now,
      )
      if (!consumed.ok) {
        // E4, as above: refused, not restarted.
        setStatus(db, ledgerId, a.status, { last_error: `refused: ${consumed.reason}` }, now, a.status)
        return loadOrThrow(db, ledgerId)
      }
    }
    // ── A.2 + A.4 (F-4 + F-5): ONE transaction ────────────────────────────
    // The spec asks for BEGIN … verify claim … RESERVE quota … WRITE SENDING …
    // COMMIT. Before this, the three were three separate statements: the fence
    // was never checked at all, the quota reservation had no caller, and the
    // campaign ceiling was a COUNT(*) outside the write, so two concurrent sends
    // both read "there is still room".
    let quotaReserved = false
    const admit = db.transaction((): { ok: true } | { ok: false; reason: string } => {
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
        const live = `status NOT IN ('CANCELLED','FAILED_TERMINAL','PLANNED','FAILED_RETRYABLE')`
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

      const claimed = setStatus(db, ledgerId, 'SENDING', {
        sending_at: now, attempt: a.attempt + 1,
        // F-2: written BEFORE the call, with the same reasoning that puts SENDING
        // before the call — if the process dies mid-send, the row still says which
        // run and which approved versions authorised it.
        ...(opts.claim ? { claim_fence: opts.claim.fence } : {}),
        ...(opts.audit?.runId !== undefined ? { run_id: opts.audit.runId } : {}),
        ...(opts.audit?.campaignVersion !== undefined ? { campaign_version: opts.audit.campaignVersion } : {}),
        ...(opts.audit?.approvalVersion !== undefined ? { approval_version: opts.audit.approvalVersion } : {}),
        ...(opts.audit?.renderedVariablesHash !== undefined ? { rendered_variables_hash: opts.audit.renderedVariablesHash } : {}),
      }, now, a.status)
      // E1: the SENDING write is the moment this run takes ownership of the row,
      // so it is a compare-and-swap like every other transition. Losing it means
      // somebody else moved the row between the load at the top of this function
      // and here — thrown rather than returned, so the quota slot reserved three
      // lines up is rolled back with it.
      if (!claimed) throw new AdmissionConflict(`the row left ${a.status} while this send was being admitted`)
      return { ok: true }
    })

    let admission: { ok: true } | { ok: false; reason: string }
    try {
      admission = admit()
    } catch (err) {
      if (!(err instanceof AdmissionConflict)) throw err
      // The transaction rolled back, so the reservation went with it.
      quotaReserved = false
      admission = { ok: false, reason: err.message }
    }

    if (!admission.ok) {
      // E4: the entry status is kept — see the kill-switch refusal above.
      // Conditional, because a row that has moved on is no longer ours to
      // annotate; the reloaded row below is what the caller gets either way.
      setStatus(db, ledgerId, a.status, { last_error: `refused: ${admission.reason}` }, now, a.status)
      return loadOrThrow(db, ledgerId)
    }
    let externalRef: string
    let threadRef: string | undefined
    try {
      const r = await adapter.send(loadOrThrow(db, ledgerId))
      externalRef = r.externalRef
      threadRef = r.threadRef
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
        const settled = setStatus(db, ledgerId, hints.terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE', { last_error: msg }, now, 'SENDING')
        if (!settled) return pinSendConflict(db, ledgerId, `send failed (${msg}) but the row had already left SENDING`, now)
      } else {
        const settled = setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: msg }, now, 'SENDING')
        if (!settled) return pinSendConflict(db, ledgerId, `send outcome unknown (${msg}) and the row had already left SENDING`, now)
      }
      return loadOrThrow(db, ledgerId)
    }
    // F-2: provider_message_id existed as a column and was never written, which
    // is a trap — it looks like the provider's own id is on file. external_ref
    // IS that id for every adapter we have; recording it under both names keeps
    // the AC-21 query answerable without guessing which column is real.
    const applied = setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', {
      external_ref: externalRef, applied_at: now, provider_message_id: externalRef,
      ...(threadRef ? { thread_ref: threadRef } : {}),
    }, now, 'SENDING')
    // E1: the provider ACCEPTED the message and the row is not the one we left in
    // SENDING. Blindly stamping APPLIED_UNVERIFIED here is what made the race
    // invisible: it erased whatever the concurrent recovery had decided, and if
    // that decision was "back to PLANNED", the same message was queued for a
    // second send with nothing on the row to say so.
    if (!applied) {
      return pinSendConflict(db, ledgerId,
        `provider accepted ${externalRef} but the row had already left SENDING — a second delivery may be queued`, now)
    }
    return verifyAction(db, adapter, ledgerId, now)
  }

  async function verifyAction(
    db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
  ): Promise<OutboundAction> {
    const a = loadOrThrow(db, ledgerId)
    let rb: ReadbackResult
    // A readback sends nothing, so losing a compare-and-swap here costs nothing:
    // whoever won wrote a conclusion drawn from the same provider. The reloaded
    // row is returned in every branch, so the caller sees the state that won.
    try {
      rb = await adapter.readback(a.externalIdempotencyMarker, a.externalRef ?? undefined)
    } catch (err) {
      setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: `readback unavailable: ${String((err as Error)?.message ?? err)}` }, now, a.status)
      return loadOrThrow(db, ledgerId)
    }
    if (rb.found) {
      setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now, a.status)
    } else if (rb.available === false) {
      setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: 'readback unavailable' }, now, a.status)
    } else {
      // E5. The readback WORKED and did not find the marker. That is evidence,
      // not proof: a provider that accepted a message a second ago routinely has
      // not indexed it yet, and the first miss used to go straight to
      // RECOVERY_REQUIRED — a human-pinned alarm on a perfectly delivered letter,
      // in a state nothing ever re-checks. The absence has to still be true after
      // the grace window before it counts.
      //
      // The re-probe is not hypothetical: APPLIED_UNVERIFIED is in the scheduler's
      // reconcile queue, and executeAction routes that status back into this
      // function, so every tick re-asks until it either finds the marker or the
      // window closes.
      const appliedAt = a.appliedAt
      if (appliedAt !== null && appliedAt !== undefined && now >= appliedAt + READBACK_ABSENT_GRACE_SEC) {
        setStatus(db, ledgerId, 'RECOVERY_REQUIRED', {
          last_error: `provider reported success but marker still absent ${now - appliedAt}s after acceptance`,
        }, now, a.status)
      } else {
        // applied_at missing (a row moved here by hand or by an older build):
        // start the clock now rather than treating "unknown age" as "expired".
        setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', {
          last_error: 'marker not visible on readback yet',
          ...(appliedAt === null || appliedAt === undefined ? { applied_at: now } : {}),
        }, now, a.status)
      }
    }
    return loadOrThrow(db, ledgerId)
  }

  async function recoverAction(
    db: Database.Database, adapter: OutboundAdapter, ledgerId: string, now: number,
  ): Promise<OutboundAction> {
    const a = loadOrThrow(db, ledgerId)
    // E1, belt and braces with reconcileOutbound's filter. A SENDING row younger
    // than the grace window may still be in the provider's hands: its marker is
    // legitimately not findable yet, and the `else` branch below would read that
    // as "never sent" and put the row back on the queue — a second delivery of a
    // message already accepted. The reconcile queue no longer offers such rows;
    // this guard covers every OTHER way here: executeAction on a SENDING row, a
    // direct call, a maintenance script.
    //
    // Only SENDING. OUTCOME_UNKNOWN is written AFTER the send call returned, so
    // nothing is in flight and recovery is exactly what it needs.
    if (a.status === 'SENDING') {
      const startedAt = a.sendingAt ?? a.updatedAt ?? 0
      if (startedAt > now - SENDING_RECOVERY_GRACE_SEC) return a
    }
    let rb: ReadbackResult
    try {
      rb = await adapter.readback(a.externalIdempotencyMarker, a.externalRef ?? undefined)
    } catch (err) {
      setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: `readback unavailable: ${String((err as Error)?.message ?? err)}` }, now, a.status)
      return loadOrThrow(db, ledgerId)
    }
    if (rb.found) {
      setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now, a.status)
    } else if (rb.available === false) {
      setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: 'readback unavailable' }, now, a.status)
    } else {
      // Back to the queue for a safe resend. Conditional on the status we read:
      // if the row moved in the meantime, the mover knew something we did not,
      // and re-queuing a row somebody else settled is the double-send again.
      setStatus(db, ledgerId, 'PLANNED', {}, now, a.status)
    }
    return loadOrThrow(db, ledgerId)
  }

  function cancelAction(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
    const a = loadOrThrow(db, ledgerId)
    if (a.status !== 'PLANNED' && a.status !== 'FAILED_RETRYABLE') {
      throw new Error(`cannot cancel ${a.status} action ${ledgerId} (provider may already have it)`)
    }
    if (!setStatus(db, ledgerId, 'CANCELLED', { last_error: reason }, now, a.status)) {
      // The row left PLANNED/FAILED_RETRYABLE between the read and the write —
      // i.e. a send started. Cancelling it now would mark a message the provider
      // may already hold as never sent.
      throw new Error(`cannot cancel ${ledgerId}: it left ${a.status} while being cancelled`)
    }
    return loadOrThrow(db, ledgerId)
  }

  return { planAction, executeAction, verifyAction, recoverAction, cancelAction, ledgerTable: T }
}
