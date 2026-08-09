import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'

// Audit triggers must be REWRITTEN on every schema init, not created only when
// absent.
//
// 2026-08-09, live incident: an older build created the ZST triggers with a
// DOUBLE-quoted RAISE message. In SQLite double quotes mean an identifier, and
// only the legacy string fallback made it work — until a table rebuild forced a
// re-parse of the whole schema, at which point it failed with "no such column"
// and the dashboard went into a boot loop. The corrected definition had been in
// the source for a long time; `IF NOT EXISTS` meant it never reached an install
// that already had the broken one.

function dbWithBrokenTrigger() {
  const db = new Database(':memory:')
  initCosSchema(db)
  // reproduce the historical shape exactly
  db.exec(`DROP TRIGGER IF EXISTS zevents_no_update`)
  db.exec(`CREATE TRIGGER zevents_no_update BEFORE UPDATE ON zst_case_events
           BEGIN SELECT RAISE(ABORT,"zst_case_events is append-only"); END`)
  return db
}

describe('audit trigger refresh', () => {
  it('re-running the schema REPLACES a broken trigger definition', () => {
    const db = dbWithBrokenTrigger()
    const before = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='zevents_no_update'`)
      .get() as { sql: string }).sql
    expect(before).toContain('"zst_case_events is append-only"')   // the bad one

    initCosSchema(db)

    const after = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='zevents_no_update'`)
      .get() as { sql: string }).sql
    expect(after).toContain("'zst_case_events is append-only'")     // single-quoted
    expect(after).not.toContain('"zst_case_events is append-only"')
  })

  it('a schema-altering statement no longer fails on the re-parse', () => {
    const db = dbWithBrokenTrigger()
    initCosSchema(db)
    // the operation that exposed the bug: renaming a table re-parses everything
    expect(() => {
      db.exec(`CREATE TABLE _probe (x INTEGER)`)
      db.exec(`ALTER TABLE _probe RENAME TO _probe2`)
      db.exec(`DROP TABLE _probe2`)
    }).not.toThrow()
  })

  it('all four append-only triggers use single quotes after init', () => {
    const db = new Database(':memory:')
    initCosSchema(db)
    const rows = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%append-only%'`
    ).all() as Array<{ name: string; sql: string }>
    expect(rows.length).toBe(4)
    for (const r of rows) expect(r.sql, r.name).not.toMatch(/RAISE\(ABORT,\s*"/)
  })

  it('the triggers still do their job — the audit log stays append-only', () => {
    const db = new Database(':memory:')
    initCosSchema(db)
    db.prepare(`INSERT INTO zst_cases (case_id, title, case_type, created_at, updated_at)
                VALUES ('z1','T','ADMIN',1,1)`).run()
    db.prepare(`INSERT INTO zst_case_events (case_id, case_version, actor, event_type, created_at)
                VALUES ('z1',1,'m','CREATED',1)`).run()
    expect(() => db.exec(`UPDATE zst_case_events SET actor='x'`)).toThrow(/append-only/)
    expect(() => db.exec(`DELETE FROM zst_case_events`)).toThrow(/append-only/)
  })
})
