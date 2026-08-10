// Draft follow-ups for stalled conversations (owner option C, 2026-08-10).
//
// Runs from personal-case-wake. Drafts only; every letter still waits in the
// approval box for Istvan. The restriction that makes this safe is in
// followup-autodraft.ts: an EXISTING conversation only, ball with them only,
// past the deadline only. A first approach is never composed unprompted.
//
// Usage: npx tsx scripts/cos-draft-followups.ts [--limit N] [--dry]

import { getDb, initDatabase } from '../src/db.js'
import { sweepFollowUpCandidates, draftFollowUp } from '../src/cos/followup-autodraft.js'
import { draftSend } from '../src/cos/send-flow.js'

const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 5
const dry = process.argv.includes('--dry')

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const { eligible, skipped } = sweepFollowUpCandidates(db, now, limit)

const drafted: string[] = []
for (const c of eligible) {
  const d = draftFollowUp(c)
  if (dry) { drafted.push(`${c.caseId} (dry)`); continue }
  draftSend(db, {
    caseId: c.caseId, connectorId: 'gmail', templateId: 'followup-nudge',
    email: { to: c.recipient, subject: d.subject, body: d.body },
  }, now)
  drafted.push(c.caseId)
}

// Skips are printed with their reasons: a sweep that reports only what it did
// cannot be told apart from one that looked at nothing.
//
// Fixed 2026-08-10: it used to print `skipped.slice(0, 5)`, so a run that
// skipped 17 cases for three different reasons showed five entries that all
// happened to share one. I read that output every ten minutes for a night and
// reported "all skipped for the same reason" — which was false, and false in
// the direction that hides the other reasons entirely. A truncated sample IS
// the thing the comment above warns about, one level down.
//
// The counts are what a reader needs; the sample is kept for the shape.
const byCode: Record<string, number> = {}
for (const s of skipped) byCode[s.code] = (byCode[s.code] ?? 0) + 1
console.log(JSON.stringify({
  drafted, skipped: skipped.length, skippedByCode: byCode, skipSample: skipped.slice(0, 5),
}))
