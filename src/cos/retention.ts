// Personal Chief of Staff (COS) — retention policy (spec §C DoD).
//
// §C requires a DEFINED retention policy for deleted cases and attachments. This
// module is the single source of that policy + the sweeps that enforce it:
//   - attachment CONTENT is purged after RETENTION.attachmentContentDays (the
//     row + checksum survive as an audit tombstone — sensitive bytes do not live
//     forever, the record of having received them does);
//   - a case that has been CANCELLED/ARCHIVED longer than RETENTION.deletedCase
//     Days is eligible for purge. The append-only audit trail (personal_case_
//     events triggers) intentionally blocks deleting the event history from the
//     normal path, so this reports the eligible set for a privileged, audited
//     purge rather than silently dropping the audit spine.
//
// backup retention lives in backup.ts (BACKUP_RETENTION_DAYS) and is mirrored
// here for a single policy view.

import type Database from 'better-sqlite3'
import { BACKUP_RETENTION_DAYS } from './backup.js'

export const RETENTION = {
  /** Days to keep a CANCELLED/ARCHIVED case before it is eligible for purge. */
  deletedCaseDays: 365,
  /** Days to keep attachment CONTENT before it is purged (checksum tombstone stays). */
  attachmentContentDays: 90,
  /** Days to keep encrypted backups (mirror of backup.ts). */
  backupDays: BACKUP_RETENTION_DAYS,
  /**
   * Days to keep a Reader evidence packet (review #4, N4-2).
   *
   * `packet_json` holds the FACTS the Reader extracted from the emails — the
   * same personal data as the attachments, only structured and therefore easier
   * to read. It accumulated with no policy at three rows per cycle: 432 a day.
   *
   * Shorter than the case window on purpose. A packet is a READING of a case at
   * a moment, not the case's record: the audit spine (progression runs, case
   * events) survives the purge and remains the thing you reconstruct history
   * from. Ninety days matches the attachment-content window, because the two
   * hold the same class of content.
   */
  evidencePacketDays: 90,
} as const

export interface AttachmentPurgeResult { purged: number }

export interface EvidencePacketPurgeResult { purged: number; kept: number }

/**
 * Purge the CONTENT of expired Reader evidence packets (§C, review #4 N4-2).
 *
 * The row survives with its §13.1 arbitration audit — reader_candidate,
 * policy_result, conflict_reason, safe_fallback_decision — and loses
 * `packet_json` and `plan_json`, which are the parts carrying the personal data
 * read out of the mail. Same shape as the attachment purge: keep the evidence
 * that a decision happened and why, drop the content it was about.
 *
 * `refusal_reason` is kept too: a refused reading holds no case content, and
 * the reason is how a repeated failure stays visible.
 *
 * Idempotent — already-purged rows have packet_json IS NULL and are skipped.
 */
export function purgeExpiredEvidencePackets(
  db: Database.Database, now: number, retentionDays = RETENTION.evidencePacketDays,
): EvidencePacketPurgeResult {
  const cutoff = now - retentionDays * 86400
  try {
    const info = db.prepare(
      `UPDATE case_evidence_packets
       SET packet_json = NULL, plan_json = NULL
       WHERE created_at < @cutoff AND packet_json IS NOT NULL`,
    ).run({ cutoff })
    const kept = (db.prepare(
      `SELECT COUNT(*) AS n FROM case_evidence_packets WHERE packet_json IS NOT NULL`,
    ).get() as { n: number }).n
    return { purged: info.changes, kept }
  } catch (e) {
    // E17 (review 2026-08-13). NARROW. This catch used to swallow EVERY error and
    // return a clean {purged:0, kept:0} — so a corrupt store, a locked database
    // or a disk failure reported a successful retention run, and the maintenance
    // script that fails loud on purpose was handed a success to print. The only
    // error this is allowed to absorb is the one it was written for: a fresh
    // store where the progression schema has not been deployed yet, so the table
    // genuinely does not exist. Everything else is a failed purge and has to
    // travel, because the alternative is sensitive extracted content quietly
    // living past its policy.
    const msg = String((e as Error)?.message ?? e)
    if (/no such table/i.test(msg)) return { purged: 0, kept: 0 }
    throw e
  }
}

/**
 * Purge attachment CONTENT older than the retention window: NULL the bytes and
 * stamp content_purged_at, keeping the row + checksum. Idempotent (already-purged
 * rows have content IS NULL and are skipped).
 */
export function purgeExpiredAttachmentContent(db: Database.Database, now: number, retentionDays = RETENTION.attachmentContentDays): AttachmentPurgeResult {
  const cutoff = now - retentionDays * 86400
  const info = db.prepare(
    `UPDATE case_attachments
       SET content = NULL, content_purged_at = @now, updated_at = @now
     WHERE content IS NOT NULL AND created_at < @cutoff`
  ).run({ now, cutoff })
  return { purged: info.changes }
}

export interface DeletedCaseRow { case_id: string; status: string; updated_at: number }

/**
 * Cases eligible for purge: CANCELLED/ARCHIVED and untouched longer than the
 * retention window. Returned (not deleted) — the actual purge is a privileged,
 * audited operation, because deleting the case would also drop its append-only
 * event history, which the normal path forbids.
 */
export function deletedCasesEligibleForPurge(db: Database.Database, now: number, retentionDays = RETENTION.deletedCaseDays): DeletedCaseRow[] {
  const cutoff = now - retentionDays * 86400
  return db.prepare(
    `SELECT case_id, status, updated_at FROM personal_cases
     WHERE status IN ('CANCELLED','ARCHIVED') AND updated_at < ?
     ORDER BY updated_at ASC`
  ).all(cutoff) as DeletedCaseRow[]
}
