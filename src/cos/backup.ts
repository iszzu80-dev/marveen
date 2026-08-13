// Personal Chief of Staff (COS) — encrypted backup + retention (spec §C DoD).
//
// §C requires: backup encrypted, backup retention defined, and a regular
// restore-test. This module provides all three as pure functions over the
// filesystem + node crypto (no external deps):
//   - createEncryptedBackup: AES-256-GCM the DB file, key derived from a
//     passphrase via scrypt, salt + iv + tag stored in the file header.
//   - restoreEncryptedBackup: decrypt back to the original bytes (the restore-
//     test asserts a round-trip byte-for-byte, so a silently-corrupt backup is
//     caught, not discovered at disaster time).
//   - pruneBackups: enforce the retention window (delete backups older than N
//     days), so backups do not accumulate sensitive copies forever.
//
// The passphrase is supplied by the caller (never stored here or logged); losing
// it makes a backup unrecoverable by design.

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const MAGIC = Buffer.from('COSBAK01', 'ascii') // 8 bytes: format tag
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/** Retention default: keep encrypted backups for 30 days, then prune. */
export const BACKUP_RETENTION_DAYS = 30

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN)
}

/** Encrypt raw bytes → a self-describing blob: MAGIC | salt | iv | tag | ciphertext. */
export function encryptBytes(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, salt, iv, tag, ct])
}

/** Decrypt a blob produced by encryptBytes. Throws if the passphrase is wrong or
 *  the blob is corrupt (GCM auth tag mismatch) — that IS the integrity check. */
export function decryptBytes(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('backup blob too short / not a COS backup')
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad backup magic (not a COS backup)')
  let o = MAGIC.length
  const salt = blob.subarray(o, o += SALT_LEN)
  const iv = blob.subarray(o, o += IV_LEN)
  const tag = blob.subarray(o, o += TAG_LEN)
  const ct = blob.subarray(o)
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export interface BackupResult { path: string; bytes: number }

/**
 * Snapshot the DB, encrypt the snapshot, and write backup-<timestamp>.db.enc
 * into destDir.
 *
 * E3 (review 2026-08-13). This used to be `readFileSync(dbPath)`. The store runs
 * in WAL mode (db.ts sets journal_mode=WAL), and in WAL mode the .db file is NOT
 * the database: committed transactions live in the -wal sidecar until a
 * checkpoint folds them in. So a raw byte copy silently omitted every commit
 * since the last checkpoint, and a concurrent writer could tear the copy
 * mid-page. The backup still decrypted byte-for-byte, which is what the restore
 * test asserted — a backup can be perfectly round-tripping and not be a database.
 *
 * `VACUUM INTO` is SQLite's own answer: it produces a transactionally consistent
 * copy of the whole database (WAL included) into a new file, from a READ-ONLY
 * connection, without blocking writers. The snapshot is deleted afterwards —
 * plaintext store bytes must not survive next to the ciphertext they exist to
 * protect.
 *
 * `now` (unix seconds) names the file deterministically — pass it in (the schema
 * policy forbids Date.now() in library code paths that must be reproducible).
 */
export function createEncryptedBackup(
  args: { dbPath: string; destDir: string; passphrase: string; now: number },
): BackupResult {
  // Beside the backup, not in tmpdir: on this box /tmp is a tmpfs smaller than
  // the store, and the maintenance script already learned that the hard way.
  const snapshot = join(args.destDir, `.snapshot-${args.now}-${randomBytes(4).toString('hex')}.db`)
  try {
    const src = new Database(args.dbPath, { readonly: true })
    try {
      src.prepare('VACUUM INTO ?').run(snapshot)
    } finally {
      src.close()
    }
    const blob = encryptBytes(readFileSync(snapshot), args.passphrase)
    const path = join(args.destDir, `backup-${args.now}.db.enc`)
    writeFileSync(path, blob, { mode: 0o600 })
    return { path, bytes: blob.length }
  } finally {
    // The plaintext snapshot is the most sensitive file this module ever
    // creates. It goes whether the encryption succeeded or threw.
    try { if (existsSync(snapshot)) unlinkSync(snapshot) } catch { /* best effort */ }
  }
}

/** Decrypt a backup file back to the original bytes. Callers can write them to a
 *  temp DB and open it to complete a full restore-test — or call
 *  verifyEncryptedBackup, which does exactly that. */
export function restoreEncryptedBackup(args: { encPath: string; passphrase: string }): Buffer {
  return decryptBytes(readFileSync(args.encPath), args.passphrase)
}

export interface BackupVerification {
  ok: boolean
  bytes: number
  /** SQLite's own verdict, verbatim. 'ok' is the only passing value. */
  integrity: string
  /** Rows in personal_cases, when the table is there — a backup that opens
   *  cleanly and holds no cases is not proof of anything. */
  cases: number | null
  problem?: string
}

/**
 * The restore-test §C actually asks for: decrypt the backup, OPEN IT AS A
 * DATABASE, and let SQLite check it.
 *
 * E3. The old verification compared the decrypted bytes with the source bytes
 * and stopped there. That proves the encryption round-trips; it says nothing
 * about whether the thing encrypted was a usable database — which is exactly
 * what the WAL-mode raw copy above got wrong. A restore test that cannot fail on
 * a torn or WAL-truncated snapshot is not a restore test.
 *
 * The probe file is written next to the backup and deleted in `finally`.
 */
export function verifyEncryptedBackup(
  args: { encPath: string; passphrase: string; probeDir?: string },
): BackupVerification {
  const bytes = restoreEncryptedBackup(args)
  const probe = join(args.probeDir ?? '.', `.restore-probe-${randomBytes(6).toString('hex')}.db`)
  try {
    writeFileSync(probe, bytes, { mode: 0o600 })
    const db = new Database(probe, { readonly: true })
    try {
      const integrity = String((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check ?? 'unknown')
      let cases: number | null = null
      try {
        cases = (db.prepare('SELECT COUNT(*) AS n FROM personal_cases').get() as { n: number }).n
      } catch {
        // A backup of a store without the COS schema is still a valid database;
        // the caller decides whether a missing table matters to it.
        cases = null
      }
      return { ok: integrity === 'ok', bytes: bytes.length, integrity, cases }
    } finally {
      db.close()
    }
  } catch (e) {
    return { ok: false, bytes: bytes.length, integrity: 'unreadable', cases: null, problem: String((e as Error)?.message ?? e) }
  } finally {
    try { if (existsSync(probe)) unlinkSync(probe) } catch { /* best effort */ }
  }
}

export interface PruneResult { deleted: string[]; kept: string[] }

/**
 * Delete backup-*.db.enc files older than the retention window. `now` in unix
 * seconds.
 *
 * E15 (review 2026-08-13). The age comes from the TIMESTAMP IN THE FILENAME,
 * which createEncryptedBackup writes and which is the moment the data in the
 * file is from. It used to come from `statSync().mtimeMs`, and mtime is a
 * property of the copy, not of the contents: restoring a backup archive,
 * rsyncing it to a new disk or a stray `touch` reset every file's clock and the
 * retention window silently restarted. The failure mode is sensitive ciphertext
 * outliving the policy that was supposed to delete it — quietly, because the
 * files still look freshly pruned.
 */
export function pruneBackups(
  args: { destDir: string; retentionDays?: number; now: number },
): PruneResult {
  const retentionDays = args.retentionDays ?? BACKUP_RETENTION_DAYS
  const cutoff = args.now - retentionDays * 86400
  const deleted: string[] = []
  const kept: string[] = []
  for (const name of readdirSync(args.destDir)) {
    const m = /^backup-(\d+)\.db\.enc$/.exec(name)
    if (!m) continue
    const full = join(args.destDir, name)
    if (Number(m[1]) < cutoff) { unlinkSync(full); deleted.push(name) }
    else kept.push(name)
  }
  return { deleted, kept }
}
