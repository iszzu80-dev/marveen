/**
 * P6 scenario 10 — the child that dies where a state machine actually breaks.
 *
 * The plan's acceptance is specific, and it is the whole reason this file is a
 * separate PROCESS rather than a mocked failure:
 *
 *   "The restart case kills the process BETWEEN the decision and the write,
 *    which is where a state machine actually breaks — a restart between runs
 *    proves nothing."
 *
 * A thrown error is not that. A throw unwinds, runs finally blocks, lets
 * better-sqlite3 roll back cleanly and gives every guard a chance to behave. A
 * SIGKILL gives none of that: the process stops between two instructions, the
 * file is left exactly as the operating system found it, and whatever the
 * database does next is what it would do after a real crash.
 *
 * WHERE IT DIES, AND WHY THAT SEAM. `prepare` is intercepted, so the kill lands
 * at a named SQL statement rather than after a timer -- a timing-based kill would
 * hit a different place on every machine, and a test whose failure point moves is
 * not a test of anything. The seam is the progression run INSERT: the decision
 * has been made, the row is being written, and the transaction has not committed.
 *
 * NOTHING IN THIS FILE IS IMPORTED BY PRODUCTION CODE. The interception lives
 * here, in the child, so the pipeline carries no crash hook of its own -- a
 * product path with a test-only branch in it is a fixture side effect waiting to
 * become a defect.
 *
 * Usage: tsx p6-crash-child.ts <dbPath> <caseId> <now> <seam>
 *   seam = 'run-insert'   kill while writing the run row (mid-transaction)
 *        = 'none'         run to completion (the control: same child, no kill)
 */
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../../db.js'
import { runProgressionCycle } from '../../cos/progression-pipeline.js'

const [dbPath, caseId, nowRaw, seam] = process.argv.slice(2)
if (!dbPath || !caseId || !nowRaw || !seam) {
  console.error('usage: p6-crash-child.ts <dbPath> <caseId> <now> <seam>')
  process.exit(2)
}
const now = Number(nowRaw)

initDatabase(dbPath)
const db = getDb()

if (seam === 'run-insert') {
  const realPrepare = db.prepare.bind(db) as (sql: string) => Database.Statement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(db as any).prepare = (sql: string): Database.Statement => {
    const stmt = realPrepare(sql)
    if (!sql.includes('INSERT INTO case_progression_runs')) return stmt
    const realRun = stmt.run.bind(stmt)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stmt as any).run = (...args: unknown[]): unknown => {
      // The write happens, and THEN the process stops -- inside the
      // transaction, before any commit. If the row survives this, the
      // durability story is wrong in a way no in-process test would show.
      const r = (realRun as (...a: unknown[]) => unknown)(...args)
      process.kill(process.pid, 'SIGKILL')
      return r
    }
    return stmt
  }
}

const result = runProgressionCycle(db, 'personal', caseId, now, {
  triggerType: 'MANUAL', triggerReference: 'p6-child',
})
process.stdout.write(JSON.stringify({ ok: true, decision: result.decision, runId: result.runId }))
