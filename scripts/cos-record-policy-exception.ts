/**
 * Record an explicit, row-bound exception to a safety assertion.
 *
 * WHY A SCRIPT AND NOT A MIGRATION. A migration would write the exception on
 * every install, including ones whose ledger never held these rows -- an
 * exception for a row that does not exist is a standing permission nobody
 * reviewed. This runs once, against a store where the row is present, and
 * REFUSES if it is not.
 *
 * WHAT IT WILL NOT DO. It does not issue an authorization, and it does not
 * change the detector. The finding stays true; what changes is that a known,
 * examined, permanently-true finding stops being reported as news. Anything not
 * named on the command line still alarms.
 *
 * Usage:
 *   tsx scripts/cos-record-policy-exception.ts --assertion policy_bypass \
 *       --reason "..." --evidence "..." <ledgerId> [<ledgerId> ...]
 *   tsx scripts/cos-record-policy-exception.ts --list
 */
import { initDatabase, getDb } from '../src/db.js'
import { recordPolicyException, listPolicyExceptions } from '../src/cos/policy-exception.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

initDatabase()
const db = getDb()

if (argv.includes('--list')) {
  console.log(JSON.stringify({ exceptions: listPolicyExceptions(db) }, null, 1))
  process.exit(0)
}

const assertion = flag('assertion')
const reason = flag('reason')
const evidence = flag('evidence')
const ids = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))

if (!assertion || !reason || !evidence || ids.length === 0) {
  console.error('usage: --assertion <name> --reason <text> --evidence <text> <ledgerId> [...]')
  process.exit(2)
}

const now = Math.floor(Date.now() / 1000)
const recorded: unknown[] = []
for (const ledgerId of ids) {
  // REFUSE ON AN ABSENT ROW. An exception for something that is not there is a
  // permission waiting for a future row to walk into it.
  const row = db.prepare(
    `SELECT status, created_at FROM outbound_ledger WHERE ledger_id = ?`,
  ).get(ledgerId) as { status: string; created_at: number } | undefined
  if (!row) {
    console.error(`REFUSED: no outbound_ledger row ${ledgerId}`)
    process.exit(3)
  }
  const id = recordPolicyException(db, {
    assertion, domain: 'personal', subjectKind: 'OUTBOUND_LEDGER_ROW',
    subjectId: ledgerId,
    // Bound to the state it was EXAMINED in. If the row moves, the exception
    // stops applying and the alarm returns on its own.
    subjectState: row.status,
    reason,
    evidence: `${evidence} | row created ${new Date(row.created_at * 1000).toISOString()}, status at recording ${row.status}`,
    recordedBy: 'marveen',
  }, now)
  recorded.push({ exceptionId: id, ledgerId, status: row.status })
}
console.log(JSON.stringify({ recorded }, null, 1))
