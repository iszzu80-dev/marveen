import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'

// P1.1 migration: an existing db carries the PRE-P1.1 outbound_ledger (old CHECK
// with APPLIED/FAILED, no external_idempotency_marker column). initCosSchema must
// rebuild it in place — new CHECK + new column — while preserving rows and
// mapping legacy states. SQLite cannot ALTER a CHECK, so this proves the
// rename-copy-drop path works and does not lose data.

// The pre-P1.1 outbound_ledger definition, verbatim from before the refinement.
const OLD_OUTBOUND = `
  CREATE TABLE outbound_ledger (
    ledger_id                TEXT PRIMARY KEY,
    case_id                  TEXT REFERENCES personal_cases(case_id),
    action_type             TEXT NOT NULL,
    sequence_number         INTEGER NOT NULL,
    internal_idempotency_key TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'PLANNED',
    payload                 TEXT,
    external_ref            TEXT,
    claim_fence             INTEGER,
    attempt                 INTEGER NOT NULL DEFAULT 0,
    last_error              TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    sending_at              INTEGER,
    applied_at              INTEGER,
    verified_at             INTEGER,
    UNIQUE(internal_idempotency_key),
    UNIQUE(case_id, action_type, sequence_number),
    CHECK (status IN ('PLANNED','SENDING','APPLIED','OUTCOME_UNKNOWN',
      'VERIFIED','FAILED','RECOVERY_REQUIRED'))
  )`

describe('outbound_ledger P1.1 migration', () => {
  it('rebuilds a pre-P1.1 table, mapping legacy states and back-filling the marker', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // 1. Full current schema (gives us a real personal_cases for the FK).
    initCosSchema(db)
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
    // 2. Replace outbound_ledger with the OLD shape + rows in legacy states.
    db.exec('DROP TABLE outbound_ledger')
    db.exec(OLD_OUTBOUND)
    const ins = db.prepare(
      `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
        internal_idempotency_key, status, external_ref, attempt, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?)`
    )
    ins.run('ob-1', 'c1', 'EMAIL_SEND', 1, 'mv-c1-EMAIL_SEND-1', 'APPLIED', 'ext-1', 900, 900)
    ins.run('ob-2', 'c1', 'EMAIL_SEND', 2, 'mv-c1-EMAIL_SEND-2', 'FAILED', null, 900, 900)
    ins.run('ob-3', 'c1', 'EMAIL_SEND', 3, 'mv-c1-EMAIL_SEND-3', 'PLANNED', null, 900, 900)
    ins.run('ob-4', 'c1', 'EMAIL_SEND', 4, 'mv-c1-EMAIL_SEND-4', 'VERIFIED', 'ext-4', 900, 900)

    // 3. Re-run schema init → detects the old shape (no marker col) and migrates.
    initCosSchema(db)

    // The new column exists now.
    const cols = (db.prepare('PRAGMA table_info(outbound_ledger)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('external_idempotency_marker')
    // The temp table is gone.
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='outbound_ledger_pre_p11'`).get()).toBeUndefined()

    // Rows preserved, legacy states mapped, marker back-filled to the internal key.
    const rows = db.prepare('SELECT ledger_id, status, external_idempotency_marker, internal_idempotency_key, external_ref FROM outbound_ledger ORDER BY ledger_id').all() as any[]
    expect(rows).toHaveLength(4)
    const byId = Object.fromEntries(rows.map(r => [r.ledger_id, r]))
    expect(byId['ob-1'].status).toBe('APPLIED_UNVERIFIED') // APPLIED → APPLIED_UNVERIFIED
    expect(byId['ob-2'].status).toBe('FAILED_TERMINAL')    // FAILED → FAILED_TERMINAL (conservative)
    expect(byId['ob-3'].status).toBe('PLANNED')            // unchanged
    expect(byId['ob-4'].status).toBe('VERIFIED')           // unchanged
    for (const r of rows) expect(r.external_idempotency_marker).toBe(r.internal_idempotency_key)
    expect(byId['ob-1'].external_ref).toBe('ext-1') // non-state fields intact

    // The new CHECK is live: a legacy value is now rejected, a new one accepted.
    expect(() => db.prepare(`UPDATE outbound_ledger SET status='APPLIED' WHERE ledger_id='ob-3'`).run()).toThrow()
    expect(() => db.prepare(`UPDATE outbound_ledger SET status='CANCELLED' WHERE ledger_id='ob-3'`).run()).not.toThrow()
  })

  it('is idempotent — a second init on the already-migrated table is a no-op', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    initCosSchema(db)
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
    db.prepare(
      `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
        internal_idempotency_key, external_idempotency_marker, status, attempt, created_at, updated_at)
       VALUES ('ob-1','c1','EMAIL_SEND',1,'k1','k1','PLANNED',0,900,900)`
    ).run()
    initCosSchema(db) // no old table → nothing to migrate
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='outbound_ledger_pre_p11'`).get()).toBeUndefined()
    expect(db.prepare('SELECT count(*) c FROM outbound_ledger').get()).toEqual({ c: 1 })
  })
})
