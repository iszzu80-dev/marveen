// Can this message id ever be marked at its source?
//
// INCIDENT (2026-08-31, Recovery Gate). Two batches sat OPEN for 402 h and 170 h
// and two messages sat in LOCAL_APPLIED behind them, holding two CRITICAL alerts
// red. Neither was real mail:
//
//   message_id  golive-probe-20260815
//   message_id  STAGE2G-LIVE-GATE-PROBE-20260824
//
// They were synthetic go-live probes POSTed to /api/cos/intake, and the chain
// had no way to say what was true about them. `closeBatch` calls the committer
// on every LOCAL_APPLIED row; Gmail answers a synthetic id with HTTP 400
// `Invalid id value` -- not 404 -- so the commit "failed", the row went back to
// LOCAL_APPLIED with attempt+1, and it retried forever. The chain could express
// "the commit failed, try again" and "the commit was skipped by policy". It
// could not express **this id can never be committed, and no number of retries
// will change that**.
//
// That is the root cause, and it is one missing distinction, not two bad rows.
//
// DERIVED, NOT STORED, deliberately. The alternative was a `source_committable`
// column set at openBatch. A column would match the codebase's usual "record it,
// do not infer it" idiom (see `thread_id_derived`) -- but here the input IS the
// stored data, the predicate is pure, and deriving it means every row already in
// the table is classified correctly the moment this ships, with no backfill that
// could disagree with the rows it was meant to describe.
import { isTriageBatch } from './email-ingest.js'

/** Gmail message and thread ids are lowercase hex. Gmail itself rejects anything
 *  else with 400 `Invalid id value` rather than 404, which is the difference
 *  between "no such message" and "that is not an id" -- and it is the second one
 *  that must never be retried. */
const GMAIL_ID = /^[0-9a-f]+$/

export type SourceIdVerdict =
  | { committable: true }
  | { committable: false; reason: string }

/**
 * Whether `messageId` could, in principle, be marked at the source for this
 * account. Says nothing about whether the message still EXISTS -- a deleted real
 * message is `committable: true` and fails at the committer, which is correct:
 * that one is a genuine source failure and deserves the retry.
 */
export function classifySourceId(accountId: string, messageId: string): SourceIdVerdict {
  if (GMAIL_ID.test(messageId)) return { committable: true }
  return {
    committable: false,
    reason:
      `message id "${messageId}" is not a Gmail id (expected lowercase hex), ` +
      `so account "${accountId}" has no source object to mark; ` +
      `Gmail answers such an id with 400 Invalid id value, not 404`,
  }
}

export function isSourceCommittable(accountId: string, messageId: string): boolean {
  return classifySourceId(accountId, messageId).committable
}

/** True when the batch itself is synthetic rather than a mailbox fetch. Kept
 *  next to the id rule because the two are the same question at two scopes, and
 *  a reader chasing one will want the other. */
export { isTriageBatch }
