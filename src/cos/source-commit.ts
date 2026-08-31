// Personal Chief of Staff (COS) — closing the inbound chain (§8, second half).
//
// The spec's chain is DISCOVERED → CLAIMED → LOCAL_APPLIED → SOURCE_COMMITTED,
// and only then may the batch terminalise and the account cursor advance. The
// first half has run since day one. The second half was written, tested, and
// never called: on 2026-08-09 all eighteen processed messages sat at
// LOCAL_APPLIED, every batch was still OPEN, and the checkpoint table was empty.
// The system genuinely did not know how far it had got.
//
// Why it was never called is worth stating, because it is not laziness: with
// Gmail, "commit the source" means writing the COS/Processed label, and this
// install's token is `gmail.send` only — least privilege, no modify scope. There
// was no way to do the labelling step, so the whole tail of the chain stayed
// unwired, and with it the batch closure and the cursor that depend on it.
//
// The fix is not to pretend the label happened. It is to make the source-commit
// step EXPLICIT and pluggable:
//   - GmailLabelCommitter        — the real thing, once a modify scope exists.
//   - NoSourceWriteCommitter     — records that the source could not be marked,
//                                  with the reason, and lets the chain close on
//                                  an audited policy rather than silently.
//
// The second one follows the precedent the spec already sets in §A.1 for
// quarantine: a message may be terminal off the happy path only if the source
// reference is kept, the reason is recorded, and an explicit policy permits the
// cursor to pass. Anything looser would let the cursor march over mail nobody
// processed, which §19 names as a critical alert — and which the reconcile now
// watches for.

import type Database from 'better-sqlite3'
import { sourceCommit, sourceCommitSkipped, sourceCommitFailed, tryAdvanceCheckpoint, isCursorPositionClear } from './email-ingest.js'
import { POISON_ATTEMPT_THRESHOLD } from './poison-quarantine.js'
import { quarantineBatchPoison, type QuarantineDeps } from './poison-quarantine.js'

export type CommitOutcome = 'COMMITTED' | 'SKIPPED_NO_CAPABILITY' | 'FAILED'

export interface CommitResult {
  outcome: CommitOutcome
  /** Why, in one line. Never empty: an unexplained skip is how a gap hides. */
  reason: string
}

/** Marks the message on the SOURCE side (for Gmail: the COS/Processed label). */
export interface SourceCommitter {
  readonly id: string
  commit(accountId: string, messageId: string): Promise<CommitResult>
}

/** The real committer, for when a modify-scoped token exists. Deliberately not
 *  instantiated anywhere yet — wiring it before the scope exists would produce a
 *  committer that fails every call and a chain that looks broken rather than
 *  ungranted. */
export class GmailLabelCommitter implements SourceCommitter {
  readonly id = 'gmail-label'
  constructor(private readonly applyLabel: (accountId: string, messageId: string) => Promise<void>) {}
  async commit(accountId: string, messageId: string): Promise<CommitResult> {
    try {
      await this.applyLabel(accountId, messageId)
      return { outcome: 'COMMITTED', reason: 'COS/Processed címke felírva' }
    } catch (e) {
      return { outcome: 'FAILED', reason: `címkézés sikertelen: ${(e as Error).message}` }
    }
  }
}

/** No source-write capability. Reports the skip with its reason rather than
 *  pretending success — the distinction between "marked at the source" and
 *  "we could not mark it" has to survive into the audit trail. */
export class NoSourceWriteCommitter implements SourceCommitter {
  readonly id = 'no-source-write'
  constructor(private readonly reason = 'a Gmail token csak gmail.send jogot hordoz, nincs modify scope') {}
  async commit(): Promise<CommitResult> {
    return { outcome: 'SKIPPED_NO_CAPABILITY', reason: this.reason }
  }
}

export interface CloseOptions {
  /** A.1 poison sweep. Absent = no sweep: quarantining is never something that
   *  happens by default, because it is the step that lets the cursor pass
   *  unprocessed mail. */
  quarantine?: QuarantineDeps
  /** Required to terminalise a batch whose messages could not be source-marked.
   *  Default false: without an explicit policy the chain stays open, visibly,
   *  which is the honest state. */
  allowCursorAdvanceWithoutSourceWrite?: boolean
}

export interface CloseResult {
  attempted: number
  committed: number
  skipped: number
  failed: number
  /** Poison messages parked under A.1 during this close. */
  quarantined: number
  batchClosed: boolean
  cursor: string | null
  reason: string
}

interface Row { gmail_account_id: string; message_id: string; attempt: number }

/**
 * Finish the chain for one batch: source-commit every LOCAL_APPLIED message,
 * then try to advance the checkpoint.
 *
 * The ordering is the spec's and it matters: local business writes happened
 * earlier and exactly once, so a failure here can only cost a retry of the
 * SOURCE side, never a duplicate case. That is the whole reason the two halves
 * are separate states rather than one.
 */
export async function closeBatch(
  db: Database.Database,
  batchId: string,
  committer: SourceCommitter,
  now: number,
  opts: CloseOptions = {},
): Promise<CloseResult> {
  const rows = db.prepare(
    `SELECT gmail_account_id, message_id, attempt FROM email_processing
     WHERE batch_id = ? AND status = 'LOCAL_APPLIED'`
  ).all(batchId) as Row[]

  let committed = 0, skipped = 0, failed = 0
  let skipReason = ''
  // Terminalise on an audited exception: the local work is done, the source was
  // NOT marked, the reason is on the row, and the two review surfaces are
  // raised. One helper because three different conditions end here and each one
  // used to be a separate half-wired branch.
  const letPast = (r: Row, reason: string): boolean => {
    if (!opts.allowCursorAdvanceWithoutSourceWrite) return false
    sourceCommitSkipped(db, r.gmail_account_id, r.message_id, `source-commit kihagyva: ${reason}`, now)
    opts.quarantine?.raiseAlert(r.gmail_account_id, r.message_id, reason, 'SOURCE_COMMIT_SKIPPED')
    opts.quarantine?.createReviewTask(r.gmail_account_id, r.message_id, reason, 'SOURCE_COMMIT_SKIPPED')
    return true
  }

  for (const r of rows) {
    const res = await committer.commit(r.gmail_account_id, r.message_id)
    if (res.outcome === 'COMMITTED') {
      sourceCommit(db, r.gmail_account_id, r.message_id, now)
      committed += 1
    } else if (res.outcome === 'SKIPPED_NO_CAPABILITY') {
      skipped += 1
      skipReason = res.reason
      if (opts.allowCursorAdvanceWithoutSourceWrite) {
        // F-8. Audited policy exception: the message is terminal on the local
        // side and its source reference is kept, so the cursor may pass. Two
        // things changed here.
        //
        // 1. The state. This used to write SOURCE_COMMITTED — §6.3's terminal
        //    SUCCESS — for a message that was never marked at the source, with
        //    the truth demoted to last_error. Every later query inherited the
        //    lie. SOURCE_COMMIT_SKIPPED is terminal too, so the cursor still
        //    passes, and it says what happened.
        // 2. A.1 lists five conditions for letting a batch past an item it could
        //    not fully process; two of them (critical alert, human review task)
        //    were wired only to the quarantine branch. An exception nobody is
        //    told about is indistinguishable from a bug, so this branch raises
        //    them too when the deps are present.
        sourceCommitSkipped(db, r.gmail_account_id, r.message_id, `source-commit kihagyva: ${res.reason}`, now)
        opts.quarantine?.raiseAlert(r.gmail_account_id, r.message_id, res.reason, 'SOURCE_COMMIT_SKIPPED')
        opts.quarantine?.createReviewTask(r.gmail_account_id, r.message_id, res.reason, 'SOURCE_COMMIT_SKIPPED')
        committed += 1
      }
    } else {
      failed += 1
      // A failure that writes nothing is indistinguishable from a step that did
      // not run. This branch used to do exactly that: no attempt, no error, no
      // state. Fifteen rows carried `attempt = 0, last_error = NULL` through two
      // weeks of daily retries, so neither the poison sweep (which selects on
      // attempt) nor a human reading the row could see that anything had been
      // tried at all.
      sourceCommitFailed(db, r.gmail_account_id, r.message_id, res.reason, now)
      // A.1 in spirit, for the chain's SECOND half. quarantineBatchPoison only
      // looks at RECOVERY_REQUIRED/CLAIMED/DISCOVERED, so a message that jams
      // AFTER the local write could pin its cursor forever with no sweep able to
      // reach it. Bounded by the same attempt threshold: a transient failure
      // retries, a persistent one is let past on the owner's policy with the
      // measured reason, never on a guess about the first failure.
      const attempts = r.attempt + 1
      if (attempts >= POISON_ATTEMPT_THRESHOLD) {
        const why = `${attempts} sikertelen forras-jeloles utan: ${res.reason}`
        if (letPast(r, why)) { failed -= 1; skipped += 1; skipReason = why; committed += 1 }
      }
    }
  }

  // A.1: a message that keeps failing must not pin the cursor forever. Swept
  // BEFORE the terminality check, so a jam cleared here lets the batch close in
  // the same pass rather than waiting for the next run.
  let quarantined = 0
  const quarantineBlocked: string[] = []
  if (opts.quarantine) {
    const q = quarantineBatchPoison(db, batchId, opts.quarantine, now)
    quarantined = q.quarantined
    for (const b of q.blocked) quarantineBlocked.push(b.reason)
  }

  // Not "is this batch done" but "is the cursor position this batch would move
  // to clear of unprocessed mail" — see isCursorPositionClear. With overlapping
  // deltas the two differ, and only the second one is the P0.2 invariant.
  if (!isCursorPositionClear(db, batchId)) {
    return {
      attempted: rows.length, committed, skipped, failed, quarantined, batchClosed: false, cursor: null,
      reason: quarantineBlocked.length
        ? `a köteg blokkolt: ${quarantineBlocked[0]}`
        : skipped && !opts.allowCursorAdvanceWithoutSourceWrite
          ? `a köteg nyitva marad: ${skipReason} (a pozíció-léptetéshez explicit policy kell)`
          : 'a köteg nem minden eleme terminális',
    }
  }
  const adv = tryAdvanceCheckpoint(db, batchId, now)
  return {
    attempted: rows.length, committed, skipped, failed, quarantined,
    // The batch closing and the account cursor moving are two different facts.
    // A triage batch closes and deliberately moves no cursor (it has no history
    // position), so reporting batchClosed from `advanced` would have shown every
    // triage close as a stall.
    batchClosed: adv.batchTerminal, cursor: adv.cursor,
    reason: adv.advanced
      ? 'a köteg lezárult, a pozíció lépett'
      : adv.batchTerminal
        ? `a köteg lezárult, a pozíció nem lépett: ${adv.holdReason ?? 'ismeretlen ok'}`
        : 'a köteg terminális, de a pozíció nem lépett',
  }
}

/** Every batch that still has work. Ordered oldest first so the cursor advances
 *  in the order the mail arrived. */
export function openBatchIds(db: Database.Database, limit = 100): string[] {
  return (db.prepare(
    `SELECT batch_id FROM email_processing_batches
     WHERE status IN ('OPEN','PROCESSING') ORDER BY created_at LIMIT ?`
  ).all(limit) as Array<{ batch_id: string }>).map((r) => r.batch_id)
}

/** Close every open batch. Used by the case-wake / reconcile path. */
export async function closeOpenBatches(
  db: Database.Database,
  committer: SourceCommitter,
  now: number,
  opts: CloseOptions = {},
): Promise<{ batches: number; closed: number; results: CloseResult[] }> {
  const ids = openBatchIds(db)
  const results: CloseResult[] = []
  for (const id of ids) results.push(await closeBatch(db, id, committer, now, opts))
  return { batches: ids.length, closed: results.filter((r) => r.batchClosed).length, results }
}
