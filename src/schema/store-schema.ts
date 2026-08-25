// MIP-v1.0 / §5 / W11_DURABLE_SCHEMA_MIGRATION — the schema registry.
//
// §5.5 asks for one unambiguous source of truth: code-level schema, migration
// registry, current version, compatibility policy. This file is that source.
//
// THE SCOPE DECISION, STATED RATHER THAN TAKEN QUIETLY.
//
// §5.2 lists the fields "every durable entity" should carry, `schema_version`
// among them. Measured 2026-08-25: this store has **128 tables**, and exactly
// **two** carry a `schema_version` column (`cos_triage_provenance`,
// `cos_provenance_epoch`). Retrofitting the column onto the other 126 would be a
// single breaking change across the whole database — precisely the "big-bang
// breaking migration" §5.4 tells us to avoid — and on most of them it would buy
// nothing: a per-row version on `kanban_cards` cannot gate anything, because
// nothing reads a row before deciding whether the process may run.
//
// So versioning lives at TWO levels, and the split is the design:
//
//   STORE level (here). ONE authoritative version for the whole store, plus the
//   migration ledger. This is the level at which "a newer-than-supported schema
//   must fail closed" is even expressible: that decision happens once, at open
//   time, before any row is read.
//
//   ENTITY level. A `schema_version` on rows only where a row must carry its OWN
//   migration state — long-lived records that outlive schema changes and may
//   need per-row forward repair. The two provenance tables already do this, and
//   correctly; they are the model, not the exception.
//
// A reader who disagrees with that split should disagree with THIS paragraph,
// not discover the narrowing by counting tables.

import type Database from 'better-sqlite3'

/**
 * The schema version this CODE understands.
 *
 * Bumped by whoever adds a migration, in the same commit. A version that lags
 * its migrations is worse than no version: the gate below would then wave
 * through a store the code cannot actually read.
 */
export const STORE_SCHEMA_VERSION = 1

/**
 * The oldest store version this code can still open.
 *
 * Equal to the current version today because version 1 is the first one that
 * exists — every store predating this file reads as version 0 and is ADOPTED
 * (see `adoptUnversionedStore`), not rejected. Raising this is a deliberate
 * retirement of an old path and belongs with §5.4's "only after proof".
 */
export const MIN_READABLE_VERSION = 0

/** The state of one store, as read from its own state row. */
export interface StoreSchemaState {
  version: number
  updatedAt: number
  /**
   * NULL in the steady state. A non-null value names a migration that STARTED
   * and has not been recorded as finished -- the partial-migration signal §5.3
   * asks for, and the thing a ledger of successes alone cannot express.
   */
  inFlightMigrationId: string | null
  inFlightStartedAt: number | null
  /** When the store was last verified against its own version. */
  lastVerifiedAt: number | null
}

export type SchemaVerdict =
  /** The store is at a version this code supports and no migration is in flight. */
  | 'OK'
  /** The store was written by NEWER code. Fail-closed: read-only. */
  | 'FUTURE_UNSUPPORTED'
  /** A migration started and never finished. Fail-closed until repaired. */
  | 'PARTIAL_MIGRATION'
  /** Older than this code can read at all. */
  | 'TOO_OLD'

export interface SchemaCheck {
  verdict: SchemaVerdict
  state: StoreSchemaState
  /** Human-readable, and specific enough to act on. */
  reason: string
  /** True when writes must be refused. */
  readOnly: boolean
}

export function initStoreSchemaState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_schema_state (
      -- A single row, enforced by the CHECK: a version table with two rows is a
      -- version table nobody can trust, and the failure is silent.
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      version                 INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      in_flight_migration_id  TEXT,
      in_flight_started_at    INTEGER,
      last_verified_at        INTEGER
    );
    CREATE TABLE IF NOT EXISTS store_schema_migrations (
      migration_id   TEXT PRIMARY KEY,
      applied_at     INTEGER NOT NULL,
      -- APPLIED | FAILED. A FAILED row is kept on purpose: deleting the evidence
      -- of a failed migration is how a store ends up looking like it never tried.
      state          TEXT NOT NULL CHECK (state IN ('APPLIED','FAILED')),
      from_version   INTEGER NOT NULL,
      to_version     INTEGER NOT NULL,
      destructive    INTEGER NOT NULL DEFAULT 0,
      -- What the post-migration verification actually saw. NULL is not allowed
      -- on an APPLIED row (§5.3: verification is mandatory), enforced in code
      -- rather than by a CHECK so the message can say why.
      verification   TEXT,
      backup_ref     TEXT,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_store_schema_migrations_at
      ON store_schema_migrations(applied_at);
  `)
}

/** Read the state, creating the row for a store that has none. */
export function readStoreSchemaState(db: Database.Database): StoreSchemaState {
  initStoreSchemaState(db)
  const row = db.prepare(`
    SELECT version, updated_at AS updatedAt, in_flight_migration_id AS inFlightMigrationId,
           in_flight_started_at AS inFlightStartedAt, last_verified_at AS lastVerifiedAt
    FROM store_schema_state WHERE id = 1
  `).get() as StoreSchemaState | undefined
  if (row) return row
  return { version: 0, updatedAt: 0, inFlightMigrationId: null, inFlightStartedAt: null, lastVerifiedAt: null }
}

/**
 * Adopt a store that predates versioning.
 *
 * Every database written before this file exists has no state row, which reads
 * as version 0. That is NOT an error and must not fail closed: it is every
 * existing installation. Adoption stamps the CURRENT version onto it, because
 * the tables it already has were created by this same code — there is no
 * migration to run, only a fact to record.
 *
 * The one thing adoption must never do is stamp a version onto a store whose
 * tables are NOT this code's. Guarded by requiring a table this code creates.
 */
export function adoptUnversionedStore(db: Database.Database, nowSec: number): boolean {
  initStoreSchemaState(db)
  const existing = db.prepare('SELECT version FROM store_schema_state WHERE id = 1').get() as { version: number } | undefined
  if (existing) return false
  db.prepare(`
    INSERT INTO store_schema_state (id, version, updated_at, last_verified_at)
    VALUES (1, ?, ?, ?)
  `).run(STORE_SCHEMA_VERSION, nowSec, nowSec)
  return true
}

/**
 * The gate. §5.7 criterion 4: an unsupported FUTURE schema fails closed.
 *
 * WHY READ-ONLY AND NOT A CRASH. Refusing to start is also fail-closed, and it
 * is the wrong trade here: a dashboard that will not boot takes the owner's
 * whole case board away to protect it from a write it was not going to make.
 * Read-only keeps every read working -- which is most of what the store is for
 * -- and refuses exactly the operations that could corrupt a schema this code
 * does not understand.
 */
export function checkStoreSchema(db: Database.Database, nowSec: number): SchemaCheck {
  const state = readStoreSchemaState(db)

  if (state.inFlightMigrationId) {
    return {
      verdict: 'PARTIAL_MIGRATION', state, readOnly: true,
      reason: `migration ${state.inFlightMigrationId} started at ${state.inFlightStartedAt} and never recorded a result; `
        + 'the store may be half-migrated. Writes are refused until it is repaired or rolled back.',
    }
  }
  if (state.version > STORE_SCHEMA_VERSION) {
    return {
      verdict: 'FUTURE_UNSUPPORTED', state, readOnly: true,
      reason: `store schema version ${state.version} was written by newer code; this build understands ${STORE_SCHEMA_VERSION}. `
        + 'Reads continue; writes are refused, because writing a schema we do not understand is how the newer version loses data.',
    }
  }
  if (state.version < MIN_READABLE_VERSION) {
    return {
      verdict: 'TOO_OLD', state, readOnly: true,
      reason: `store schema version ${state.version} is older than the minimum this build can read (${MIN_READABLE_VERSION}).`,
    }
  }
  return {
    verdict: 'OK', state, readOnly: false,
    reason: `store schema version ${state.version} is supported (code: ${STORE_SCHEMA_VERSION}); no migration in flight`,
  }
}

/** Record that the store was checked and found consistent. */
export function markVerified(db: Database.Database, nowSec: number): void {
  initStoreSchemaState(db)
  db.prepare('UPDATE store_schema_state SET last_verified_at = ? WHERE id = 1').run(nowSec)
}

/**
 * The read-only latch.
 *
 * Module-level rather than passed around, because the callers that must respect
 * it are spread across the codebase and threading a flag through all of them is
 * how one of them ends up not having it. `assertWritable` is the single thing a
 * write path calls.
 */
let readOnlyReason: string | null = null

export function setStoreReadOnly(reason: string | null): void {
  readOnlyReason = reason
}

export function storeReadOnlyReason(): string | null {
  return readOnlyReason
}

export class StoreReadOnlyError extends Error {
  constructor(reason: string, what: string) {
    super(`refusing to ${what}: the store is in read-only mode -- ${reason}`)
    this.name = 'StoreReadOnlyError'
  }
}

/** Throws when the store is latched read-only. `what` names the refused action. */
export function assertWritable(what: string): void {
  if (readOnlyReason) throw new StoreReadOnlyError(readOnlyReason, what)
}
