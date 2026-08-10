// Drive the progression engine over a COPY of the live case store and report
// what it decides. Nothing here touches live data: the caller passes a path to
// a copy, and the script refuses to open the live database by name.
//
// Why this exists. On 2026-08-09 the engine mass-closed every corporate case.
// The plan that followed proposed a two-case canary on live data. That canary
// would have proven nothing after one cycle -- the closure needs four -- and
// would have burned the two cases it was meant to protect. Running the same
// experiment against a copy, for as many cycles as it takes, costs nothing and
// answers the question properly. It is also the standing DoD for re-arming
// personal-case-wake: six cycles, zero unexplained COMPLETE.
//
//   npx tsx scripts/cos-dryrun-progression.ts <db-copy> [cycles] [--unfreeze]
//
// --unfreeze turns progression back on for every non-terminal case in the COPY
// first, which is the state re-arming would produce.

import Database from 'better-sqlite3'
import { resolve, basename } from 'path'
import { runProgressionCycle } from '../src/cos/progression-pipeline.js'
import { releaseProgressionClaim } from '../src/cos/progression-scheduler.js'

const TERMINAL = ['COMPLETED', 'CANCELLED', 'ARCHIVED']

function main(): void {
  const [dbArg, cyclesArg, ...flags] = process.argv.slice(2)
  if (!dbArg) {
    console.error('usage: cos-dryrun-progression.ts <db-copy> [cycles] [--unfreeze]')
    process.exit(2)
  }
  const dbPath = resolve(dbArg)
  // The whole value of this script is that it is not the live store. Refusing
  // by name is crude, but the failure it prevents is not recoverable.
  if (basename(dbPath) === 'claudeclaw.db' && !dbPath.includes('dryrun')) {
    console.error(`REFUSING: ${dbPath} looks like the live store. Copy it first, `
      + 'and give the copy a name containing "dryrun".')
    process.exit(2)
  }
  const cycles = Number(cyclesArg ?? 6)
  const unfreeze = flags.includes('--unfreeze')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const domains: Array<'personal' | 'zst'> = ['personal', 'zst']
  const table = { personal: 'personal_cases', zst: 'zst_cases' } as const

  if (unfreeze) {
    for (const d of domains) {
      const r = db.prepare(
        `UPDATE case_progression_state SET progression_enabled = 1
         WHERE domain = ? AND progression_enabled = 0
           AND case_id IN (SELECT case_id FROM ${table[d]} WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')}))`,
      ).run(d, ...TERMINAL)
      console.log(`unfroze ${r.changes} ${d} cases in the copy`)
    }
  }

  const targets: Array<{ domain: 'personal' | 'zst'; caseId: string; status: string }> = []
  for (const d of domains) {
    const rows = db.prepare(
      `SELECT c.case_id AS case_id, c.status AS status
       FROM ${table[d]} c JOIN case_progression_state s
         ON s.case_id = c.case_id AND s.domain = ?
       WHERE s.progression_enabled = 1 AND c.status NOT IN (${TERMINAL.map(() => '?').join(',')})
       ORDER BY c.case_id`,
    ).all(d, ...TERMINAL) as Array<{ case_id: string; status: string }>
    for (const r of rows) targets.push({ domain: d, caseId: r.case_id, status: r.status })
  }
  console.log(`driving ${targets.length} cases (${targets.filter(t => t.domain === 'personal').length} personal, `
    + `${targets.filter(t => t.domain === 'zst').length} zst) for ${cycles} cycles\n`)

  const now = Math.floor(Date.now() / 1000)
  const closed: Array<{ caseId: string; cycle: number; reason: string }> = []

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const tally = new Map<string, number>()
    for (const t of targets) {
      const at = now + cycle * 600
      releaseProgressionClaim(db, t.domain, t.caseId, 'dryrun', at + 300)
      let decision: string
      let reason = ''
      try {
        const r = runProgressionCycle(db, t.domain, t.caseId, at,
          { triggerType: 'MANUAL', triggerReference: 'dryrun' })
        decision = r.decision
        reason = r.reason
      } catch (e) {
        decision = `ERROR:${(e as Error).name}`
      }
      tally.set(decision, (tally.get(decision) ?? 0) + 1)
      if (decision === 'COMPLETE') closed.push({ caseId: t.caseId, cycle, reason })
    }
    const line = [...tally.entries()].sort().map(([d, n]) => `${d}=${n}`).join('  ')
    console.log(`cycle ${cycle}: ${line}`)
  }

  console.log()
  if (closed.length === 0) {
    console.log(`VERDICT: 0 cases closed over ${cycles} cycles.`)
  } else {
    console.log(`VERDICT: ${closed.length} CLOSURES over ${cycles} cycles:`)
    for (const c of closed.slice(0, 20)) {
      console.log(`  cycle ${c.cycle}  ${c.caseId}  ${c.reason}`)
    }
  }
  // Independent of the decisions: what does the store now say?
  for (const d of domains) {
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM ${table[d]} WHERE status = 'COMPLETED'`,
    ).get() as { n: number }
    console.log(`${d} COMPLETED rows in the copy after the run: ${n.n}`)
  }
  db.close()
  process.exit(closed.length === 0 ? 0 : 1)
}

main()
