import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { addAttachment, verifyAttachment, sha256Hex } from '../cos/attachments.js'
import { purgeExpiredAttachmentContent, deletedCasesEligibleForPurge, RETENTION } from '../cos/retention.js'

// §12 item 19 (attachment checksum readback) + §C retention.

const NOW = 1_000_000

describe('case attachments — checksum readback (§12.19)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW)
  })

  it('stores an attachment with its sha256 and verifies OK', () => {
    const db = getDb()
    const content = Buffer.from('invoice pdf bytes')
    const { checksum } = addAttachment(db, { attachmentId: 'a1', caseId: 'c1', content, filename: 'inv.pdf' }, NOW)
    expect(checksum).toBe(sha256Hex(content))
    const v = verifyAttachment(db, 'a1')
    expect(v.integrity).toBe('OK')
    expect(v.computedChecksum).toBe(v.storedChecksum)
  })

  it('a silently corrupted attachment is caught by the readback (CORRUPT)', () => {
    const db = getDb()
    addAttachment(db, { attachmentId: 'a1', caseId: 'c1', content: Buffer.from('good') }, NOW)
    db.prepare(`UPDATE case_attachments SET content=? WHERE attachment_id='a1'`).run(Buffer.from('TAMPERED'))
    const v = verifyAttachment(db, 'a1')
    expect(v.integrity).toBe('CORRUPT')
    expect(v.computedChecksum).not.toBe(v.storedChecksum)
  })

  it('an unknown attachment → NOT_FOUND', () => {
    expect(verifyAttachment(getDb(), 'nope').integrity).toBe('NOT_FOUND')
  })
})

describe('§C retention', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW)
  })

  it('the policy is defined', () => {
    expect(RETENTION.attachmentContentDays).toBeGreaterThan(0)
    expect(RETENTION.deletedCaseDays).toBeGreaterThan(0)
    expect(RETENTION.backupDays).toBeGreaterThan(0)
  })

  it('purges attachment CONTENT past the window, keeps the checksum tombstone', () => {
    const db = getDb()
    const old = NOW - (RETENTION.attachmentContentDays + 1) * 86400
    const recent = NOW - 5 * 86400
    // seed an old and a recent attachment (created_at set explicitly)
    addAttachment(db, { attachmentId: 'old', caseId: 'c1', content: Buffer.from('old secret') }, old)
    addAttachment(db, { attachmentId: 'new', caseId: 'c1', content: Buffer.from('fresh') }, recent)
    const r = purgeExpiredAttachmentContent(db, NOW)
    expect(r.purged).toBe(1)
    // old: content gone, checksum + row remain, verify reports CONTENT_PURGED (not CORRUPT)
    const vo = verifyAttachment(db, 'old')
    expect(vo.integrity).toBe('CONTENT_PURGED')
    expect(vo.storedChecksum).toBeTruthy()
    // new: untouched
    expect(verifyAttachment(db, 'new').integrity).toBe('OK')
    // idempotent
    expect(purgeExpiredAttachmentContent(db, NOW).purged).toBe(0)
  })

  it('lists deleted (CANCELLED/ARCHIVED) cases past the window; skips recent + active', () => {
    const db = getDb()
    createCase(db, { caseId: 'oldArchived', title: 'a', caseType: 'X' }, NOW)
    createCase(db, { caseId: 'recentCancelled', title: 'b', caseType: 'X' }, NOW)
    const longAgo = NOW - (RETENTION.deletedCaseDays + 10) * 86400
    // move oldArchived to ARCHIVED long ago, recentCancelled to CANCELLED just now
    transitionCase(db, { caseId: 'oldArchived', seenVersion: 1, newStatus: 'ARCHIVED', actor: 'm' }, longAgo)
    transitionCase(db, { caseId: 'recentCancelled', seenVersion: 1, newStatus: 'CANCELLED', actor: 'm' }, NOW)
    const eligible = deletedCasesEligibleForPurge(db, NOW).map(c => c.case_id)
    expect(eligible).toContain('oldArchived')
    expect(eligible).not.toContain('recentCancelled') // too recent
    expect(eligible).not.toContain('c1')               // still active
  })
})
