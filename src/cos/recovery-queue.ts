// Personal Chief of Staff (COS) — W12 / §6.7: the RECOVERY QUEUE.
//
// §6.7 asks for a durable queue whose rows carry the exact pending action, the
// input reference, the idempotency key, the last known outcome, a RETRY POLICY,
// a MAX ATTEMPTS and a HUMAN ESCALATION THRESHOLD. The W12 audit found the first
// four present as columns spread across two tables, and the last three absent:
// `RECOVERY_REQUIRED` was a STATUS, `attempt` was a counter nothing read on the
// ingest side, and the only ceiling in the inbound path
// (THREAD_FETCH_MAX_ATTEMPTS) governed Gmail thread fetches alone.
//
// Istvan's decision (2026-08-25, Telegram): make it first-class durable data —
// retry policy, attempt count, next attempt, last error, retry class, max
// attempts and escalation threshold all EXPLICIT, never hidden hardcoded
// behaviour; on reaching the threshold the record moves to NEEDS_HUMAN; the
// EXISTING internal UI surfaces it, and W12 opens NO new outbound notification
// channel.
//
// TWO TABLES, AND THE SPLIT IS THE POINT
//
//   cos_retry_policy   — the policy AS DATA, one row per retry class. Editable
//                        without a deploy, readable by a human, and the thing
//                        the code consults rather than a constant it embeds.
//   cos_recovery_queue — one durable row per (surface, ref) needing recovery,
//                        carrying §6.7's fields plus its own lifecycle status.
//
// WHY THE QUEUE HAS ITS OWN STATUS INSTEAD OF WIDENING THE SOURCE ENUMS
//
// The obvious alternative was to add NEEDS_HUMAN to `email_processing.status`
// and `outbound_ledger.status`. Both are CHECK-constrained enums read by dozens
// of consumers (the scheduler's work query, the approval LIVE filter, the
// terminal-status sets that decide whether the CURSOR may move), and adding a
// value to them changes the meaning of every one of those queries at once.
//
// More importantly the two facts are orthogonal. "What is the work's state" and
// "has recovery given up on it" are different questions with different answers:
// a row can be RECOVERY_REQUIRED and still inside its retry budget, or
// RECOVERY_REQUIRED and past it. Collapsing them into one enum is exactly the
// mistake SOURCE_COMMIT_SKIPPED exists to remember — a state name that answers
// the wrong question poisons every later query.
//
// So the source row keeps owning the WORK state, this queue owns the RECOVERY
// state, and the link between them is a UNIQUE (surface, ref) key. The queue is
// derived-but-durable: `reconcileRecoveryQueue` re-derives membership from the
// source tables on every run (idempotently), while attempt counts, escalation
// and resolution are written only here and survive restarts.

import type Database from 'better-sqlite3'

export type RecoverySurface = 'INGEST' | 'OUTBOUND' | 'ZST_OUTBOUND'

/** PENDING_RETRY  — inside its budget; `next_attempt_at` says when it is due.
 *  NEEDS_HUMAN    — the escalation threshold was reached. Nothing automatic
 *                   will touch it again; a human resolves it. (NEEDS_ISTVAN in
 *                   Istvan's words — one owner, so the generic name is the same
 *                   record.)
 *  RESOLVED       — the source row left its recovery state on its own.
 *  CANCELLED      — the source row disappeared or was cancelled. */
export type RecoveryQueueStatus = 'PENDING_RETRY' | 'NEEDS_HUMAN' | 'RESOLVED' | 'CANCELLED'

export interface RetryPolicy {
  retryClass: string
  maxAttempts: number
  baseBackoffSec: number
  /** Attempts after which the record goes NEEDS_HUMAN. Deliberately its OWN
   *  number rather than "== maxAttempts": a class may want a human to look
   *  BEFORE the budget is spent (the outbound readback classes do), and a class
   *  that never retries at all escalates at zero. */
  escalateAfterAttempts: number
  description: string
}

/**
 * The outbound send ceiling, defined ONCE, here.
 *
 * F-15 put these in executor-core, and the first W12 build left them there
 * while `DEFAULT_RETRY_POLICIES` repeated the same two numbers by hand. Istvan
 * refused that closure (2026-08-25): a duplicated policy source-of-truth means
 * an operator editing `cos_retry_policy.OUTBOUND_SEND` moves the queue's view
 * of the budget and NOT the executor's behaviour, and nothing would say so.
 *
 * They live in this file rather than in executor-core because this is where
 * policy lives, and because the dependency has to point one way: the executor
 * reads the policy, the policy never reads the executor. executor-core
 * re-exports both names so existing importers are unaffected.
 *
 * Five attempts over an exponential backoff reaches ~8 minutes, which covers a
 * provider blip; past that the failure is not transient and a human should see
 * it as FAILED_TERMINAL rather than as an endless queue.
 */
export const DEFAULT_MAX_SEND_ATTEMPTS = 5
export const DEFAULT_SEND_BACKOFF_SEC = 30

/** The seeded classes. These are DEFAULTS FOR AN EMPTY TABLE, not the source of
 *  truth: once a row exists, the row wins and this constant is not consulted
 *  again. That is the difference between "policy as data" and "policy in code
 *  with a table that mirrors it".
 *
 *  OUTBOUND_SEND takes its numbers from the constants above BY REFERENCE, so
 *  the seed and the executor's fallback cannot drift into two different
 *  answers to the same question. */
export const DEFAULT_RETRY_POLICIES: readonly RetryPolicy[] = [
  {
    retryClass: 'INGEST_LOCAL_APPLY', maxAttempts: 5, baseBackoffSec: 60, escalateAfterAttempts: 3,
    description: 'Inbound message parked in RECOVERY_REQUIRED. Every attempt is local state; no provider is touched.',
  },
  {
    retryClass: 'OUTBOUND_READBACK', maxAttempts: 0, baseBackoffSec: 0, escalateAfterAttempts: 0,
    description: 'Provider claimed success, marker provably absent. NEVER auto-retried: a retry here is a second send.',
  },
  {
    retryClass: 'OUTBOUND_SEND', maxAttempts: DEFAULT_MAX_SEND_ATTEMPTS,
    baseBackoffSec: DEFAULT_SEND_BACKOFF_SEC, escalateAfterAttempts: DEFAULT_MAX_SEND_ATTEMPTS,
    description: 'Retryable send failure the adapter proved never reached the provider.',
  },
]

export function ensureRecoveryQueueSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_retry_policy (
      retry_class              TEXT PRIMARY KEY,
      max_attempts             INTEGER NOT NULL,
      base_backoff_sec         INTEGER NOT NULL,
      escalate_after_attempts  INTEGER NOT NULL,
      description              TEXT NOT NULL,
      updated_at               INTEGER NOT NULL,
      CHECK (max_attempts >= 0),
      CHECK (base_backoff_sec >= 0),
      CHECK (escalate_after_attempts >= 0)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_recovery_queue (
      queue_id                 TEXT PRIMARY KEY,
      surface                  TEXT NOT NULL,
      ref                      TEXT NOT NULL,
      case_id                  TEXT,
      -- §6.7's required payload. pending_action is what a recovery run would DO,
      -- in words, because "RECOVERY_REQUIRED" does not say whether the safe next
      -- step is to verify, to re-apply locally, or to do nothing but ask.
      pending_action           TEXT NOT NULL,
      input_ref                TEXT,
      idempotency_key          TEXT,
      last_known_outcome       TEXT NOT NULL,
      retry_class              TEXT NOT NULL,
      attempt_count            INTEGER NOT NULL DEFAULT 0,
      -- Materialised from the policy when the row is enqueued. A row must be
      -- readable on its own: a queue entry whose ceiling can only be learned by
      -- joining a table that may have changed since cannot be audited after the
      -- fact, and the ceiling that MATTERED is the one in force at the time.
      max_attempts             INTEGER NOT NULL,
      escalate_after_attempts  INTEGER NOT NULL,
      next_attempt_at          INTEGER,
      last_error               TEXT,
      status                   TEXT NOT NULL DEFAULT 'PENDING_RETRY',
      escalated_at             INTEGER,
      escalation_reason        TEXT,
      resolved_at              INTEGER,
      resolution               TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      UNIQUE (surface, ref),
      CHECK (surface IN ('INGEST','OUTBOUND','ZST_OUTBOUND')),
      CHECK (status IN ('PENDING_RETRY','NEEDS_HUMAN','RESOLVED','CANCELLED')),
      CHECK (attempt_count >= 0)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_crq_status ON cos_recovery_queue(status, next_attempt_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_crq_surface ON cos_recovery_queue(surface, status)`)
  seedRetryPolicies(db)
}

/** Insert the default policy rows if they are missing. INSERT OR IGNORE, never
 *  UPDATE: an operator's edit to `max_attempts` must survive the next boot, or
 *  the table is decoration and the constant is still the policy. */
export function seedRetryPolicies(db: Database.Database, now = Math.floor(Date.now() / 1000)): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cos_retry_policy
       (retry_class, max_attempts, base_backoff_sec, escalate_after_attempts, description, updated_at)
     VALUES (@retryClass, @maxAttempts, @baseBackoffSec, @escalateAfterAttempts, @description, @now)`
  )
  for (const p of DEFAULT_RETRY_POLICIES) ins.run({ ...p, now })
}

/** The policy in force for a class. Throws on an unknown class: a missing
 *  policy must not silently become "retry forever" or "never retry", because
 *  both are decisions and neither was made. */
export function getRetryPolicy(db: Database.Database, retryClass: string): RetryPolicy {
  const row = db.prepare(
    `SELECT retry_class, max_attempts, base_backoff_sec, escalate_after_attempts, description
     FROM cos_retry_policy WHERE retry_class = ?`
  ).get(retryClass) as
    | { retry_class: string; max_attempts: number; base_backoff_sec: number; escalate_after_attempts: number; description: string }
    | undefined
  if (!row) throw new Error(`no retry policy for class: ${retryClass}`)
  return {
    retryClass: row.retry_class, maxAttempts: row.max_attempts, baseBackoffSec: row.base_backoff_sec,
    escalateAfterAttempts: row.escalate_after_attempts, description: row.description,
  }
}

export interface EnqueueInput {
  surface: RecoverySurface
  ref: string
  caseId?: string | null
  pendingAction: string
  inputRef?: string | null
  idempotencyKey?: string | null
  lastKnownOutcome: string
  retryClass: string
  lastError?: string | null
}

export interface RecoveryQueueRow {
  queueId: string
  surface: RecoverySurface
  ref: string
  caseId: string | null
  pendingAction: string
  inputRef: string | null
  idempotencyKey: string | null
  lastKnownOutcome: string
  retryClass: string
  attemptCount: number
  maxAttempts: number
  escalateAfterAttempts: number
  nextAttemptAt: number | null
  lastError: string | null
  status: RecoveryQueueStatus
  escalatedAt: number | null
  escalationReason: string | null
  createdAt: number
  updatedAt: number
}

const SELECT_COLS = `queue_id, surface, ref, case_id, pending_action, input_ref, idempotency_key,
  last_known_outcome, retry_class, attempt_count, max_attempts, escalate_after_attempts,
  next_attempt_at, last_error, status, escalated_at, escalation_reason, created_at, updated_at`

interface RawRow {
  queue_id: string; surface: RecoverySurface; ref: string; case_id: string | null
  pending_action: string; input_ref: string | null; idempotency_key: string | null
  last_known_outcome: string; retry_class: string; attempt_count: number
  max_attempts: number; escalate_after_attempts: number; next_attempt_at: number | null
  last_error: string | null; status: RecoveryQueueStatus; escalated_at: number | null
  escalation_reason: string | null; created_at: number; updated_at: number
}

function hydrate(r: RawRow): RecoveryQueueRow {
  return {
    queueId: r.queue_id, surface: r.surface, ref: r.ref, caseId: r.case_id,
    pendingAction: r.pending_action, inputRef: r.input_ref, idempotencyKey: r.idempotency_key,
    lastKnownOutcome: r.last_known_outcome, retryClass: r.retry_class, attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts, escalateAfterAttempts: r.escalate_after_attempts,
    nextAttemptAt: r.next_attempt_at, lastError: r.last_error, status: r.status,
    escalatedAt: r.escalated_at, escalationReason: r.escalation_reason,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export const queueId = (surface: RecoverySurface, ref: string): string => `${surface}:${ref}`

/** Enqueue (or refresh) one recovery record. Idempotent per (surface, ref).
 *
 *  A REFRESH DOES NOT RESET THE ATTEMPT COUNT, and does not un-escalate. The
 *  reconciler below runs on every cycle, so a counter that reset on refresh
 *  would never reach any threshold and the escalation would be unreachable code
 *  — the failure mode being one where nothing ever looks broken. */
export function enqueueRecovery(db: Database.Database, input: EnqueueInput, now: number): RecoveryQueueRow {
  const policy = getRetryPolicy(db, input.retryClass)
  const id = queueId(input.surface, input.ref)
  const existing = db.prepare(`SELECT ${SELECT_COLS} FROM cos_recovery_queue WHERE queue_id = ?`).get(id) as RawRow | undefined

  if (!existing) {
    // A class with a zero budget is NEEDS_HUMAN from the first breath: there is
    // no attempt to wait for, and PENDING_RETRY would promise a retry that will
    // never come. This is the OUTBOUND_READBACK case — the provider claimed
    // success and re-sending risks a duplicate, so a human decides.
    const escalateNow = policy.escalateAfterAttempts <= 0
    db.prepare(
      `INSERT INTO cos_recovery_queue
        (queue_id, surface, ref, case_id, pending_action, input_ref, idempotency_key,
         last_known_outcome, retry_class, attempt_count, max_attempts, escalate_after_attempts,
         next_attempt_at, last_error, status, escalated_at, escalation_reason, created_at, updated_at)
       VALUES (@id, @surface, @ref, @caseId, @pendingAction, @inputRef, @idempotencyKey,
         @lastKnownOutcome, @retryClass, 0, @maxAttempts, @escalateAfter,
         @nextAttemptAt, @lastError, @status, @escalatedAt, @escalationReason, @now, @now)`
    ).run({
      id, surface: input.surface, ref: input.ref, caseId: input.caseId ?? null,
      pendingAction: input.pendingAction, inputRef: input.inputRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null, lastKnownOutcome: input.lastKnownOutcome,
      retryClass: input.retryClass, maxAttempts: policy.maxAttempts,
      escalateAfter: policy.escalateAfterAttempts,
      nextAttemptAt: escalateNow ? null : now,
      lastError: input.lastError ?? null,
      status: escalateNow ? 'NEEDS_HUMAN' : 'PENDING_RETRY',
      escalatedAt: escalateNow ? now : null,
      escalationReason: escalateNow ? `${input.retryClass}: policy allows no automatic attempt` : null,
      now,
    })
    return getRecovery(db, input.surface, input.ref)!
  }

  // Refresh the descriptive fields only. A row already RESOLVED that comes back
  // is REOPENED (the source row is in a recovery state again) but keeps its
  // history: same attempt count, so a flapping row escalates instead of
  // oscillating forever.
  db.prepare(
    `UPDATE cos_recovery_queue
        SET case_id = @caseId, pending_action = @pendingAction, input_ref = @inputRef,
            idempotency_key = @idempotencyKey, last_known_outcome = @lastKnownOutcome,
            last_error = COALESCE(@lastError, last_error),
            status = CASE WHEN status IN ('RESOLVED','CANCELLED') THEN 'PENDING_RETRY' ELSE status END,
            resolved_at = CASE WHEN status IN ('RESOLVED','CANCELLED') THEN NULL ELSE resolved_at END,
            updated_at = @now
      WHERE queue_id = @id`
  ).run({
    id, caseId: input.caseId ?? null, pendingAction: input.pendingAction,
    inputRef: input.inputRef ?? null, idempotencyKey: input.idempotencyKey ?? null,
    lastKnownOutcome: input.lastKnownOutcome, lastError: input.lastError ?? null, now,
  })
  return getRecovery(db, input.surface, input.ref)!
}

export function getRecovery(db: Database.Database, surface: RecoverySurface, ref: string): RecoveryQueueRow | null {
  const r = db.prepare(`SELECT ${SELECT_COLS} FROM cos_recovery_queue WHERE queue_id = ?`).get(queueId(surface, ref)) as RawRow | undefined
  return r ? hydrate(r) : null
}

/** Record one attempt against a queue row and apply the policy.
 *
 *  Returns the row as it stands afterwards. The escalation decision is made
 *  HERE, on the same write as the counter, because a threshold evaluated in a
 *  separate pass is a threshold that a crash between the two can skip. */
export function recordRecoveryAttempt(
  db: Database.Database, surface: RecoverySurface, ref: string, outcome: { ok: boolean; error?: string }, now: number,
): RecoveryQueueRow {
  const row = getRecovery(db, surface, ref)
  if (!row) throw new Error(`no recovery queue row: ${queueId(surface, ref)}`)
  if (row.status === 'NEEDS_HUMAN') return row // a human owns it; the loop does not touch it again

  if (outcome.ok) return resolveRecovery(db, surface, ref, 'recovered', now)

  const attempt = row.attemptCount + 1
  const policy = getRetryPolicy(db, row.retryClass)
  // Exponential backoff from the policy's base, so the budget is spent over
  // time rather than inside one tick.
  const nextAt = now + policy.baseBackoffSec * Math.pow(2, Math.max(0, attempt - 1))
  const escalate = attempt >= row.escalateAfterAttempts || attempt >= row.maxAttempts
  db.prepare(
    `UPDATE cos_recovery_queue
        SET attempt_count = @attempt, last_error = @error,
            next_attempt_at = @nextAt, status = @status,
            escalated_at = @escalatedAt, escalation_reason = @reason, updated_at = @now
      WHERE queue_id = @id`
  ).run({
    id: row.queueId, attempt, error: outcome.error ?? row.lastError,
    nextAt: escalate ? null : nextAt,
    status: escalate ? 'NEEDS_HUMAN' : 'PENDING_RETRY',
    escalatedAt: escalate ? now : null,
    reason: escalate
      ? `${attempt} attempt(s) of max ${row.maxAttempts}, escalation threshold ${row.escalateAfterAttempts}`
      : null,
    now,
  })
  return getRecovery(db, surface, ref)!
}

export function resolveRecovery(
  db: Database.Database, surface: RecoverySurface, ref: string, resolution: string, now: number,
): RecoveryQueueRow {
  db.prepare(
    `UPDATE cos_recovery_queue
        SET status='RESOLVED', resolved_at=@now, resolution=@resolution, next_attempt_at=NULL, updated_at=@now
      WHERE queue_id=@id`
  ).run({ id: queueId(surface, ref), resolution, now })
  const row = getRecovery(db, surface, ref)
  if (!row) throw new Error(`no recovery queue row: ${queueId(surface, ref)}`)
  return row
}

/** Rows a human must look at. This is what the internal UI shows. */
export function listNeedsHuman(db: Database.Database, limit = 50): RecoveryQueueRow[] {
  return (db.prepare(
    `SELECT ${SELECT_COLS} FROM cos_recovery_queue WHERE status='NEEDS_HUMAN' ORDER BY escalated_at ASC LIMIT ?`
  ).all(limit) as RawRow[]).map(hydrate)
}

/** Rows due for an automatic attempt at `now`. */
export function listDueForRetry(db: Database.Database, now: number, limit = 50): RecoveryQueueRow[] {
  return (db.prepare(
    `SELECT ${SELECT_COLS} FROM cos_recovery_queue
      WHERE status='PENDING_RETRY' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY COALESCE(next_attempt_at, created_at) ASC LIMIT ?`
  ).all(now, limit) as RawRow[]).map(hydrate)
}

export interface ReconcileResult {
  enqueued: number
  resolved: number
  needsHuman: number
  pendingRetry: number
}

/**
 * Re-derive queue MEMBERSHIP from the source tables. Idempotent; safe to run on
 * every cycle.
 *
 * THE INGEST SURFACE IS WHY THIS EXISTS. An `email_processing` row in
 * RECOVERY_REQUIRED is NON-TERMINAL, so under P0.2 it pins the account's history
 * cursor — and the audit found that NOTHING in the codebase read those rows: no
 * retry, no listing, no alert, no test. A single parked message would silently
 * stop inbound mail from advancing, and the only visible symptom would be the
 * cycle reporting "batch not terminal" forever, which it also reports in the
 * ordinary healthy case.
 *
 * The outbound surfaces are already surfaced elsewhere (alertOutboundRecovery,
 * the monitoring endpoint); they are here so that ONE table answers "what is
 * waiting for recovery, how many attempts has it had, and who owns it now".
 */
export function reconcileRecoveryQueue(db: Database.Database, now: number): ReconcileResult {
  let enqueued = 0
  let resolved = 0

  const tx = db.transaction(() => {
    // ── INGEST ──────────────────────────────────────────────────────────
    const ingest = db.prepare(
      `SELECT gmail_account_id, message_id, batch_id, case_id, attempt, last_error
         FROM email_processing WHERE status='RECOVERY_REQUIRED'`
    ).all() as Array<{ gmail_account_id: string; message_id: string; batch_id: string; case_id: string | null; attempt: number; last_error: string | null }>
    for (const r of ingest) {
      const ref = `${r.gmail_account_id}/${r.message_id}`
      const before = getRecovery(db, 'INGEST', ref)
      enqueueRecovery(db, {
        surface: 'INGEST', ref, caseId: r.case_id,
        pendingAction: 'RE_APPLY_LOCAL: re-run the local intake for this message; nothing is sent to any provider',
        inputRef: r.batch_id, idempotencyKey: ref,
        lastKnownOutcome: 'RECOVERY_REQUIRED', retryClass: 'INGEST_LOCAL_APPLY',
        lastError: r.last_error,
      }, now)
      if (!before) enqueued++
    }

    // ── OUTBOUND (personal + ZST) ───────────────────────────────────────
    for (const [surface, table] of [['OUTBOUND', 'outbound_ledger'], ['ZST_OUTBOUND', 'zst_outbound_ledger']] as const) {
      // A missing ZST schema is not an empty queue — but on a store that has
      // never had the corporate namespace it genuinely is absent, so ask the
      // catalogue rather than letting a "no such table" abort the whole
      // reconcile and take the ingest half down with it.
      const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)
      if (!present) continue
      const rows = db.prepare(
        `SELECT ledger_id, case_id, action_type, status, internal_idempotency_key, external_ref, last_error
           FROM ${table} WHERE status IN ('RECOVERY_REQUIRED','OUTCOME_UNKNOWN')`
      ).all() as Array<{ ledger_id: string; case_id: string | null; action_type: string; status: string; internal_idempotency_key: string; external_ref: string | null; last_error: string | null }>
      for (const r of rows) {
        const before = getRecovery(db, surface, r.ledger_id)
        enqueueRecovery(db, {
          surface, ref: r.ledger_id, caseId: r.case_id,
          // §6.5 in one sentence, on the row itself: RECOVERY_REQUIRED means the
          // marker was PROVABLY ABSENT after the provider claimed success, so a
          // resend risks a duplicate and only a human may decide. OUTCOME_UNKNOWN
          // means we do not know, and the safe step is to look again.
          pendingAction: r.status === 'RECOVERY_REQUIRED'
            ? 'HUMAN_VERIFY: provider reported success but the marker was absent on readback. NEVER auto-resend.'
            : 'VERIFY_READBACK: outcome unknown; look for the marker before anything else happens',
          inputRef: r.external_ref, idempotencyKey: r.internal_idempotency_key,
          lastKnownOutcome: r.status,
          retryClass: r.status === 'RECOVERY_REQUIRED' ? 'OUTBOUND_READBACK' : 'OUTBOUND_SEND',
          lastError: r.last_error,
        }, now)
        if (!before) enqueued++
      }
    }

    // ── rows whose source left its recovery state ───────────────────────
    // Closed here rather than left to a human: a queue that only ever grows
    // stops being read. The check is a fresh look at the SOURCE, so a row is
    // never closed on the strength of this table's own memory.
    const open = (db.prepare(
      `SELECT ${SELECT_COLS} FROM cos_recovery_queue WHERE status IN ('PENDING_RETRY','NEEDS_HUMAN')`
    ).all() as RawRow[]).map(hydrate)
    for (const q of open) {
      let stillOpen = false
      if (q.surface === 'INGEST') {
        const [acc, msg] = q.ref.split('/')
        const row = db.prepare(
          `SELECT status FROM email_processing WHERE gmail_account_id=? AND message_id=?`
        ).get(acc, msg) as { status: string } | undefined
        stillOpen = row?.status === 'RECOVERY_REQUIRED'
        if (!row) { cancelRecovery(db, q.surface, q.ref, 'source row disappeared', now); resolved++; continue }
      } else {
        const table = q.surface === 'OUTBOUND' ? 'outbound_ledger' : 'zst_outbound_ledger'
        const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (!present) continue
        const row = db.prepare(`SELECT status FROM ${table} WHERE ledger_id=?`).get(q.ref) as { status: string } | undefined
        stillOpen = row?.status === 'RECOVERY_REQUIRED' || row?.status === 'OUTCOME_UNKNOWN'
        if (!row) { cancelRecovery(db, q.surface, q.ref, 'source row disappeared', now); resolved++; continue }
      }
      if (!stillOpen) { resolveRecovery(db, q.surface, q.ref, 'source row left its recovery state', now); resolved++ }
    }
  })
  tx()

  const counts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM cos_recovery_queue GROUP BY status`
  ).all() as Array<{ status: RecoveryQueueStatus; n: number }>
  const by = (s: RecoveryQueueStatus) => counts.find(c => c.status === s)?.n ?? 0
  return { enqueued, resolved, needsHuman: by('NEEDS_HUMAN'), pendingRetry: by('PENDING_RETRY') }
}

export function cancelRecovery(
  db: Database.Database, surface: RecoverySurface, ref: string, reason: string, now: number,
): void {
  db.prepare(
    `UPDATE cos_recovery_queue SET status='CANCELLED', resolved_at=@now, resolution=@reason,
        next_attempt_at=NULL, updated_at=@now WHERE queue_id=@id`
  ).run({ id: queueId(surface, ref), reason, now })
}
