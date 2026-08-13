import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  encryptBytes, decryptBytes, createEncryptedBackup, restoreEncryptedBackup, pruneBackups,
  verifyEncryptedBackup,
} from '../cos/backup.js'

// §C DoD: backups are ENCRYPTED, a restore round-trips byte-for-byte (the
// restore-test), and old backups are pruned to the retention window.

const PASS = 'correct horse battery staple'

describe('encrypted backup', () => {
  it('encrypts + decrypts a byte buffer (round-trip)', () => {
    const plain = Buffer.from('the quick brown fox \x00\x01\x02', 'binary')
    const blob = encryptBytes(plain, PASS)
    expect(blob.subarray(0, 8).toString('ascii')).toBe('COSBAK01')
    expect(blob.equals(plain)).toBe(false) // actually encrypted, not stored plain
    expect(decryptBytes(blob, PASS).equals(plain)).toBe(true)
  })

  // CHANGED 2026-08-13 (E3). This asserted a byte-for-byte round trip of a file
  // that was not even a database ('SQLite format 3' + 500 x's). That is a test of
  // AES-GCM, not of the backup: it passed just as happily when the thing being
  // encrypted was a WAL-mode .db file missing every uncheckpointed commit. The
  // restore test now OPENS the result and asks SQLite whether it is a database.
  it('the RESTORE-TEST: the backup opens as a database and passes integrity_check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'))
    const dbPath = join(dir, 'claudeclaw.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE personal_cases (case_id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO personal_cases VALUES (?)').run('c1')

    const { path } = createEncryptedBackup({ dbPath, destDir: dir, passphrase: PASS, now: 1000 })
    const v = verifyEncryptedBackup({ encPath: path, passphrase: PASS, probeDir: dir })
    expect(v.integrity).toBe('ok')
    expect(v.ok).toBe(true)
    expect(v.cases).toBe(1)
    db.close()
    // and the plaintext snapshot the backup was taken from does not survive
    expect(readdirSync(dir).filter(n => n.startsWith('.snapshot-'))).toEqual([])
  })

  // E3 HEADLINE. The store runs in WAL mode, so a committed row lives in the
  // -wal sidecar until a checkpoint. readFileSync() of the .db copied a database
  // that did not contain it — silently, and the byte-for-byte restore test above
  // could never notice.
  it('E3: a commit that is still in the WAL survives the backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'))
    const dbPath = join(dir, 'claudeclaw.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE personal_cases (case_id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO personal_cases VALUES (?)').run('committed-but-not-checkpointed')
    // deliberately NOT closed and NOT checkpointed — the live-store situation

    const { path } = createEncryptedBackup({ dbPath, destDir: dir, passphrase: PASS, now: 2000 })
    const v = verifyEncryptedBackup({ encPath: path, passphrase: PASS, probeDir: dir })
    expect(v.ok).toBe(true)
    expect(v.cases).toBe(1) // <-- the raw-copy backup restored ZERO here
    db.close()
  })

  it('E3: a corrupt backup FAILS the restore test instead of round-tripping happily', () => {
    // The control the byte-for-byte test could not provide: garbage encrypts and
    // decrypts perfectly, and is still not a database.
    const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'))
    const enc = join(dir, 'backup-3000.db.enc')
    writeFileSync(enc, encryptBytes(Buffer.from('SQLite format 3\x00' + 'x'.repeat(500)), PASS))
    const v = verifyEncryptedBackup({ encPath: enc, passphrase: PASS, probeDir: dir })
    expect(v.ok).toBe(false)
  })

  it('a wrong passphrase fails to decrypt (integrity/auth check)', () => {
    const blob = encryptBytes(Buffer.from('secret'), PASS)
    expect(() => decryptBytes(blob, 'wrong pass')).toThrow()
  })

  it('a corrupted blob is rejected (GCM tag mismatch)', () => {
    const blob = encryptBytes(Buffer.from('secret'), PASS)
    blob[blob.length - 1] ^= 0xff // flip a ciphertext bit
    expect(() => decryptBytes(blob, PASS)).toThrow()
  })

  it('a non-backup blob is rejected by magic', () => {
    expect(() => decryptBytes(Buffer.from('not a backup at all........'), PASS)).toThrow(/magic|short/)
  })

  it('pruneBackups deletes files older than the retention window, keeps recent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'))
    const now = 100 * 86400
    // CHANGED 2026-08-13 (E15): the age is the timestamp IN THE NAME, so the
    // fixture names the files by their real ages instead of back-dating mtimes.
    const oldF = join(dir, `backup-${now - 40 * 86400}.db.enc`); writeFileSync(oldF, 'old')
    const newF = join(dir, `backup-${now - 1 * 86400}.db.enc`); writeFileSync(newF, 'new')
    const other = join(dir, 'notes.txt'); writeFileSync(other, 'keep me') // not a backup file
    const r = pruneBackups({ destDir: dir, retentionDays: 30, now })
    expect(r.deleted).toEqual([`backup-${now - 40 * 86400}.db.enc`])
    expect(r.kept).toEqual([`backup-${now - 1 * 86400}.db.enc`])
    // the non-backup file is untouched
    expect(readdirSync(dir)).toContain('notes.txt')
    expect(readFileSync(other, 'utf8')).toBe('keep me')
  })

  // E15 (review 2026-08-13). Ageing by mtime made the retention window a
  // property of the COPY, not of the data: restoring an archive, rsyncing to a
  // new disk or a stray `touch` restarted the clock and sensitive ciphertext
  // outlived the policy — quietly, because the files then look freshly pruned.
  it('E15: a touched backup does not escape the retention window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'))
    const now = 100 * 86400
    const stale = join(dir, `backup-${now - 40 * 86400}.db.enc`)
    writeFileSync(stale, 'old ciphertext')
    utimesSync(stale, now, now) // copied/restored yesterday → mtime says "brand new"
    const r = pruneBackups({ destDir: dir, retentionDays: 30, now })
    expect(r.deleted).toEqual([`backup-${now - 40 * 86400}.db.enc`])
    expect(readdirSync(dir)).toEqual([])
  })
})
