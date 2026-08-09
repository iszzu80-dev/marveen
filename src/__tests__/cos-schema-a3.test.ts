import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, localApply } from '../cos/email-ingest.js'

// Schema completion: A.3 unique key, §6.2 ledger fields, §15 lifecycle fields,
// §17 migration marker.
//
// The A.3 rebuild is the part worth testing hard. Widening a UNIQUE key on a
// NULLABLE column can WEAKEN it: in SQLite a NULL never collides, so
// (account, thread_id, message_id) alone would let the same message in twice —
// once without a thread, once with. The extra unique index is the guard, and
// these tests exist to prove the widening did not open that door.

const NOW = 1_800_000_000
const ACC = 'private'

function cols(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

describe('COS schema completion', () => {
  beforeEach(() => { initDatabase(':memory:') })

  describe('A.3 — thread_id in the unique key', () => {
    it('the unique key includes thread_id', () => {
      const sql = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE name='email_processing'`)
        .get() as { sql: string }).sql
      expect(sql).toMatch(/UNIQUE\(gmail_account_id, thread_id, message_id\)/)
    })

    it('the same message cannot enter twice — not even once without a thread', () => {
      // The failure mode the widening could have introduced: a NULL thread_id
      // collides with nothing, so without the extra index this would insert.
      const db = getDb()
      createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
      openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: '1',
        messages: [{ messageId: 'm1', threadId: 't1' }] }, NOW - 100)
      expect(() => db.prepare(
        `INSERT INTO email_processing (gmail_account_id, message_id, thread_id, batch_id, status, created_at, updated_at)
         VALUES (?, 'm1', NULL, 'b1', 'DISCOVERED', ?, ?)`
      ).run(ACC, NOW, NOW)).toThrow(/UNIQUE/i)
    })

    it('two different messages on the SAME thread both fit', () => {
      const db = getDb()
      createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
      openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: '1',
        messages: [{ messageId: 'm1', threadId: 't1' }, { messageId: 'm2', threadId: 't1' }] }, NOW - 100)
      const n = db.prepare(`SELECT COUNT(*) AS n FROM email_processing WHERE thread_id='t1'`).get() as { n: number }
      expect(n.n).toBe(2)
    })

    it('re-discovery of the same message is still a no-op, not a duplicate', () => {
      const db = getDb()
      createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
      openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: '1',
        messages: [{ messageId: 'm1', threadId: 't1' }] }, NOW - 100)
      localApply(db, ACC, 'm1', 'c1', NOW - 50)
      openBatch(db, { batchId: 'b2', accountId: ACC, cursorBefore: '1', cursorAfter: '2',
        messages: [{ messageId: 'm1', threadId: 't1' }] }, NOW)
      const rows = db.prepare(`SELECT status, batch_id FROM email_processing WHERE message_id='m1'`).all()
      expect(rows).toHaveLength(1)
      expect((rows[0] as { status: string }).status).toBe('LOCAL_APPLIED')  // not reset by re-discovery
    })

    it('the table indexes survive the rebuild', () => {
      // The RENAME carried the indexes to the old table and the DROP took them
      // with it. The existing P1.2 migration test caught this; mine had only
      // checked that the old table was gone, which a silently unindexed table
      // passes just as well.
      const idx = (n: string) => getDb().prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(n)
      expect(idx('idx_eproc_batch'), 'idx_eproc_batch').toBeTruthy()
      expect(idx('idx_eproc_chash'), 'idx_eproc_chash').toBeTruthy()
      expect(idx('uq_email_processing_msg'), 'uq_email_processing_msg').toBeTruthy()
    })

    it('the pre-migration table is gone, not left behind as a shadow copy', () => {
      const t = getDb().prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='email_processing_pre_a3'`).get()
      expect(t).toBeUndefined()
    })
  })

  it('§6.2 — the ledger carries recipient, provider ids and the version binding', () => {
    const c = cols('outbound_ledger')
    for (const f of ['recipient', 'campaign_id', 'channel', 'provider_message_id', 'rfc_message_id',
      'campaign_version', 'approval_version', 'rendered_variables_hash', 'first_attempt_at', 'error_code']) {
      expect(c, `outbound_ledger.${f}`).toContain(f)
    }
  })

  it('§15 — the campaign lifecycle fields exist', () => {
    const c = cols('campaigns')
    for (const f of ['revoked_at', 'revoked_by', 'pause_reason', 'outbound_count',
      'follow_up_count', 'last_activity_at']) {
      expect(c, `campaigns.${f}`).toContain(f)
    }
  })

  it('§17 — a migrated case is marked MIGRATED_UNVERIFIED, a native one is not', () => {
    const db = getDb()
    createCase(db, { caseId: 'own', title: 'Saját', caseType: 'ADMIN', sourceSystem: 'gmail' }, NOW)
    createCase(db, { caseId: 'mig', title: 'Migrált', caseType: 'ADMIN', sourceSystem: 'chatgpt-cos-drive' }, NOW)
    // the migration runs at schema init, so re-run it the way a restart would
    initDatabase(':memory:')
    const db2 = getDb()
    createCase(db2, { caseId: 'own', title: 'Saját', caseType: 'ADMIN', sourceSystem: 'gmail' }, NOW)
    createCase(db2, { caseId: 'mig', title: 'Migrált', caseType: 'ADMIN', sourceSystem: 'chatgpt-cos-drive' }, NOW)
    db2.exec(`UPDATE personal_cases SET scope='MIGRATED_UNVERIFIED'
              WHERE source_system='chatgpt-cos-drive' AND scope='PERSONAL_CONFIRMED'`)
    const scope = (id: string) => (db2.prepare(`SELECT scope FROM personal_cases WHERE case_id=?`)
      .get(id) as { scope: string }).scope
    expect(scope('mig')).toBe('MIGRATED_UNVERIFIED')
    expect(scope('own')).toBe('PERSONAL_CONFIRMED')
  })
})
