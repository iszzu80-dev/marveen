// Switch the progression engine ON for a case it was never switched on for.
//
//   npx tsx scripts/cos-enroll-case-progression.ts <domain> <caseId> "<reason>" [--apply]
//
// WHY THIS IS A SCRIPT AND NOT AN UPDATE STATEMENT. The P1 sweep found exactly
// one active case in either namespace with a progression row and
// `progression_enabled = 0`: PRI-TRIP-2026-001, zero runs, mode 'off', created
// 2026-08-16 outside every enrollment path in src/ (all four of them name the
// column explicitly; this row carries the schema defaults, so whatever inserted
// it named neither). WHO wrote it is not established, and is recorded as
// unknown rather than guessed at.
//
// It does NOT decide anything about the case. It gives the engine the chance to,
// and writes down that a human asked for that -- an enrollment that leaves no
// trace is indistinguishable from a case that was always enrolled, which is how
// the outlier became invisible in the first place.

import { getDb, initDatabase } from '../src/db.js'
import { appendCaseEvent } from '../src/cos/case-store.js'
import { appendZstCaseEvent } from '../src/cos/zst-case-store.js'
import { projectCase, type ProjectionDomain } from '../src/cos/case-projection.js'

const [domainArg, caseId, reason] = process.argv.slice(2)
const apply = process.argv.includes('--apply')
if (!domainArg || !caseId || !reason) {
  console.error('usage: cos-enroll-case-progression.ts <personal|zst> <caseId> "<reason>" [--apply]')
  process.exit(2)
}
const domain = domainArg as ProjectionDomain

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const table = domain === 'personal' ? 'personal_cases' : 'zst_cases'

const state = db.prepare(
  `SELECT progression_enabled, progression_mode FROM case_progression_state
    WHERE domain = ? AND case_id = ?`,
).get(domain, caseId) as { progression_enabled: number; progression_mode: string } | undefined
const row = db.prepare(`SELECT version, status FROM ${table} WHERE case_id = ?`)
  .get(caseId) as { version: number; status: string } | undefined
if (!state || !row) {
  console.error(`nincs ilyen ügy vagy progression state: ${domain}/${caseId}`)
  process.exit(1)
}
if (state.progression_enabled) {
  console.log(JSON.stringify({ caseId, already: true, mode: state.progression_mode }))
  process.exit(0)
}
if (!apply) {
  console.log(JSON.stringify({
    caseId, wouldEnable: true, from: { enabled: state.progression_enabled, mode: state.progression_mode },
    to: { enabled: 1, mode: 'internal' }, status: row.status, dryRun: true,
  }, null, 1))
  process.exit(0)
}

db.transaction(() => {
  db.prepare(
    `UPDATE case_progression_state
        SET progression_enabled = 1, progression_mode = 'internal',
            next_progression_at = ?, updated_at = ?
      WHERE domain = ? AND case_id = ?`,
  ).run(now, now, domain, caseId)
  const append = domain === 'personal' ? appendCaseEvent : appendZstCaseEvent
  append(db, {
    caseId, caseVersion: row.version, actor: 'marveen',
    eventType: 'PROGRESSION_ENABLED', reason,
    payload: { from: state, to: { progression_enabled: 1, progression_mode: 'internal' } },
    sourceSystem: 'cos-enroll-case-progression',
  }, now)
})()

console.log(JSON.stringify({
  caseId, enabled: true, mode: 'internal',
  projection: projectCase(db, domain, caseId, now),
}, null, 1))
