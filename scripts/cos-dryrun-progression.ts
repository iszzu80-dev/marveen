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
//     [--ledger <path> --arm REACTIVE_CONTROL|PROACTIVE_SHADOW [--run-id <id>]]
//
// --unfreeze turns progression back on for every non-terminal case in the COPY
// first, which is the state re-arming would produce.
//
// --ledger PERSISTS the run (§1.4.6 / §26(26)). Without it this script reports
// to stdout and nothing else, which is what it did until now and is fine for
// answering "does the engine still mass-close cases". It is NOT enough to be a
// control arm: §1.4.6 requires the baseline to be recorded independently and
// immutably, with a run ID and a config version, BEFORE any adjudication. A
// scrollback buffer is none of those things.
//
// The ledger is a SEPARATE database from the corpus. Writing run rows into the
// corpus would change the corpus, so the fingerprint taken at the start would
// stop describing what the next arm runs over — and "the same frozen corpus"
// would be false in a way nobody would notice.

import Database from 'better-sqlite3'
import { resolve, basename } from 'path'
import { randomUUID } from 'node:crypto'
import { runProgressionCycle } from '../src/cos/progression-pipeline.js'
import { releaseProgressionClaim } from '../src/cos/progression-scheduler.js'
import {
  ensureReplaySchema, beginRun, recordOutput, sealRun, corpusFingerprint,
  type ReplayArm,
} from '../src/cos/replay-run.js'

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
  const flagValue = (name: string): string | undefined => {
    const i = flags.indexOf(name)
    return i >= 0 ? flags[i + 1] : undefined
  }
  const ledgerPath = flagValue('--ledger')
  const arm = flagValue('--arm') as ReplayArm | undefined
  const runId = flagValue('--run-id') ?? `replay-${randomUUID()}`
  if (ledgerPath && arm !== 'REACTIVE_CONTROL' && arm !== 'PROACTIVE_SHADOW') {
    // No default arm. Which side of the comparison a run belongs to is the one
    // thing this script must never guess: a mislabelled arm produces a
    // comparison that looks valid and measures nothing.
    console.error('--ledger requires --arm REACTIVE_CONTROL or --arm PROACTIVE_SHADOW')
    process.exit(2)
  }

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

  // The fingerprint is taken AFTER --unfreeze and BEFORE the first cycle: the
  // corpus the run is driven over is the one that exists at the moment the
  // driving starts, not the one on disk before it was prepared.
  let ledger: Database.Database | null = null
  if (ledgerPath) {
    ledger = new Database(resolve(ledgerPath))
    ensureReplaySchema(ledger)
    const fp = corpusFingerprint(db)
    const begun = beginRun(ledger, {
      runId, arm: arm!, corpusFingerprint: fp,
      config: { cycles, unfreeze, targets: targets.length, engine: 'progression-pipeline' },
    }, now)
    if (!begun.ok) {
      console.error(`REFUSING: ${begun.reason}`)
      process.exit(2)
    }
    console.log(`run ${runId} (${arm}) corpus=${fp} config=${begun.run.configVersion}\n`)
  }

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
      // Every decision, not only the interesting ones. A ledger that records
      // what the run's author found notable is a ledger that cannot answer a
      // question nobody had thought of yet — and the adjudication in §1.4.3 is
      // exactly such a question, asked later, by somebody else.
      if (ledger) recordOutput(ledger, { runId, domain: t.domain, caseId: t.caseId, cycle, decision, reason })
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
  if (ledger) {
    // Sealed here and not by a later step: §1.4.6 wants the output immutable
    // BEFORE the adjudication, and a run left open until somebody remembers is a
    // run that stayed editable for exactly as long as it took to look at it.
    const sealed = sealRun(ledger, runId, Math.floor(Date.now() / 1000))
    console.log(`\nsealed ${runId}: ${sealed.outputCount} outputs, digest=${sealed.outputDigest}`)
    ledger.close()
  } else {
    console.log('\n(no --ledger: this run is NOT persisted and cannot serve as a §1.4.6 control arm)')
  }
  db.close()
  process.exit(closed.length === 0 ? 0 : 1)
}

main()
