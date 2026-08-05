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
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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

/** Read the DB file, encrypt it, and write backup-<timestamp>.db.enc into destDir.
 *  `now` (unix seconds) names the file deterministically — pass it in (the schema
 *  policy forbids Date.now() in library code paths that must be reproducible). */
export function createEncryptedBackup(
  args: { dbPath: string; destDir: string; passphrase: string; now: number },
): BackupResult {
  const plain = readFileSync(args.dbPath)
  const blob = encryptBytes(plain, args.passphrase)
  const path = join(args.destDir, `backup-${args.now}.db.enc`)
  writeFileSync(path, blob, { mode: 0o600 })
  return { path, bytes: blob.length }
}

/** Decrypt a backup file back to the original bytes. Callers can write them to a
 *  temp DB and open it to complete a full restore-test. */
export function restoreEncryptedBackup(args: { encPath: string; passphrase: string }): Buffer {
  return decryptBytes(readFileSync(args.encPath), args.passphrase)
}

export interface PruneResult { deleted: string[]; kept: string[] }

/** Delete backup-*.db.enc files older than the retention window. `now` in unix
 *  seconds; a file's age is taken from its mtime. */
export function pruneBackups(
  args: { destDir: string; retentionDays?: number; now: number },
): PruneResult {
  const retentionDays = args.retentionDays ?? BACKUP_RETENTION_DAYS
  const cutoff = args.now - retentionDays * 86400
  const deleted: string[] = []
  const kept: string[] = []
  for (const name of readdirSync(args.destDir)) {
    if (!/^backup-\d+\.db\.enc$/.test(name)) continue
    const full = join(args.destDir, name)
    const mtime = Math.floor(statSync(full).mtimeMs / 1000)
    if (mtime < cutoff) { unlinkSync(full); deleted.push(name) }
    else kept.push(name)
  }
  return { deleted, kept }
}
