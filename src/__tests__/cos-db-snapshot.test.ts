import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifiedSnapshot, verifySnapshotAgainst, isPlainCopyOfWalDatabase } from '../cos/db-snapshot.js'

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
    // The digest is the proof, not the count.
    expect(ev.tables[0].sourceDigest).toHaveLength(64)
    expect(ev.tables[0].snapshotDigest).toBe(ev.tables[0].sourceDigest)
    expect(ev.problems).toEqual([])
    expect(ev.bytes).toBeGreaterThan(0)
  })

  it('DBSNAP-001/003: a tampered snapshot FAILS verification, same row count and all', () => {
    // The earlier version of this case only observed that two digests differed
    // and never saw `verified` come back false -- not the same claim, as the
    // review pointed out. This one re-verifies the tampered file against the
    // untouched source and reads the verdict.
    const out = join(dir, 'tampered.db')
    expect(verifiedSnapshot(src, out, ['docs']).verified).toBe(true)

    const t = new Database(out)
    t.prepare("UPDATE docs SET body='after' WHERE body='before'").run()  // same count
    t.close()

    const again = verifySnapshotAgainst(src, out, ['docs'])
    expect(again.verified).toBe(false)
    expect(again.tables[0].source).toBe(again.tables[0].snapshot)   // counts agree
    expect(again.problems.join(' ')).toContain('content digest differs')
  })

  it('re-verifying an UNTAMPERED snapshot still passes', () => {
    // The mirror, so the case above cannot pass by the verifier simply always
    // refusing on the re-verify path.
    const out = join(dir, 'intact.db')
    expect(verifiedSnapshot(src, out, ['docs']).verified).toBe(true)
    expect(verifySnapshotAgainst(src, out, ['docs']).verified).toBe(true)
  })

  it('DBSNAP-002: framing is unambiguous, so contents cannot collide', () => {
    // Separator bytes are not enough: a prefix can occur INSIDE a value, and
    // two different rows could then line up into the same byte stream. Each
    // value carries its type and byte length, which its own contents cannot
    // re-frame.
    const db = new Database(src)
    db.exec('CREATE TABLE frames (a, b)')
    db.prepare('INSERT INTO frames (a,b) VALUES (?,?)').run('x', 'yz')
    db.close()
    const first = verifiedSnapshot(src, join(dir, 'f1.db'), ['frames'])

    const db2 = new Database(src)
    db2.prepare("UPDATE frames SET a='xy', b='z'").run()   // same concatenation
    db2.close()
    const second = verifiedSnapshot(src, join(dir, 'f2.db'), ['frames'])

    expect(first.tables[0].source).toBe(second.tables[0].source)
    expect(first.tables[0].sourceDigest).not.toBe(second.tables[0].sourceDigest)
  })

  it('distinguishes NULL from an empty string, and 1 from "1"', () => {
    // A digest that collapses these would pass a snapshot that lost type
    // information -- which is a different database wearing the same counts.
    const db = new Database(src)
    db.exec('CREATE TABLE typed (a)')
    db.prepare('INSERT INTO typed (a) VALUES (?)').run(null)
    db.close()
    const withNull = verifiedSnapshot(src, join(dir, 'a.db'), ['typed'])

    const db2 = new Database(src)
    db2.prepare("UPDATE typed SET a=''").run()
    db2.close()
    const withEmpty = verifiedSnapshot(src, join(dir, 'b.db'), ['typed'])

    expect(withNull.tables[0].source).toBe(withEmpty.tables[0].source)
    expect(withNull.tables[0].sourceDigest).not.toBe(withEmpty.tables[0].sourceDigest)
  })

  it('DBSNAP-004: the digest covers COLUMN IDENTITY, not just ordered values', () => {
    // A table whose columns were renamed or reordered holds the same bytes
    // meaning something different. Hashing only the values would mark that
    // equal -- the schema is part of the content.
    const db = new Database(src)
    db.exec('CREATE TABLE named (alpha, beta)')
    db.prepare('INSERT INTO named (alpha,beta) VALUES (?,?)').run('x', 'y')
    db.close()
    const before = verifiedSnapshot(src, join(dir, 'n1.db'), ['named'])

    const db2 = new Database(src)
    db2.exec('ALTER TABLE named RENAME COLUMN beta TO gamma')
    db2.close()
    const after = verifiedSnapshot(src, join(dir, 'n2.db'), ['named'])

    expect(before.tables[0].source).toBe(after.tables[0].source)      // same rows
    expect(before.tables[0].sourceDigest).not.toBe(after.tables[0].sourceDigest)
  })

  it('...and a declared type change is a content change too -- SAME table name', () => {
    // Codex review DBSNAP-006: the first version of this case compared tables
    // called typed2 and typed3, and the digest also hashes the table NAME. It
    // would have passed with declared types removed entirely. Same name, two
    // databases, only the type differs.
    const mk = (decl: string, file: string): string => {
      const path = join(dir, file)
      const db = new Database(path)
      db.exec(`CREATE TABLE same_name (a ${decl})`)
      db.prepare("INSERT INTO same_name (a) VALUES ('1')").run()
      db.close()
      return verifiedSnapshot(path, join(dir, `snap-${file}`), ['same_name']).tables[0].sourceDigest
    }
    expect(mk('TEXT', 'ty-text.db')).not.toBe(mk('INTEGER', 'ty-int.db'))
  })

  it('DBSNAP-005: big integers do not round into each other', () => {
    // SQLite INTEGERs above JavaScript's safe range come back as doubles by
    // default. Two distinct ids -- exactly what a store uses as a key -- would
    // lose precision and digest identically.
    const a = join(dir, 'big-a.db'); const b = join(dir, 'big-b.db')
    for (const [path, v] of [[a, '9007199254740993'], [b, '9007199254740995']] as const) {
      const db = new Database(path)
      db.exec('CREATE TABLE big (id INTEGER)')
      db.exec(`INSERT INTO big (id) VALUES (${v})`)
      db.close()
    }
    const da = verifiedSnapshot(a, join(dir, 'sa.db'), ['big']).tables[0].sourceDigest
    const db2 = verifiedSnapshot(b, join(dir, 'sb.db'), ['big']).tables[0].sourceDigest
    expect(da).not.toBe(db2)
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
