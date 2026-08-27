// What an owner answer MEANS, and how long it means it (review 2026-08-13,
// findings A1/A2/A3 — one root cause, one fix).
//
// The three failures this file pins down were the same failure wearing three
// faces: the engine read an answer's meaning off the string 'NO' and nothing
// else, and it never asked when the answer was given or whether it had already
// been used.
//
//   A1  Anything that was not 'NO' granted an approval — an OWNER_INFORMATION,
//       a confirmation, a decision whose payload failed to parse. Answering
//       "a vízdíjról: holnap utánanézek" moved the case to READY under the
//       words "Owner approved the request".
//   A2  An answer had no expiry and no consumed-marker, and plan wrap-around
//       makes the same (decision, nbaStep) question recur BY DESIGN. So a YES
//       from months ago approved a DIFFERENT request the owner never saw.
//   A3  Mission Control offers real alternatives — Lemondjuk, Várjunk még rá —
//       and every one of them advanced the plan exactly like a go-ahead,
//       because nothing outside answer-options.ts read the values.
//
// Plus the two clocks that were measuring the wrong thing (A6), the §22 switch
// that did not reach the engine (A7), and the ledger fields that were fiction
// (A17).

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase, appendCaseEvent, transitionCase } from '../cos/case-store.js'
import { ensureLadderSchema } from '../cos/autonomy-ladder.js'
import { engageKillSwitch } from '../cos/kill-switch.js'
import { runProgressionCycle, decide, type PipelineOptions, type ResolvedContext } from '../cos/progression-pipeline.js'
import { releaseProgressionClaim } from '../cos/progression-scheduler.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initCosSchema(db)
  return db
}

const T = 1_800_000_000
const OPTS: PipelineOptions = { triggerType: 'MANUAL', triggerReference: 'answer-semantics-test' }

/** A case whose questions are answerable: status drives the question, and the
 *  DoD is pre-satisfied so the completion gate never interferes. */
function seedCase(db: Database.Database, caseId: string, status: string, t = T): void {
  createCase(db, {
    caseId, title: caseId, caseType: 'HOME_REPAIR',
    status: status as never, sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
  }, t)
  db.prepare(
    `INSERT INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode, goal, summary,
      next_progression_at, dod_verification_json, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', ?, ?, ?, ?, ?, ?)`,
  ).run(caseId, 'Goal', 'Summary', t, JSON.stringify({
    criteria: [{ label: '_seed_guard', met: true, met_at: t, met_by_run: '_seed' }],
    all_met: true, evaluated_at: t,
  }), t, t)
}

function cycle(db: Database.Database, caseId: string, at: number) {
  releaseProgressionClaim(db, 'personal', caseId, 'runner', at)
  return runProgressionCycle(db, 'personal', caseId, at, OPTS)
}

function status(db: Database.Database, caseId: string): string {
  return (db.prepare('SELECT status FROM personal_cases WHERE case_id = ?')
    .get(caseId) as { status: string }).status
}

function answer(
  db: Database.Database, caseId: string, runId: string,
  ev: 'OWNER_DECISION' | 'OWNER_INFORMATION' | 'OWNER_CONFIRMATION',
  payload: unknown, at: number,
): void {
  appendCaseEvent(db, {
    caseId, caseVersion: 1, actor: 'istvan', eventType: ev,
    payload: payload as never, sourceSystem: 'mission_control', sourceReference: runId,
  }, at)
}

/** Drive an AWAITING_APPROVAL case to a SETTLED question and return the run
 *  that asked it.
 *
 *  Two cycles, not one: the first completes plan step 1 (VERIFY, autonomous),
 *  so the question it asked was (REQUEST_APPROVAL, step 1) and the case is now
 *  asking (REQUEST_APPROVAL, step 2). Answering the first run would be answering
 *  a question the case has moved past — which the content-identity rule
 *  correctly refuses, and which is not what any of these tests are about. */
function askApproval(db: Database.Database, caseId: string, at: number): string {
  expect(cycle(db, caseId, at).decision).toBe('REQUEST_APPROVAL')
  const r = cycle(db, caseId, at + 1)
  expect(r.decision).toBe('REQUEST_APPROVAL')
  return r.runId
}

// ── A1: the approval gate ────────────────────────────────────────────────

describe('an approval is granted by an explicit YES and nothing else', () => {
  it('OWNER_INFORMATION — free text on an approval question — does NOT approve', () => {
    const db = freshDb()
    seedCase(db, 'c-info', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-info', T + 1)

    // Exactly what recordOwnerAnswer writes for any sentence that is not a
    // plain yes/no. This used to read as "Owner approved the request".
    answer(db, 'c-info', runId, 'OWNER_INFORMATION',
      { choice: null, answer: 'A vízdíjról: holnap utánanézek' }, T + 10)

    const r = cycle(db, 'c-info', T + 11)
    expect(status(db, 'c-info')).toBe('AWAITING_APPROVAL')
    expect(r.decision).toBe('REQUEST_APPROVAL')
    expect(r.reason).toMatch(/explicit YES/)
  })

  it('OWNER_CONFIRMATION does NOT approve', () => {
    const db = freshDb()
    seedCase(db, 'c-conf', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-conf', T + 1)
    answer(db, 'c-conf', runId, 'OWNER_CONFIRMATION', {}, T + 10)

    cycle(db, 'c-conf', T + 11)
    expect(status(db, 'c-conf')).toBe('AWAITING_APPROVAL')
  })

  it('an OWNER_DECISION whose payload will not parse does NOT approve', () => {
    const db = freshDb()
    seedCase(db, 'c-broken', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-broken', T + 1)
    // The parse failure was swallowed, leaving choice:null — which is not 'NO'.
    db.prepare(
      `INSERT INTO personal_case_events
       (case_id, case_version, actor, event_type, payload, source_system, source_reference, created_at)
       VALUES (?, 1, 'istvan', 'OWNER_DECISION', '{not json', 'mission_control', ?, ?)`,
    ).run('c-broken', runId, T + 10)

    cycle(db, 'c-broken', T + 11)
    expect(status(db, 'c-broken')).toBe('AWAITING_APPROVAL')
  })

  it('an OWNER_DECISION with an unknown choice value does NOT approve', () => {
    const db = freshDb()
    seedCase(db, 'c-unknown', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-unknown', T + 1)
    answer(db, 'c-unknown', runId, 'OWNER_DECISION', { choice: 'MAYBE' }, T + 10)

    cycle(db, 'c-unknown', T + 11)
    expect(status(db, 'c-unknown')).toBe('AWAITING_APPROVAL')
  })

  it('an explicit YES still approves — the gate is not a wall', () => {
    const db = freshDb()
    seedCase(db, 'c-yes', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-yes', T + 1)
    answer(db, 'c-yes', runId, 'OWNER_DECISION', { choice: 'YES' }, T + 10)

    cycle(db, 'c-yes', T + 11)
    expect(status(db, 'c-yes')).toBe('READY')
  })
})

// ── A2: an answer is time-bounded and consumed once ──────────────────────

describe('an answer belongs to the question it was given to', () => {
  it('a YES from an EARLIER approval episode cannot approve a later one', () => {
    const db = freshDb()
    seedCase(db, 'c-old', 'AWAITING_APPROVAL')
    const firstAsk = askApproval(db, 'c-old', T + 1)
    answer(db, 'c-old', firstAsk, 'OWNER_DECISION', { choice: 'YES' }, T + 10)
    cycle(db, 'c-old', T + 11)
    expect(status(db, 'c-old')).toBe('READY')

    // Months later the case needs approval for something ELSE. Same case, same
    // status, and the run stabilises on the same (REQUEST_APPROVAL, step)
    // tuple — which is what made the year-old YES look current.
    const later = T + 200 * 86400
    const v = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-old') as { version: number }).version
    transitionCase(db, {
      caseId: 'c-old', newStatus: 'AWAITING_APPROVAL', actor: 'istvan',
      seenVersion: v, reason: 'new request needs approval',
    }, later)

    const r = cycle(db, 'c-old', later + 1)
    expect(r.decision).toBe('REQUEST_APPROVAL')
    expect(status(db, 'c-old')).toBe('AWAITING_APPROVAL')
  })

  it('the same answer is not consumed twice', () => {
    const db = freshDb()
    seedCase(db, 'c-once', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-once', T + 1)
    answer(db, 'c-once', runId, 'OWNER_DECISION', { choice: 'YES' }, T + 10)

    cycle(db, 'c-once', T + 11)
    expect(status(db, 'c-once')).toBe('READY')

    // The consuming run names the event it used; nothing may use it again.
    const consumed = db.prepare(
      `SELECT json_extract(progress_delta_json, '$.consumedAnswerEventId') AS id
       FROM case_progression_runs WHERE case_id = 'c-once'
         AND json_extract(progress_delta_json, '$.consumedAnswerEventId') IS NOT NULL`,
    ).all() as Array<{ id: number }>
    expect(consumed).toHaveLength(1)

    // Put the case back into the asking state WITHOUT a new answer.
    const v = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-once') as { version: number }).version
    transitionCase(db, {
      caseId: 'c-once', newStatus: 'AWAITING_APPROVAL', actor: 'istvan',
      seenVersion: v, reason: 'asking again',
    }, T + 20)

    cycle(db, 'c-once', T + 21)
    expect(status(db, 'c-once')).toBe('AWAITING_APPROVAL')
  })
})

// ── A3: the option vocabulary has meaning ────────────────────────────────

describe('the buttons Mission Control renders mean what they say', () => {
  /** An AWAITING_SELECTION case asks REQUEST_DECISION on plan step 2. */
  function askDecision(db: Database.Database, caseId: string): string {
    seedCase(db, caseId, 'AWAITING_SELECTION')
    const r1 = cycle(db, caseId, T + 1)
    expect(r1.decision).toBe('CONTINUE_AUTONOMOUSLY')
    const r2 = cycle(db, caseId, T + 2)
    expect(r2.decision).toBe('REQUEST_DECISION')
    return r2.runId
  }

  function completedStep(db: Database.Database, caseId: string): number {
    return (db.prepare(
      `SELECT completed_plan_step AS s FROM case_progression_state
       WHERE domain = 'personal' AND case_id = ?`,
    ).get(caseId) as { s: number }).s
  }

  it('"Lemondjuk" (CANCEL) blocks the case instead of advancing the plan', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-cancel')
    answer(db, 'c-cancel', runId, 'OWNER_DECISION', { choice: 'CANCEL' }, T + 10)

    const r = cycle(db, 'c-cancel', T + 11)
    expect(status(db, 'c-cancel')).toBe('BLOCKED')
    expect(r.decision).toBe('RECOVERY_REQUIRED')
  })

  it('"Hagyjuk ezt az utat" (DROP) blocks the case', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-drop')
    answer(db, 'c-drop', runId, 'OWNER_DECISION', { choice: 'DROP' }, T + 10)

    cycle(db, 'c-drop', T + 11)
    expect(status(db, 'c-drop')).toBe('BLOCKED')
  })

  it('"Várjunk még rá" (KEEP_WAITING) does not advance the step', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-wait')
    const before = completedStep(db, 'c-wait')
    answer(db, 'c-wait', runId, 'OWNER_DECISION', { choice: 'KEEP_WAITING' }, T + 10)

    const r = cycle(db, 'c-wait', T + 11)
    expect(completedStep(db, 'c-wait')).toBe(before)
    expect(status(db, 'c-wait')).toBe('AWAITING_SELECTION')
    expect(r.reason).toMatch(/wait/i)
  })

  it('"Elhalasztjuk" (POSTPONE) does not advance the step', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-postpone')
    const before = completedStep(db, 'c-postpone')
    answer(db, 'c-postpone', runId, 'OWNER_DECISION', { choice: 'POSTPONE' }, T + 10)

    cycle(db, 'c-postpone', T + 11)
    expect(completedStep(db, 'c-postpone')).toBe(before)
  })

  it('"Kérjünk mástól is" (ASK_OTHERS) has no engine meaning yet, so nothing moves', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-others')
    const before = completedStep(db, 'c-others')
    answer(db, 'c-others', runId, 'OWNER_DECISION', { choice: 'ASK_OTHERS' }, T + 10)

    const r = cycle(db, 'c-others', T + 11)
    expect(completedStep(db, 'c-others')).toBe(before)
    expect(status(db, 'c-others')).toBe('AWAITING_SELECTION')
    expect(r.reason).toMatch(/no engine meaning/)
  })

  it('"Megyünk" (GO) settles the decision and advances', () => {
    const db = freshDb()
    const runId = askDecision(db, 'c-go')
    answer(db, 'c-go', runId, 'OWNER_DECISION', { choice: 'GO' }, T + 10)

    const r = cycle(db, 'c-go', T + 11)
    // P4 CLOSURE, owner 2026-08-27: an answer is not an approval. The step still
    // ADVANCES on the answer -- which is what this test is about -- but the
    // EXECUTE step it advances to is HIGH_RISK, and Invariant E gates it while
    // the engine's own confidence is below HIGH. Asserting the gate's code here
    // rather than only the decision keeps the test measuring answer handling: a
    // regression in answer consumption would produce REQUEST_DECISION, not this.
    expect(r.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(r.safetyViolations.map(v => v.assertion)).toContain('INVARIANT_E_REFUSAL')
    expect(completedStep(db, 'c-go')).toBeGreaterThan(2)
  })
})

// ── A6: the wait clock starts when the wait starts ───────────────────────

describe('the external-wait escalation measures the wait, not the case', () => {
  it('a months-old case that has JUST started waiting is not overdue', () => {
    const db = freshDb()
    const born = T - 90 * 86400
    seedCase(db, 'c-wait-clock', 'READY', born)
    const v = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-wait-clock') as { version: number }).version
    transitionCase(db, {
      caseId: 'c-wait-clock', newStatus: 'WAITING_EXTERNAL', actor: 'istvan',
      seenVersion: v, reason: 'asked the contractor',
    }, T)

    const r = cycle(db, 'c-wait-clock', T + 60)
    // Before the fix this was RECOVERY_REQUIRED with "External wait exceeded
    // 7 days (90d)" — about a wait one minute old.
    expect(r.decision).toBe('WAIT_EXTERNAL')
  })

  it('a wait that really has run for more than a week still escalates', () => {
    const db = freshDb()
    const born = T - 90 * 86400
    seedCase(db, 'c-wait-old', 'READY', born)
    const v = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-wait-old') as { version: number }).version
    transitionCase(db, {
      caseId: 'c-wait-old', newStatus: 'WAITING_EXTERNAL', actor: 'istvan',
      seenVersion: v, reason: 'asked the contractor',
    }, T - 10 * 86400)

    const r = cycle(db, 'c-wait-old', T)
    expect(r.decision).toBe('RECOVERY_REQUIRED')
    expect(r.reason).toContain('10d')
  })

  it('decide() reads statusAgeDays, not ageDays', () => {
    const ctx: ResolvedContext = {
      eventCount: 1, lastEventType: null, lastEventReason: null,
      hasParent: false, hasChildren: false,
      ageDays: 400, statusAgeDays: 1, nextWakeAt: null, sensitivity: 'PERSONAL',
    }
    const nba = {
      planStep: 2, description: 'x', kind: 'AWAIT_EXTERNAL' as const,
      canProceedAutonomously: false, estimatedEffortMinutes: 5,
    }
    expect(decide(nba, ctx, 'WAITING_EXTERNAL').decision).toBe('WAIT_EXTERNAL')
    expect(decide(nba, { ...ctx, statusAgeDays: 9 }, 'WAITING_EXTERNAL').decision).toBe('RECOVERY_REQUIRED')
  })
})

// ── A16: WAIT_TIME has a producer, and it arms the scheduler ─────────────

describe('a wait bounded by a clock we hold is WAIT_TIME', () => {
  it('produces WAIT_TIME and schedules the next progression for the wake', () => {
    const db = freshDb()
    seedCase(db, 'c-wake', 'WAITING_EXTERNAL')
    const wake = T + 3 * 86400
    db.prepare('UPDATE personal_cases SET next_wake_at = ? WHERE case_id = ?').run(wake, 'c-wake')

    const r = cycle(db, 'c-wake', T + 60)
    expect(r.decision).toBe('WAIT_TIME')
    const st = db.prepare(
      `SELECT next_progression_at AS n, wait_version AS w FROM case_progression_state
       WHERE domain = 'personal' AND case_id = 'c-wake'`,
    ).get() as { n: number; w: number }
    expect(st.n).toBe(wake)
    // A newly armed wait is a new state for §10.8's dedup hash.
    expect(st.w).toBe(1)
    // Re-arming the SAME wait must NOT bump it, or every sweep looks like a
    // new state and the run storm comes back.
    cycle(db, 'c-wake', T + 120)
    expect((db.prepare(
      `SELECT wait_version AS w FROM case_progression_state
       WHERE domain = 'personal' AND case_id = 'c-wake'`,
    ).get() as { w: number }).w).toBe(1)
  })
})

// ── A7: the kill switch stops the engine ─────────────────────────────────

describe('the §22 master switch reaches the progression engine', () => {
  it('refuses the cycle, consumes no answer and transitions nothing', () => {
    const db = freshDb()
    ensureLadderSchema(db)
    db.exec(`CREATE TABLE IF NOT EXISTS cos_kill_switch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, engaged INTEGER NOT NULL, reason TEXT,
      actor TEXT, tickets_revoked INTEGER, created_at INTEGER NOT NULL)`)
    seedCase(db, 'c-stop', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-stop', T + 1)
    answer(db, 'c-stop', runId, 'OWNER_DECISION', { choice: 'YES' }, T + 10)

    engageKillSwitch(db, { reason: 'állj', actor: 'istvan' }, T + 11)

    const r = cycle(db, 'c-stop', T + 12)
    expect(r.status).toBe('FAILED')
    expect(r.errorCode).toBe('KILL_SWITCH_ENGAGED')
    expect(r.decision).toBeNull()
    // The answer was NOT consumed and the case did NOT move.
    expect(status(db, 'c-stop')).toBe('AWAITING_APPROVAL')
    expect((db.prepare(
      `SELECT COUNT(*) AS n FROM case_progression_runs
       WHERE case_id = 'c-stop' AND json_extract(progress_delta_json, '$.consumedAnswerEventId') IS NOT NULL`,
    ).get() as { n: number }).n).toBe(0)
    // …and the refusal is in the ledger rather than silent.
    expect((db.prepare(
      `SELECT COUNT(*) AS n FROM case_progression_runs
       WHERE case_id = 'c-stop' AND error_code = 'KILL_SWITCH_ENGAGED'`,
    ).get() as { n: number }).n).toBe(1)
  })
})

// ── A14: the cycle claims for itself ─────────────────────────────────────

describe('a caller that forgets to claim is protected anyway', () => {
  it('refuses when another runner already holds the progression claim', () => {
    const db = freshDb()
    seedCase(db, 'c-claim', 'READY')
    db.prepare(
      `INSERT INTO case_claims (claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
       VALUES ('progression:personal:c-claim', 'other-runner', 1, ?, ?)`,
    ).run(T, T + 300)

    const r = runProgressionCycle(db, 'personal', 'c-claim', T + 1, OPTS)
    expect(r.status).toBe('FAILED')
    expect(r.errorCode).toBe('PROGRESSION_CLAIM_HELD')
    // No progression state was written by the refused run.
    expect((db.prepare(
      `SELECT last_progressed_at AS l FROM case_progression_state
       WHERE domain = 'personal' AND case_id = 'c-claim'`,
    ).get() as { l: number | null }).l).toBeNull()
  })

  it('takes and releases its own claim when nobody holds one', () => {
    const db = freshDb()
    seedCase(db, 'c-claim-ok', 'READY')
    const r = runProgressionCycle(db, 'personal', 'c-claim-ok', T + 1, OPTS)
    expect(r.status).toBe('COMPLETED')
    expect((db.prepare(
      `SELECT COUNT(*) AS n FROM case_claims WHERE claim_key = 'progression:personal:c-claim-ok'`,
    ).get() as { n: number }).n).toBe(0)
  })
})

// ── A17: the run ledger records the case's real versions ─────────────────

describe('the run ledger is replayable', () => {
  it('case_version_before/after follow the CASE, not the state row counter', () => {
    const db = freshDb()
    seedCase(db, 'c-ver', 'AWAITING_APPROVAL')
    const runId = askApproval(db, 'c-ver', T + 1)
    const vBefore = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-ver') as { version: number }).version

    // A run that changes nothing leaves the version alone.
    const quiet = db.prepare(
      `SELECT case_version_before AS b, case_version_after AS a FROM case_progression_runs
       WHERE progression_run_id = ?`,
    ).get(runId) as { b: number; a: number }
    expect(quiet.b).toBe(vBefore)
    expect(quiet.a).toBe(vBefore)

    // A run that transitions the case records the version it left behind.
    answer(db, 'c-ver', runId, 'OWNER_DECISION', { choice: 'YES' }, T + 10)
    const r = cycle(db, 'c-ver', T + 11)
    const moved = db.prepare(
      `SELECT case_version_before AS b, case_version_after AS a FROM case_progression_runs
       WHERE progression_run_id = ?`,
    ).get(r.runId) as { b: number; a: number }
    const vAfter = (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('c-ver') as { version: number }).version
    expect(moved.b).toBe(vBefore)
    expect(moved.a).toBe(vAfter)
    expect(moved.a).toBeGreaterThan(moved.b)
  })
})
