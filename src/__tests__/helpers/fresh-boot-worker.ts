// One process, one bootstrap of the store at --db. Prints a single JSON line.
//
// A separate process is the whole point: the defect this guards is between
// PROCESSES. In one isolate the module-level `db` handle and V8's single thread
// serialise the DDL for free, so an in-process version of this test would be
// green against both the fixed and the broken code -- it would prove the
// function is re-entrant, not that the boot is safe.
import { initDatabase, getDb } from '../../db.js'
import { lastBootstrapLockOutcome } from '../../db-bootstrap-lock.js'
import { existsSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`)
  return process.argv[i + 1]!
}

const dbPath = arg('db')
const tag = arg('tag')
const peers = Number(arg('peers'))

// Rendezvous on readiness, not on the clock. A wall-clock start turns the race
// into a coin toss on a loaded box: whichever process is still loading tsx is
// not racing anything. Each worker drops a file and spins until every peer has.
const barrierDir = dirname(dbPath)
writeFileSync(join(barrierDir, `ready.${tag}`), '1')
const deadline = Date.now() + 20_000
while (readdirSync(barrierDir).filter((f) => f.startsWith('ready.')).length < peers) {
  if (Date.now() > deadline) throw new Error('barrier timeout')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
}

const startedAt = Date.now()
try {
  initDatabase(dbPath)
  const outcome = lastBootstrapLockOutcome()
  // Prove the store is actually usable afterwards, not merely that no error was
  // thrown: a bootstrap that half-ran and swallowed is the failure mode next
  // door to the one being tested.
  const tables = getDb().prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table'",
  ).get() as { n: number }
  getDb().close()
  console.log(JSON.stringify({
    tag, pid: process.pid, ok: true, startedAt, finishedAt: Date.now(),
    locked: outcome.locked, waitedMs: outcome.waitedMs, tables: tables.n,
    lockSidecar: existsSync(`${dbPath}.bootlock`),
  }))
} catch (err) {
  console.log(JSON.stringify({
    tag, pid: process.pid, ok: false, startedAt, finishedAt: Date.now(),
    error: String((err as Error)?.message ?? err),
  }))
  process.exitCode = 1
}
