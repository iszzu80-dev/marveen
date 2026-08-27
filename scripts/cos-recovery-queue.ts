#!/usr/bin/env npx tsx
/**
 * W12 / §6.7 — reconcile the recovery queue, every cycle.
 *
 * The queue is derived-but-durable: membership is re-derived from the source
 * tables (email_processing, the two outbound ledgers) on every run, while
 * attempt counts, escalation and resolution live in cos_recovery_queue and
 * survive restarts. This is the step that runs that reconcile.
 *
 * IT DELIVERS NOTHING. Istvan's decision (2026-08-25): W12 opens no new
 * automatic email/push/outbound notification channel — the existing internal UI
 * (COS Control → monitoring) surfaces the NEEDS_HUMAN rows. That constraint is
 * not left to this file's good intentions: the step's scheduled-task grant is
 * READ + WRITE_LOCAL with no EXTERNAL_EFFECT, so a future edit that tries to
 * notify from here fails at the capability boundary rather than succeeding
 * quietly.
 *
 * The exit code is 0 even when rows need a human. A queue with an escalated row
 * is the system working, not the cycle failing, and a step that exits 1 every
 * ten minutes for a condition only a human can clear would train its reader to
 * ignore it — which is how the one real alarm gets missed. What DOES exit 1 is
 * a reconcile that could not run.
 */
import { getDb, initDatabase } from '../src/db.js'
import { reconcileRecoveryQueue, listNeedsHuman } from '../src/cos/recovery-queue.js'

initDatabase()
const now = Math.floor(Date.now() / 1000)

try {
  const res = reconcileRecoveryQueue(getDb(), now)
  const needsHuman = listNeedsHuman(getDb(), 20).map(r => ({
    queueId: r.queueId, surface: r.surface, ref: r.ref, caseId: r.caseId,
    attempts: `${r.attemptCount}/${r.maxAttempts}`, since: r.escalatedAt,
    pendingAction: r.pendingAction, lastError: r.lastError,
  }))
  // CPP TRANSLATION, AT THE BOUNDARY ON PURPOSE (2026-08-27).
  //
  // The domain function speaks domain (`enqueued`, `resolved`, `inRecovery`);
  // the cycle's normaliser speaks CPP (`examined`, `matched`, `acted`). Doing
  // the mapping here keeps CPP vocabulary out of src/cos/ and keeps the
  // normaliser free of a per-step table -- the thing its own comment warns
  // against, because the step nobody remembered to add to that table reports
  // UNKNOWN while looking exactly like a step that genuinely cannot say what it
  // did. This step WAS that step: it reported UNKNOWN on every cycle from the
  // pinned cutover (2026-08-24) until now, not because it could not speak but
  // because nothing asked it in a language the reader knew.
  //
  // `acted` is enqueued + resolved: both are WRITES this reconcile made. A
  // status count (needsHuman, pendingRetry) is state, not action, and putting
  // state in `acted` would report work on every quiet cycle that has a single
  // parked row.
  console.log(JSON.stringify({
    ...res,
    matched: res.inRecovery,
    acted: res.enqueued + res.resolved,
    needsHumanRows: needsHuman,
  }))
  process.exit(0)
} catch (err) {
  console.log(JSON.stringify({ failed: true, error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
}
