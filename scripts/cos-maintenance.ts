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
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDb, initDatabase } from '../src/db.js'
import { assertStorePermissions, anyTooOpen, missingPaths } from '../src/cos/store-security.js'
import {
  createEncryptedBackup, pruneBackups, verifyEncryptedBackup,
  createPolicyBackup, prunePolicyBackups, verifyPolicyBackup,
} from '../src/cos/backup.js'
import {
  purgeExpiredAttachmentContent, deletedCasesEligibleForPurge, purgeExpiredEvidencePackets,
} from '../src/cos/retention.js'

const DB_PATH = process.env.MARVEEN_DB ?? 'store/claudeclaw.db'
/** Where the policy files live. Derived from DB_PATH so an override moves both
 *  halves of the backup together — a policy bundle taken from a different store
 *  than the database would be worse than none. */
const STORE_DIR = dirname(DB_PATH)
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
// E17: a path that does not exist was silently skipped — it produced no entry
// at all, so anyTooOpen() stayed false and the check reported success while
// checking nothing. A typo'd or moved store path is now its own problem.
const missing = missingPaths(perms)
if (missing.length) problems.push(`store path not found (never checked): ${missing.join(', ')}`)

// ── 2. retention purge ──────────────────────────────────────────────────────
initDatabase(DB_PATH)
const db = getDb()
try {
  const purged = purgeExpiredAttachmentContent(db, now)
  const deletable = deletedCasesEligibleForPurge(db, now)
  // Reader evidence packets (review #4, N4-2). The table did not exist when this
  // step was written, and a retention policy that does not know about a table
  // holding extracted personal data is a policy with a hole in it.
  const packets = purgeExpiredEvidencePackets(db, now)
  report.retention = {
    attachmentContent: purged,
    deletedCasesEligible: deletable.length,
    evidencePackets: packets,
  }
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

    // E3: the verification lives in backup.ts now, so the restore test is the
    // same code the unit tests pin. It decrypts, OPENS the bytes as a database
    // and runs PRAGMA integrity_check — the old probe here counted rows but
    // never asked SQLite whether the file was internally sound, so a torn
    // snapshot (which is what byte-copying a live WAL store produces) could
    // return a plausible count and pass.
    //
    // The probe is written NEXT TO THE BACKUP, not in tmpdir. On this box /tmp is
    // a 5.4 GB tmpfs and the store is 165 MB, so a probe there plus the backup
    // itself filled it and the run died with ENOSPC — found by running this
    // against a copy of the live store. Deleted by the verifier either way.
    const v = verifyEncryptedBackup({ encPath: made.path, passphrase, probeDir: BACKUP_DIR })
    const rows = v.cases ?? 0

    report.backup = {
      path: made.path, bytes: made.bytes, pruned: pruned.deleted.length,
      kept: pruned.kept.length, restoredCases: rows, integrity: v.integrity,
    }
    if (!v.ok) problems.push(`restore test: ${v.integrity}${v.problem ? ` — ${v.problem}` : ''}`)
    // A backup that decrypts to an openable database with no cases in it is not
    // proof of anything when the live store has cases.
    const live = (db.prepare('SELECT COUNT(*) AS n FROM personal_cases').get() as { n: number }).n
    if (rows !== live) problems.push(`restore test: backup holds ${rows} cases, live store has ${live}`)

    // W14 / §8.2 — THE POLICY HALF. The database backup carries every case and
    // none of the rules: the autonomy levels, the egress allowlist, which secret
    // is bound to which MCP server, the source-commit policy. A restore from the
    // db backup alone would produce a store that looks complete and behaves
    // differently — including a security control that would come back empty.
    //
    // Same crypto, same retention, same restore test: decrypt, parse, and check
    // every file the manifest claims is there.
    const pol = createPolicyBackup({ storeDir: STORE_DIR, destDir: BACKUP_DIR, passphrase, now })
    const polPruned = prunePolicyBackups({ destDir: BACKUP_DIR, now })
    const polV = verifyPolicyBackup({ encPath: pol.path, passphrase })
    report.policyBackup = {
      path: pol.path, bytes: pol.bytes, files: polV.restoredFiles.length,
      pruned: polPruned.deleted.length, unclassified: pol.unclassified,
    }
    if (!polV.ok) {
      problems.push(`policy restore test: ${polV.problem ?? `missing ${polV.missing.join(', ')}`}`)
    }
    // NOT a problem, deliberately: an unclassified store file is a question for
    // the operator, not a failure of the run. It is reported on every run until
    // somebody decides whether it is policy or state — which is what stops the
    // declared list from quietly rotting as the system grows.
    if (pol.unclassified.length) {
      report.policyUnclassified = pol.unclassified
    }
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
