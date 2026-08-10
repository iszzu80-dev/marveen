#!/usr/bin/env npx tsx
/**
 * COS §C maintenance — store permissions, retention purge, encrypted backup,
 * prune, and a real restore test.
 *
 * Why this file exists (review 2026-08-10, medium-term item 9). §C's seven
 * requirements had four libraries and ZERO callers:
 *   - assertStorePermissions       — the store's permissions were never checked
 *   - createEncryptedBackup        — an encrypted backup had never been made
 *   - pruneBackups                 — no retention window was ever enforced
 *   - purgeExpiredAttachmentContent— sensitive attachment bytes lived forever
 * §25's DoD item (10) "there is a rollback and operations plan" depends on all
 * of it: without a backup there is no rollback.
 *
 * DETERMINISTIC ON PURPOSE. This is a script, not a prompt (F-17): every step
 * is a rule, none of it is a judgement, and a scheduled LLM turn that forgets to
 * run one of them is indistinguishable from one that ran it and found nothing.
 *
 * FAILS LOUD. No passphrase means no backup, and no backup means the run is a
 * failure, not a quiet skip — a maintenance job that reports success while
 * silently doing nothing is worse than no job at all, because it also removes
 * the suspicion that would have caught it.
 *
 * Exit code 1 on any failure so a scheduler can tell.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getDb, initDatabase } from '../src/db.js'
import { assertStorePermissions, anyTooOpen } from '../src/cos/store-security.js'
import { createEncryptedBackup, pruneBackups, restoreEncryptedBackup } from '../src/cos/backup.js'
import { purgeExpiredAttachmentContent, deletedCasesEligibleForPurge } from '../src/cos/retention.js'

const DB_PATH = process.env.MARVEEN_DB ?? 'store/claudeclaw.db'
const BACKUP_DIR = process.env.COS_BACKUP_DIR ?? 'store/backups'
const now = Math.floor(Date.now() / 1000)
const problems: string[] = []
const report: Record<string, unknown> = { at: new Date(now * 1000).toISOString() }

// ── 1. store permissions ────────────────────────────────────────────────────
// enforce:true — finding a world-readable case store and leaving it that way
// would make this a report rather than a control.
const perms = assertStorePermissions([
  { path: DB_PATH, kind: 'file' },
  { path: 'store', kind: 'dir' },
  { path: 'store/.dashboard-token', kind: 'file' },
  { path: BACKUP_DIR, kind: 'dir' },
], { enforce: true })
report.permissions = { checked: perms.length, fixed: perms.filter(p => p.fixed).map(p => p.path) }
if (anyTooOpen(perms)) problems.push(`still over-open after enforcement: ${perms.filter(p => p.tooOpen).map(p => p.path).join(', ')}`)

// ── 2. retention purge ──────────────────────────────────────────────────────
initDatabase(DB_PATH)
const db = getDb()
try {
  const purged = purgeExpiredAttachmentContent(db, now)
  const deletable = deletedCasesEligibleForPurge(db, now)
  report.retention = { attachmentContent: purged, deletedCasesEligible: deletable.length }
} catch (e) {
  problems.push(`retention: ${String((e as Error)?.message ?? e)}`)
}

// ── 3. encrypted backup + prune + RESTORE TEST ──────────────────────────────
// The restore test is the point. §C asks for a "regular restore test", and a
// backup nobody has ever restored is a belief, not a backup: the decrypted
// bytes are written to a temp file and OPENED as a database, so a corrupt or
// truncated backup fails here rather than on the day it is needed.
const passphrase = process.env.COS_BACKUP_PASSPHRASE ?? await readVaultPassphrase()
if (!passphrase) {
  problems.push('no backup passphrase (COS_BACKUP_PASSPHRASE, or COS_BACKUP_PASSPHRASE in the vault) — NO BACKUP WAS MADE')
} else {
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
    const made = createEncryptedBackup({ dbPath: DB_PATH, destDir: BACKUP_DIR, passphrase, now })
    const pruned = pruneBackups({ destDir: BACKUP_DIR, now })

    const bytes = restoreEncryptedBackup({ encPath: made.path, passphrase })
    // The probe is written NEXT TO THE BACKUP, not in tmpdir. On this box /tmp is
    // a 5.4 GB tmpfs and the store is 165 MB, so a probe there plus the backup
    // itself filled it and the run died with ENOSPC — found by running this
    // against a copy of the live store. Deleted in the finally either way.
    const probe = join(BACKUP_DIR, `.restore-probe-${now}.db`)
    writeFileSync(probe, bytes, { mode: 0o600 })
    let rows = 0
    try {
      const t = new Database(probe, { readonly: true })
      rows = (t.prepare('SELECT COUNT(*) AS n FROM personal_cases').get() as { n: number }).n
      t.close()
    } finally { try { unlinkSync(probe) } catch { /* best effort */ } }

    report.backup = { path: made.path, bytes: made.bytes, pruned: pruned.deleted.length, kept: pruned.kept.length, restoredCases: rows }
    // A backup that decrypts to an openable database with no cases in it is not
    // proof of anything when the live store has cases.
    const live = (db.prepare('SELECT COUNT(*) AS n FROM personal_cases').get() as { n: number }).n
    if (rows !== live) problems.push(`restore test: backup holds ${rows} cases, live store has ${live}`)
  } catch (e) {
    problems.push(`backup/restore: ${String((e as Error)?.message ?? e)}`)
  }
}

report.problems = problems
console.log(JSON.stringify(report, null, 1))
process.exit(problems.length ? 1 : 0)

async function readVaultPassphrase(): Promise<string | null> {
  try {
    // Dynamic import, not require(). This file runs as ESM under tsx, where
    // require() is not defined — so the first version threw on the very first
    // line, the catch swallowed it, and the script reported "no passphrase
    // configured" while the secret sat in the vault the whole time. Exactly the
    // silent-fallback shape this script's own header warns about, written by me
    // three hours earlier. Found by putting the real key in and watching it
    // still say no.
    //
    // Imported lazily on purpose: a missing vault must still produce the clean
    // "no passphrase" failure below rather than a stack trace at import time.
    const { getSecret } = await import('../src/web/vault.js') as { getSecret: (id: string) => string | null }
    return getSecret('COS_BACKUP_PASSPHRASE')
  } catch (e) {
    // Say WHY. "No passphrase" and "the vault could not be read" are different
    // facts, and the difference decides whether the fix is a key or a bug.
    problems.push(`vault unreadable: ${String((e as Error)?.message ?? e)}`)
    return null
  }
}
