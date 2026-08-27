// One process, one trip through the bootstrap critical section, with a
// RENDEZVOUS in the middle. Prints a single JSON line.
//
// WHY THIS EXISTS. The Phase 0 fresh-boot closure proved the lock with a
// probabilistic race: four processes over one fresh store, and a RED case that
// disabled the lock and retried up to six rounds until the defect reappeared.
// It reappeared, and the proof was real -- but it is a LOAD-DEPENDENT proof, and
// the owner refused to let one stand in a release gate (2026-08-27):
//
//   "A terhelésfüggő »lock nélkül néha elromlik« teszt ne maradjon flaky gating
//    test. Tedd determinisztikussá barrier/rendezvous/fault-injection
//    segítségével, VAGY minősítsd át külön stress/reproducer tesztté."
//
// He is right, and the reason is sharper than flakiness. A race that fails 1
// time in 48 also PASSES 47 times in 48, and a green from it says nothing: it is
// the same number a fixed system produces. The retry loop hid that by turning
// "did the defect appear" into "did the defect appear eventually", which is a
// question whose answer depends on how busy the machine is.
//
// WHAT REPLACES IT. The two processes are made to meet INSIDE the check-then-act
// window, or provably fail to. The barrier is the instrument:
//
//   LOCK ON   the second process cannot enter while the first is inside, so the
//             rendezvous CANNOT be met. The unmet rendezvous is not a timeout to
//             be tolerated -- it is the positive observation of mutual exclusion.
//   LOCK OFF  both are inside at once, both read "column missing", both ALTER,
//             and exactly one dies with `duplicate column name`. Every time.
//
// THE DDL HERE IS A REPLICA, and saying so matters. It is not `initDatabase`'s
// 970 lines; it is the SHAPE those lines fail in -- `PRAGMA table_info` followed
// by `ALTER TABLE ... ADD COLUMN`, the raw check-then-act at db.ts:742 that
// produced `duplicate column name: trace_id` in the original measurement. This
// file proves the LOCK provides mutual exclusion, deterministically. The
// stress/reproducer suite still runs the real bootstrap, because "the replica is
// faithful" is a claim, and the real thing is the one that checks it.
//
// Usage: bootstrap-lock-probe.ts --db <path> --tag <t> --peers <n> --mode <m>
//   mode = racy-ddl     check-then-act with a rendezvous inside the lock
//        = hold-and-die SIGKILL while HOLDING the lock (crash release)
//        = plain-boot   ordinary initDatabase, reports waitedMs
import Database from 'better-sqlite3'
import { writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withBootstrapLock, lastBootstrapLockOutcome } from '../../db-bootstrap-lock.js'
import { initDatabase, getDb } from '../../db.js'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`)
  return process.argv[i + 1]!
}

const dbPath = arg('db')
const tag = arg('tag')
const peers = Number(arg('peers'))
const mode = arg('mode')
const dir = dirname(dbPath)

/** Block until every peer has arrived, or the deadline passes.
 *
 *  Returns whether the meeting HAPPENED. That boolean is the measurement: under
 *  a working lock it must be false for every process, because a lock that lets
 *  two holders meet inside the critical section is not a lock. */
function rendezvous(name: string, timeoutMs: number): { met: boolean; peak: number } {
  writeFileSync(join(dir, `${name}.${tag}`), '1')
  const deadline = Date.now() + timeoutMs
  let peak = 0
  for (;;) {
    const arrived = readdirSync(dir).filter(f => f.startsWith(`${name}.`)).length
    if (arrived > peak) peak = arrived
    if (arrived >= peers) return { met: true, peak }
    if (Date.now() > deadline) return { met: false, peak }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

/** Everybody starts together. Without this the "race" is decided by whichever
 *  process finished loading tsx first, which is not a race at all. */
function startBarrier(): void {
  writeFileSync(join(dir, `ready.${tag}`), '1')
  const deadline = Date.now() + 30_000
  while (readdirSync(dir).filter(f => f.startsWith('ready.')).length < peers) {
    if (Date.now() > deadline) throw new Error('start barrier timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

const out: Record<string, unknown> = { tag, pid: process.pid, mode }

try {
  startBarrier()

  if (mode === 'racy-ddl') {
    let met = false
    let peak = 0
    withBootstrapLock(dbPath, () => {
      const db = new Database(dbPath)
      db.pragma('busy_timeout = 30000')
      db.exec(`CREATE TABLE IF NOT EXISTS bootstrap_race_probe (id INTEGER PRIMARY KEY)`)
      // CHECK. The replica of db.ts:742: read the columns, decide the column is
      // missing, and act on that decision later.
      const cols = (db.pragma('table_info(bootstrap_race_probe)') as Array<{ name: string }>).map(c => c.name)
      const missing = !cols.includes('trace_id')
      // ...AND THE WINDOW. Everything between the read and the write is where
      // the other process must not be. This is the only line that differs from
      // production, and it is what turns "sometimes" into "always" or "never".
      const meeting = rendezvous('inside', 3_000)
      met = meeting.met
      peak = meeting.peak
      if (missing) db.exec(`ALTER TABLE bootstrap_race_probe ADD COLUMN trace_id TEXT`)
      db.close()
      // Leave the room before releasing the lock, so the NEXT holder starts from
      // an empty one. Without this, three sequential holders under a working
      // lock would accumulate three markers and the third would "meet" two
      // processes that had already left -- a false positive built out of litter.
      rmSync(join(dir, `inside.${tag}`), { force: true })
    })
    out.ok = true
    out.rendezvousMet = met
    out.peakInside = peak
    out.locked = lastBootstrapLockOutcome().locked
    out.waitedMs = lastBootstrapLockOutcome().waitedMs
  } else if (mode === 'hold-and-die') {
    withBootstrapLock(dbPath, () => {
      // Announce that the lock is HELD, then stop existing. No COMMIT, no
      // close, no finally -- the file descriptor dies with the process, which is
      // the entire reason this lock is an OS file lock and not a lockfile.
      writeFileSync(join(dir, 'held.marker'), String(process.pid))
      process.kill(process.pid, 'SIGKILL')
    })
    out.ok = false
    out.error = 'the kill did not happen'
  } else if (mode === 'plain-boot') {
    initDatabase(dbPath)
    const tables = getDb().prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table'",
    ).get() as { n: number }
    getDb().close()
    const o = lastBootstrapLockOutcome()
    out.ok = true
    out.locked = o.locked
    out.waitedMs = o.waitedMs
    out.tables = tables.n
    out.lockSidecar = existsSync(`${dbPath}.bootlock`)
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
} catch (err) {
  out.ok = false
  out.error = String((err as Error)?.message ?? err)
  process.exitCode = 1
}

console.log(JSON.stringify(out))
