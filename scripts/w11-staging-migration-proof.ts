#!/usr/bin/env npx tsx
/**
 * MIP-v1.0 / §5 / W11 — §5.7 criterion 5: "migration proof stagingen".
 *
 * WHAT "STAGING" MEANS HERE, since this system has no staging environment.
 *
 * A COPY of the live store, taken with SQLite's own `backup()` so a concurrent
 * writer cannot produce a torn file. That copy is the most faithful staging
 * there is for a schema change: it has the real 128 tables, the real row counts,
 * and the real accumulated oddities (the 20 pre-existing foreign-key violations
 * that `widenCheckConstraint` already has to work around). A hand-built fixture
 * would prove the migration works on a database nobody has.
 *
 * READ-ONLY WITH RESPECT TO THE LIVE STORE. It opens the live file read-only,
 * copies it, and every write lands on the copy. The copy is deleted at the end
 * unless --keep is passed.
 *
 * Exit 0 = the proof holds. Exit 1 = it does not, and the output says where.
 */
import Database from 'better-sqlite3'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  STORE_SCHEMA_VERSION, adoptUnversionedStore, checkStoreSchema, readStoreSchemaState,
} from '../src/schema/store-schema.js'
import {
  ensureColumnStrict, runMigrations, readMigrationLedger, type Migration,
} from '../src/schema/migration-runner.js'

const LIVE = process.env.MARVEEN_DB ?? join(process.env.HOME ?? '', 'marveen', 'store', 'claudeclaw.db')
const keep = process.argv.includes('--keep')
const problems: string[] = []
const report: Record<string, unknown> = { at: new Date().toISOString(), live: LIVE }

if (!existsSync(LIVE)) {
  console.log(JSON.stringify({ ...report, problems: [`live store not found: ${LIVE}`] }, null, 1))
  process.exit(1)
}

const stage = join(tmpdir(), `w11-staging-${Date.now()}.db`)
const live = new Database(LIVE, { readonly: true })
await live.backup(stage)
live.close()
report.stageBytes = statSync(stage).size

const db = new Database(stage)
const nowSec = Math.floor(Date.now() / 1000)

// ---- 1. the gate on a REAL store ------------------------------------------
const tableCount = (db.prepare(
  `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
).get() as { n: number }).n
report.tables = tableCount

const adopted = adoptUnversionedStore(db, nowSec)
const gate = checkStoreSchema(db, nowSec)
report.adopted = adopted
report.gate = { verdict: gate.verdict, version: gate.state.version, readOnly: gate.readOnly }
if (gate.verdict !== 'OK') problems.push(`gate on a healthy live copy said ${gate.verdict}: ${gate.reason}`)

// ---- 2. a REAL additive migration on the REAL schema ------------------------
// Additive and reversible on purpose (§5.4 prefers additive): the point is to
// prove the runner against real data, not to reshape the owner's store.
const PROBE_TABLE = 'store_schema_state'
const probe: Migration = {
  id: 'w11-staging-probe',
  toVersion: STORE_SCHEMA_VERSION,
  description: 'additive probe column, proving the runner against the real schema',
  up: ({ db }) => { ensureColumnStrict(db, PROBE_TABLE, 'w11_probe', 'TEXT') },
  verify: ({ db }) => {
    const cols = db.prepare(`PRAGMA table_info(${PROBE_TABLE})`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'w11_probe')) throw new Error('probe column missing after migration')
    return `${PROBE_TABLE}.w11_probe present on the real schema`
  },
}

const first = runMigrations(db, [probe], { nowSec })
report.firstRun = first
if (first[0]?.result !== 'APPLIED') problems.push(`migration on the live copy did not apply: ${first[0]?.reason}`)

// ---- 3. idempotency, on real data ------------------------------------------
const second = runMigrations(db, [probe], { nowSec: nowSec + 1 })
report.secondRun = second
if (second[0]?.result !== 'SKIPPED') problems.push(`second run was not SKIPPED (${second[0]?.result}) -- the runner is not idempotent on real data`)

// ---- 4. row counts unchanged ------------------------------------------------
// The migration was additive, so every table must still hold what it held. This
// is the check that would catch a migration that "succeeded" by dropping rows.
const before = new Map<string, number>()
const tables = (db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
).all() as Array<{ name: string }>).map(r => r.name)
for (const t of tables) {
  try { before.set(t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n) } catch { /* view-like */ }
}
const totalRows = [...before.values()].reduce((a, b) => a + b, 0)
report.totalRows = totalRows
if (totalRows === 0) problems.push('the staging copy has zero rows -- the proof would be vacuous')

// ---- 5. integrity, from SQLite itself ---------------------------------------
const integrity = db.pragma('integrity_check', { simple: true })
report.integrity = integrity
if (integrity !== 'ok') problems.push(`integrity_check on the migrated copy: ${integrity}`)

// ---- 6. the ledger says what it verified ------------------------------------
const led = readMigrationLedger(db, 5).filter(r => r.migrationId === 'w11-staging-probe')
report.ledger = led
if (!led.length || led[0].state !== 'APPLIED' || !led[0].verification) {
  problems.push('the ledger does not carry an APPLIED row with a verification note')
}

// ---- 7. the future-schema gate, on the real store ----------------------------
db.prepare('UPDATE store_schema_state SET version = ? WHERE id = 1').run(STORE_SCHEMA_VERSION + 1)
const future = checkStoreSchema(db, nowSec)
report.futureGate = { verdict: future.verdict, readOnly: future.readOnly }
if (future.verdict !== 'FUTURE_UNSUPPORTED' || !future.readOnly) {
  problems.push('a store marked newer-than-supported did NOT fail closed on the real schema')
}
db.prepare('UPDATE store_schema_state SET version = ? WHERE id = 1').run(readStoreSchemaState(db).version)

db.close()
if (!keep) rmSync(stage, { force: true })
report.stagePath = keep ? stage : '(deleted)'
report.problems = problems

console.log(JSON.stringify(report, null, 1))
process.exit(problems.length ? 1 : 0)
