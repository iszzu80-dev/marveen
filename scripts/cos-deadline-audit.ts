// Cycle step: are there open cases whose deadline exists only as prose?
//
// Added after the 2026-08-16 near miss (card eec5ca9f). Both car-rental cases
// said "DONTES 2026-08-16 10:00 elott" in their next action while their date
// columns pointed at the pickup two days later, so no date-driven view showed
// the deadline. Istvan decided in time on his own.
//
// Runs over BOTH namespaces. A check that covered only the personal store would
// leave the company one with the failure we just measured.
//
// Usage: npx tsx scripts/cos-deadline-audit.ts

import { getDb, initDatabase } from '../src/db.js'
import { auditProseDeadlines, describeDeadlineAudit } from '../src/cos/deadline-audit.js'

initDatabase()
const db = getDb()

const personal = auditProseDeadlines(db, 'personal_cases')
const zst = auditProseDeadlines(db, 'zst_cases')

// The lines are printed for a human reading the cycle output; the JSON is what
// the runner folds into its report. Both carry the zero.
for (const line of describeDeadlineAudit(personal)) console.log('personal: ' + line)
for (const line of describeDeadlineAudit(zst)) console.log('zst: ' + line)

console.log(JSON.stringify({
  personal: { examined: personal.examined, proseOnly: personal.proseOnly },
  zst: { examined: zst.examined, proseOnly: zst.proseOnly },
}))
