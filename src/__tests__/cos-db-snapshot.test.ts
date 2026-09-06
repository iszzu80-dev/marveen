import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifiedSnapshot, isPlainCopyOfWalDatabase } from '../cos/db-snapshot.js'

// The lesson these cases hold was paid for on 2026-09-07: a `cp` of the live
// WAL-mode store was treated as a backup before a mutation, and it was the last
// CHECKPOINT rather than the moment. It happened to predate the run, which made
// it useful by luck. As a rollback artifact it was never valid.
//
// The first case below reproduces exactly that, so the claim is measured rather
// than asserted from memory.

describe('verified database snapshots', () => {
  let dir: string
  let src: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
    src = join(dir, 'live.db')
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)')
    db.prepare('INSERT INTO docs (body) VALUES (?)').run('before')
    db.close()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('THE LESSON: a plain cp of a WAL database misses committed rows', () => {
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    // Committed, and still living in the -wal until a checkpoint.
    for (let i = 0; i < 50; i++) db.prepare('INSERT INTO docs (body) VALUES (?)').run(`row-${i}`)
    const live = (db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n

    const naive = join(dir, 'naive-copy.db')
    copyFileSync(src, naive)                     // exactly what was done, and it is wrong
    db.close()

    const copied = new Database(naive, { readonly: true })
    const seen = (copied.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n
    copied.close()

    expect(live).toBe(51)
    // The copy is missing committed data. If this ever stops being true the
    // helper is no longer needed -- but it is true, and it is invisible from
    // the file alone.
    expect(seen).toBeLessThan(live)
  })

  it('flags a source whose -wal holds data, so a cp cannot be called evidence', () => {
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    db.prepare('INSERT INTO docs (body) VALUES (?)').run('uncheckpointed')
    expect(isPlainCopyOfWalDatabase(src)).toBe(true)
    db.close()
  })

  it('VACUUM INTO carries the committed rows the cp missed', () => {
    const db = new Database(src)
    db.pragma('journal_mode = WAL')
    for (let i = 0; i < 50; i++) db.prepare('INSERT INTO docs (body) VALUES (?)').run(`row-${i}`)
    db.close()

    const out = join(dir, 'verified.db')
    const ev = verifiedSnapshot(src, out, ['docs'])
    expect(ev.verified).toBe(true)
    expect(ev.integrity).toBe('ok')
    expect(ev.tables[0]).toMatchObject({ table: 'docs', source: 51, snapshot: 51, equal: true })
    expect(ev.problems).toEqual([])
    expect(ev.bytes).toBeGreaterThan(0)
  })

  it('refuses to verify against nothing', () => {
    // "Which rows must survive" is the caller's question to answer. A snapshot
    // checked against no table is checked against nothing.
    const ev = verifiedSnapshot(src, join(dir, 'empty-check.db'), [])
    expect(ev.verified).toBe(false)
    expect(ev.problems.join(' ')).toContain('proves nothing')
  })

  it('names a table it cannot read rather than passing', () => {
    const ev = verifiedSnapshot(src, join(dir, 'missing-table.db'), ['docs', 'no_such_table'])
    expect(ev.verified).toBe(false)
    expect(ev.problems.join(' ')).toContain('no_such_table')
    // The table it COULD read is still reported, so the failure is specific.
    expect(ev.tables.find((t) => t.table === 'docs')?.equal).toBe(true)
  })

  it('overwrites a stale file at the target instead of leaving it as "the backup"', () => {
    const out = join(dir, 'stale.db')
    writeFileSync(out, 'not a database at all')
    const ev = verifiedSnapshot(src, out, ['docs'])
    expect(ev.verified).toBe(true)
    expect(existsSync(out)).toBe(true)
  })

  it('reports a failure to take the snapshot at all, rather than claiming one', () => {
    const ev = verifiedSnapshot(src, join(dir, 'no', 'such', 'dir', 'x.db'), ['docs'])
    expect(ev.verified).toBe(false)
    expect(ev.bytes).toBe(0)
    expect(ev.problems.join(' ')).toContain('VACUUM INTO failed')
  })
})
