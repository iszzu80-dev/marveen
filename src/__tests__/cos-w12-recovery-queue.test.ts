import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, markRecoveryRequired, sourceCommit } from '../cos/email-ingest.js'
import {
  reconcileRecoveryQueue, getRecovery, recordRecoveryAttempt, listNeedsHuman, listDueForRetry,
  getRetryPolicy, seedRetryPolicies, DEFAULT_RETRY_POLICIES,
} from '../cos/recovery-queue.js'

// W12 / §6.7 — the recovery queue as first-class durable data.
//
// Istvan's decision (2026-08-25): retry policy, attempt count, next attempt,
// last error, retry class, max attempts and escalation threshold are EXPLICIT
// DATA, not hidden hardcoded behaviour; reaching the threshold moves the record
// to NEEDS_HUMAN; the existing internal UI surfaces it; W12 opens no new
// outbound notification channel.
//
// The ingest half is the one that had nothing at all before this: an
// `email_processing` row in RECOVERY_REQUIRED is NON-TERMINAL, so it pins the
// account history cursor (P0.2) — and no code read those rows. The tests below
// therefore assert not only that the queue works, but that the ingest surface is
// IN it.

const ACC = 'iszzu80'
const NOW = 1_700_000_000

function ingestRow(messageId: string, err = 'transient parse fail') {
  const db = getDb()
  openBatch(db, {
    batchId: `b-${messageId}`, accountId: ACC, cursorBefore: '100', cursorAfter: '150',
    messages: [{ messageId, threadId: `t-${messageId}` }],
  }, NOW)
  markRecoveryRequired(db, ACC, messageId, err, NOW)
}

function outboundRow(ledgerId: string, status: string, lastError: string) {
  getDb().prepare(
    `INSERT INTO outbound_ledger
      (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
       external_idempotency_marker, status, attempt, last_error, created_at, updated_at)
     VALUES (?, 'c1', 'EMAIL_SEND', 1, ?, ?, ?, 1, ?, ?, ?)`
  ).run(ledgerId, `idem-${ledgerId}`, `COS-Ref:${ledgerId}`, status, lastError, NOW, NOW)
}

describe('W12 §6.7 recovery queue — policy as data', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('seeds every default class, and an operator edit survives re-seeding', () => {
    const db = getDb()
    for (const p of DEFAULT_RETRY_POLICIES) {
      expect(getRetryPolicy(db, p.retryClass).maxAttempts).toBe(p.maxAttempts)
    }
    // The point of "policy as data": change the row, boot again, keep the change.
    db.prepare(`UPDATE cos_retry_policy SET max_attempts=9 WHERE retry_class='INGEST_LOCAL_APPLY'`).run()
    seedRetryPolicies(db, NOW)
    expect(getRetryPolicy(db, 'INGEST_LOCAL_APPLY').maxAttempts).toBe(9)
  })

  it('an unknown retry class throws rather than defaulting to a decision nobody made', () => {
    expect(() => getRetryPolicy(getDb(), 'NO_SUCH_CLASS')).toThrow(/no retry policy/)
  })
})

describe('W12 §6.7 recovery queue — the INGEST surface', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('enqueues a parked ingest row with every §6.7 field populated', () => {
    ingestRow('m1')
    const res = reconcileRecoveryQueue(getDb(), NOW)
    expect(res.enqueued).toBe(1)
    const q = getRecovery(getDb(), 'INGEST', `${ACC}/m1`)!
    expect(q.status).toBe('PENDING_RETRY')
    expect(q.pendingAction).toMatch(/RE_APPLY_LOCAL/)      // the exact pending action
    expect(q.inputRef).toBe('b-m1')                        // input reference
    expect(q.idempotencyKey).toBe(`${ACC}/m1`)             // idempotency key
    expect(q.lastKnownOutcome).toBe('RECOVERY_REQUIRED')   // last known outcome
    expect(q.lastError).toBe('transient parse fail')
    expect(q.maxAttempts).toBe(5)                          // max attempts, ON THE ROW
    expect(q.escalateAfterAttempts).toBe(3)                // escalation threshold, ON THE ROW
    expect(q.attemptCount).toBe(0)
    expect(q.nextAttemptAt).toBe(NOW)
  })

  it('reconcile is idempotent and a refresh never resets the attempt count', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'still failing' }, NOW + 60)
    expect(getRecovery(db, 'INGEST', `${ACC}/m1`)!.attemptCount).toBe(1)

    const second = reconcileRecoveryQueue(db, NOW + 120)
    expect(second.enqueued).toBe(0)
    // A counter that reset on every reconcile could never reach a threshold, and
    // the escalation would be unreachable code that always looks healthy.
    expect(getRecovery(db, 'INGEST', `${ACC}/m1`)!.attemptCount).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) n FROM cos_recovery_queue`).get() as { n: number }).n).toBe(1)
  })

  it('attempts back off, then the threshold moves the record to NEEDS_HUMAN', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)

    const a1 = recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'e1' }, NOW + 10)
    expect(a1.status).toBe('PENDING_RETRY')
    expect(a1.nextAttemptAt).toBe(NOW + 10 + 60)          // base backoff, from the policy row

    const a2 = recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'e2' }, NOW + 100)
    expect(a2.nextAttemptAt).toBe(NOW + 100 + 120)        // exponential, not fixed

    const a3 = recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'e3' }, NOW + 300)
    expect(a3.status).toBe('NEEDS_HUMAN')                 // threshold 3 reached
    expect(a3.escalatedAt).toBe(NOW + 300)
    expect(a3.escalationReason).toMatch(/3 attempt\(s\) of max 5, escalation threshold 3/)
    // No further automatic attempt is scheduled: an escalated row must not look
    // like one the loop will pick up again.
    expect(a3.nextAttemptAt).toBeNull()
    expect(listDueForRetry(db, NOW + 10_000).map(r => r.queueId)).toEqual([])
    expect(listNeedsHuman(db).map(r => r.ref)).toEqual([`${ACC}/m1`])
  })

  it('an escalated record is never touched again by the automatic loop', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    for (const t of [10, 100, 300]) recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false }, NOW + t)
    const escalated = getRecovery(db, 'INGEST', `${ACC}/m1`)!
    const after = recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'loop tried again' }, NOW + 999)
    expect(after).toEqual(escalated)
  })

  it('a source row that leaves RECOVERY_REQUIRED closes its queue entry', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    sourceCommit(db, ACC, 'm1', NOW + 500)
    const res = reconcileRecoveryQueue(db, NOW + 600)
    expect(res.resolved).toBe(1)
    expect(getRecovery(db, 'INGEST', `${ACC}/m1`)!.status).toBe('RESOLVED')
  })

  it('a source row that disappears is CANCELLED, not left pending forever', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    db.prepare(`DELETE FROM email_processing WHERE gmail_account_id=? AND message_id='m1'`).run(ACC)
    reconcileRecoveryQueue(db, NOW + 600)
    expect(getRecovery(db, 'INGEST', `${ACC}/m1`)!.status).toBe('CANCELLED')
  })
})

describe('W12 §6.7 recovery queue — the OUTBOUND surfaces', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('RECOVERY_REQUIRED is NEEDS_HUMAN from the first breath — never an automatic retry', () => {
    outboundRow('ob-1', 'RECOVERY_REQUIRED', 'marker absent after provider success')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    const q = getRecovery(db, 'OUTBOUND', 'ob-1')!
    // §6.5: the provider claimed success. A retry here IS a second send, so the
    // policy allows zero attempts and the record goes straight to a human.
    expect(q.retryClass).toBe('OUTBOUND_READBACK')
    expect(q.maxAttempts).toBe(0)
    expect(q.status).toBe('NEEDS_HUMAN')
    expect(q.nextAttemptAt).toBeNull()
    expect(q.pendingAction).toMatch(/NEVER auto-resend/)
    expect(listDueForRetry(db, NOW + 10_000)).toEqual([])
  })

  it('OUTCOME_UNKNOWN queues a VERIFY, never a resend', () => {
    outboundRow('ob-2', 'OUTCOME_UNKNOWN', 'provider timed out')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    const q = getRecovery(db, 'OUTBOUND', 'ob-2')!
    expect(q.status).toBe('PENDING_RETRY')
    expect(q.pendingAction).toMatch(/^VERIFY_READBACK/)
    expect(q.pendingAction).not.toMatch(/resend|RESEND/)
    expect(q.idempotencyKey).toBe('idem-ob-2')
  })

  it('both surfaces live in ONE queue, so a single read answers "what needs recovery"', () => {
    ingestRow('m1')
    outboundRow('ob-1', 'RECOVERY_REQUIRED', 'marker absent')
    const db = getDb()
    const res = reconcileRecoveryQueue(db, NOW)
    expect(res.enqueued).toBe(2)
    expect(res.needsHuman).toBe(1)
    expect(res.pendingRetry).toBe(1)
  })
})

// ── The counters that decide whether this step can speak ─────────────────────
//
// Added 2026-08-27, after the pinned cycle reported `recoveryQueue` as
// runStatus UNKNOWN on two consecutive live cycles: "successful exit but
// payload exposes no CPP counters". The step was not broken and the normaliser
// was not wrong -- the reconcile returned four STATUS counts and nothing about
// what it had LOOKED AT, so a run over an empty store and a run that never
// queried were numerically identical.
//
// These tests are the reason the fix is not "teach the reader another name":
// `enqueued: 0` is a true zero on a healthy store, and mapping it to `examined`
// would have turned an honest "we don't know" into a confident "nothing to do"
// without measuring anything. `examined` has to come from the loops.
describe('W12 §6.7 recovery queue — reconcile reports what it examined', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('an empty store is examined:0 -- and the WITNESS says it still looked', () => {
    const res = reconcileRecoveryQueue(getDb(), NOW)
    expect(res.examined).toBe(0)
    expect(res.inRecovery).toBe(0)
    expect(res.reChecked).toBe(0)
    expect(res.enqueued).toBe(0)
    // This is the live store's shape: nothing parked, so every row counter is
    // 0 on every healthy cycle -- which is byte-identical to a reconcile that
    // never queried. Fixing UNKNOWN by producing THAT zero would have moved the
    // ambiguity rather than removed it. surfacesScanned counts the QUERIES, so
    // it is the one number that separates the two cases when there is no input.
    expect(res.surfacesScanned).toBeGreaterThan(0)
  })

  it('every source surface present is scanned, and the count says how many', () => {
    // ingest + outbound_ledger + zst_outbound_ledger on a full store.
    expect(reconcileRecoveryQueue(getDb(), NOW).surfacesScanned).toBe(3)
  })

  it('source rows in a recovery state are counted, in BOTH passes of one run', () => {
    ingestRow('m1')
    ingestRow('m2')
    outboundRow('l1', 'RECOVERY_REQUIRED', 'marker absent on readback')
    const res = reconcileRecoveryQueue(getDb(), NOW)
    expect(res.enqueued).toBe(3)
    expect(res.inRecovery).toBe(3)
    // Written expecting 1x3 and measured at 2x3. The two passes share ONE
    // transaction, so the rows the enqueue pass had just inserted were already
    // open when the closure pass queried. The counter is right and the
    // expectation was wrong -- kept here in the shape that corrected it.
    expect(res.reChecked).toBe(3)
    expect(res.examined).toBe(6)
  })

  it('a later run re-checks the open rows even when it enqueues nothing', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)

    const second = reconcileRecoveryQueue(db, NOW + 60)
    expect(second.enqueued).toBe(0)         // idempotent: nothing new
    expect(second.inRecovery).toBe(1)
    expect(second.reChecked).toBe(1)
    expect(second.examined).toBe(2)
  })

  it('a reconcile that only CLOSES rows still reports work, not silence', () => {
    ingestRow('m1')
    const db = getDb()
    reconcileRecoveryQueue(db, NOW)
    // The source leaves its recovery state; the queue row must be closed.
    sourceCommit(db, ACC, 'm1', NOW + 30)

    const res = reconcileRecoveryQueue(db, NOW + 60)
    expect(res.inRecovery).toBe(0)          // nothing parked any more
    expect(res.reChecked).toBe(1)           // but the open row WAS re-checked
    expect(res.examined).toBe(1)
    expect(res.resolved).toBe(1)
    expect(res.surfacesScanned).toBe(3)
    // Without these counters this run and a run that never queried both
    // reported enqueued:0 -- and the closure would have been invisible work.
  })
})
