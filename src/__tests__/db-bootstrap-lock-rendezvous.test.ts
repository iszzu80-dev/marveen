// FRESH_BOOT_NEGATIVE_CONTROL — the owner's second Phase 1 pre-release blocker,
// 2026-08-27.
//
//   "A terhelésfüggő »lock nélkül néha elromlik« teszt ne maradjon flaky gating
//    test. Tedd determinisztikussá barrier/rendezvous/fault-injection
//    segítségével, VAGY minősítsd át külön stress/reproducer tesztté.
//    A normál release gate-ben a pozitív safety proof legyen determinisztikus:
//    concurrent boot; single-writer lock ownership; ownership interval overlap
//    = 0; crash releases lock; subsequent boot progresses."
//
// WHAT WAS WRONG WITH THE OLD PROOF. It was not wrong about the defect -- the
// race is real and was measured. It was wrong as an INSTRUMENT. Four processes
// raced the real bootstrap with the lock disabled, and the case retried up to
// six rounds until a failure appeared. That makes both of its answers weak: a
// green is what 47 of 48 unlocked boots produce anyway, and a red can be a
// quiet machine rather than a regression. The retry loop turned "does the defect
// occur" into "does it occur eventually", and the answer to the second question
// depends on load.
//
// WHAT REPLACES IT. A rendezvous inside the check-then-act window. The two
// processes either MEET in there or they provably do not, and which of the two
// happens is decided by the lock and nothing else:
//
//   lock ON    the second cannot enter while the first is inside. Nobody meets,
//              every holder sees an occupancy of exactly one, and the ledger
//              intervals do not overlap. Mutual exclusion, OBSERVED -- not
//              inferred from the absence of a crash.
//   lock OFF   both are inside at once, both read "the column is missing", both
//              ALTER, and the second dies with `duplicate column name`. Every
//              run, on every machine.
//
// The DDL in the probe is a faithful REPLICA of the shape the real bootstrap
// fails in (`PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN`, the raw
// check-then-act at db.ts:742 that produced `duplicate column name: trace_id`).
// The real 970 lines are still raced -- in the stress reproducer, which is where
// a load-dependent test belongs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const PROBE = join(process.cwd(), 'src', '__tests__', 'helpers', 'bootstrap-lock-probe.ts')
const PEERS = 3

interface ProbeLine {
  tag: string; pid: number; mode: string; ok: boolean
  rendezvousMet?: boolean; peakInside?: number
  locked?: boolean; waitedMs?: number; tables?: number; lockSidecar?: boolean
  error?: string
}

function probe(dbPath: string, tag: string, mode: string, env: NodeJS.ProcessEnv = {}, peers = PEERS): Promise<ProbeLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [PROBE, '--db', dbPath, '--tag', tag, '--peers', String(peers), '--mode', mode], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''; let err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    child.on('error', reject)
    child.on('close', code => {
      const parsed = out.split('\n')
        .map(l => { try { return JSON.parse(l.trim()) as ProbeLine } catch { return null } })
        .filter((v): v is ProbeLine => v !== null && typeof v.ok === 'boolean')
        .pop()
      if (!parsed) return reject(new Error(`probe ${tag} produced no verdict (exit ${code}): ${err.slice(-800)}`))
      resolve(parsed)
    })
  })
}

const race = (dbPath: string, mode: string, env: NodeJS.ProcessEnv = {}): Promise<ProbeLine[]> =>
  Promise.all(Array.from({ length: PEERS }, (_, i) => probe(dbPath, String.fromCharCode(65 + i), mode, env)))

function holders(dbPath: string): Array<{ pid: number; started_ms: number; ended_ms: number; waited_ms: number }> {
  const lock = new Database(`${dbPath}.bootlock`, { readonly: true })
  const rows = lock.prepare(
    'SELECT pid, started_ms, ended_ms, waited_ms FROM bootstrap_holders ORDER BY started_ms',
  ).all() as Array<{ pid: number; started_ms: number; ended_ms: number; waited_ms: number }>
  lock.close()
  return rows
}

describe('bootstrap lock, proven by rendezvous (deterministic)', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bootlock-rv-'))
    dbPath = join(dir, 'claudeclaw.db')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('POSITIVE: three concurrent boots, and NOBODY meets inside the critical section', async () => {
    const results = await race(dbPath, 'racy-ddl')

    expect(results.filter(r => !r.ok).map(r => `${r.tag}: ${r.error}`)).toEqual([])
    // THE MEASUREMENT. Each holder sat in the window for a fixed three seconds
    // and counted the room. Under a working lock the answer is always one, and
    // the rendezvous is never met -- which is what "single writer" means, said
    // as an observation rather than as the absence of an error.
    expect(results.map(r => r.peakInside)).toEqual([1, 1, 1])
    expect(results.map(r => r.rendezvousMet)).toEqual([false, false, false])
    expect(results.every(r => r.locked === true)).toBe(true)
  }, 120_000)

  it('POSITIVE: ownership intervals do not overlap, and every contender provably blocked', async () => {
    await race(dbPath, 'racy-ddl')
    const rows = holders(dbPath)

    expect(rows).toHaveLength(PEERS)
    expect(new Set(rows.map(r => r.pid)).size).toBe(PEERS)
    // Sorted by start: each holder begins after the previous one ended.
    expect(rows.filter((r, i) => i > 0 && r.started_ms < rows[i - 1]!.ended_ms)).toEqual([])

    // AND THE CONTENTION IS NOT LUCK. The first holder occupies the section for
    // three seconds by construction, so the other two MUST have waited. The old
    // suite could only ask for "at least one waited", and got it or did not
    // depending on how busy the box was.
    //
    // AT LEAST PEERS-1, not exactly: the first holder's `waited_ms` is the gap
    // between opening the sidecar and taking the RESERVED lock, which is 0 on an
    // idle box and occasionally 1-2ms under a loaded suite. Asserting `exactly
    // PEERS-1` made this test load-dependent in the one direction the whole
    // rewrite exists to remove, and the full suite found it. The claim that IS
    // deterministic is the one below it: somebody blocked for essentially the
    // whole three-second occupancy, which cannot happen by accident.
    expect(rows.filter(r => r.waited_ms > 0).length).toBeGreaterThanOrEqual(PEERS - 1)
    expect(Math.max(...rows.map(r => r.waited_ms))).toBeGreaterThan(2_000)
  }, 120_000)

  it('NEGATIVE CONTROL: with the lock disabled they DO meet, and the boot breaks — every time', async () => {
    // The same code, the same processes, one environment variable. This is the
    // case that makes the two above mean something: if this were green, the lock
    // would not be what keeps them apart.
    const results = await race(dbPath, 'racy-ddl', { MARVEEN_BOOTSTRAP_LOCK_DISABLED: '1' })

    // They were in there together. Not "the run failed" -- they MET.
    expect(results.some(r => r.rendezvousMet === true)).toBe(true)
    expect(Math.max(...results.map(r => r.peakInside ?? 0))).toBeGreaterThan(1)

    // ...and the check-then-act broke, deterministically: all three read
    // "missing", so every ALTER after the first one is a duplicate.
    const failures = results.filter(r => !r.ok)
    expect(failures).toHaveLength(PEERS - 1)
    for (const f of failures) expect(f.error).toMatch(/duplicate column name/)
  }, 120_000)

  it('a crash RELEASES the lock, and the next boot progresses', async () => {
    // The reason this lock is an OS file lock and not a lockfile: nothing runs
    // on the way out. The process is killed while holding the transaction, and
    // the kernel closes the descriptor.
    //
    // `node --import tsx`, NOT the tsx shim. The shim is a wrapper process: it
    // spawns node as a CHILD, so a SIGKILL inside kills the grandchild and the
    // wrapper exits with a code and `signal: null`. The assertion below would
    // then be measuring the wrapper, and the first version of this test failed
    // on exactly that -- correctly, which is the point of asserting the signal
    // rather than assuming the kill.
    const dead = spawnSync(process.execPath, [
      '--import', 'tsx', PROBE, '--db', dbPath, '--tag', 'X', '--peers', '1', '--mode', 'hold-and-die',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
    // ASSERT THE KILL. A clean exit would mean the process released the lock
    // normally, and the rest of this test would be about nothing.
    expect(dead.signal).toBe('SIGKILL')
    expect(existsSync(join(dir, 'held.marker'))).toBe(true)
    expect(existsSync(`${dbPath}.bootlock`)).toBe(true)

    // A stale lockfile would strand this boot until somebody cleaned up by hand.
    const after = await probe(dbPath, 'Y', 'plain-boot', {}, 1)
    expect(after.ok, after.error).toBe(true)
    expect(after.locked).toBe(true)
    expect(after.tables!).toBeGreaterThan(20)
    // It did not have to wait for a dead holder: the lock died with the process.
    expect(after.waitedMs!).toBeLessThan(1_000)
  }, 120_000)
})
