import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'

// W12 / §6.8 + §6.9 — "two workers, same input", settled with two REAL
// processes against one store file.
//
// The audit that opened W12 tried to reproduce a duplicate ingest IN PROCESS and
// could not, and said so: `ingestTriagedEmail` does its own read, so inside one
// isolate the second call always sees the first one's committed row. That made
// the in-process result meaningless as evidence either way — it proves the
// function is re-entrant, not that it is concurrency-safe. The finding it left
// standing was narrower and sharper: safety rested on
// UNIQUE(gmail_account_id, message_id), not on the status check, and the LOSER
// of a genuine cross-process race would get a constraint EXCEPTION rather than
// a clean ALREADY_PROCESSED.
//
// This is the test that can tell the difference. Two `tsx` processes hit the
// same (account, message) at a shared wall-clock barrier. The assertions are
// about all three consequences, because only the first is about data:
//   1. exactly one email_processing row and one case  (the constraint's job)
//   2. exactly one CASE_CREATED and one ALREADY_PROCESSED (the check's job)
//   3. NEITHER process reports an error                 (the caller's job)
//
// Forty messages, not one. The first version of this test raced a SINGLE
// message and passed against the PRE-FIX code — the two processes overlapped in
// wall-clock time but did not happen to interleave inside the unprotected
// window, so the test asserted the right things and could not tell the two
// implementations apart. A concurrency test that cannot go red on the defect it
// names is decoration. Walking both processes through the same forty keys in
// the same order makes the collision reliable, and the mutation check is
// recorded in W12_DONE_REPORT.md rather than assumed.
//
// MEASURED against the pre-fix shape (transaction removed, two consecutive
// runs): both processes report
//   SqliteError: UNIQUE constraint failed: cos_triage_provenance.receipt_id
// The audit predicted the collision would land on
// email_processing_batches.batch_id; it lands one step earlier, on the triage
// receipt, because the receipt is written before the batch is opened. Same
// defect, different first casualty -- and the difference is written down here
// rather than left as the prediction, because the prediction is not what the
// machine did.

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const WORKER = join(process.cwd(), 'src', '__tests__', 'helpers', 'ingest-race-worker.ts')
const ACC = 'iszzu80'
const PREFIX = 'msg-cross-process'
const COUNT = 40

interface WorkerLine {
  pid: number; enteredAt: number; leftAt: number
  outcomes: Record<string, string>
  errors: Array<{ messageId: string; error: string }>
}

function runWorker(dbPath: string, tag: string): Promise<WorkerLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [WORKER, '--db', dbPath, '--account', ACC, '--prefix', PREFIX, '--count', String(COUNT), '--tag', tag, '--peers', '2'], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''; let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop()
      if (!line) return reject(new Error(`worker produced no JSON (exit ${code}): ${err.slice(-800)}`))
      try { resolve(JSON.parse(line) as WorkerLine) } catch (e) { reject(new Error(`bad JSON: ${line}\n${String(e)}`)) }
    })
  })
}

describe('W12 §6.8/§6.9 — two processes, one message', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'w12-ingest-race-'))
    dbPath = join(dir, 'race.db')
    // The PARENT creates the schema, then gets out of the way.
    //
    // Letting both workers bootstrap a fresh store concurrently made this test
    // flaky for a reason that is real but is NOT what it tests: the schema
    // bootstrap is itself full of check-then-act steps (PRAGMA table_info then
    // ALTER TABLE; index creation ordered against tables another process has
    // not made yet), and three different startup errors were observed --
    // `duplicate column name: channel`, `duplicate column name: dispatch_id`,
    // `no such table: main.memories`. Two of those are now guarded
    // (db.ts's WAL retry, schema.ts's ensureColumns), the rest are named as a
    // gap in W12_DONE_REPORT.md rather than fixed inside a test that is about
    // the INGEST race. A flaky test proves nothing on the run where it is
    // green, so the boot is serialised here on purpose.
    initDatabase(dbPath)
    getDb().close()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('every message: exactly one case, one winner, one clean ALREADY_PROCESSED, no crash', async () => {
    // No wall-clock start: the workers rendezvous on a file each writes once it
    // is booted and connected (see the worker header). A race that only happens
    // when one process is still loading tsx is not the race being tested, and a
    // timed start is exactly what turns that into a coin toss on a loaded box.
    const [a, b] = await Promise.all([runWorker(dbPath, 'A'), runWorker(dbPath, 'B')])

    // 3. the caller's job — FIRST, because a crash here is the defect the audit
    // predicted and the other two assertions would still pass while it happened.
    expect([...a.errors, ...b.errors]).toEqual([])

    // 2. the check's job: per message, one creator and one clean loser.
    for (let i = 0; i < COUNT; i++) {
      const id = `${PREFIX}-${i}`
      expect([a.outcomes[id], b.outcomes[id]].sort(), `message ${id}`)
        .toEqual(['ALREADY_PROCESSED', 'CASE_CREATED'])
    }

    // 1. the constraint's job
    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE gmail_account_id=?`).get(ACC) as { n: number }
      const cases = db.prepare(`SELECT COUNT(*) n FROM personal_cases`).get() as { n: number }
      const batches = db.prepare(`SELECT COUNT(*) n FROM email_processing_batches`).get() as { n: number }
      expect(rows.n).toBe(COUNT)
      expect(cases.n).toBe(COUNT)
      expect(batches.n).toBe(COUNT)
      // Every winner FINISHED its work: no row is stranded in CLAIMED. A row
      // left CLAIMED would mean a winner was interrupted between claiming and
      // applying, which is the state the loser must never be able to cause.
      const stuck = db.prepare(`SELECT COUNT(*) n FROM email_processing WHERE status <> 'LOCAL_APPLIED'`).get() as { n: number }
      expect(stuck.n).toBe(0)
    } finally { db.close() }

    // The processes really did overlap: the second entered before the first
    // left. Without this, a serialised pair of runs would satisfy every
    // assertion above and prove nothing about concurrency.
    const first = a.enteredAt <= b.enteredAt ? a : b
    const second = first === a ? b : a
    expect(second.enteredAt).toBeLessThanOrEqual(first.leftAt)
  }, 60_000)
})
