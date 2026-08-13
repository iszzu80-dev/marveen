// Personal Chief of Staff (COS) — self-generated Gmail event guard (spec P1.2,
// AC-28).
//
// When the COS finishes processing a message it labels it (COS/Processed). That
// label write is itself a change in the Gmail mailbox, so the history-delta
// poller will later SEE it. Left unguarded, the poller would treat our own label
// echo as a brand-new event and re-process the message — a self-wake loop.
//
// The guard classifies each history event BEFORE any business processing, using
// the message ledger (email_processing) + a content fingerprint:
//   - SELF_LABEL_NOOP: the only change is us adding our own label(s) to a message
//     we already know → no business, origin logged.
//   - DUPLICATE: a message we already committed re-surfaces, or a different
//     message id carries content we already committed (resend).
//   - NEW_BUSINESS: anything else → process normally.
//
// Pure over the DB (no Gmail client), so it is fully testable before the live
// history poller (which needs the write-scope consent) exists.
//
// ── NOT ON THE LIVE PATH (stated 2026-08-13, review finding P5) ─────────────
//
// Nothing in production calls classifyHistoryEvent or recordSelfEvent, and
// nothing writes email_processing.content_hash — so the resend branch below
// cannot match on the live store even if it were called. That is not a bug in
// this file: the history POLLER it guards does not exist yet. Today's inlet is
// the triage feeder, which dedups at the poll level with its own --mark file
// and at the case level with email_processing's UNIQUE.
//
// It is written down here because an audit reading "AC-28 implemented" from the
// file list would be counting a guard that guards nothing today. Wire this the
// same day the history poller lands — and populate content_hash at commit time,
// or the resend branch stays decorative.

import type Database from 'better-sqlite3'
import { TERMINAL_MESSAGE_STATUSES, type MessageStatus } from './email-ingest.js'

/** Labels the COS itself writes. A history event whose ONLY change is adding one
 *  of these, on a message we already know, is our own echo. Keep in sync with
 *  whatever label the source-commit step applies. */
export const COS_OWNED_LABELS: ReadonlySet<string> = new Set(['COS/Processed'])

export interface HistoryEvent {
  accountId: string
  messageId: string
  /** Labels this event ADDED to the message. */
  labelsAdded?: string[]
  /** Labels this event REMOVED from the message. */
  labelsRemoved?: string[]
  /** True when this event is a genuinely new message arriving (not a mutation). */
  messageAdded?: boolean
  /** Fingerprint of the message content, for resend dedup across message ids. */
  contentHash?: string
}

export type HistoryOutcome = 'NEW_BUSINESS' | 'SELF_LABEL_NOOP' | 'DUPLICATE'
export interface HistoryClassification {
  outcome: HistoryOutcome
  reason: string
  /** The known ledger status of the message, if any (for the caller's audit). */
  knownStatus: MessageStatus | null
}

function knownStatus(db: Database.Database, accountId: string, messageId: string): MessageStatus | null {
  const r = db.prepare(
    `SELECT status FROM email_processing WHERE gmail_account_id=? AND message_id=?`
  ).get(accountId, messageId) as { status: MessageStatus } | undefined
  return r?.status ?? null
}

/**
 * Classify a Gmail history event. The self-label echo test is deliberately
 * strict: the message must already be in the ledger, the event must be
 * label-only (no new message), the added labels must ALL be COS-owned, and
 * nothing may be removed. Anything looser risks swallowing a real event.
 */
export function classifyHistoryEvent(db: Database.Database, e: HistoryEvent): HistoryClassification {
  const status = knownStatus(db, e.accountId, e.messageId)
  const added = e.labelsAdded ?? []
  const removed = e.labelsRemoved ?? []
  const isLabelOnly = !e.messageAdded && (added.length > 0 || removed.length > 0)
  const addedAllOurs = added.length > 0 && added.every(l => COS_OWNED_LABELS.has(l))

  // Self-generated label echo: known message, the only change is us adding our
  // own label(s), nothing removed. NOT new business.
  if (status != null && isLabelOnly && addedAllOurs && removed.length === 0) {
    return { outcome: 'SELF_LABEL_NOOP', reason: `self label echo (${added.join(',')}) on ${status} message`, knownStatus: status }
  }

  // A message we already carried to a terminal state re-surfacing (same id) is a
  // duplicate, not new business.
  if (status != null && TERMINAL_MESSAGE_STATUSES.has(status)) {
    return { outcome: 'DUPLICATE', reason: `message already processed (${status})`, knownStatus: status }
  }

  // Resend dedup: a DIFFERENT message id carrying content we already committed.
  if (e.contentHash) {
    const dup = db.prepare(
      `SELECT message_id FROM email_processing
       WHERE gmail_account_id=? AND content_hash=? AND message_id<>?
       ORDER BY created_at ASC LIMIT 1`
    ).get(e.accountId, e.contentHash, e.messageId) as { message_id: string } | undefined
    if (dup) return { outcome: 'DUPLICATE', reason: `content-hash matches already-seen message ${dup.message_id}`, knownStatus: status }
  }

  return { outcome: 'NEW_BUSINESS', reason: status == null ? 'new message' : `known message, non-self change (${status})`, knownStatus: status }
}

/** Origin log for a recognised self-generated echo (P1.2 "az origin naplózva"):
 *  bump the per-message counter + timestamp so the audit shows we saw and
 *  ignored our own label write. No status change — the message stays where it is. */
export function recordSelfEvent(db: Database.Database, accountId: string, messageId: string, now: number): void {
  db.prepare(
    `UPDATE email_processing
       SET self_event_count = self_event_count + 1, last_self_event_at = @now, updated_at = @now
     WHERE gmail_account_id = @accountId AND message_id = @messageId`
  ).run({ accountId, messageId, now })
}
