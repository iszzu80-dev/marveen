// §10.4 typed wait conditions — P2.
//
// WHAT THE AUDIT GOT WRONG, since it is the reason this exists at all.
// `wait_system_json` was called "a wake system with no writer". It has a writer,
// a reader and a clearer (capability-preflight.ts) and means ONE thing: parked
// on a dead capability. It is empty because that branch is unreachable --
// `preflight` returns ok when no capabilities are declared and nothing declares
// any. And WAIT_TIME is rare not because typed waiting is missing but because
// `decide()` gates it on `context.nextWakeAt`, a board column that is 0 of 122.
//
// The owner's condition for this packet: a typed wait is done when it has a
// writer, a durable condition, a wake evaluator, an idempotent wake and stale
// safety. Filling a column is not acceptance. Each of the five has its own
// block below.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { initProgressionSchema } from '../cos/schema.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import {
  armWaitCondition, activeWaitCondition, evaluateWaitCondition, resolveWaitCondition,
  dueWaitConditions, resolveWaitById, WAIT_KINDS, EVALUABLE_KINDS, DEFAULT_STALE_REVIEW_SEC,
} from '../cos/wait-condition.js'
import { decideTrigger } from '../cos/progression-trigger.js'
import { detectProjectionDrift, projectCase } from '../cos/case-projection.js'

const T0 = 1_700_000_000
const DAY = 86400
type Db = ReturnType<typeof getDb>

function seed(db: Db, caseId = 'c1'): void {
  createCase(db, { caseId, title: 'Garancia', caseType: 'CLAIM' }, T0)
  seedCaseProgressionState(db, 'personal', caseId, T0)
}
function arm(db: Db, over: Record<string, unknown> = {}, now = T0) {
  return armWaitCondition(db, {
    domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE',
    subject: 'a szerviz', expectedBy: now + 3 * DAY, wakePolicy: 'EITHER',
    ...over,
  } as never, now)
}

describe('P2 — the writer', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('arms a durable condition that survives as a row, not a blob', () => {
    const db = getDb(); seed(db)
    const r = arm(db)
    expect(r.ok).toBe(true)
    const w = activeWaitCondition(db, 'personal', 'c1')!
    expect(w.kind).toBe('EXTERNAL_RESPONSE')
    expect(w.subject).toBe('a szerviz')
    expect(w.expected_by).toBe(T0 + 3 * DAY)
    expect(w.resolved_at).toBeNull()
    expect(JSON.parse(w.evidence_predicate_json).test).toBe('CASE_EVENT_AFTER_ARM')
  })

  it('a second arm SUPERSEDES the first instead of running two waits at once', () => {
    // Two live waits on one case is a case that can be woken twice for the same
    // reason. Enforced by a partial unique index, not by convention.
    const db = getDb(); seed(db)
    const first = arm(db)
    const second = arm(db, { subject: 'a gyártó' }, T0 + 100)
    expect(second.supersededWaitId).toBe(first.waitId)
    const rows = db.prepare(`SELECT resolution FROM case_wait_conditions ORDER BY armed_at`)
      .all() as Array<{ resolution: string | null }>
    expect(rows.map(r => r.resolution)).toEqual(['SUPERSEDED', null])
  })

  it('REFUSES a kind it cannot evaluate, rather than writing a row nothing can resolve', () => {
    // COMMITMENT needs the §11 promise tracker, which is Phase 2's and does not
    // exist. POLICY_CHANGE has no source at all. A row that looks typed and can
    // never be resolved is a silent park with better paperwork.
    const db = getDb(); seed(db)
    for (const kind of ['COMMITMENT', 'POLICY_CHANGE']) {
      const r = arm(db, { kind })
      expect(r.ok).toBe(false)
      expect(r.refusal).toBe('UNEVALUABLE_KIND')
    }
    expect(activeWaitCondition(db, 'personal', 'c1')).toBeUndefined()
  })

  it('ORACLE: every declared kind is either evaluable or explicitly refused', () => {
    const db = getDb(); seed(db)
    for (const kind of WAIT_KINDS) {
      const evaluable = EVALUABLE_KINDS.includes(kind)
      const r = arm(db, { kind, expectedBy: T0 + DAY })
      expect(r.ok).toBe(evaluable)
      if (!evaluable) expect(r.refusal).toBe('UNEVALUABLE_KIND')
    }
  })

  it('refuses a timed wait with no deadline, and an unnamed subject', () => {
    const db = getDb(); seed(db)
    expect(arm(db, { wakePolicy: 'TIMER', expectedBy: null }).refusal).toBe('NO_DEADLINE_FOR_TIMED_WAIT')
    expect(arm(db, { subject: '   ' }).refusal).toBe('NO_SUBJECT')
  })
})

describe('P2 — stale safety (§10.2 Invariant C)', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('an EVENT_ONLY wait still carries its own review — silence is not permission', () => {
    const db = getDb(); seed(db)
    const r = arm(db, { wakePolicy: 'EVENT_ONLY', expectedBy: null })
    expect(r.ok).toBe(true)
    const w = activeWaitCondition(db, 'personal', 'c1')!
    expect(w.expected_by).toBeNull()
    expect(w.stale_review_at).toBe(T0 + DEFAULT_STALE_REVIEW_SEC)
  })

  it('a wait nothing answered EXPIRES, and EXPIRED is not SATISFIED', () => {
    // The two mean opposite things to the engine. A wait that quietly reported
    // "met" when the deadline passed would close cases nobody answered.
    const db = getDb(); seed(db)
    arm(db, { wakePolicy: 'EVENT_ONLY', expectedBy: null })
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY).verdict).toBe('WAITING')
    const e = evaluateWaitCondition(db, 'personal', 'c1', T0 + DEFAULT_STALE_REVIEW_SEC + 1)
    expect(e.verdict).toBe('EXPIRED')
    expect(e.detail).toContain('lejárt')
  })

  it('refuses a review time that is already in the past', () => {
    const db = getDb(); seed(db)
    expect(arm(db, { staleReviewAt: T0 - 1 }).refusal).toBe('STALE_REVIEW_BEFORE_NOW')
  })
})

describe('P2 — the evaluator', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('an EITHER wait is met by the reply that arrives BEFORE the deadline', () => {
    const db = getDb(); seed(db)
    arm(db)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY).verdict).toBe('WAITING')
    appendCaseEvent(db, {
      caseId: 'c1', caseVersion: 1, actor: 'gmail', eventType: 'EXTERNAL_MESSAGE_RECEIVED',
    }, T0 + DAY)
    const e = evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY + 1)
    expect(e.verdict).toBe('SATISFIED')
    expect(e.evidence?.eventId).toBeGreaterThan(0)
  })

  it('a TIMER wait ignores events and waits for its clock', () => {
    const db = getDb(); seed(db)
    arm(db, { kind: 'SCHEDULED_REVIEW', wakePolicy: 'TIMER', expectedBy: T0 + 2 * DAY })
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + DAY)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY + 1).verdict).toBe('WAITING')
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + 2 * DAY).verdict).toBe('SATISFIED')
  })

  it('EVENT_ONLY ignores a deadline it HAS — the policy decides, not the absence of a date', () => {
    // The earlier EVENT_ONLY test armed with no deadline at all, so the clock
    // branch could not fire whatever the policy said. A mutation making
    // EVENT_ONLY honour the clock survived it. Here the deadline exists and has
    // passed, and the wait must still be open until the stale review.
    const db = getDb(); seed(db)
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE', subject: 'a szerviz',
      expectedBy: T0 + DAY, wakePolicy: 'EVENT_ONLY', staleReviewAt: T0 + 30 * DAY,
    }, T0)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + 2 * DAY).verdict).toBe('WAITING')
  })

  it('TIMER ignores an event it COULD see — same reason, other direction', () => {
    // The earlier TIMER test used SCHEDULED_REVIEW, a kind that has no event
    // predicate at all, so the policy check was never the thing enforcing it. A
    // mutation making TIMER honour events survived. EXTERNAL_RESPONSE DOES have
    // an event predicate, so here the policy is the only thing standing between
    // the event and a wrong SATISFIED.
    const db = getDb(); seed(db)
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE', subject: 'a szerviz',
      expectedBy: T0 + 5 * DAY, wakePolicy: 'TIMER',
    }, T0)
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + DAY)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY + 1).verdict).toBe('WAITING')
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + 5 * DAY).verdict).toBe('SATISFIED')
  })

  it('an EVENT_ONLY wait ignores its clock and waits for evidence', () => {
    const db = getDb(); seed(db)
    arm(db, { wakePolicy: 'EVENT_ONLY', expectedBy: null, staleReviewAt: T0 + 30 * DAY })
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + 10 * DAY).verdict).toBe('WAITING')
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + 11 * DAY)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + 11 * DAY).verdict).toBe('SATISFIED')
  })

  it('evaluating is READ-ONLY — asking does not consume', () => {
    // The trigger asks on every sweep. A query with a side effect would make the
    // answer depend on who asked first.
    const db = getDb(); seed(db)
    arm(db)
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + DAY)
    for (let i = 0; i < 3; i++) {
      expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY + 1).verdict).toBe('SATISFIED')
    }
    expect(activeWaitCondition(db, 'personal', 'c1')!.resolved_at).toBeNull()
  })

  it('only events AFTER the arming count', () => {
    const db = getDb(); seed(db)
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'OLD' }, T0 - 10)
    arm(db)
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY).verdict).toBe('WAITING')
  })

  it('dueWaitConditions lists what is satisfied or expired, and nothing else', () => {
    const db = getDb()
    seed(db, 'c1'); seed(db, 'c2'); seed(db, 'c3')
    armWaitCondition(db, { domain: 'personal', caseId: 'c1', kind: 'SCHEDULED_REVIEW',
      subject: 'r', expectedBy: T0 + DAY, wakePolicy: 'TIMER' }, T0)
    armWaitCondition(db, { domain: 'personal', caseId: 'c2', kind: 'SCHEDULED_REVIEW',
      subject: 'r', expectedBy: T0 + 100 * DAY, wakePolicy: 'TIMER' }, T0)
    armWaitCondition(db, { domain: 'personal', caseId: 'c3', kind: 'EXTERNAL_RESPONSE',
      subject: 's', expectedBy: null, wakePolicy: 'EVENT_ONLY', staleReviewAt: T0 + DAY }, T0)
    const due = dueWaitConditions(db, T0 + DAY + 1)
    expect(due.map(d => `${d.caseId}:${d.verdict}`).sort())
      .toEqual(['c1:SATISFIED', 'c3:EXPIRED'])
  })
})

describe('P2 — the idempotent wake', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('two runners see the same satisfied wait; exactly ONE consumes it', () => {
    const db = getDb(); seed(db)
    arm(db)
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + DAY)
    const first = resolveWaitCondition(db, 'personal', 'c1', 'SATISFIED', 'reply', 'run-A', T0 + DAY)
    const second = resolveWaitCondition(db, 'personal', 'c1', 'SATISFIED', 'reply', 'run-B', T0 + DAY)
    expect(first.resolved).toBe(true)
    expect(first.alreadyResolved).toBe(false)
    expect(second.resolved).toBe(false)
    expect(second.alreadyResolved).toBe(true)
    const row = db.prepare(`SELECT resolved_run_id, resolution FROM case_wait_conditions`)
      .get() as { resolved_run_id: string; resolution: string }
    expect(row.resolved_run_id).toBe('run-A')
    expect(row.resolution).toBe('SATISFIED')
  })

  it('the RACE: two callers that both already read the row — exactly one wins', () => {
    // The test above exercises the lookup-first early return, and a mutation
    // that deleted the statement's WHERE clause survived it, because the second
    // call never reached the statement at all. This is the guard that answers
    // the actual race: two sweeps evaluating the same satisfied condition at the
    // same moment, both holding the row they read a millisecond ago.
    const db = getDb(); seed(db)
    const armed = arm(db)
    const waitId = armed.waitId!
    const a = resolveWaitById(db, waitId, 'SATISFIED', 'runner A', 'run-A', T0 + DAY)
    const b = resolveWaitById(db, waitId, 'SATISFIED', 'runner B', 'run-B', T0 + DAY)
    expect(a.resolved).toBe(true)
    expect(b.resolved).toBe(false)
    expect(b.alreadyResolved).toBe(true)
    const row = db.prepare(`SELECT resolved_run_id, resolution_detail FROM case_wait_conditions`)
      .get() as { resolved_run_id: string; resolution_detail: string }
    expect(row.resolved_run_id).toBe('run-A')
    expect(row.resolution_detail).toBe('runner A')
  })

  it('a resolved wait stops being the case\'s live condition', () => {
    const db = getDb(); seed(db)
    arm(db)
    resolveWaitCondition(db, 'personal', 'c1', 'SATISFIED', 'x', 'run-A', T0 + DAY)
    expect(activeWaitCondition(db, 'personal', 'c1')).toBeUndefined()
    expect(evaluateWaitCondition(db, 'personal', 'c1', T0 + DAY).verdict).toBe('NONE')
  })
})

describe('P2 — the wake actually wakes the case', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  function settle(db: Db) {
    // Give the trigger a recorded state so "never progressed" is not the reason
    // it fires.
    db.prepare(`UPDATE case_progression_state SET last_effective_state = 'x'
                WHERE domain='personal' AND case_id='c1'`).run()
  }

  it('a WAITING condition holds the case back', () => {
    const db = getDb(); seed(db); settle(db); arm(db)
    const d = decideTrigger(db, 'personal', 'c1', T0 + DAY)
    expect(d.shouldRun).toBe(false)
    expect(d.reason).toContain('typed condition')
  })

  it('a SATISFIED condition wakes it, and names the wait as the reason', () => {
    const db = getDb(); seed(db); settle(db); arm(db)
    appendCaseEvent(db, { caseId: 'c1', caseVersion: 1, actor: 'x', eventType: 'NOTE' }, T0 + DAY)
    const d = decideTrigger(db, 'personal', 'c1', T0 + DAY + 1)
    expect(d.shouldRun).toBe(true)
    expect(d.reason).toContain('wait condition was met')
  })

  it('an EXPIRED condition wakes it too — the case a reply never came for', () => {
    // The one the hash rule alone can never catch: an expiry is not an event, so
    // nothing about the case changes when a wait goes unanswered.
    const db = getDb(); seed(db); settle(db)
    arm(db, { wakePolicy: 'EVENT_ONLY', expectedBy: null, staleReviewAt: T0 + DAY })
    expect(decideTrigger(db, 'personal', 'c1', T0 + 100).shouldRun).toBe(false)
    const d = decideTrigger(db, 'personal', 'c1', T0 + DAY + 1)
    expect(d.shouldRun).toBe(true)
    expect(d.reason).toContain('expired unmet')
  })
})

describe('P2 — the board reads the typed wait', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('proj_next_review_at becomes the wait\'s own deadline, not the poll timer', () => {
    // The P1 proof recorded this as still-not-true: next_progression_at is the
    // poller's five-minute re-check wearing the name of a review appointment.
    const db = getDb(); seed(db)
    db.prepare(`UPDATE case_progression_state SET next_progression_at = ?
                WHERE domain='personal' AND case_id='c1'`).run(T0 + 300)
    projectCase(db, 'personal', 'c1', T0)
    expect(db.prepare(`SELECT proj_next_review_at AS v FROM personal_cases WHERE case_id='c1'`).get())
      .toEqual({ v: T0 + 300 })

    arm(db, { expectedBy: T0 + 3 * DAY })
    projectCase(db, 'personal', 'c1', T0 + 1)
    const b = db.prepare(
      `SELECT proj_next_review_at, proj_wait_condition FROM personal_cases WHERE case_id='c1'`,
    ).get() as { proj_next_review_at: number; proj_wait_condition: string }
    expect(b.proj_next_review_at).toBe(T0 + 3 * DAY)
    expect(b.proj_wait_condition).toBe('EXTERNAL_RESPONSE: a szerviz')
  })

  it('ORACLE: arming or resolving a wait MOVES the canonical revision', () => {
    // The wait lives in its own table, and canonical_revision lives on
    // case_progression_state. Without the triggers on the wait table, the board
    // would go stale while the revision insisted it was current -- the exact
    // failure case-projection's oracle test exists to make impossible.
    const db = getDb(); seed(db)
    const rev = () => (db.prepare(
      `SELECT canonical_revision AS r FROM case_progression_state
        WHERE domain='personal' AND case_id='c1'`).get() as { r: number }).r
    projectCase(db, 'personal', 'c1', T0)
    const before = rev()
    arm(db)
    expect(rev()).toBe(before + 1)
    expect(detectProjectionDrift(db, T0 + 1).behind.map(x => x.caseId)).toEqual(['c1'])
    projectCase(db, 'personal', 'c1', T0 + 1)
    expect(detectProjectionDrift(db, T0 + 2).behind).toEqual([])
    const afterArm = rev()
    resolveWaitCondition(db, 'personal', 'c1', 'SATISFIED', 'x', 'run', T0 + 2)
    expect(rev()).toBe(afterArm + 1)
  })
})
