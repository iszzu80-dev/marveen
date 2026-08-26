// P1 backfill — reconcile the case board with the canonical progression state.
//
//   npx tsx scripts/cos-projection-backfill.ts [--apply] [--db <path>]
//
// DRY RUN BY DEFAULT. Without --apply it reports exactly what would change and
// writes nothing: no projection, no conflict event, not even a
// `last_reconciled_at` stamp. The owner asked for a backfill dry run as a P1
// acceptance condition, and a dry run that leaves a mark is not one.
//
// It prints Invariant A on the BOARD before and after, because that is the
// number the packet is judged on, and it prints them from the same function the
// runtime check uses -- a backfill measured by its own private query would be
// grading its own homework.

import { getDb, initDatabase } from '../src/db.js'
import {
  reconcileProjections, evaluateInvariantA, detectProjectionDrift,
  type ProjectionDomain,
} from '../src/cos/case-projection.js'

function invariantLine(db: ReturnType<typeof getDb>, domain: ProjectionDomain): string {
  const r = evaluateInvariantA(db, domain)
  return `  ${domain.padEnd(9)} active ${String(r.active).padStart(3)}  `
    + `satisfied ${String(r.satisfied).padStart(3)}  `
    + `violating ${String(r.violations.length).padStart(3)}  `
    + `unenrolled ${String(r.unenrolled).padStart(3)}`
}

function main(): void {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dbFlag = args.indexOf('--db')
  if (dbFlag !== -1 && args[dbFlag + 1]) initDatabase(args[dbFlag + 1])
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  console.log(apply ? '== BACKFILL (APPLY) ==' : '== BACKFILL (DRY RUN — nothing is written) ==')
  console.log('Invariant A on the board, BEFORE:')
  console.log(invariantLine(db, 'personal'))
  console.log(invariantLine(db, 'zst'))

  const before = detectProjectionDrift(db, now)
  console.log(`Drift before: ${before.total} `
    + `(behind ${before.behind.length}, never-reconciled ${before.neverReconciled.length}, `
    + `conflicted ${before.conflicted.length}, unenrolled ${before.unenrolled.length})`)

  const sweep = reconcileProjections(db, now, { dryRun: !apply })
  console.log(`\nSweep: examined ${sweep.examined}, `
    + `${apply ? 'projected' : 'would project'} ${sweep.projected}, `
    + `unchanged ${sweep.unchanged}, fenced ${sweep.fenced}, `
    + `no-canonical ${sweep.noCanonical}, conflicts ${sweep.conflicts}`)
  for (const f of sweep.fencedCases.slice(0, 10)) console.log(`  FENCED  ${f.domain}/${f.caseId}: ${f.reason}`)
  for (const c of sweep.conflictCases.slice(0, 10)) console.log(`  CONFLICT ${c.domain}/${c.caseId}: ${c.reason}`)

  if (apply) {
    console.log('\nInvariant A on the board, AFTER:')
    console.log(invariantLine(db, 'personal'))
    console.log(invariantLine(db, 'zst'))
    const after = detectProjectionDrift(db, now)
    console.log(`Drift after: ${after.total} `
      + `(behind ${after.behind.length}, never-reconciled ${after.neverReconciled.length}, `
      + `conflicted ${after.conflicted.length}, unenrolled ${after.unenrolled.length})`)
    for (const u of after.unenrolled) console.log(`  UNENROLLED ${u.domain}/${u.caseId} [${u.status}]`)
    for (const v of [...evaluateInvariantA(db, 'personal').violations,
      ...evaluateInvariantA(db, 'zst').violations]) {
      console.log(`  VIOLATION ${v.domain}/${v.caseId} [${v.status}] ${v.reason}`)
    }
  } else {
    console.log('\nNothing was written. Re-run with --apply to reconcile.')
  }
}

main()
