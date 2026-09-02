/**
 * REGRESSION: why an owner-action on a finished case answered RECOVERY_REQUIRED.
 *
 * 2026-09-02. The owner said a case was finished. The owner-action route wrote
 * the event, ran a progression cycle, and the cycle's new decision came back
 * RECOVERY_REQUIRED while the status stayed WAITING_EXTERNAL. I reported that as
 * "the engine did not interpret the owner's result as a resolution". That
 * explanation was wrong, and this file exists to pin what actually happened, so
 * the wrong explanation cannot be repaired into the code as a feature.
 *
 * THE REAL MECHANISM (progression-pipeline.ts, the WAITING_EXTERNAL branch):
 *
 *     if (currentStatus === 'WAITING_EXTERNAL') {
 *       if (context.statusAgeDays > 7) return { decision: 'RECOVERY_REQUIRED', ... }
 *
 * PRI-FAMILY-2026-002 had been WAITING_EXTERNAL since 2026-08-24 — nine days.
 * The decision had nothing to do with the owner's message, with completion
 * intent, or with the owner-action route. ANY cycle on ANY trigger would have
 * returned the same answer that afternoon, and would have on the day before.
 * The owner-action did not cause it; it revealed it.
 *
 * SO THE FAILURE MODE THE BRIEF ASKED ABOUT DOES NOT EXIST. "It stayed in a
 * misleading recovery state merely because completion intent was missing" is
 * not what the code does: remove completion intent from the picture entirely
 * and the same decision comes out, because the trigger is the clock.
 *
 * WHAT IS STILL WRONG, NARROWLY. An overdue wait and a failed recovery are
 * different situations sharing one decision value. Nothing failed on a case
 * that has simply been waiting nine days for a reply; what it needs is someone
 * to decide, not a recovery plan. The two arrive at the reader as the same
 * word. That is a real classification smell — and changing the decision the
 * engine emits for every overdue wait touches the decision table for every
 * waiting case in the store, which is a bigger call than this feature's scope
 * and belongs to the owner, not to me. So this file MEASURES it and does not
 * change it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'

const NOW = 1_700_000_000
const DAY = 86_400

function waitingCase(caseId: string, waitingSinceDaysAgo: number): void {
  const db = getDb()
  const started = NOW - waitingSinceDaysAgo * DAY
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN', status: 'WAITING_EXTERNAL',
    sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'regression',
  }, started)
  seedCaseProgressionState(db, 'personal', caseId, started)
  // The clock the branch reads is the age of the STATUS, not of the case.
  db.prepare(`UPDATE personal_cases SET updated_at = ? WHERE case_id = ?`).run(started, caseId)
  db.prepare(
    `UPDATE case_progression_state SET updated_at = ?, created_at = ?
     WHERE domain = 'personal' AND case_id = ?`,
  ).run(started, started, caseId)
}

function cycle(caseId: string) {
  return runProgressionCycle(getDb(), 'personal', caseId, NOW, {
    triggerType: 'MANUAL', triggerReference: 'regression',
  })
}

describe('owner-action → RECOVERY_REQUIRED: the clock, not the owner', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a wait older than 7 days decides RECOVERY_REQUIRED with NO owner event at all', () => {
    // No owner-action, no completion intent, nothing said by anybody. If the
    // decision still comes out RECOVERY_REQUIRED, then the owner's message was
    // never the cause -- which is the whole claim of this file.
    waitingCase('c-overdue', 9)
    cycle('c-overdue')

    const run = getDb().prepare(
      `SELECT decision, reason FROM case_progression_runs
       WHERE case_id = 'c-overdue' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get() as { decision: string; reason: string } | undefined

    expect(run?.decision).toBe('RECOVERY_REQUIRED')
    // The reason names the clock. An assertion on the decision alone would pass
    // for a recovery triggered by something else entirely.
    expect(run?.reason).toMatch(/exceeded 7 days/i)
  })

  it('the same case one day under the threshold decides WAIT_EXTERNAL', () => {
    // The control. Without it, the test above proves only that this fixture
    // produces recovery, not that the SEVEN-DAY BOUNDARY is what produces it.
    waitingCase('c-fresh', 3)
    cycle('c-fresh')

    const run = getDb().prepare(
      `SELECT decision FROM case_progression_runs
       WHERE case_id = 'c-fresh' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get() as { decision: string } | undefined

    expect(run?.decision).toBe('WAIT_EXTERNAL')
  })

  it('the case is left in WAITING_EXTERNAL, not moved into a recovery status', () => {
    // The half that made the original report confusing: the DECISION says
    // recovery while the STATUS stays put. Both are true at once, and a reader
    // who sees only the decision concludes the case moved when it did not.
    waitingCase('c-status', 9)
    cycle('c-status')
    const row = getDb().prepare(
      `SELECT status FROM personal_cases WHERE case_id = 'c-status'`,
    ).get() as { status: string }
    expect(row.status).toBe('WAITING_EXTERNAL')
  })
})
