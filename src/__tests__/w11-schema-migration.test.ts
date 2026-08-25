// MIP-v1.0 / §5 / W11_DURABLE_SCHEMA_MIGRATION.
//
// §5.6 names eight required scenarios. Each has a test below, and each asserts
// on OBSERVABLE STATE (was the column added, was the row written, is the store
// latched) rather than only on the runner's own return value -- a runner that
// lies about what it did would pass the second kind of test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  STORE_SCHEMA_VERSION, adoptUnversionedStore, checkStoreSchema, initStoreSchemaState,
  readStoreSchemaState, setStoreReadOnly, storeReadOnlyReason, assertWritable,
  StoreReadOnlyError, markVerified,
} from '../schema/store-schema.js'
import {
  ensureColumnStrict, runMigrations, readMigrationLedger, clearInFlightAfterRepair,
  type Migration,
} from '../schema/migration-runner.js'

const T0 = 1_787_000_000

function fresh(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)`)
  initStoreSchemaState(db)
  return db
}

/** A minimal, well-formed migration: adds a column and verifies it landed. */
function addColumn(id: string, col: string, toVersion = 1): Migration {
  return {
    id, toVersion,
    description: `add ${col} to widgets`,
    up: ({ db }) => { ensureColumnStrict(db, 'widgets', col, 'TEXT') },
    verify: ({ db }) => {
      const cols = db.prepare(`PRAGMA table_info(widgets)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === col)) throw new Error(`${col} missing after migration`)
      return `widgets.${col} present`
    },
  }
}

afterEach(() => setStoreReadOnly(null))

describe('§5.6 empty database / state', () => {
  it('an unversioned store is ADOPTED, not rejected — that is every existing install', () => {
    const db = fresh()
    expect(readStoreSchemaState(db).version).toBe(0)
    expect(adoptUnversionedStore(db, T0)).toBe(true)
    const check = checkStoreSchema(db, T0)
    expect(check.verdict).toBe('OK')
    expect(check.readOnly).toBe(false)
    expect(readStoreSchemaState(db).version).toBe(STORE_SCHEMA_VERSION)
    db.close()
  })

  it('adoption is itself idempotent — a second call does not re-stamp', () => {
    const db = fresh()
    expect(adoptUnversionedStore(db, T0)).toBe(true)
    expect(adoptUnversionedStore(db, T0 + 500)).toBe(false)
    expect(readStoreSchemaState(db).updatedAt).toBe(T0)
    db.close()
  })

  it('migrations run on a completely empty store', () => {
    const db = fresh()
    const r = runMigrations(db, [addColumn('2026-08-25-a', 'colour')], { nowSec: T0 })
    expect(r[0].result).toBe('APPLIED')
    expect(readStoreSchemaState(db).version).toBe(1)
    db.close()
  })
})

describe('§5.6 n-1 -> n migration', () => {
  it('moves the store version forward and records what it verified', () => {
    const db = fresh()
    adoptUnversionedStore(db, T0)
    db.prepare('UPDATE store_schema_state SET version = 0 WHERE id = 1').run()

    const r = runMigrations(db, [addColumn('2026-08-25-b', 'size', 1)], { nowSec: T0 })
    expect(r[0].result).toBe('APPLIED')
    expect(readStoreSchemaState(db).version).toBe(1)

    const led = readMigrationLedger(db)
    expect(led[0].state).toBe('APPLIED')
    expect(led[0].fromVersion).toBe(0)
    expect(led[0].toVersion).toBe(1)
    // The ledger keeps WHAT was verified, not merely THAT something was.
    expect(led[0].verification).toBe('widgets.size present')
    db.close()
  })
})

describe('§5.6 duplicate execution / retry', () => {
  it('running the same migration twice applies it once and corrupts nothing', () => {
    const db = fresh()
    let bodyRuns = 0
    const m: Migration = {
      ...addColumn('2026-08-25-c', 'weight'),
      up: ({ db }) => { bodyRuns += 1; ensureColumnStrict(db, 'widgets', 'weight', 'TEXT') },
    }
    expect(runMigrations(db, [m], { nowSec: T0 })[0].result).toBe('APPLIED')
    expect(runMigrations(db, [m], { nowSec: T0 + 10 })[0].result).toBe('SKIPPED')
    expect(bodyRuns).toBe(1)
    expect(readMigrationLedger(db)).toHaveLength(1)
    db.close()
  })

  it('a FAILED migration is retried, and a retry that succeeds flips the ledger row', () => {
    const db = fresh()
    let attempt = 0
    const flaky: Migration = {
      id: '2026-08-25-d', toVersion: 1, description: 'fails once',
      up: ({ db }) => {
        attempt += 1
        if (attempt === 1) throw new Error('transient')
        ensureColumnStrict(db, 'widgets', 'depth', 'TEXT')
      },
      verify: ({ db }) => {
        const cols = db.prepare(`PRAGMA table_info(widgets)`).all() as Array<{ name: string }>
        if (!cols.some(c => c.name === 'depth')) throw new Error('depth missing')
        return 'widgets.depth present'
      },
    }
    expect(runMigrations(db, [flaky], { nowSec: T0 })[0].result).toBe('FAILED')
    expect(readMigrationLedger(db)[0].state).toBe('FAILED')
    // The failed attempt rolled back, so the store is NOT latched and the retry
    // is allowed. "Failed" and "applied" must never be the same ledger state.
    expect(readStoreSchemaState(db).inFlightMigrationId).toBeNull()

    expect(runMigrations(db, [flaky], { nowSec: T0 + 60 })[0].result).toBe('APPLIED')
    const led = readMigrationLedger(db)
    expect(led).toHaveLength(1)
    expect(led[0].state).toBe('APPLIED')
    db.close()
  })
})

describe('§5.6 migration interruption — partial failure is DETECTABLE', () => {
  it('a non-transactional failure LEAVES the in-flight marker and latches writes', () => {
    const db = fresh()
    const halfway: Migration = {
      id: '2026-08-25-e', toVersion: 1, description: 'dies halfway', nonTransactional: true,
      up: ({ db }) => {
        ensureColumnStrict(db, 'widgets', 'half', 'TEXT')
        throw new Error('interrupted after the column, before the data')
      },
      verify: () => 'never reached',
    }
    expect(runMigrations(db, [halfway], { nowSec: T0 })[0].result).toBe('FAILED')

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR: a ledger of successes cannot
    // tell "never ran" from "started and died". The in-flight marker can.
    const st = readStoreSchemaState(db)
    expect(st.inFlightMigrationId).toBe('2026-08-25-e')

    const check = checkStoreSchema(db, T0 + 1)
    expect(check.verdict).toBe('PARTIAL_MIGRATION')
    expect(check.readOnly).toBe(true)
    db.close()
  })

  it('a further run is REFUSED while one is in flight', () => {
    const db = fresh()
    const halfway: Migration = {
      id: 'x-1', toVersion: 1, description: 'dies', nonTransactional: true,
      up: () => { throw new Error('boom') }, verify: () => 'n/a',
    }
    runMigrations(db, [halfway], { nowSec: T0 })
    const second = runMigrations(db, [addColumn('x-2', 'later')], { nowSec: T0 + 5 })
    expect(second[0].result).toBe('REFUSED')
    expect(second[0].reason).toMatch(/still in flight/)
    db.close()
  })

  it('repair is explicit and human-driven, never automatic', () => {
    const db = fresh()
    const halfway: Migration = {
      id: 'x-3', toVersion: 1, description: 'dies', nonTransactional: true,
      up: () => { throw new Error('boom') }, verify: () => 'n/a',
    }
    runMigrations(db, [halfway], { nowSec: T0 })
    expect(clearInFlightAfterRepair(db, 'not-that-one', 'wrong id', T0)).toBe(false)
    expect(clearInFlightAfterRepair(db, 'x-3', 'rolled back by hand', T0 + 100)).toBe(true)
    expect(checkStoreSchema(db, T0 + 101).verdict).toBe('OK')
    expect(readMigrationLedger(db)[0].error).toMatch(/repaired: rolled back by hand/)
    db.close()
  })
})

describe('§5.6 malformed legacy state', () => {
  it('a migration whose precheck refuses does not run, and stops the list', () => {
    const db = fresh()
    let laterRan = false
    const refusing: Migration = {
      ...addColumn('m-1', 'never'),
      precheck: () => 'legacy rows carry a status this migration cannot map',
    }
    const later: Migration = {
      ...addColumn('m-2', 'also-never'),
      up: () => { laterRan = true },
    }
    const r = runMigrations(db, [refusing, later], { nowSec: T0 })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/pre-migration compatibility check refused/)
    expect(laterRan).toBe(false)
    const cols = db.prepare(`PRAGMA table_info(widgets)`).all() as Array<{ name: string }>
    expect(cols.some(c => c.name === 'never')).toBe(false)
    db.close()
  })

  it('ensureColumnStrict fails LOUDLY on a missing table, instead of swallowing it', () => {
    const db = fresh()
    // This is the whole difference from `try { ALTER } catch { /* exists */ }`:
    // that pattern reports success for a table that does not exist.
    expect(() => ensureColumnStrict(db, 'no_such_table', 'c', 'TEXT')).toThrow(/does not exist/)
    db.close()
  })

  it('ensureColumnStrict is idempotent by LOOKING, not by failing', () => {
    const db = fresh()
    expect(ensureColumnStrict(db, 'widgets', 'tint', 'TEXT')).toBe(true)
    expect(ensureColumnStrict(db, 'widgets', 'tint', 'TEXT')).toBe(false)
    db.close()
  })
})

describe('§5.6 newer-than-supported schema — fail closed', () => {
  it('a store from newer code drops to READ-ONLY and says so', () => {
    const db = fresh()
    adoptUnversionedStore(db, T0)
    db.prepare('UPDATE store_schema_state SET version = ? WHERE id = 1').run(STORE_SCHEMA_VERSION + 7)

    const check = checkStoreSchema(db, T0)
    expect(check.verdict).toBe('FUTURE_UNSUPPORTED')
    expect(check.readOnly).toBe(true)
    expect(check.reason).toMatch(new RegExp(`version ${STORE_SCHEMA_VERSION + 7}`))
    db.close()
  })

  it('the read-only latch actually refuses a write', () => {
    setStoreReadOnly(null)
    expect(() => assertWritable('open a case')).not.toThrow()
    setStoreReadOnly('store written by newer code')
    expect(storeReadOnlyReason()).toMatch(/newer code/)
    expect(() => assertWritable('open a case')).toThrow(StoreReadOnlyError)
    expect(() => assertWritable('open a case')).toThrow(/refusing to open a case/)
  })

  it('a migration may not target a version this build does not declare', () => {
    const db = fresh()
    const r = runMigrations(db, [addColumn('too-new', 'x', STORE_SCHEMA_VERSION + 1)], { nowSec: T0 })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/bump the constant in the same commit/)
    db.close()
  })
})

describe('§5.3 verification and backups are not optional', () => {
  it('a migration with no verify() is refused BEFORE it runs', () => {
    const db = fresh()
    let ran = false
    const noVerify = {
      id: 'nv-1', toVersion: 1, description: 'no verification',
      up: () => { ran = true },
    } as unknown as Migration
    const r = runMigrations(db, [noVerify], { nowSec: T0 })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/verification is mandatory/)
    expect(ran).toBe(false)
    db.close()
  })

  it('a verify() that returns nothing useful FAILS the migration', () => {
    const db = fresh()
    const empty: Migration = { ...addColumn('ev-1', 'blank'), verify: () => '   ' }
    const r = runMigrations(db, [empty], { nowSec: T0 })
    expect(r[0].result).toBe('FAILED')
    expect(r[0].reason).toMatch(/no description of what it checked/)
    db.close()
  })

  it('a DESTRUCTIVE migration with no backup path is refused', () => {
    const db = fresh()
    const d: Migration = { ...addColumn('d-1', 'gone'), destructive: true }
    const r = runMigrations(db, [d], { nowSec: T0 })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/no backup path/)
    db.close()
  })

  it('a destructive migration takes the backup BEFORE the body runs', () => {
    const db = fresh()
    const order: string[] = []
    const d: Migration = {
      ...addColumn('d-2', 'risky'), destructive: true,
      up: ({ db }) => { order.push('body'); ensureColumnStrict(db, 'widgets', 'risky', 'TEXT') },
    }
    const r = runMigrations(db, [d], {
      nowSec: T0,
      backupPath: id => `/tmp/backup-${id}.db`,
      backup: () => { order.push('backup') },
    })
    expect(r[0].result).toBe('APPLIED')
    expect(order).toEqual(['backup', 'body'])
    expect(readMigrationLedger(db)[0].backupRef).toBe('/tmp/backup-d-2.db')
    db.close()
  })

  it('a failed backup refuses the destructive migration rather than proceeding', () => {
    const db = fresh()
    let bodyRan = false
    const d: Migration = {
      ...addColumn('d-3', 'nope'), destructive: true,
      up: () => { bodyRan = true },
    }
    const r = runMigrations(db, [d], {
      nowSec: T0,
      backupPath: id => `/tmp/backup-${id}.db`,
      backup: () => { throw new Error('disk full') },
    })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/backup failed/)
    expect(bodyRan).toBe(false)
    db.close()
  })
})

describe('the registry refuses a badly authored list before touching the store', () => {
  it('duplicate migration ids are refused', () => {
    const db = fresh()
    const r = runMigrations(db, [addColumn('dup', 'a'), addColumn('dup', 'b')], { nowSec: T0 })
    expect(r[0].result).toBe('REFUSED')
    expect(r[0].reason).toMatch(/duplicate migration id/)
    // Nothing ran: the check happens before the loop.
    expect(readMigrationLedger(db)).toHaveLength(0)
    db.close()
  })

  it('the version never moves backward, even if a migration says so', () => {
    const db = fresh()
    runMigrations(db, [addColumn('v-1', 'one', 1)], { nowSec: T0 })
    expect(readStoreSchemaState(db).version).toBe(1)
    runMigrations(db, [addColumn('v-0', 'zero', 0)], { nowSec: T0 + 1 })
    expect(readStoreSchemaState(db).version).toBe(1)
    db.close()
  })

  it('markVerified records when the store was last checked', () => {
    const db = fresh()
    adoptUnversionedStore(db, T0)
    markVerified(db, T0 + 900)
    expect(readStoreSchemaState(db).lastVerifiedAt).toBe(T0 + 900)
    db.close()
  })
})
