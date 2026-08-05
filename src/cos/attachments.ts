// Personal Chief of Staff (COS) — case attachments with checksum readback
// (spec §12 item 19).
//
// An attachment's bytes are stored with a sha256 checksum. verifyAttachment
// recomputes the checksum from the stored content and compares — so a silently
// corrupted (or truncated) attachment is caught by a readback, not trusted
// blindly. After the retention window the content is purged (see retention.ts)
// but the checksum stays as a tombstone, so verify still reports the correct
// "content purged" state instead of a false OK.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface NewAttachment {
  attachmentId: string
  caseId?: string | null
  messageId?: string | null
  filename?: string | null
  mimeType?: string | null
  sensitivity?: 'PUBLIC' | 'PERSONAL' | 'SENSITIVE_PERSONAL' | 'HIGHLY_SENSITIVE'
  content: Buffer
}

/** Store an attachment, computing + persisting its checksum and byte size. */
export function addAttachment(db: Database.Database, a: NewAttachment, now: number): { checksum: string } {
  const checksum = sha256Hex(a.content)
  db.prepare(
    `INSERT INTO case_attachments
       (attachment_id, case_id, message_id, filename, mime_type, byte_size, checksum, sensitivity, content, created_at, updated_at)
     VALUES (@id, @caseId, @messageId, @filename, @mimeType, @size, @checksum, @sensitivity, @content, @now, @now)`
  ).run({
    id: a.attachmentId, caseId: a.caseId ?? null, messageId: a.messageId ?? null,
    filename: a.filename ?? null, mimeType: a.mimeType ?? null, size: a.content.length,
    checksum, sensitivity: a.sensitivity ?? 'SENSITIVE_PERSONAL', content: a.content, now,
  })
  return { checksum }
}

export type AttachmentIntegrity = 'OK' | 'CORRUPT' | 'CONTENT_PURGED' | 'NOT_FOUND'

export interface VerifyResult {
  integrity: AttachmentIntegrity
  storedChecksum: string | null
  computedChecksum: string | null
}

/** Readback integrity check: recompute the checksum of the stored content and
 *  compare to what was recorded. CONTENT_PURGED (retention) is distinguished from
 *  CORRUPT (checksum mismatch) — a purged attachment is not a failure. */
export function verifyAttachment(db: Database.Database, attachmentId: string): VerifyResult {
  const row = db.prepare(
    `SELECT checksum, content, content_purged_at FROM case_attachments WHERE attachment_id = ?`
  ).get(attachmentId) as { checksum: string; content: Buffer | null; content_purged_at: number | null } | undefined
  if (!row) return { integrity: 'NOT_FOUND', storedChecksum: null, computedChecksum: null }
  if (row.content == null) {
    return { integrity: 'CONTENT_PURGED', storedChecksum: row.checksum, computedChecksum: null }
  }
  const computed = sha256Hex(row.content)
  return {
    integrity: computed === row.checksum ? 'OK' : 'CORRUPT',
    storedChecksum: row.checksum, computedChecksum: computed,
  }
}
