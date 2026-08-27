// P6 — the end-to-end proof, and restart.
//
//   "One harness that drives a case through the full lifecycle against a real
//    store: intake -> actionable -> action -> waiting -> wake -> completion with
//    evidence -> contradictory evidence -> reopen. Then kill the process
//    mid-flight and restart, and assert the state is consistent and no work is
//    duplicated."
//
// Acceptance: all ten §10.8 scenarios green IN ONE RUN, each red-capable.
//
// WHY ONE FILE FOR TEN SCENARIOS THAT MOSTLY HAVE TESTS ALREADY. The audit's
// standing table says four covered, four partial, one gap, one unknown -- and
// every "covered" is covered by a different file, with a different fixture, on a
// different shape of case. That is ten proofs that ten mechanisms work, and it
// is not a proof that they compose. This file drives ONE case through the whole
// arc against a real file-backed store, so a scenario that only passes on its
// own fixture fails here.
//
// A REAL STORE, not ':memory:', because scenario 10 needs a second process to
// open the same database -- and because a lifecycle proof over a database that
// evaporates when the test ends is proving something weaker than it sounds.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent, transitionCase } from '../cos/case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { decideTrigger, recordProgressionState } from '../cos/progression-trigger.js'
import { armWaitCondition, evaluateWaitCondition } from '../cos/wait-condition.js'
import {
  canCompleteCase, satisfyNextDoDCriterionWithEvidence, initializeDoDVerification,
} from '../cos/progression-completion.js'
import { reopenCase } from '../cos/case-reopen.js'
import { invariantE } from '../cos/decision-confidence.js'

const NOW = 1_700_000_000

let root: string
let dbPath: string

beforeAll(() => {
  // NOT /tmp-prefixed via a bare literal: the hook-path guard rejects those, and
  // a suite that goes falsely red there teaches the wrong lesson twice.
  root = mkdtempSync(join(tmpdir(), 'cos-p6-'))
  dbPath = join(root, 'p6.db')
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } })

/** A case at the start of its life, on the real store. */
function freshCase(caseId: string, status: 'NEW' | 'READY' | 'AWAITING_SELECTION' = 'NEW'): void {
  const db = getDb()
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN', status,
    sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'p6',
  }, NOW - 1000)
  seedCaseProgressionState(db, 'personal', caseId, NOW - 1000)
}

function runCycle(caseId: string, at: number, ref = 'p6') {
  return runProgressionCycle(getDb(), 'personal', caseId, at, {
    triggerType: 'MANUAL', triggerReference: ref,
  })
}

const runRows = (caseId: string): Array<{ decision: string; status: string; trigger_reference: string }> =>
  getDb().prepare(
    `SELECT decision, status, trigger_reference FROM case_progression_runs
      WHERE case_id = ? ORDER BY started_at, rowid`,
  ).all(caseId) as never

describe('P6 — the ten §10.8 scenarios, one store, one arc', () => {
  beforeEach(() => { initDatabase(dbPath) })

  it('1. an actionable case advances, and the advance is durable', () => {
    freshCase('s1')
    const r = runCycle('s1', NOW)
    expect(r.decision).toBeTruthy()
    const rows = runRows('s1')
    expect(rows.length).toBe(1)
    // The DURABLE row, not the returned object -- the distinction this phase
    // learned the hard way.
    expect(rows[0].decision).toBe(r.decision)
    const state = getDb().prepare(
      `SELECT completed_plan_step AS c, next_best_action_json AS nba
         FROM case_progression_state WHERE domain='personal' AND case_id='s1'`,
    ).get() as { c: number; nba: string }
    expect(state.nba).toBeTruthy()
    expect(state.c).toBeGreaterThanOrEqual(0)
  })

  it('2. a waiting case wakes on an EVENT, through the typed condition', () => {
    freshCase('s2')
    const armed = armWaitCondition(getDb(), {
      domain: 'personal', caseId: 's2', kind: 'EXTERNAL_RESPONSE',
      subject: 'a szállító válasza', expectedBy: NOW + 86_400,
      wakePolicy: 'EITHER', runId: 'p6-arm',
    }, NOW)
    expect(armed.ok).toBe(true)

    const before = evaluateWaitCondition(getDb(), 'personal', 's2', NOW + 60)
    expect(before.verdict).toBe('WAITING')

    appendCaseEvent(getDb(), {
      caseId: 's2', caseVersion: 1, actor: 'supplier', eventType: 'EMAIL_RECEIVED',
      payload: { from: 'szallito@pelda.hu' }, sourceSystem: 'gmail', sourceReference: 'm1',
    }, NOW + 120)

    const after = evaluateWaitCondition(getDb(), 'personal', 's2', NOW + 180)
    expect(after.verdict).toBe('SATISFIED')
    // RED-CAPABLE: the control is `before`. Without it, a condition that is
    // satisfied from birth would pass this test and prove nothing about events.
  })

  it('3. a waiting case wakes on its REVIEW DATE even when nothing happened', () => {
    freshCase('s3')
    armWaitCondition(getDb(), {
      domain: 'personal', caseId: 's3', kind: 'SCHEDULED_REVIEW',
      subject: 'ütemezett átnézés', expectedBy: NOW + 3600,
      wakePolicy: 'TIMER', runId: 'p6-arm',
    }, NOW)
    expect(evaluateWaitCondition(getDb(), 'personal', 's3', NOW + 60).verdict).toBe('WAITING')
    // SATISFIED, not EXPIRED, and I had this backwards on the first pass. The
    // two words mean opposite things here: reaching the review date IS the wake
    // this wait was armed for, so the clock SATISFIES it. EXPIRED is reserved
    // for the stale-review time passing with nothing having met the condition --
    // scenario 4 is where that gets proven.
    const woke = evaluateWaitCondition(getDb(), 'personal', 's3', NOW + 3601)
    expect(woke.verdict).toBe('SATISFIED')
    expect(woke.detail).toMatch(/óra/)
  })

  it('4. a wait nothing ever satisfies EXPIRES rather than holding for ever', () => {
    // PARTIAL BY DESIGN, and named as such: §11's commitment model is Phase 2,
    // so what is provable here is the wait's stale safety, not a promise ledger.
    // Asserting more than that would be a green test over an unbuilt feature.
    //
    // EVENT_ONLY on purpose. Under EITHER the clock would SATISFY the wait, and
    // this scenario is about the other end -- Invariant C's rule that an
    // event-only wake carries its own stale review, so a reply that never comes
    // cannot park a case for ever.
    freshCase('s4')
    armWaitCondition(getDb(), {
      domain: 'personal', caseId: 's4', kind: 'EXTERNAL_RESPONSE',
      subject: 'ígért visszajelzés', expectedBy: null,
      wakePolicy: 'EVENT_ONLY', runId: 'p6-arm',
    }, NOW)
    const w = getDb().prepare(
      `SELECT stale_review_at AS t FROM case_wait_conditions
        WHERE case_id='s4' AND resolved_at IS NULL`,
    ).get() as { t: number }
    expect(evaluateWaitCondition(getDb(), 'personal', 's4', w.t - 1).verdict).toBe('WAITING')
    const late = evaluateWaitCondition(getDb(), 'personal', 's4', w.t + 1)
    expect(late.verdict).toBe('EXPIRED')
  })

  it('5. a question is asked ONCE, and a second run does not re-ask', () => {
    freshCase('s5', 'AWAITING_SELECTION')
    runCycle('s5', NOW)
    const r2 = runCycle('s5', NOW + 10)
    expect(r2.decision).toBe('REQUEST_DECISION')
    const asked = getDb().prepare(
      `SELECT COUNT(*) AS n FROM cos_owner_questions WHERE case_id='s5'`,
    ).get() as { n: number }
    const r3 = runCycle('s5', NOW + 20)
    const askedAgain = getDb().prepare(
      `SELECT COUNT(*) AS n FROM cos_owner_questions WHERE case_id='s5'`,
    ).get() as { n: number }
    expect(askedAgain.n).toBe(asked.n)
    expect(r3.decision).toBe('REQUEST_DECISION')
  })

  it('6. a high-risk action at unproven confidence produces NO side effect', () => {
    // The scenario the audit called a GAP: it was enforced by the approval bind,
    // which is a different rule that happens to overlap. P4 made it an invariant.
    freshCase('s6', 'READY')
    runCycle('s6', NOW)
    getDb().prepare(
      `UPDATE case_progression_state SET completed_plan_step = 1
        WHERE domain='personal' AND case_id='s6'`,
    ).run()
    const r = runCycle('s6', NOW + 60)
    expect(r.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
    // NO SIDE EFFECT: nothing was staged on the outbound ledger.
    const staged = getDb().prepare(
      `SELECT COUNT(*) AS n FROM outbound_ledger WHERE case_id='s6'`,
    ).get() as { n: number }
    expect(staged.n).toBe(0)
    // And the durable row agrees with the refusal.
    expect(runRows('s6').at(-1)?.decision).toBe('MANUAL_ACTION_REQUIRED')
  })

  it('7. completion needs evidence AND a DoD that belongs to THIS case', () => {
    // Two rules, and the arc found the second one. Satisfying every criterion
    // with evidence is NOT enough while the DoD is the per-status template: a
    // template says the same three things about every case in that status, so
    // meeting it proves the engine ran, not that the matter is settled. That
    // rule is what stopped the 2026-08-09 mass closure, and it is worth a
    // scenario of its own rather than being discovered by a surprised test.
    freshCase('s7')
    runCycle('s7', NOW)
    expect(canCompleteCase(getDb(), 'personal', 's7', 'ENGINE').allowed).toBe(false)

    // All criteria met, with evidence, on a GENERIC template.
    let satisfied = 0
    while (satisfyNextDoDCriterionWithEvidence(
      getDb(), 'personal', 's7', 'p6', `ev-${satisfied}`, NOW + 100 + satisfied) >= 0) satisfied++
    expect(satisfied).toBeGreaterThan(0)
    const generic = canCompleteCase(getDb(), 'personal', 's7', 'ENGINE')
    expect(generic.allowed).toBe(false)
    expect(generic.reason).toMatch(/generic status template/)
    // And the refusal does not blame the criteria it just watched being met.
    expect(generic.unmet).toEqual([])

    // THE CONTROL, which is what makes this red-capable: a case-specific
    // contract, met with evidence, and the same gate opens. Without it, a gate
    // that never opens at all would pass every assertion above.
    freshCase('s7b')
    runCycle('s7b', NOW)
    getDb().prepare(
      `UPDATE case_progression_state SET dod_verification_json = NULL
        WHERE domain='personal' AND case_id='s7b'`,
    ).run()
    initializeDoDVerification(getDb(), 'personal', 's7b',
      ['A szállító visszaigazolta a szállítást'], 'CASE_SPECIFIC', NOW + 50)
    expect(canCompleteCase(getDb(), 'personal', 's7b', 'ENGINE').allowed).toBe(false)
    satisfyNextDoDCriterionWithEvidence(getDb(), 'personal', 's7b', 'p6', 'gmail:msg-1', NOW + 60)
    expect(canCompleteCase(getDb(), 'personal', 's7b', 'ENGINE').allowed).toBe(true)
  })

  it('8. contradictory evidence after completion REOPENS, and the completion survives', () => {
    freshCase('s8')
    const db = getDb()
    transitionCase(db, {
      caseId: 's8', newStatus: 'COMPLETED', actor: 'p6', seenVersion: 1,
    }, NOW + 10)
    const completedAt = (db.prepare(
      `SELECT completed_at AS t FROM personal_cases WHERE case_id='s8'`,
    ).get() as { t: number | null }).t
    expect(completedAt).not.toBeNull()

    const re = reopenCase(db, {
      domain: 'personal', caseId: 's8',
      reason: 'a szállító azt írja, sosem érkezett meg', actor: 'p6',
      evidence: { sourceSystem: 'gmail', sourceReference: 'thread-1' },
    }, NOW + 100)
    expect(re.ok).toBe(true)

    const row = db.prepare(
      `SELECT status, completed_at AS t FROM personal_cases WHERE case_id='s8'`,
    ).get() as { status: string; t: number | null }
    expect(row.status).not.toBe('COMPLETED')
    expect(row.t).toBeNull()
    // The completion is not erased -- it moves into the append-only log.
    const events = db.prepare(
      `SELECT event_type FROM personal_case_events WHERE case_id='s8' ORDER BY event_id`,
    ).all() as Array<{ event_type: string }>
    expect(events.map(e => e.event_type)).toContain('CASE_REOPENED')
    expect(events.filter(e => e.event_type === 'STATUS_CHANGED').length).toBeGreaterThan(0)
  })

  it('9. an unchanged case is not reasoned about again -- the trigger contract', () => {
    // MY FIRST VERSION OF THIS WAS NEARLY TAUTOLOGICAL: it drove two cycles and
    // asserted two run rows with two trigger references, which is true of a
    // system that duplicates work as readily as one that does not. The real
    // property is the trigger contract -- after a run has consumed the state it
    // saw, an unchanged case is NOT due -- and that is what is asserted here.
    freshCase('s9')
    const db = getDb()
    const payload = { from: 'a@b.hu', messageId: 'dup-1' }
    appendCaseEvent(db, {
      caseId: 's9', caseVersion: 1, actor: 'x', eventType: 'EMAIL_RECEIVED',
      payload, sourceSystem: 'gmail', sourceReference: 'dup-1',
    }, NOW + 10)
    runCycle('s9', NOW + 20, 'first')
    recordProgressionState(db, 'personal', 's9',
      decideTrigger(db, 'personal', 's9', NOW + 21).effectiveStateHash, NOW + 21)
    const afterFirst = runRows('s9').length

    // The SAME event again: same reference, same content, nothing new about the
    // case. The trigger must say so.
    appendCaseEvent(db, {
      caseId: 's9', caseVersion: 1, actor: 'x', eventType: 'EMAIL_RECEIVED',
      payload, sourceSystem: 'gmail', sourceReference: 'dup-1',
    }, NOW + 30)
    const dup = decideTrigger(db, 'personal', 's9', NOW + 40)

    // The control that makes it red-capable: something that genuinely changed
    // MUST be due, or "not due" would be a constant rather than a judgement.
    //
    // A REAL TRANSITION, not a direct UPDATE of the status column. The trigger's
    // identity is built from the case VERSION, not from the status text, so a
    // hand-written status change moves nothing it looks at -- which is exactly
    // what my first control did, and it read as "the trigger ignores changes"
    // when it actually meant "that was not a change the trigger can see".
    transitionCase(db, { caseId: 's9', newStatus: 'READY', actor: 'p6', seenVersion: 1 }, NOW + 45)
    const changed = decideTrigger(db, 'personal', 's9', NOW + 50)
    expect(changed.shouldRun).toBe(true)
    expect(dup.shouldRun).toBe(false)
    expect(runRows('s9').length).toBe(afterFirst)
  })
})

describe('P6 scenario 10 — a real process dies between the decision and the write', () => {
  beforeEach(() => { initDatabase(dbPath) })

  /** NODE DIRECTLY, not `npx tsx`. The child kills ITSELF, and with npx in the
   *  middle the signal lands on a grandchild: `spawnSync` then reports npx's own
   *  ordinary exit and `signal` is null. The first version of this test did
   *  exactly that and would have passed a "no rows" assertion while the process
   *  had died for the wrong reason -- or not died at all. */
  function child(caseId: string, at: number, seam: 'run-insert' | 'none') {
    return spawnSync(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'src/__tests__/support/p6-crash-child.ts'),
      dbPath, caseId, String(at), seam,
    ], { encoding: 'utf8', timeout: 120_000 })
  }

  it('the CONTROL: the same child, not killed, writes exactly one run', () => {
    // Without this, "no rows after the kill" would be indistinguishable from
    // "the child never worked at all", which is the failure mode a crash test is
    // most likely to have and least likely to notice.
    freshCase('s10a')
    const r = child('s10a', NOW, 'none')
    expect(r.status, r.stderr).toBe(0)
    initDatabase(dbPath)
    expect(runRows('s10a').length).toBe(1)
  })

  it('HEADLINE: killed mid-transaction, the store is consistent and no work is duplicated', () => {
    freshCase('s10b')
    const killed = child('s10b', NOW, 'run-insert')
    // SIGKILL: no exit code, a signal. A clean exit here would mean the seam
    // never fired and the rest of this test proves nothing.
    expect(killed.signal).toBe('SIGKILL')

    initDatabase(dbPath)
    expect(existsSync(dbPath)).toBe(true)
    // NOTHING was committed: the decision died with the process.
    expect(runRows('s10b').length).toBe(0)
    const state = getDb().prepare(
      `SELECT progression_claimed_by AS claim FROM case_progression_state
        WHERE domain='personal' AND case_id='s10b'`,
    ).get() as { claim: string | null } | undefined
    expect(state).toBeTruthy()

    // AND THE RESTART DOES THE WORK, ONCE. A store that survives a crash but
    // cannot make progress afterwards is consistent and useless.
    const after = child('s10b', NOW + 60, 'none')
    expect(after.status, after.stderr).toBe(0)
    initDatabase(dbPath)
    expect(runRows('s10b').length).toBe(1)
  })
})
