#!/usr/bin/env npx tsx
/**
 * MIP-v1.0 / §8.3 — the RESTORE DRILL, as a program.
 *
 * §8.3 is explicit that documenting a restore is not enough, and it lists six
 * steps. The daily maintenance job already does a restore TEST (decrypt, open,
 * integrity_check, count cases), which covers steps 1, 3 and part of 4. What it
 * does not do is restore into a CLEAN TARGET, run smoke tests against the
 * restored store, or measure RPO and RTO. This does all six.
 *
 *   1. staging backup      — a fresh encrypted backup taken from the live store
 *   2. clean restore target — an empty directory, nothing pre-existing
 *   3. restore             — database AND policy files
 *   4. consistency checks  — integrity, foreign keys, row counts against source
 *   5. smoke tests         — REAL read paths on the restored store
 *   6. RPO / RTO           — measured, printed, not estimated
 *
 * READ-ONLY WITH RESPECT TO THE LIVE STORE. The source is opened read-only and
 * copied with SQLite's own VACUUM INTO (a torn copy is the failure this whole
 * file exists to catch, so it must not be the way the drill reads). Everything
 * else happens in a temp directory that is deleted unless --keep is passed.
 *
 * Usage:
 *   npx tsx scripts/w14-restore-drill.ts [--db <path>] [--store <dir>] [--keep]
 *
 * Exit 0 = the drill passed. Exit 1 = it did not, and the output says which step.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  createEncryptedBackup, restoreEncryptedBackup, createPolicyBackup, restorePolicyBackup,
  verifyPolicyBackup, POLICY_FILES,
} from '../src/cos/backup.js'
import { listActiveCases, listTodayCases } from '../src/cos/case-store.js'
import { getCheckpoint } from '../src/cos/email-ingest.js'
import { listNeedsHuman } from '../src/cos/recovery-queue.js'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

const DB_PATH = arg('db', process.env.MARVEEN_DB ?? 'store/claudeclaw.db')
const STORE_DIR = arg('store', dirname(DB_PATH))
const KEEP = process.argv.includes('--keep')
const PASSPHRASE = process.env.COS_BACKUP_PASSPHRASE ?? ''

interface StepResult { step: string; ok: boolean; detail: unknown }
const steps: StepResult[] = []
const record = (step: string, ok: boolean, detail: unknown) => { steps.push({ step, ok, detail }); return ok }

if (!PASSPHRASE) {
  console.log(JSON.stringify({ failed: true, error: 'COS_BACKUP_PASSPHRASE is not set — a drill with no passphrase would prove nothing' }))
  process.exit(1)
}
if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ failed: true, error: `no such database: ${DB_PATH}` }))
  process.exit(1)
}

// NOT tmpdir by default. On this box /tmp is a tmpfs and the store is ~190 MB;
// the maintenance job already learned that the hard way (a backup plus a probe
// filled it and the run died with ENOSPC). The drill copies the store TWICE, so
// it works next to the store unless told otherwise.
const workRoot = arg('work', join(STORE_DIR, 'backups'))
if (!existsSync(workRoot)) mkdirSync(workRoot, { recursive: true, mode: 0o700 })
const work = mkdtempSync(join(workRoot, '.drill-'))
const backupDir = join(work, 'backups')
const target = join(work, 'restored')     // step 2: the CLEAN target
for (const d of [backupDir, target]) mkdirSync(d, { recursive: true, mode: 0o700 })

const now = Math.floor(Date.now() / 1000)
let exitCode = 0

try {
  // ── source facts, read-only ───────────────────────────────────────────────
  const src = new Database(DB_PATH, { readonly: true })
  const sourceCounts: Record<string, number> = {}
  try {
    for (const t of ['personal_cases', 'personal_case_events', 'outbound_ledger', 'email_processing']) {
      try { sourceCounts[t] = (src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n } catch { /* table absent */ }
    }
  } finally { src.close() }

  // ── 1. staging backup ─────────────────────────────────────────────────────
  const tBackupStart = Date.now()
  const made = createEncryptedBackup({ dbPath: DB_PATH, destDir: backupDir, passphrase: PASSPHRASE, now })
  const policy = createPolicyBackup({ storeDir: STORE_DIR, destDir: backupDir, passphrase: PASSPHRASE, now })
  const backupMs = Date.now() - tBackupStart
  record('1-staging-backup', true, { db: made.bytes, policy: policy.bytes, unclassified: policy.unclassified, ms: backupMs })

  // ── 2. clean restore target ───────────────────────────────────────────────
  const targetEmpty = readdirSync(target).length === 0
  if (!record('2-clean-target', targetEmpty, { target, entries: readdirSync(target).length })) {
    throw new Error('restore target was not empty — a restore onto existing data proves nothing')
  }

  // ── 3. restore (the clock for RTO starts here) ────────────────────────────
  const tRestoreStart = Date.now()
  const restoredDb = join(target, 'claudeclaw.db')
  writeFileSync(restoredDb, restoreEncryptedBackup({ encPath: made.path, passphrase: PASSPHRASE }), { mode: 0o600 })
  const policyRestore = restorePolicyBackup({ encPath: policy.path, passphrase: PASSPHRASE, targetDir: target })
  record('3-restore', true, { db: restoredDb, policyFiles: policyRestore.written.length })

  // ── 4. consistency checks ─────────────────────────────────────────────────
  const rdb = new Database(restoredDb, { readonly: true })
  let consistent = true
  const checks: Record<string, unknown> = {}
  try {
    checks.integrity = String((rdb.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check)
    consistent &&= checks.integrity === 'ok'
    // Foreign keys are REPORTED, not asserted: the live store carries 20
    // pre-existing violations (documented in the W11 staging proof), so failing
    // the drill on them would fail it every time for a condition the drill did
    // not cause.
    checks.foreignKeyViolations = (rdb.pragma('foreign_key_check') as unknown[]).length
    const restoredCounts: Record<string, number> = {}
    for (const [t, n] of Object.entries(sourceCounts)) {
      restoredCounts[t] = (rdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      if (restoredCounts[t] !== n) consistent = false
    }
    checks.sourceCounts = sourceCounts
    checks.restoredCounts = restoredCounts
    // The policy half: every declared file that existed is back.
    const polV = verifyPolicyBackup({ encPath: policy.path, passphrase: PASSPHRASE })
    checks.policyRestored = polV.restoredFiles.length
    checks.policyMissing = polV.missing
    checks.policyDeclared = POLICY_FILES.length
    consistent &&= polV.ok
    record('4-consistency', consistent, checks)

    // ── 5. smoke tests — REAL read paths, not a row count ───────────────────
    // A restored file that opens is not a restored SYSTEM. These are the same
    // functions the running COS calls, pointed at the restored store.
    const smoke: Record<string, unknown> = {}
    let smokeOk = true
    try {
      smoke.activeCases = listActiveCases(rdb).length
      smoke.todayCases = listTodayCases(rdb, 86400).length
      smoke.checkpoint = getCheckpoint(rdb, 'iszzu80')
      smoke.recoveryNeedsHuman = listNeedsHuman(rdb).length
    } catch (e) {
      smokeOk = false
      smoke.error = String((e as Error)?.message ?? e)
    }
    // A store with cases whose Today view throws or comes back structurally
    // empty is a restore that would look fine and serve nothing.
    if (sourceCounts.personal_cases > 0 && smoke.activeCases === 0) {
      smokeOk = false
      smoke.error = 'restored store has cases but listActiveCases returned none'
    }
    record('5-smoke', smokeOk, smoke)
    consistent &&= smokeOk
  } finally { rdb.close() }

  const restoreMs = Date.now() - tRestoreStart

  // ── 6. RPO / RTO, measured ────────────────────────────────────────────────
  //
  // RPO: how much data a restore would lose. It is NOT this drill's own backup
  // age (that would be zero and meaningless) — it is the age of the NEWEST
  // backup in the real backup directory, because that is what a real restore
  // would start from. Reported as "unknown" when there is none, which is itself
  // the answer to "what is our RPO".
  const realBackupDir = process.env.COS_BACKUP_DIR ?? join(STORE_DIR, 'backups')
  let newest = 0
  if (existsSync(realBackupDir)) {
    for (const name of readdirSync(realBackupDir)) {
      const m = /^backup-(\d+)\.db\.enc$/.exec(name)
      if (m && Number(m[1]) > newest) newest = Number(m[1])
    }
  }
  const rpoSeconds = newest ? now - newest : null
  record('6-rpo-rto', true, {
    rpoSeconds, rpoHours: rpoSeconds === null ? null : +(rpoSeconds / 3600).toFixed(2),
    rtoSeconds: +(restoreMs / 1000).toFixed(2),
    note: rpoSeconds === null
      ? 'no backup in the real backup directory — the RPO is unbounded until the daily job has run'
      : 'RPO is the age of the newest real backup; RTO is measured restore+verify wall clock',
  })

  exitCode = steps.every(s => s.ok) ? 0 : 1
  console.log(JSON.stringify({ ok: exitCode === 0, steps, work: KEEP ? work : undefined }, null, 2))
} catch (e) {
  exitCode = 1
  console.log(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e), steps }, null, 2))
} finally {
  if (!KEEP) rmSync(work, { recursive: true, force: true })
}

process.exit(exitCode)
