/**
 * W12 / §6.8 fault injection: "two workers, same input" — as two REAL processes.
 *
 * Not a test file (no `.test.` in the name, so vitest does not collect it): the
 * child half of cos-w12-ingest-cross-process.test.ts. It exists because the
 * question it settles cannot be asked in one process. `ingestTriagedEmail`
 * performs its own read internally, so two calls inside a single V8 isolate are
 * ordered by construction — the second one always sees the first one's
 * committed row, whatever the locking does. Only two OS processes sharing one
 * SQLite file can produce the interleaving the audit was worried about.
 *
 * Usage:
 *   tsx ingest-race-worker.ts --db <path> --account <id> --prefix <p> --count <n> --tag <A|B> --peers <n>
 *
 * The barrier is a FILE RENDEZVOUS, not a wall clock. A wall-clock start time
 * assumes both interpreters finish booting before it, and under a loaded
 * machine (the full suite runs 500+ files) one can arrive late, run alone, and
 * turn a genuine concurrency failure into a green test — or, the other way
 * round, fail the overlap check on nothing but scheduler jitter. Each worker
 * instead announces itself and then spins until every peer has announced, so
 * they enter together whatever the load.
 *
 * `--count` then walks BOTH processes through the same key space in the same
 * order: a single shared message id is one coin toss, and a pair of runs that
 * happen not to interleave proves nothing. Forty of them in lockstep collide.
 *
 * It prints ONE line of JSON and exits 0 — even on failure, because the parent
 * must be able to tell a lost race (a clean ALREADY_PROCESSED) apart from a
 * crash (an `error` entry), and a non-zero exit would blur exactly that
 * distinction.
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initDatabase, getDb } from '../../db.js'
import { ingestTriagedEmail } from '../../cos/triage-bridge.js'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

const dbPath = arg('db')
const accountId = arg('account')
const prefix = arg('prefix')
const count = Number(arg('count'))
const tag = arg('tag')
const peers = Number(arg('peers'))

initDatabase(dbPath)
const db = getDb()

// Rendezvous: announce, then spin until every peer has announced. Spin rather
// than sleep — setTimeout would hand the processes different wake-up
// granularities, and the point is that they leave the barrier together.
const readyDir = dirname(dbPath)
writeFileSync(join(readyDir, `ready-${tag}`), String(process.pid))
const rendezvousDeadline = Date.now() + 30_000
while (readdirSync(readyDir).filter((f) => f.startsWith('ready-')).length < peers) {
  if (Date.now() > rendezvousDeadline) {
    console.log(JSON.stringify({ pid: process.pid, error: `rendezvous timeout waiting for ${peers} peers` }))
    process.exit(0)
  }
}

const at = Date.now()

const outcomes: Record<string, string> = {}
const errors: Array<{ messageId: string; error: string }> = []
const enteredAt = Date.now()

for (let i = 0; i < count; i++) {
  const messageId = `${prefix}-${i}`
  try {
    const res = ingestTriagedEmail(db, {
      accountId, messageId, threadId: `t-${messageId}`,
      subject: `Race ${i}`, from: 'peer@example.com', snippet: 'same message, two processes',
      actionable: true, caseType: 'EMAIL', title: `Race ${i}`,
    }, Math.floor(at / 1000))
    outcomes[messageId] = res.outcome
  } catch (err) {
    errors.push({ messageId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  }
}

console.log(JSON.stringify({ pid: process.pid, enteredAt, leftAt: Date.now(), outcomes, errors }))
