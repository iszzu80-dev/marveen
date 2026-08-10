// Turn the progression engine back on for cases whose flag was left off.
//
// Card 0a7574db step 3. Two separate freezes ended up in the store and this
// thaws both:
//
//   the 2026-08-09 corporate mass-closure, whose restore put the STATUS back
//   and left progression_enabled at 0, so 27 cases looked alive on the board
//   for a full day while nothing polled them;
//
//   the cases restored on 2026-08-10, which the engine had switched off as it
//   closed them.
//
// This is only safe because the closure defect is fixed and measured: on a copy
// of the live store with every one of these cases unfrozen, six cycles produced
// zero closures (scripts/cos-dryrun-progression.ts). Run that first. Unfreezing
// before the fix would have closed 45 live cases within four cycles.
//
// It preserves each case's existing progression_mode rather than imposing one:
// the mode is how much the engine is allowed to do, and quietly promoting a
// shadow case to internal while thawing it would smuggle a second change in
// under the first.
//
//   npx tsx scripts/cos-unfreeze-progression.ts <db> [--apply]

import Database from 'better-sqlite3'
import { resolve } from 'path'
import { setProgressionEnabled, scheduleNextProgression } from '../src/cos/progression-scheduler.js'

const TERMINAL = ['COMPLETED', 'CANCELLED', 'ARCHIVED']

interface Row { domain: 'personal' | 'zst'; case_id: string; mode: string; status: string; title: string }

/** Frozen means "the engine will not look at this case again", and there are
 *  TWO ways to be in that state, not one.
 *
 *  progression_enabled = 0 is the obvious one. next_progression_at IS NULL is
 *  the quiet one: the flag says enabled, the board says alive, and findDueCases
 *  never returns it because there is no due time to compare against.
 *
 *  The first version of this script only cleared the flag. It reported 72 cases
 *  unfrozen and the very next live heartbeat picked up 24 -- the other 48 were
 *  enabled and still invisible. That is the 2026-08-09 defect exactly, one
 *  layer down: a restore that fixes the field it was looking at and leaves the
 *  field that actually decides. Both are cleared here, together, or the count
 *  this script prints is a number about a flag rather than about the engine. */
function frozen(db: Database.Database, domain: 'personal' | 'zst'): Row[] {
  const t = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  return db.prepare(
    `SELECT s.case_id AS case_id, s.progression_mode AS mode,
            c.status AS status, c.title AS title
     FROM case_progression_state s
     JOIN ${t} c ON c.case_id = s.case_id
     WHERE s.domain = ?
       AND (s.progression_enabled = 0 OR s.next_progression_at IS NULL)
       AND c.status NOT IN (${TERMINAL.map(() => '?').join(',')})
       AND c.archived_at IS NULL
     ORDER BY s.case_id`,
  ).all(domain, ...TERMINAL).map(r => ({ ...(r as object), domain } as Row))
}

function main(): void {
  const [dbArg, ...flags] = process.argv.slice(2)
  if (!dbArg) {
    console.error('usage: cos-unfreeze-progression.ts <db> [--apply]')
    process.exit(2)
  }
  const apply = flags.includes('--apply')
  const db = new Database(resolve(dbArg))
  db.pragma('journal_mode = WAL')

  const rows = [...frozen(db, 'personal'), ...frozen(db, 'zst')]
  if (!rows.length) {
    console.log('nothing frozen: every live case is already being polled')
    db.close()
    return
  }

  const byMode = new Map<string, number>()
  for (const r of rows) byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + 1)
  console.log(`${rows.length} frozen live case(s)${apply ? '' : ' (DRY RUN, nothing written)'}`)
  console.log(`  personal ${rows.filter(r => r.domain === 'personal').length}, `
    + `zst ${rows.filter(r => r.domain === 'zst').length}`)
  console.log(`  modes: ${[...byMode.entries()].map(([m, n]) => `${m}=${n}`).join(', ')}\n`)
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${r.domain.padEnd(8)} ${r.case_id.padEnd(34)} ${r.status.padEnd(18)} ${r.title.slice(0, 40)}`)
  }
  if (rows.length > 8) console.log(`  … és még ${rows.length - 8}`)

  if (!apply) {
    console.log('\nre-run with --apply to write')
    db.close()
    return
  }

  const now = Math.floor(Date.now() / 1000)
  for (const r of rows) {
    setProgressionEnabled(db, r.domain, r.case_id, true, r.mode, now)
    // Due immediately. The alternative -- spreading them over the next hour --
    // would be gentler on one heartbeat and would also mean the first cycle
    // after arming proves nothing about the other cases.
    scheduleNextProgression(db, r.domain, r.case_id, now, now)
  }

  // Read it back rather than trusting the loop.
  const left = [...frozen(db, 'personal'), ...frozen(db, 'zst')].length
  console.log(`\nunfroze ${rows.length}; still frozen: ${left}`)
  db.close()
  process.exit(left === 0 ? 0 : 1)
}

main()
