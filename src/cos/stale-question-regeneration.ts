// A question that cannot be delivered must not hold a slot for ever.
//
// Owner directive, 2026-09-02, after the second freeze was measured.
//
// WHAT HAPPENED. The channel recovery freed the five slots, the reader asked two
// held questions, and NONE of the three oldest blocking decisions reached the
// owner. The delivery freshness gate refused them, correctly: their evidence
// packets were 8 to 22 days old and the cases had moved since. PRI-DQ-2026-001's
// watermark had been pushed from 423 to 517 by a DECISION_IMPORTED event on
// 2026-08-24.
//
// The refusal was right. What was missing is what happens NEXT. The send site's
// own comment said the row is "left unmarked so the next reader/question pass
// may refresh it" -- but the reader only re-reads a case when a progression run
// completed after its last packet, and nothing gave a stale-blocked case that
// reason. So the question sat: undeliverable, unrefreshed, and occupying one of
// five slots. A freeze one layer below the one that had just been fixed, with
// the same shape: a state nothing could leave.
//
// ── WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT ───────────────
//
// It records the block, frees the slot, and gives the reader a reason to read
// the case again. It does NOT rewrite the question, and it does not decide the
// question is obsolete: regeneration goes through the ordinary reader path, so
// the new question is built by the same code as every other question, from a
// current packet. If the ask is unchanged the hash is unchanged, which means the
// SAME ROW and the SAME TOKEN -- semantic identity is preserved by construction
// rather than by a copy step. If the ask genuinely changed, the composer's
// existing supersede rule applies, which is the explicit semantic replacement
// the owner allows.
//
// And it is BOUNDED. A question that goes stale three times is not a case that
// needs one more retry; it is an operational failure, and it says so rather than
// retrying quietly for ever. Unbounded retry is how a loud failure becomes a
// silent one.

import type Database from 'better-sqlite3'

/** After this many stale-blocked deliveries, stop regenerating and report.
 *
 *  Three, because two is indistinguishable from a race (the case moved while the
 *  cycle ran) and ten would mean a day of silence before anybody heard. */
export const MAX_STALE_RETRIES = 3

export interface StaleBlockedQuestion {
  domain: 'personal' | 'zst'
  caseId: string
  questionHash: string
  retryCount: number
  blockedAt: number
  lastError: string | null
}

/**
 * Record that delivery refused this question as stale.
 *
 * The row stays OPEN — it is still a real question and its answer would still be
 * wanted. What changes is that it stops counting against capacity (see
 * `staleBlockedFilterSql`) and that the reader now has a reason to re-read its
 * case.
 */
export function markQuestionStaleBlocked(
  db: Database.Database,
  input: { caseId: string; questionHash: string; error: string; now?: number },
): number {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE cos_owner_questions
        SET stale_blocked_at = ?, stale_retry_count = stale_retry_count + 1, stale_last_error = ?
      WHERE case_id = ? AND question_hash = ?`,
  ).run(now, input.error.slice(0, 200), input.caseId, input.questionHash)
  const r = db.prepare(
    `SELECT stale_retry_count AS n FROM cos_owner_questions
      WHERE case_id = ? AND question_hash = ?`,
  ).get(input.caseId, input.questionHash) as { n: number } | undefined
  return r?.n ?? 0
}

/**
 * The block is lifted when the question is delivered, or when it is re-asked
 * from a newer progression run.
 *
 * `stale_retry_count` is NOT reset on a successful send. A case that goes stale,
 * recovers, and goes stale again is exhibiting the same problem twice, and
 * zeroing the counter on every success would let it alternate for ever without
 * ever reaching the bound.
 */
export function clearStaleBlock(
  db: Database.Database, caseId: string, questionHash: string,
): void {
  db.prepare(
    `UPDATE cos_owner_questions SET stale_blocked_at = NULL, stale_last_error = NULL
      WHERE case_id = ? AND question_hash = ?`,
  ).run(caseId, questionHash)
}

/** SQL fragment: a question that currently counts against the cap.
 *
 *  A stale-blocked one does not. It cannot be delivered, so holding a seat for
 *  it starves questions that CAN be — which is precisely the failure this
 *  module exists to end. It is still open, still answerable, and still visible;
 *  it simply no longer blocks the channel. */
export const COUNTS_AGAINST_CAP_SQL =
  `answered_at IS NULL AND superseded_at IS NULL AND stale_blocked_at IS NULL`

/** Cases whose open question is stale-blocked and still within the retry bound.
 *  The reader adds these to its candidate list so a fresh packet gets built. */
export function staleBlockedCases(
  db: Database.Database, limit = 20,
): StaleBlockedQuestion[] {
  try {
    return db.prepare(
      `SELECT domain, case_id AS caseId, question_hash AS questionHash,
              stale_retry_count AS retryCount, stale_blocked_at AS blockedAt,
              stale_last_error AS lastError
         FROM cos_owner_questions
        WHERE answered_at IS NULL AND superseded_at IS NULL
          AND stale_blocked_at IS NOT NULL
          AND stale_retry_count < ?
        ORDER BY stale_blocked_at ASC LIMIT ?`,
    ).all(MAX_STALE_RETRIES, limit) as never
  } catch { return [] }
}

/**
 * Questions that have gone stale too many times AND are still blocked.
 *
 * `stale_blocked_at IS NOT NULL` is the whole difference, and it was added after
 * the live readback: PRI-HOME-2026-004 was DELIVERED, its block lifted, and the
 * cycle went on reporting REPEATED_STALE about it every ten minutes because its
 * historical count was five. A failure report about something that succeeded is
 * worse than no report -- it is what teaches everyone to stop reading
 * `problems`, which is the failure this whole day has been about.
 *
 * The count itself still does not reset on success, deliberately: a case that
 * alternates between fresh and stale must still reach the bound. What changed is
 * only WHEN it is reported -- while it is actually blocked.
 *
 * These are the operational failure the owner asked to be VISIBLE. They are
 * returned rather than retried, so the cycle can put them in `problems` where a
 * person reads them — a question that can never be delivered and never says so
 * is the exact shape of the bug this whole day has been about.
 */
export function exhaustedStaleQuestions(
  db: Database.Database,
): StaleBlockedQuestion[] {
  try {
    return db.prepare(
      `SELECT domain, case_id AS caseId, question_hash AS questionHash,
              stale_retry_count AS retryCount, stale_blocked_at AS blockedAt,
              stale_last_error AS lastError
         FROM cos_owner_questions
        WHERE answered_at IS NULL AND superseded_at IS NULL
          AND stale_blocked_at IS NOT NULL
          AND stale_retry_count >= ?
        ORDER BY stale_blocked_at ASC`,
    ).all(MAX_STALE_RETRIES) as never
  } catch { return [] }
}
