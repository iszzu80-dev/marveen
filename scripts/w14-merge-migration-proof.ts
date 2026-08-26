#!/usr/bin/env npx tsx
/**
 * MIP-v1.0 §1.5 / the merge gate: "migration proof, ha kell".
 *
 * It is needed here. W11 proved ITS migration against a copy of the live store;
 * W12, W13 and W14 have since added tables (`cos_recovery_queue`,
 * `cos_retry_policy`, `cos_disclosure_records`) and — the one that is not merely
 * additive — a REBUILD of `cos_feature_runs` to carry §8.7's cross-column CHECK.
 *
 * A rebuild against the owner's real store is exactly the class of change that
 * must not be proven on a fixture. So: copy the live store with SQLite's own
 * backup(), boot the CURRENT branch's schema code against the copy, and check
 * what actually happened to it.
 *
 * READ-ONLY WITH RESPECT TO THE LIVE STORE. The source is opened readonly and
 * every write lands on the copy, which is deleted unless --keep is passed.
 *
 * Usage: npx tsx scripts/w14-merge-migration-proof.ts [--keep]
 * Exit 0 = the boot is safe against the live store. Exit 1 = it is not.
 */
import Database from 'better-sqlite3'
import { existsSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LIVE = process.env.MARVEEN_DB ?? join(process.env.HOME ?? '', 'marveen', 'store', 'claudeclaw.db')
const KEEP = process.argv.includes('--keep')
const problems: string[] = []
const report: Record<string, unknown> = { at: new Date().toISOString(), live: LIVE }

if (!existsSync(LIVE)) {
  console.log(JSON.stringify({ ...report, problems: [`live store not found: ${LIVE}`] }, null, 1))
  process.exit(1)
}

// Beside the live store, not in tmpdir: /tmp here is a tmpfs and the store is
// ~190 MB (the maintenance job learned that with an ENOSPC).
const workDir = join(process.env.HOME ?? '', 'marveen', 'store', 'backups')
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true, mode: 0o700 })
const stage = join(workDir, `.merge-proof-${Date.now()}.db`)

const live = new Database(LIVE, { readonly: true })
await live.backup(stage)
live.close()
report.stageBytes = statSync(stage).size

// What the copy looks like BEFORE this branch's code touches it.
const before = new Database(stage, { readonly: true })
const beforeState: Record<string, number | null> = {}
const has = (db: Database.Database, t: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t) !== undefined
const count = (db: Database.Database, t: string) =>
  has(db, t) ? (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : null
const NEW_TABLES = ['cos_recovery_queue', 'cos_retry_policy', 'cos_disclosure_records', 'cos_canary']
const CARRIED = ['personal_cases', 'personal_case_events', 'outbound_ledger', 'email_processing', 'cos_feature_runs']
for (const t of [...NEW_TABLES, ...CARRIED]) beforeState[t] = count(before, t)
before.close()
report.before = beforeState

// ── boot the CURRENT code against the copy ──────────────────────────────────
const bootStart = Date.now()
let booted = false
try {
  const { initDatabase, getDb } = await import('../src/db.js')
  initDatabase(stage)
  const db = getDb()
  booted = true
  report.bootMs = Date.now() - bootStart

  const afterState: Record<string, number | null> = {}
  for (const t of [...NEW_TABLES, ...CARRIED]) afterState[t] = count(db, t)
  report.after = afterState

  // 1. every new table exists after the boot
  for (const t of NEW_TABLES) {
    if (afterState[t] === null) problems.push(`new table missing after boot: ${t}`)
  }

  // 2. NOTHING was lost from the carried tables
  for (const t of CARRIED) {
    const b = beforeState[t]
    const a = afterState[t]
    if (b === null) continue
    if (a === null) { problems.push(`${t} disappeared during boot`); continue }
    if (a !== b) problems.push(`${t}: ${b} rows before, ${a} after`)
  }

  // 3. the cos_feature_runs REBUILD carries §8.7's constraint, and the pre-W14
  //    table it replaced left no leftover behind
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cos_feature_runs'`)
    .get() as { sql: string } | undefined)?.sql ?? ''
  if (!ddl.includes('run_status')) problems.push('cos_feature_runs was not rebuilt to the W14 shape')
  if (has(db, 'cos_feature_runs_pre_w14')) problems.push('the pre-W14 table was left behind')

  // 4. the retry policy seeded itself — the recovery queue is inert without it
  const policies = count(db, 'cos_retry_policy') ?? 0
  report.retryPolicies = policies
  if (policies < 3) problems.push(`retry policy rows: ${policies}, expected the three seeded classes`)

  // 5. the store still passes its own schema gate after the boot
  const { checkStoreSchema } = await import('../src/schema/store-schema.js')
  const gate = checkStoreSchema(db, Math.floor(Date.now() / 1000))
  report.gate = { verdict: gate.verdict, version: gate.state.version, readOnly: gate.readOnly }
  if (gate.verdict !== 'OK') problems.push(`schema gate after boot: ${gate.verdict} — ${gate.reason}`)

  // 6. integrity, because a boot that corrupts is worse than one that fails
  const integrity = String((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check)
  report.integrity = integrity
  if (integrity !== 'ok') problems.push(`integrity_check after boot: ${integrity}`)

  db.close()
} catch (e) {
  problems.push(`boot threw: ${String((e as Error)?.message ?? e)}`)
} finally {
  report.booted = booted
  // `.bootlock` is the fresh-boot single-writer sidecar (db-bootstrap-lock.ts).
  // It is a sidecar of THIS temporary store like -wal/-shm, and it is listed
  // here because the first run after the lock landed left one behind in
  // store/backups/ -- a real, if small, consequence of the change.
  if (!KEEP) {
    for (const sfx of ['', '-wal', '-shm', '.bootlock', '.bootlock-journal']) {
      try { rmSync(stage + sfx, { force: true }) } catch { /* best effort */ }
    }
  }
  else report.stage = stage
}

report.problems = problems
console.log(JSON.stringify(report, null, 1))
process.exit(problems.length ? 1 : 0)
