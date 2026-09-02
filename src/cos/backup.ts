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

// ── W14 / §8.2: the POLICY half of the backup ───────────────────────────────
//
// The audit measured what the daily backup covers: the database, and nothing
// else. Everything this system DECIDES with that is not in SQLite sits in
// `store/*.json` — the autonomy levels, the egress allowlist, which secret is
// bound to which MCP server, the source-commit policy. A restore from a current
// backup would produce a store with every case and none of the operator's
// rules, including a security control.
//
// TWO LISTS AND A RULE, rather than one list:
//
//   POLICY_FILES     what is backed up, declared by name so the set is auditable
//   SECRET_FILES     what is deliberately NOT backed up (§8.2: "Secret backup
//                    külön security policy szerint"), also declared by name so
//                    the exclusion is a decision on the record and not an
//                    oversight
//   isRuntimeState() the pattern for files that are recomputable and belong in
//                    neither list
//
// And the manifest reports anything in `store/` that matches NONE of the three
// as UNCLASSIFIED. That is the part that keeps this honest: a new policy file
// added next month does not silently fall outside the backup — it shows up as
// unclassified in every run until somebody decides which list it belongs to.

/** Operator-authored decisions. Losing one silently changes behaviour. */
export const POLICY_FILES: readonly string[] = [
  'autonomy-config.json',            // what may act without asking
  'egress-allowlist.json',           // a security control
  'cos-source-commit-policy.json',   // may the cursor advance without a source write
  'config-overrides.json',           // dashboard settings that survive a restart
  'capacity-routing-config.json',    // which model takes over when a quota ends
  'data-sensitivity-gate.json',      // which models may see which data
  'provider-trust-map.json',
  'model-profile-map.json',
  'optimization-config.json',
  'vault-bindings.json',             // WHICH secret goes WHERE — ids only, no values
  'costops-config.json', 'costops-collectors.json', 'costops-domains.json',
  'costops-pricing.json', 'costops-render-pricing.json', 'costops-fx.json',
  'billing-map.json',
  'auto-restart.json',
  // Classified 2026-09-02. Both are operator-authored and behaviour-defining:
  // which agents the fleet is supposed to be running, and which model each of
  // them runs on. A restore without them brings back a fleet that is the wrong
  // shape, on the wrong models, silently.
  'agents-desired.json',
  'runtime-model-overlay.json',
]

/** Deliberately excluded: these ARE the secrets, and §8.2 puts them under a
 *  separate policy. Named here so the absence is visible in the manifest rather
 *  than looking like a file nobody thought about.
 *
 *  The connector credentials below were UNCLASSIFIED until 2026-09-02. That was
 *  not merely untidy: unclassified and excluded-secret produce the same backup
 *  content, so the manifest could not distinguish "we decided not to back this
 *  up" from "nobody looked at it". The owner's instruction was explicit —
 *  a credential's sensitivity must be stated even when the file is encrypted at
 *  rest, and it must not stay UNKNOWN by omission. */
export const SECRET_FILES: readonly string[] = [
  'vault.json', '.vault-key', '.dashboard-token', '.claude-oauth-token',
  'test-user-creds.json',
  // Connector / provider credentials (classified 2026-09-02).
  '.google-private-client.json', '.google-private-creds.json',
  '.google-zst-client.json', '.google-zst-creds.json',
  '.google-tasks-creds.json',
  '.cos-telegram-bot.json', '.cos-radar-bot.json',
  '.nav-test-credentials.json', '.nav-test-credentials-mgmt.json',
  '.barion-eskuvo-sandbox.json',
  '.twilio-handover.json',   // carries TWILIO_AUTH_TOKEN
  '.github-token', '.deepseek-key',
]

/** Recomputable runtime state: a restore does not need it and a backup of it
 *  would age badly. */
export function isRuntimeState(name: string): boolean {
  return /-state\.json$/.test(name)
    || /^schedule-/.test(name)
    || /^fleet-/.test(name)
    || /^context-guard-/.test(name)
    || /^session-/.test(name)
    || /^terminal-/.test(name)
    || /snapshot/.test(name)
    || /^command-task-health\.json$/.test(name)
    // Watermarks for the PR-comment watcher: a seen-list and a per-PR
    // last-seen id. Both are rebuilt by the next poll, so a backup of them
    // would restore a stale position rather than a useful one.
    || /^\.pr-comment-/.test(name)
}

/** Files whose CONTENT is a credential, for the permission control to check.
 *
 *  This is deliberately a PATTERN and not the hand-written list the maintenance
 *  script used to carry. That list named four paths — the database, the store
 *  directory, the dashboard token and the backup directory — and reported
 *  "checked 4, fixed []" while `.vault-key` sat at mode 0664. A security control
 *  whose coverage is a literal list is only as good as the last person who
 *  remembered to extend it, and the same file's own E17 comment already says
 *  what that failure looks like: success reported for something never examined.
 *
 *  Everything in SECRET_FILES is covered by name; the pattern catches the next
 *  credential to be dropped into the store before anybody classifies it. */
export function looksLikeCredentialFile(name: string): boolean {
  if ((SECRET_FILES as readonly string[]).includes(name)) return true
  return /(^|[.\-_])(creds?|credentials?|secret|token|key|vault|oauth)([.\-_]|$)/i.test(name)
    || /-bot\.json$/.test(name)
}

export type PolicyFileStatus = 'BACKED_UP' | 'MISSING' | 'EXCLUDED_SECRET' | 'RUNTIME_STATE' | 'UNCLASSIFIED'

export interface PolicyManifestEntry { name: string; status: PolicyFileStatus; bytes?: number }

export interface PolicyBackupResult {
  path: string
  bytes: number
  manifest: PolicyManifestEntry[]
  /** Files in store/ that no rule covers. Non-empty is not a failure — it is a
   *  question for the operator, and it is asked on every run until answered. */
  unclassified: string[]
}

interface PolicyBundle {
  createdAt: number
  files: Record<string, string>
  manifest: PolicyManifestEntry[]
}

/**
 * Encrypt the policy set into `policy-<timestamp>.json.enc` beside the database
 * backup, with the same crypto and the same retention.
 *
 * The bundle carries the MANIFEST as well as the contents, so a restore can say
 * what was expected and not found — a policy file that was already missing when
 * the backup ran must not look identical to one that restored correctly.
 */
export function createPolicyBackup(
  args: { storeDir: string; destDir: string; passphrase: string; now: number },
): PolicyBackupResult {
  const files: Record<string, string> = {}
  const manifest: PolicyManifestEntry[] = []

  for (const name of POLICY_FILES) {
    const full = join(args.storeDir, name)
    if (!existsSync(full)) { manifest.push({ name, status: 'MISSING' }); continue }
    const content = readFileSync(full, 'utf-8')
    files[name] = content
    manifest.push({ name, status: 'BACKED_UP', bytes: content.length })
  }
  for (const name of SECRET_FILES) {
    if (existsSync(join(args.storeDir, name))) manifest.push({ name, status: 'EXCLUDED_SECRET' })
  }

  const declared = new Set([...POLICY_FILES, ...SECRET_FILES])
  const unclassified: string[] = []
  for (const name of readdirSync(args.storeDir)) {
    if (!name.endsWith('.json')) continue
    if (declared.has(name)) continue
    if (isRuntimeState(name)) { manifest.push({ name, status: 'RUNTIME_STATE' }); continue }
    if (name.endsWith('.example')) continue
    manifest.push({ name, status: 'UNCLASSIFIED' })
    unclassified.push(name)
  }

  const bundle: PolicyBundle = { createdAt: args.now, files, manifest }
  const blob = encryptBytes(Buffer.from(JSON.stringify(bundle), 'utf-8'), args.passphrase)
  const path = join(args.destDir, `policy-${args.now}.json.enc`)
  writeFileSync(path, blob, { mode: 0o600 })
  return { path, bytes: blob.length, manifest, unclassified }
}

export interface PolicyVerification {
  ok: boolean
  restoredFiles: string[]
  /** Declared policy files the bundle does not carry. */
  missing: string[]
  unclassified: string[]
  problem?: string
}

/** The restore test for the policy half: decrypt, parse, and check that every
 *  file the manifest calls BACKED_UP is actually in the bundle AND parses as
 *  JSON. A bundle that decrypts to truncated or corrupt content would otherwise
 *  pass exactly as a good one does. */
export function verifyPolicyBackup(args: { encPath: string; passphrase: string }): PolicyVerification {
  try {
    const bundle = JSON.parse(decryptBytes(readFileSync(args.encPath), args.passphrase).toString('utf-8')) as PolicyBundle
    const restoredFiles = Object.keys(bundle.files ?? {})
    const missing: string[] = []
    for (const entry of bundle.manifest ?? []) {
      if (entry.status !== 'BACKED_UP') continue
      const content = bundle.files?.[entry.name]
      if (content === undefined) { missing.push(entry.name); continue }
      try { JSON.parse(content) } catch { missing.push(entry.name + ' (unparseable)') }
    }
    const unclassified = (bundle.manifest ?? []).filter(e => e.status === 'UNCLASSIFIED').map(e => e.name)
    return { ok: missing.length === 0 && restoredFiles.length > 0, restoredFiles, missing, unclassified }
  } catch (e) {
    return { ok: false, restoredFiles: [], missing: [], unclassified: [], problem: String((e as Error)?.message ?? e) }
  }
}

/** Write the policy bundle back onto disk. Used by a restore drill; refuses to
 *  touch anything the bundle does not carry. */
export function restorePolicyBackup(
  args: { encPath: string; passphrase: string; targetDir: string },
): { written: string[] } {
  const bundle = JSON.parse(decryptBytes(readFileSync(args.encPath), args.passphrase).toString('utf-8')) as PolicyBundle
  const written: string[] = []
  for (const [name, content] of Object.entries(bundle.files ?? {})) {
    writeFileSync(join(args.targetDir, name), content, { mode: 0o600 })
    written.push(name)
  }
  return { written }
}

/** Prune the policy bundles on the same window as the database backups. Same
 *  filename-timestamp rule, and for the same reason: mtime is a property of the
 *  copy, not of the contents. */
export function prunePolicyBackups(
  args: { destDir: string; retentionDays?: number; now: number },
): PruneResult {
  const retentionDays = args.retentionDays ?? BACKUP_RETENTION_DAYS
  const cutoff = args.now - retentionDays * 86400
  const deleted: string[] = []
  const kept: string[] = []
  for (const name of readdirSync(args.destDir)) {
    const m = /^policy-(\d+)\.json\.enc$/.exec(name)
    if (!m) continue
    const full = join(args.destDir, name)
    if (Number(m[1]) < cutoff) { unlinkSync(full); deleted.push(name) }
    else kept.push(name)
  }
  return { deleted, kept }
}
