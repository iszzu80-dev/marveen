/**
 * P4 blocker closure — the child that dies after an approval is granted and
 * before it is used.
 *
 * The owner's sixth proof: "approval létrejött, de execution előtti hard crash
 * nem veszti el jogtalanul". A thrown error cannot demonstrate that. A throw
 * unwinds, runs finally blocks, lets better-sqlite3 roll back cleanly and gives
 * every guard a chance to behave well. SIGKILL gives none of that: the process
 * stops between two instructions and the file is left exactly as the operating
 * system found it.
 *
 * WHERE IT DIES. Immediately after `recordOwnerAnswer` returns -- the point at
 * which the gate has run, the ticket is written and the request is latched, and
 * NOTHING has consumed it yet. That is the exact window the owner names.
 *
 * NOTHING HERE IS IMPORTED BY PRODUCTION CODE. The kill lives in the child so no
 * product path carries a test-only branch.
 *
 * Usage: approval-crash-child.ts <dbPath> <caseId> <now> <seam>
 *   seam = 'none'            seed, refuse, approve; exit normally (the CONTROL)
 *        = 'after-approval'  the same, then SIGKILL before anything consumes it
 *        = 'consume'         run one more cycle, which consumes the ticket
 */
import { initDatabase, getDb } from '../../db.js'
import { createCase, appendCaseEvent } from '../../cos/case-store.js'
import { runProgressionCycle } from '../../cos/progression-pipeline.js'
import { recordOwnerAnswer } from '../../cos/owner-question.js'

const [dbPath, caseId, nowRaw, seam] = process.argv.slice(2)
if (!dbPath || !caseId || !nowRaw || !seam) {
  console.error('usage: approval-crash-child.ts <dbPath> <caseId> <now> <seam>')
  process.exit(2)
}
const now = Number(nowRaw)
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

initDatabase(dbPath)
const db = getDb()

if (seam === 'consume') {
  const r = runProgressionCycle(db, 'personal', caseId, now + 60, {
    triggerType: 'MANUAL', triggerReference: 'approval-child-consume',
  })
  process.stdout.write(JSON.stringify({ ok: true, decision: r.decision }))
  process.exit(0)
}

createCase(db, {
  // RECOVERY_REQUIRED + a queued send: the one coherently external action in
  // the plan template. Mirrors the in-process fixture; see the note there.
  caseId, title: `Ügy ${caseId}`, caseType: 'SELECTION', status: 'RECOVERY_REQUIRED',
  sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
}, now - 100)
db.prepare(
  `INSERT INTO case_progression_state
    (domain, case_id, progression_enabled, progression_mode, goal, summary,
     next_progression_at, dod_verification_json, created_at, updated_at)
   VALUES ('personal', ?, 1, 'internal', 'Test goal', 'Test summary', ?, ?, ?, ?)`,
).run(caseId, now - 100, JSON.stringify({
  criteria: [{ label: '_seed_guard', met: true, met_at: now - 100, met_by_run: '_seed' }],
  all_met: true, evaluated_at: now - 100,
}), now - 100, now - 100)
db.prepare(
  `INSERT INTO outbound_ledger
     (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
      status, created_at, updated_at)
   VALUES (?, ?, 'EMAIL_SEND', 1, ?, 'PLANNED', ?, ?)`,
).run(`led-${caseId}`, caseId, `idem-${caseId}`, now - 100, now - 100)

// Walk the plan to the external EXECUTE step: Invariant E has nothing to refuse
// until the case is standing on it. Same fixture shape as the in-process tests.
runProgressionCycle(db, 'personal', caseId, now, { triggerType: 'MANUAL', triggerReference: 'c0' })
runProgressionCycle(db, 'personal', caseId, now + 10, { triggerType: 'MANUAL', triggerReference: 'c1' })
runProgressionCycle(db, 'personal', caseId, now + 20, { triggerType: 'MANUAL', triggerReference: 'c1b' })
runProgressionCycle(db, 'personal', caseId, now + 30, { triggerType: 'MANUAL', triggerReference: 'c2' })

const req = db.prepare(
  `SELECT question_hash AS h FROM cos_action_approval_requests
    WHERE case_id = ? AND decided_at IS NULL`,
).get(caseId) as { h: string } | undefined
if (!req) { console.error('no approval request opened'); process.exit(3) }
db.prepare(
  `UPDATE cos_owner_questions SET channel=?, channel_target=? WHERE case_id=? AND question_hash=?`,
).run(CHANNEL, `${CHAT}:1`, caseId, req.h)

const rec = recordOwnerAnswer(db, {
  caseId, domain: 'personal', text: 'igen', now: now + 50,
  channel: { channel: CHANNEL, target: CHAT },
})
if (!rec) { console.error('answer not recorded'); process.exit(4) }

if (seam === 'after-approval') {
  // The ticket is committed and unconsumed. Stop here, the way a power cut does.
  process.kill(process.pid, 'SIGKILL')
}

process.stdout.write(JSON.stringify({ ok: true, approved: true }))
