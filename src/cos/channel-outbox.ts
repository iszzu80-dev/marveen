// A queue for messages that must LEAVE the machine on a channel.
//
// WHY A QUEUE AND NOT A SEND. The owner-question path already learned this: the
// step that decides WHAT to say and the step that decides whether the sentence
// actually left are separate, because merging them makes a delivery failure look
// like "nothing to say". Tonight (2026-08-11) it cost a real question — the
// Telegram call failed, and only the split told us.
//
// The radar has the same need and none of the machinery. `alertRadarHit` runs
// inside the radar tick: synchronous, no awaiting, no network. A direct Telegram
// send there would put an HTTPS round trip with its own failure modes inside a
// loop that must not block, and a hit lost to a transient error would be lost
// for good — the price only ever drops below target once.
//
// So the producer ENQUEUES (one INSERT, no network) and the channel step drains.
// Which channel a kind of message goes to is configuration, not code, so the
// answer to "the CoS bot or a separate one?" is a config value rather than a
// rewrite.
import type Database from 'better-sqlite3'

export interface OutboxEntry {
  /** The channel id this is addressed to, e.g. 'telegram:cos'. */
  channel: string
  /** What kind of message — for reporting, and so a route can be enabled per kind. */
  kind: string
  /** Stable identity of the THING being announced, not of the attempt.
   *  A retry, a second tick, or a restarted process must not send twice. */
  dedupeKey: string
  text: string
}

/**
 * Queue a message for delivery. Idempotent per `dedupeKey`.
 *
 * Returns true when this call created the row, false when the same thing was
 * already queued (or already sent). The caller can report the difference; it
 * must not treat false as an error.
 */
export function enqueueOutbox(
  db: Database.Database, entry: OutboxEntry, now: number = Math.floor(Date.now() / 1000),
): boolean {
  const r = db.prepare(
    `INSERT INTO cos_channel_outbox (channel, kind, dedupe_key, text, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  ).run(entry.channel, entry.kind, entry.dedupeKey, entry.text, now)
  return r.changes > 0
}

export interface PendingOutboxRow {
  outbox_id: number
  kind: string
  dedupe_key: string
  text: string
  attempts: number
}

/** Undelivered entries for one channel, oldest first. */
export function pendingOutbox(
  db: Database.Database, channel: string, limit = 10,
): PendingOutboxRow[] {
  return db.prepare(
    `SELECT outbox_id, kind, dedupe_key, text, attempts FROM cos_channel_outbox
      WHERE channel = ? AND sent_at IS NULL
      ORDER BY created_at ASC, outbox_id ASC LIMIT ?`,
  ).all(channel, limit) as PendingOutboxRow[]
}

export function markOutboxSent(
  db: Database.Database, outboxId: number, channelTarget: string,
  now: number = Math.floor(Date.now() / 1000),
): void {
  db.prepare(
    `UPDATE cos_channel_outbox SET sent_at = ?, channel_target = ?, last_error = NULL
      WHERE outbox_id = ?`,
  ).run(now, channelTarget, outboxId)
}

/** Record a failed attempt. The row stays UNSENT so the next drain retries it —
 *  losing a radar hit to a transient network error would lose it for good. */
export function markOutboxFailed(
  db: Database.Database, outboxId: number, error: string,
): void {
  db.prepare(
    `UPDATE cos_channel_outbox SET attempts = attempts + 1, last_error = ?
      WHERE outbox_id = ?`,
  ).run(error.slice(0, 200), outboxId)
}
