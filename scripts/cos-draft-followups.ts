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
import { readFileSync } from 'node:fs'

const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 5
const dry = process.argv.includes('--dry')

// THE SCHEDULED GENERATION SWITCH (owner, 2026-09-06, P1).
//
// "A scheduled follow-up auto-draft generálást ideiglenesen állítsd le /
//  ne engedd új draftokat automatikusan létrehozni. On-demand/manual draft
//  maradhat."
//
// WHY IT IS A FILE AND NOT A CODE CHANGE. There was no runtime switch at all:
// the step is a fixed entry in the pinned cycle's step list, so turning it off
// meant a release, and turning it back on would mean another. The global kill
// switch is not this -- it stops the executor and progression as well, which is
// far more than was asked. So the state lives in `store/`, which the pinned
// release symlinks to the live store: an operator can flip it without a cutover.
//
// FAIL DIRECTION: a missing or unreadable file reads as OFF. A thing that writes
// letters to strangers should need an explicit yes, and after what this pipeline
// was measured doing on 2026-09-06 the burden belongs on enabling it. The state
// is REPORTED on every run, so "off, no config" can never look like "ran and
// found nothing to draft".
//
// `--manual` bypasses the switch. That is the on-demand path the owner kept, and
// it is a human typing the flag, not a scheduler.
const manual = process.argv.includes('--manual')
const SWITCH_PATH = new URL('../store/cos-followup-autodraft.json', import.meta.url)
function scheduledGeneration(): { on: boolean; state: string } {
  try {
    const raw = JSON.parse(readFileSync(SWITCH_PATH, 'utf-8')) as { scheduledGeneration?: string }
    const v = String(raw.scheduledGeneration ?? '').toUpperCase()
    if (v === 'ON') return { on: true, state: 'ON' }
    if (v === 'OFF') return { on: false, state: 'OFF' }
    return { on: false, state: `OFF_UNRECOGNISED_VALUE(${v || 'empty'})` }
  } catch {
    return { on: false, state: 'OFF_NO_CONFIG' }
  }
}

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)

const sw = scheduledGeneration()
if (!manual && !sw.on) {
  // Refusing is not "nothing to do", and the difference has to be visible in the
  // step's own output or the next reader will conflate them.
  console.log(JSON.stringify({
    drafted: [], skipped: 0, skippedByCode: {}, skipSample: [],
    scheduledGeneration: sw.state,
    refused: 'scheduled follow-up auto-draft generation is disabled; run with --manual for the on-demand path',
  }))
  process.exit(0)
}

const { eligible, skipped } = sweepFollowUpCandidates(db, now, limit)

const drafted: string[] = []
for (const c of eligible) {
  const d = draftFollowUp(c)
  if (dry) { drafted.push(`${c.caseId} (dry)`); continue }
  draftSend(db, {
    caseId: c.caseId, connectorId: 'gmail', templateId: 'followup-nudge',
    email: { to: c.recipient, subject: d.subject, body: d.body },
    // Ez a regi utankoveto sopres, nem a progression pipeline. A sajat kapuja
    // (followUpEligibility) dontott mar rola; a progression_mode nem ez.
    origin: 'followup-sweep',
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
  scheduledGeneration: manual ? `MANUAL(switch=${sw.state})` : sw.state,
}))
