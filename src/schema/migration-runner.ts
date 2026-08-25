// MIP-v1.0 / §5 / W11_DURABLE_SCHEMA_MIGRATION — the migration runner.
//
// WHAT THIS ADDS OVER WHAT ALREADY EXISTED, because most of it already did.
//
// `src/cos/schema.ts` has `runOnce()`: a migration ledger whose marker is
// written in the SAME transaction as the body, so a crash cannot leave a
// migration applied-but-unmarked. That is genuinely good and this runner reuses
// the idea rather than replacing it. It also has `ensureColumns()` (reads
// `PRAGMA table_info` instead of catching an error) and `widenCheckConstraint()`
// (row-count check plus a foreign-key-violation DELTA against a baseline). Those
// are W11-shaped and were built before W11 existed.
//
// Three things they cannot do, and this runner does:
//
//   1. PARTIAL FAILURE IS DETECTABLE (§5.3, §5.7 criterion 3). A ledger of
//      successes cannot distinguish "never ran" from "started and died", because
//      both leave no row. A migration that is transactional does not need the
//      distinction -- but a DESTRUCTIVE one takes a backup outside the
//      transaction, and a long data migration may be chunked. So the runner
//      writes an in-flight marker BEFORE the body and clears it after, and the
//      schema gate refuses writes while one is set.
//
//   2. POST-MIGRATION VERIFICATION IS MANDATORY (§5.3). Not "recommended": a
//      migration with no `verify` is REFUSED, before it runs. The failure lands
//      on the author, at development time, instead of on the data at 3am.
//
//   3. PRE-MIGRATION COMPATIBILITY CHECK (§5.3), and a backup before anything
//      destructive.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not replace the 34 `ALTER TABLE`
// statements in `db.ts`. Those are additive column adds guarded by
// `try { ... } catch { /* exists */ }` -- 21 of them -- and that pattern's real
// defect is that it swallows EVERY error, so a genuine failure (locked table,
// disk full, constraint violation) is indistinguishable from "already applied".
// Rewriting all of them in one pass is exactly the big-bang §5.4 warns about.
// `ensureColumnStrict` below is the replacement, and the migration to it is a
// separate, per-call-site job with its own proof.

import type Database from 'better-sqlite3'
import { copyFileSync, existsSync } from 'node:fs'
import {
  STORE_SCHEMA_VERSION, initStoreSchemaState, readStoreSchemaState,
} from './store-schema.js'

export interface MigrationContext {
  db: Database.Database
  nowSec: number
}

export interface Migration {
  /** Stable, unique, and dated. Never reused: the ledger is keyed on it. */
  id: string
  description: string
  /** The version this migration brings the store TO. */
  toVersion: number
  /**
   * True when the migration can lose data if it goes wrong -- a DROP, a table
   * rebuild, an UPDATE that overwrites. Destructive migrations take a backup
   * first (§5.3) and are refused when no backup path is available.
   */
  destructive?: boolean
  /**
   * §5.3 pre-migration compatibility check. Return a reason string to REFUSE.
   * Returning null/undefined means "compatible, proceed".
   */
  precheck?: (ctx: MigrationContext) => string | null | undefined
  /** The change itself. Runs inside a transaction unless `nonTransactional`. */
  up: (ctx: MigrationContext) => void
  /**
   * §5.3 post-migration verification. MANDATORY. Return a short description of
   * what was verified; THROW to fail the migration.
   *
   * Returning a string rather than a boolean on purpose: a boolean records that
   * something was checked, a string records WHAT -- and the ledger keeps it.
   */
  verify: (ctx: MigrationContext) => string
  /**
   * Set when the body cannot run inside one transaction (chunked data work,
   * pragma changes SQLite ignores inside a transaction). The in-flight marker is
   * what makes this safe to allow at all.
   */
  nonTransactional?: boolean
}

export interface MigrationOutcome {
  id: string
  /** SKIPPED = already in the ledger. */
  result: 'APPLIED' | 'SKIPPED' | 'REFUSED' | 'FAILED'
  reason?: string
  verification?: string
  backupRef?: string
}

export interface RunOptions {
  nowSec?: number
  /** Where to write a backup before a destructive migration. */
  backupPath?: (migrationId: string) => string
  /** Injectable for tests: copy the database file. */
  backup?: (dest: string) => void
  /** The database file, for the default backup implementation. */
  dbFile?: string
}

/**
 * Additive column add that does NOT swallow errors.
 *
 * The replacement for `try { ALTER TABLE ... } catch { /* exists *\/ }`. It asks
 * `PRAGMA table_info` first, so "already there" is answered by looking rather
 * than by failing -- and any error that then occurs is a REAL error and
 * propagates. That single difference is what turns a silent half-migration into
 * a loud one.
 */
export function ensureColumnStrict(
  db: Database.Database, table: string, column: string, definition: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.length) throw new Error(`ensureColumnStrict: table ${table} does not exist`)
  if (cols.some(c => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

function alreadyApplied(db: Database.Database, id: string): boolean {
  const row = db.prepare(
    `SELECT state FROM store_schema_migrations WHERE migration_id = ?`).get(id) as { state: string } | undefined
  // A FAILED row does NOT count as applied: the migration may be retried. That
  // is the retry path §5.6 asks for, and it is why the ledger stores a state
  // rather than mere presence.
  return row?.state === 'APPLIED'
}

function setInFlight(db: Database.Database, id: string | null, nowSec: number): void {
  initStoreSchemaState(db)
  const exists = db.prepare('SELECT 1 FROM store_schema_state WHERE id = 1').get()
  if (!exists) {
    db.prepare(`INSERT INTO store_schema_state (id, version, updated_at, in_flight_migration_id, in_flight_started_at)
                VALUES (1, 0, ?, ?, ?)`).run(nowSec, id, id ? nowSec : null)
    return
  }
  db.prepare(`UPDATE store_schema_state
              SET in_flight_migration_id = ?, in_flight_started_at = ?, updated_at = ?
              WHERE id = 1`).run(id, id ? nowSec : null, nowSec)
}

function recordLedger(
  db: Database.Database, m: Migration, state: 'APPLIED' | 'FAILED',
  fromVersion: number, nowSec: number, verification: string | null, backupRef: string | null, error: string | null,
): void {
  db.prepare(`
    INSERT INTO store_schema_migrations
      (migration_id, applied_at, state, from_version, to_version, destructive, verification, backup_ref, error)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(migration_id) DO UPDATE SET
      applied_at = excluded.applied_at, state = excluded.state,
      verification = excluded.verification, backup_ref = excluded.backup_ref, error = excluded.error
  `).run(m.id, nowSec, state, fromVersion, m.toVersion, m.destructive ? 1 : 0, verification, backupRef, error)
}

function bumpVersion(db: Database.Database, toVersion: number, nowSec: number): void {
  const cur = readStoreSchemaState(db)
  // Never move the version BACKWARD from a migration: a migration that targets
  // an older version than the store already has is a mistake, and silently
  // downgrading would make the gate wave through code that cannot read it.
  const next = Math.max(cur.version, toVersion)
  const exists = db.prepare('SELECT 1 FROM store_schema_state WHERE id = 1').get()
  if (exists) {
    db.prepare('UPDATE store_schema_state SET version = ?, updated_at = ?, last_verified_at = ? WHERE id = 1')
      .run(next, nowSec, nowSec)
  } else {
    db.prepare('INSERT INTO store_schema_state (id, version, updated_at, last_verified_at) VALUES (1,?,?,?)')
      .run(next, nowSec, nowSec)
  }
}

/**
 * Run a list of migrations in order.
 *
 * Idempotent (§5.7 criterion 2): a migration already in the ledger as APPLIED is
 * skipped, so running the whole list twice changes nothing. A migration that
 * FAILED is retried, which is a different thing from being applied twice.
 */
export function runMigrations(
  db: Database.Database, migrations: readonly Migration[], opts: RunOptions = {},
): MigrationOutcome[] {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  initStoreSchemaState(db)
  const out: MigrationOutcome[] = []

  // Refuse the WHOLE run while a previous migration is in flight. Running the
  // next one over a half-finished one is how a recoverable state becomes an
  // unrecoverable one.
  const pre = readStoreSchemaState(db)
  if (pre.inFlightMigrationId) {
    return migrations.map(m => ({
      id: m.id, result: 'REFUSED' as const,
      reason: `a previous migration (${pre.inFlightMigrationId}) is still in flight; repair or roll it back first`,
    }))
  }

  // Authoring checks run BEFORE anything touches the database, so a badly
  // declared list cannot half-apply.
  const seen = new Set<string>()
  for (const m of migrations) {
    if (!m.verify) {
      return [{ id: m.id, result: 'REFUSED', reason: 'migration declares no verify(): post-migration verification is mandatory (§5.3)' }]
    }
    if (seen.has(m.id)) {
      return [{ id: m.id, result: 'REFUSED', reason: `duplicate migration id ${m.id} in the list` }]
    }
    seen.add(m.id)
    if (m.toVersion > STORE_SCHEMA_VERSION) {
      return [{
        id: m.id, result: 'REFUSED',
        reason: `migration targets version ${m.toVersion} but this build declares STORE_SCHEMA_VERSION=${STORE_SCHEMA_VERSION}; `
          + 'bump the constant in the same commit as the migration',
      }]
    }
  }

  for (const m of migrations) {
    if (alreadyApplied(db, m.id)) {
      out.push({ id: m.id, result: 'SKIPPED', reason: 'already in the ledger as APPLIED' })
      continue
    }
    const ctx: MigrationContext = { db, nowSec }
    const fromVersion = readStoreSchemaState(db).version

    const refusal = m.precheck?.(ctx)
    if (refusal) {
      out.push({ id: m.id, result: 'REFUSED', reason: `pre-migration compatibility check refused: ${refusal}` })
      // A refusal stops the run: later migrations assume this one happened.
      break
    }

    let backupRef: string | null = null
    if (m.destructive) {
      const dest = opts.backupPath?.(m.id)
      if (!dest) {
        out.push({ id: m.id, result: 'REFUSED', reason: 'destructive migration with no backup path configured (§5.3)' })
        break
      }
      try {
        if (opts.backup) opts.backup(dest)
        else if (opts.dbFile && existsSync(opts.dbFile)) copyFileSync(opts.dbFile, dest)
        else throw new Error('no backup implementation and no dbFile to copy')
        backupRef = dest
      } catch (e) {
        out.push({ id: m.id, result: 'REFUSED', reason: `backup failed, refusing a destructive migration: ${msg(e)}` })
        break
      }
    }

    setInFlight(db, m.id, nowSec)
    try {
      if (m.nonTransactional) m.up(ctx)
      else db.transaction(() => m.up(ctx))()

      // Verification runs OUTSIDE the body's transaction on purpose: verifying
      // inside it would check what the transaction sees, which is exactly the
      // state we are trying to confirm actually landed.
      const verification = m.verify(ctx)
      if (typeof verification !== 'string' || !verification.trim()) {
        throw new Error('verify() returned no description of what it checked')
      }
      recordLedger(db, m, 'APPLIED', fromVersion, nowSec, verification, backupRef, null)
      bumpVersion(db, m.toVersion, nowSec)
      setInFlight(db, null, nowSec)
      out.push({ id: m.id, result: 'APPLIED', verification, ...(backupRef ? { backupRef } : {}) })
    } catch (e) {
      const error = msg(e)
      // The in-flight marker is cleared and the failure recorded, so the store
      // is not left permanently latched by a migration that failed CLEANLY (its
      // transaction rolled back). A non-transactional failure is different and
      // KEEPS the marker: there the store really may be half-migrated, and a
      // human has to look.
      recordLedger(db, m, 'FAILED', fromVersion, nowSec, null, backupRef, error)
      if (!m.nonTransactional) setInFlight(db, null, nowSec)
      out.push({ id: m.id, result: 'FAILED', reason: error, ...(backupRef ? { backupRef } : {}) })
      break
    }
  }
  return out
}

/**
 * Clear a stuck in-flight marker after a human has repaired or rolled back.
 *
 * Deliberately NOT automatic. The marker exists precisely because the runner
 * cannot tell whether the half-migrated store is safe, and a function that
 * clears it on a timer would answer that question by assumption.
 */
export function clearInFlightAfterRepair(
  db: Database.Database, migrationId: string, note: string, nowSec: number,
): boolean {
  const st = readStoreSchemaState(db)
  if (st.inFlightMigrationId !== migrationId) return false
  setInFlight(db, null, nowSec)
  db.prepare(`UPDATE store_schema_migrations SET error = COALESCE(error,'') || ' | repaired: ' || ? WHERE migration_id = ?`)
    .run(note, migrationId)
  return true
}

/** The ledger, newest first. Used by the acceptance check and the report. */
export function readMigrationLedger(db: Database.Database, limit = 100): Array<{
  migrationId: string; appliedAt: number; state: string; fromVersion: number; toVersion: number
  destructive: number; verification: string | null; backupRef: string | null; error: string | null
}> {
  initStoreSchemaState(db)
  return db.prepare(`
    SELECT migration_id AS migrationId, applied_at AS appliedAt, state,
           from_version AS fromVersion, to_version AS toVersion, destructive,
           verification, backup_ref AS backupRef, error
    FROM store_schema_migrations ORDER BY applied_at DESC, migration_id DESC LIMIT ?
  `).all(limit) as never
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
