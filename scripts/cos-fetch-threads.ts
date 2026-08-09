// Fetch and store the full mail thread for cases that only have a preview (§8).
//
// Runs from personal-case-wake, AFTER the case exists. Never in the intake
// path: tying case creation to a network round-trip would make the seam as
// reliable as Gmail on its worst day, and a failed intake loses mail.
//
// Usage: npx tsx scripts/cos-fetch-threads.ts [--limit N]

import { getDb, initDatabase } from '../src/db.js'
import { GmailThreadReader, storeCaseThread, casesMissingThreadText, recordThreadFetchFailure, abandonedThreadFetches } from '../src/cos/gmail-thread-read.js'

const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 10

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const todo = casesMissingThreadText(db, limit)
const reader = new GmailThreadReader()

let stored = 0
const failures: string[] = []
for (const c of todo) {
  const r = await storeCaseThread(db, reader, c.case_id, c.thread_id, 'personal', now)
  if (r.stored) { stored += 1; continue }
  failures.push(`${c.case_id}: ${r.reason}`)
  recordThreadFetchFailure(db, c.case_id, c.thread_id, r.reason, now)
}
// Failures are printed, not swallowed: a fetcher that reports "0 failures"
// because it never looked is the shape of every silent gap found tonight.
// Abandoned ones are listed separately: a give-up that is only visible as an
// absence is indistinguishable from a job that never looked.
console.log(JSON.stringify({
  candidates: todo.length, stored, failures,
  abandoned: abandonedThreadFetches(db).map((a) => `${a.case_id} (${a.attempts}x): ${a.last_error}`),
}))
