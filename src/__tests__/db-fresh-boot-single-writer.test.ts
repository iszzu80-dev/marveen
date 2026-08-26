import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// FRESH_STORE_CONCURRENT_BOOT_SAFETY — the Phase 0 blocker the owner kept open
// on 2026-08-26, closed here and PROVEN rather than asserted.
//
// W12 named this gap and declined to close it statement by statement, for a
// reason that still holds: `initDatabase` is ~970 lines of DDL, every
// `PRAGMA table_info` + `ALTER TABLE` pair in it is check-then-act, and fixing
// the site that happens to fail moves the failure to the next one. MEASURED on
// develop @1adf2a23, four processes over one fresh store, twelve rounds:
// 47 boots OK, 1 dead at startup with `duplicate column name: trace_id`
// (db.ts:742, a raw check-then-act with no catch). Against the PINNED live
// runtime the same race gives 13 failures in 60 across five distinct errors.
//
// So the close is infrastructural: one writer at a time, enforced by SQLite's
// RESERVED lock on a sidecar database, which is an OS file lock and not a
// convention. See src/db-bootstrap-lock.ts.
//
// WHAT THIS TEST ASSERTS, and why "nobody crashed" is not enough. Six green
// boots could be six lucky interleavings. The lock writes a ledger row per
// holder with the interval it held the lock for, so the real assertion is
// MUTUAL EXCLUSION: N rows, no two intervals overlapping, and contenders that
// measurably blocked. That is a claim about what the machine did, not about
// what did not happen to go wrong.
//
// RED-CAPABILITY is not left to the reader either: the last case runs the same
// race with the lock disabled by env and requires the failures to come back.
// A guard nobody has driven into the red is a guard nobody has checked.

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const WORKER = join(process.cwd(), 'src', '__tests__', 'helpers', 'fresh-boot-worker.ts')
const PEERS = 4

interface WorkerLine {
  tag: string; pid: number; ok: boolean
  startedAt: number; finishedAt: number
  locked?: boolean; waitedMs?: number; tables?: number; lockSidecar?: boolean
  error?: string
}

function runWorker(dbPath: string, tag: string, env: NodeJS.ProcessEnv = {}): Promise<WorkerLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [WORKER, '--db', dbPath, '--tag', tag, '--peers', String(PEERS)], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''; let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      // The logger writes to stdout too (the lock logs its contention), so the
      // worker's verdict is the last line that parses AND carries `ok` --
      // not simply the last line.
      const parsed = out.split('\n')
        .map((l) => { try { return JSON.parse(l.trim()) as WorkerLine } catch { return null } })
        .filter((v): v is WorkerLine => v !== null && typeof v.ok === 'boolean')
        .pop()
      if (!parsed) return reject(new Error(`worker ${tag} produced no verdict (exit ${code}): ${err.slice(-800)}`))
      resolve(parsed)
    })
  })
}

function raceBoot(dbPath: string, env: NodeJS.ProcessEnv = {}): Promise<WorkerLine[]> {
  return Promise.all(
    Array.from({ length: PEERS }, (_, i) => runWorker(dbPath, String.fromCharCode(65 + i), env)),
  )
}

describe('fresh store, concurrent first boot (Phase 0 blocker closure)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fresh-boot-'))
    dbPath = join(dir, 'claudeclaw.db')
    // Nothing pre-creates the store. That is the point: an EXISTING store
    // re-boots without altering anything, so a test that seeds the schema first
    // cannot see this defect at all.
    expect(existsSync(dbPath)).toBe(false)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('four processes bootstrap one brand-new store: none dies, all end usable', async () => {
    const results = await raceBoot(dbPath)

    const failed = results.filter((r) => !r.ok)
    expect(failed.map((f) => `${f.tag}: ${f.error}`)).toEqual([])

    // Every worker must end with a store it can actually query, and they must
    // agree on what they see -- a half-built schema that threw nothing would
    // show up here as a differing table count.
    const counts = new Set(results.map((r) => r.tables))
    expect(counts.size).toBe(1)
    expect([...counts][0]!).toBeGreaterThan(20)
    expect(results.every((r) => r.locked === true)).toBe(true)
  }, 120_000)

  it('holds the lock mutually exclusively, and the contenders really blocked', async () => {
    const results = await raceBoot(dbPath)
    expect(results.every((r) => r.ok)).toBe(true)

    const lockPath = `${dbPath}.bootlock`
    expect(existsSync(lockPath)).toBe(true)
    // The sidecar sits in STORE_DIR next to the database; it must not be
    // world-readable either.
    expect(statSync(lockPath).mode & 0o077).toBe(0)

    const lock = new Database(lockPath, { readonly: true })
    const rows = lock.prepare(
      'SELECT pid, started_ms, ended_ms, waited_ms FROM bootstrap_holders ORDER BY started_ms',
    ).all() as Array<{ pid: number; started_ms: number; ended_ms: number; waited_ms: number }>
    lock.close()

    // One row per process: the ledger is written INSIDE the critical section, so
    // a missing row means a process bootstrapped without the lock.
    expect(rows).toHaveLength(PEERS)
    expect(new Set(rows.map((r) => r.pid)).size).toBe(PEERS)

    // The assertion that matters. Sorted by start, each holder must begin after
    // the previous one ended.
    const overlaps = rows.filter((r, i) => i > 0 && r.started_ms < rows[i - 1]!.ended_ms)
    expect(overlaps).toEqual([])

    // ...and they must have been genuinely contending. Zero blocked workers
    // would mean the processes never overlapped, which makes the run above a
    // test of nothing -- exactly the failure mode of W12's first race test.
    expect(rows.filter((r) => r.waited_ms > 0).length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('RED: with the lock disabled, the same race breaks the boot again', async () => {
    // Same code, same processes, one env var. Anything green here would mean
    // the two cases above pass for a reason other than the lock.
    //
    // The race is probabilistic by nature, so this retries the round rather than
    // asserting a single run fails -- and it FAILS the test if the defect never
    // reappears, instead of quietly accepting a lucky green.
    let sawFailure: string | null = null
    for (let round = 0; round < 6 && sawFailure === null; round++) {
      const roundDir = mkdtempSync(join(tmpdir(), 'fresh-boot-red-'))
      const roundDb = join(roundDir, 'claudeclaw.db')
      try {
        const results = await raceBoot(roundDb, { MARVEEN_BOOTSTRAP_LOCK_DISABLED: '1' })
        const failure = results.find((r) => !r.ok)
        if (failure) sawFailure = failure.error ?? 'unknown'
      } finally {
        rmSync(roundDir, { recursive: true, force: true })
      }
    }
    expect(sawFailure, 'the unlocked bootstrap survived 6 rounds of a 4-way race; either the race got weaker or the guard is no longer what makes it safe').not.toBeNull()
  }, 300_000)
})
