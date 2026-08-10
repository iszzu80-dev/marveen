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
import { BACKUP_RETENTION_DAYS } from './backup.js';
export const RETENTION = {
    /** Days to keep a CANCELLED/ARCHIVED case before it is eligible for purge. */
    deletedCaseDays: 365,
    /** Days to keep attachment CONTENT before it is purged (checksum tombstone stays). */
    attachmentContentDays: 90,
    /** Days to keep encrypted backups (mirror of backup.ts). */
    backupDays: BACKUP_RETENTION_DAYS,
};
/**
 * Purge attachment CONTENT older than the retention window: NULL the bytes and
 * stamp content_purged_at, keeping the row + checksum. Idempotent (already-purged
 * rows have content IS NULL and are skipped).
 */
export function purgeExpiredAttachmentContent(db, now, retentionDays = RETENTION.attachmentContentDays) {
    const cutoff = now - retentionDays * 86400;
    const info = db.prepare(`UPDATE case_attachments
       SET content = NULL, content_purged_at = @now, updated_at = @now
     WHERE content IS NOT NULL AND created_at < @cutoff`).run({ now, cutoff });
    return { purged: info.changes };
}
/**
 * Cases eligible for purge: CANCELLED/ARCHIVED and untouched longer than the
 * retention window. Returned (not deleted) — the actual purge is a privileged,
 * audited operation, because deleting the case would also drop its append-only
 * event history, which the normal path forbids.
 */
export function deletedCasesEligibleForPurge(db, now, retentionDays = RETENTION.deletedCaseDays) {
    const cutoff = now - retentionDays * 86400;
    return db.prepare(`SELECT case_id, status, updated_at FROM personal_cases
     WHERE status IN ('CANCELLED','ARCHIVED') AND updated_at < ?
     ORDER BY updated_at ASC`).all(cutoff);
}
