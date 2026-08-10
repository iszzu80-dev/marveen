// Restore cases the progression engine closed on a generic, self-certified DoD.
//
// The engine's closure decisions are recoverable because the case event log is
// append-only and every transition records previous_status. So the restore does
// not guess: for each case still sitting in COMPLETED whose LAST transition was
// written by 'progression-engine', it puts the case back into exactly the status
// that transition moved it out of. Same technique as the 2026-08-09 corporate
// restore, which is why it is known to work.
//
// Two things it deliberately does NOT do:
//
//   It does not write SQL. Transitions go through the case store, so the
//   restore appends its own events and is itself auditable and reversible. A
//   raw UPDATE would fix the board and corrupt the record.
//
//   It does not touch progression_enabled. The 2026-08-09 corporate restore
//   moved the status back and left the engine flag off, which is how 27 cases
//   looked alive for a day while nothing polled them. Leaving the flag alone
//   here is the same asymmetry -- but deliberate, stated, and safe in this
//   direction: OFF is the safe side, and re-arming is a separate step with its
//   own dry-run DoD.
//
//   npx tsx scripts/cos-restore-engine-closed-cases.ts <db> [--apply]
//
// Without --apply it prints the plan and changes nothing.

import Database from 'better-sqlite3'
import { resolve } from 'path'
import { transitionCase } from '../src/cos/case-store.js'
import { transitionZstCase } from '../src/cos/zst-case-store.js'

const ENGINE = 'progression-engine'

interface Plan {
  domain: 'personal' | 'zst'
  caseId: string
  title: string
  restoreTo: string
  version: number
  closedAt: number
  eventId: number
}

function planFor(db: Database.Database, domain: 'personal' | 'zst'): Plan[] {
  const cases = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  // The LAST status-changing event per case, not merely any engine closure: a
  // case the owner deliberately closed afterwards must stay closed.
  return db.prepare(
    `SELECT c.case_id AS caseId, c.title AS title, c.version AS version,
            c.completed_at AS closedAt,
            e.event_id AS eventId, e.previous_status AS restoreTo
     FROM ${cases} c
     JOIN ${events} e ON e.event_id = (
       SELECT event_id FROM ${events}
       WHERE case_id = c.case_id AND new_status IS NOT NULL
       ORDER BY event_id DESC LIMIT 1
     )
     WHERE c.status = 'COMPLETED'
       AND e.actor = ?
       AND e.new_status = 'COMPLETED'
       AND e.previous_status IS NOT NULL
       AND e.previous_status <> 'COMPLETED'
     ORDER BY c.case_id`,
  ).all(ENGINE).map(r => ({ ...(r as object), domain } as Plan))
}

function main(): void {
  const [dbArg, ...flags] = process.argv.slice(2)
  if (!dbArg) {
    console.error('usage: cos-restore-engine-closed-cases.ts <db> [--apply]')
    process.exit(2)
  }
  const apply = flags.includes('--apply')
  const db = new Database(resolve(dbArg))
  db.pragma('journal_mode = WAL')

  const plans = [...planFor(db, 'personal'), ...planFor(db, 'zst')]
  if (plans.length === 0) {
    console.log('nothing to restore: no COMPLETED case was last closed by the engine')
    db.close()
    return
  }

  console.log(`${plans.length} case(s) to restore${apply ? '' : ' (DRY RUN, nothing written)'}:\n`)
  for (const p of plans) {
    console.log(`  ${p.domain.padEnd(8)} ${p.caseId.padEnd(34)} COMPLETED -> ${p.restoreTo.padEnd(18)} ${p.title.slice(0, 46)}`)
  }
  if (!apply) {
    console.log('\nre-run with --apply to write')
    db.close()
    return
  }

  const now = Math.floor(Date.now() / 1000)
  let ok = 0
  const failed: Array<{ caseId: string; err: string }> = []
  for (const p of plans) {
    const fn = p.domain === 'personal' ? transitionCase : transitionZstCase
    try {
      fn(db, {
        caseId: p.caseId,
        newStatus: p.restoreTo as never,
        actor: 'marveen',
        seenVersion: p.version,
        reason: `Restored from event ${p.eventId}: closed by the progression engine on a generic, `
          + 'self-certified DoD (incident 2026-08-09, card 0a7574db). The case was never finished.',
      }, now)
      ok++
    } catch (e) {
      failed.push({ caseId: p.caseId, err: `${(e as Error).name}: ${(e as Error).message}` })
    }
  }

  console.log(`\nrestored ${ok}/${plans.length}`)
  for (const f of failed) console.log(`  FAILED ${f.caseId}: ${f.err}`)

  // Read the result back from the store rather than trusting the counter above.
  for (const domain of ['personal', 'zst'] as const) {
    const t = domain === 'personal' ? 'personal_cases' : 'zst_cases'
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE status = 'COMPLETED'`).get() as { n: number }
    console.log(`${domain} COMPLETED after restore: ${n.n}`)
  }
  db.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
