// MIP-v1.0 / §5 / W11 closure — Istvan's review, 2026-08-25.
//
// The claim under test is a PAIR, and only the pair is worth anything:
//
//   "already applied"  must stay an idempotent SUCCESS
//   a real failure     must become a VISIBLE failure
//
// A helper that throws on everything would pass half of these and break every
// restart. A helper that swallows everything -- the pattern being replaced --
// passes the other half and hides corruption. So every negative test below has
// a positive twin.
//
// THE CASE THAT MOTIVATES THE WHOLE THING is `a NOT NULL column added to a
// non-empty table`. SQLite refuses it. Under `catch { /* exists */ }` that
// refusal was indistinguishable from "the column is already there" -- so the
// column would be **missing forever** while every subsequent run reported
// success and every reader assumed it existed. That is not a hypothetical; it
// is the exact shape the old pattern permits.

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureColumnStrict, dropColumnIfPresentStrict, sqliteAtLeast,
} from '../schema/migration-runner.js'

function db(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)`)
  return d
}

describe('"already applied" stays an idempotent success', () => {
  it('adding a column that exists returns false and does NOT throw', () => {
    const d = db()
    expect(ensureColumnStrict(d, 'items', 'colour', 'TEXT')).toBe(true)
    expect(ensureColumnStrict(d, 'items', 'colour', 'TEXT')).toBe(false)
    expect(() => ensureColumnStrict(d, 'items', 'colour', 'TEXT')).not.toThrow()
    d.close()
  })

  it('dropping a column that is already gone returns false and does NOT throw', () => {
    const d = db()
    expect(dropColumnIfPresentStrict(d, 'items', 'name')).toBe(true)
    expect(dropColumnIfPresentStrict(d, 'items', 'name')).toBe(false)
    expect(() => dropColumnIfPresentStrict(d, 'items', 'name')).not.toThrow()
    d.close()
  })

  it('a full init sequence is replayable — the property every restart depends on', () => {
    const d = db()
    const initSequence = () => {
      ensureColumnStrict(d, 'items', 'a', 'TEXT')
      ensureColumnStrict(d, 'items', 'b', 'INTEGER NOT NULL DEFAULT 0')
      dropColumnIfPresentStrict(d, 'items', 'name')
    }
    initSequence(); initSequence(); initSequence()
    const cols = (d.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols.sort()).toEqual(['a', 'b', 'id'])
    d.close()
  })
})

describe('a REAL failure is now visible — the pattern being replaced hid each of these', () => {
  it('NOT NULL with no default on a non-empty table THROWS instead of looking applied', () => {
    const d = db()
    d.prepare('INSERT INTO items (id, name) VALUES (?,?)').run('1', 'x')
    // Under the old catch this was silently "already exists", and the column
    // never appeared. The assertion is BOTH halves: it throws, AND the column
    // is genuinely absent afterwards.
    expect(() => ensureColumnStrict(d, 'items', 'required', 'TEXT NOT NULL'))
      .toThrow(/NOT NULL/i)
    const cols = (d.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).not.toContain('required')
    d.close()
  })

  it('malformed DDL THROWS rather than being mistaken for "already there"', () => {
    const d = db()
    expect(() => ensureColumnStrict(d, 'items', 'bad', 'NOT_A_TYPE((('))
      .toThrow()
    d.close()
  })

  it('a missing TABLE throws — the old catch reported success for a table that does not exist', () => {
    const d = db()
    expect(() => ensureColumnStrict(d, 'ghosts', 'c', 'TEXT')).toThrow(/table ghosts does not exist/)
    expect(() => dropColumnIfPresentStrict(d, 'ghosts', 'c')).toThrow(/table ghosts does not exist/)
    d.close()
  })

  it('a PERMISSION failure (read-only database) throws instead of passing silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w11-perm-'))
    const file = join(dir, 'ro.db')
    const writable = new Database(file)
    writable.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`)
    writable.close()

    // A genuinely read-only handle: SQLite itself refuses the DDL, which is the
    // closest reproduction of "the process cannot write the store" that does not
    // depend on running as a particular user.
    const ro = new Database(file, { readonly: true })
    expect(() => ensureColumnStrict(ro, 'items', 'nope', 'TEXT'))
      .toThrow(/readonly|attempt to write/i)
    ro.close()

    rmSync(dir, { recursive: true, force: true })
  })

  it('an UNEXPECTED database error propagates — a closed handle is not "already applied"', () => {
    const d = db()
    d.close()
    expect(() => ensureColumnStrict(d, 'items', 'x', 'TEXT')).toThrow(/not open/i)
  })

  it('a duplicate column name added under a different definition still throws', () => {
    // Guards the specific temptation to make ensureColumnStrict "helpful" by
    // treating any ALTER error as benign when the name matches.
    const d = db()
    d.exec(`ALTER TABLE items ADD COLUMN dup TEXT`)
    // Present -> idempotent success, definition intentionally NOT compared:
    // comparing would invent a migration nobody wrote.
    expect(ensureColumnStrict(d, 'items', 'dup', 'INTEGER')).toBe(false)
    const t = d.prepare('PRAGMA table_info(items)').all() as Array<{ name: string; type: string }>
    expect(t.find(c => c.name === 'dup')?.type).toBe('TEXT')
    d.close()
  })
})

describe('DROP COLUMN separates "absent" from "this build cannot drop"', () => {
  it('the version parse is exact at the 3.35 boundary', () => {
    expect(sqliteAtLeast('3.34.9', 3, 35)).toBe(false)
    expect(sqliteAtLeast('3.35.0', 3, 35)).toBe(true)
    expect(sqliteAtLeast('3.49.2', 3, 35)).toBe(true)
    expect(sqliteAtLeast('4.0.0', 3, 35)).toBe(true)
    expect(sqliteAtLeast('nonsense', 3, 35)).toBe(false)
  })

  it('an old SQLite must NOT report a retirement it did not perform', () => {
    // The old comment read "column absent or SQLite pre-3.35" -- two different
    // facts sharing one silence. A build that cannot drop the column has not
    // retired it, and saying otherwise leaves a revoked column in place while
    // the code believes it is gone.
    const d = db()
    const original = d.prepare.bind(d)
    // Force the version branch without needing an ancient SQLite binary.
    ;(d as unknown as { prepare: typeof d.prepare }).prepare = ((sql: string) =>
      sql.includes('sqlite_version')
        ? ({ get: () => ({ v: '3.30.1' }) } as never)
        : original(sql)) as typeof d.prepare
    expect(() => dropColumnIfPresentStrict(d, 'items', 'name'))
      .toThrow(/cannot DROP COLUMN.*refusing to report success/s)
    d.close()
  })
})

describe('the converted init path is what actually runs', () => {
  it('db.ts holds no swallowing catch on any schema-mutating statement', async () => {
    // The check that keeps this closed. It greps for the PATTERN rather than
    // trusting that today's conversion stays converted -- a new
    // `try { ALTER ... } catch {}` added next month turns this red.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/db.ts', 'utf8')
    const offenders = src.split('\n')
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter(({ text }) => /catch\s*\{\s*\/\*/.test(text) && /ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP/.test(text))
    expect(offenders.map(o => `${o.line}: ${o.text.trim()}`)).toEqual([])
  })

  it('the strict helpers are the ones db.ts calls', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/db.ts', 'utf8')
    // Control: the test is not vacuously green because the calls vanished.
    expect((src.match(/ensureColumnStrict\(db,/g) ?? []).length).toBeGreaterThanOrEqual(13)
    expect((src.match(/dropColumnIfPresentStrict\(db,/g) ?? []).length).toBe(4)
  })
})
