// §10.8 trigger contract.
//
// MEASURED BEFORE THIS EXISTED: 10 716 progression runs in 24 hours over 101
// cases — one per case every ten minutes — of which 10 347 decided
// CONTINUE_AUTONOMOUSLY and NONE started an action. The scheduler asked "is this
// case due?", the answer was always yes, and a case with nothing new about it
// was reasoned over again and again.
//
// Harmless while the engine is deterministic. One model call each the moment the
// Reader (§10.2) arrives — which is why this is the Reader's PRECONDITION and not
// a later optimisation.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { setNextWake } from '../cos/scheduler.js'
import { decideTrigger, recordProgressionState, effectiveStateHash, dueDeadline } from '../cos/progression-trigger.js'
import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'
import { initProgressionSchema } from '../cos/schema.js'
import { seedProgressionState } from '../cos/progression-migrate.js'

const T0 = 1_700_000_000

function seed(caseId = 'c1') {
  const db = getDb()
  createCase(db, { caseId, title: 'T', caseType: 'QUOTE' }, T0)
  // Production always has a progression-state row by the time a trigger is
  // decided (the pipeline creates it). Seeding here keeps the test on the real
  // shape instead of a state the system never actually reaches.
  seedProgressionState(db, T0)
  return db
}

/** Run one decision and record it, i.e. simulate a completed cycle. */
function cycle(db: ReturnType<typeof getDb>, caseId: string, now: number) {
  const d = decideTrigger(db, 'personal', caseId, now)
  if (d.shouldRun) recordProgressionState(db, 'personal', caseId, d.effectiveStateHash, now)
  return d
}

describe('§10.8 trigger contract', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('a case that has never progressed runs once', () => {
    const db = seed()
    const d = decideTrigger(db, 'personal', 'c1', T0 + 1)
    expect(d.shouldRun).toBe(true)
    expect(d.trigger).toBe('NEW_RELEVANT_EVENT')
  })

  it('HEADLINE: an unchanged case does NOT reason again', () => {
    // The whole point. Before this, the second call was identical to the first
    // and ran anyway — ten thousand times a day.
    const db = seed()
    expect(cycle(db, 'c1', T0 + 1).shouldRun).toBe(true)
    const second = decideTrigger(db, 'personal', 'c1', T0 + 2)
    expect(second.shouldRun).toBe(false)
    expect(second.reason).toContain('nothing has changed')
  })

  it('a changed case DOES reason again', () => {
    // Control for the test above: "never runs" would also satisfy it.
    const db = seed()
    cycle(db, 'c1', T0 + 1)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'test' }, T0 + 2)
    const after = decideTrigger(db, 'personal', 'c1', T0 + 3)
    expect(after.shouldRun).toBe(true)
    expect(after.trigger).toBe('NEW_RELEVANT_EVENT')
  })

  it('a WAITING case still wakes on its deadline, though nothing changed', () => {
    // The reason the time triggers are checked BEFORE the state comparison: a
    // waiting case has by definition not changed, and a state-only rule would
    // leave it asleep for ever.
    const db = seed()
    cycle(db, 'c1', T0 + 1)
    expect(decideTrigger(db, 'personal', 'c1', T0 + 2).shouldRun).toBe(false)
    setNextWake(db, 'c1', T0 + 100, T0 + 2)
    const woken = decideTrigger(db, 'personal', 'c1', T0 + 101)
    expect(woken.shouldRun).toBe(true)
    expect(woken.trigger).toBe('WAIT_WAKE_DUE')
  })

  it('a due follow-up is a reason too', () => {
    const db = seed()
    cycle(db, 'c1', T0 + 1)
    transitionCase(db, {
      caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'test',
      patch: { follow_up_at: T0 + 50 },
    }, T0 + 2)
    recordProgressionState(db, 'personal', 'c1', decideTrigger(db, 'personal', 'c1', T0 + 3).effectiveStateHash, T0 + 3)
    const d = decideTrigger(db, 'personal', 'c1', T0 + 60)
    expect(d.shouldRun).toBe(true)
    expect(d.trigger).toBe('FOLLOW_UP_DUE')
  })

  it('the state hash binds every field §10.8 names', () => {
    const base = { domain: 'personal', caseId: 'c1', caseVersion: 1, goalVersion: 1, waitVersion: 0, lastEventId: 5, nextWakeAt: null, followUpAt: null }
    const h = effectiveStateHash(base)
    expect(effectiveStateHash({ ...base, caseVersion: 2 })).not.toBe(h)
    expect(effectiveStateHash({ ...base, goalVersion: 2 })).not.toBe(h)
    expect(effectiveStateHash({ ...base, waitVersion: 1 })).not.toBe(h)
    expect(effectiveStateHash({ ...base, lastEventId: 6 })).not.toBe(h)
    // the deadlines are part of the state too — this is what stops an overdue
    // follow-up from firing on every single pass
    expect(effectiveStateHash({ ...base, followUpAt: 123 })).not.toBe(h)
    expect(effectiveStateHash({ ...base, nextWakeAt: 123 })).not.toBe(h)
    expect(effectiveStateHash(base)).toBe(h) // and stable
  })

  it('END TO END: the second heartbeat over unchanged cases does no work', () => {
    // The measurement that justified the whole change, in miniature.
    const db = getDb()
    createCase(db, { caseId: 'a', title: 'A', caseType: 'QUOTE' }, T0)
    createCase(db, { caseId: 'b', title: 'B', caseType: 'QUOTE' }, T0)
    seedProgressionState(db, T0)
    const first = runProgressionHeartbeat(db, T0 + 10)
    expect(first.personal).toBeGreaterThan(0)
    const second = runProgressionHeartbeat(db, T0 + 20)
    expect(second.personal).toBe(0)
    expect(second.skippedNoTrigger).toBeGreaterThan(0)
  })
})

// The hole a red test found, kept as a test of its own: a deadline set for the
// FUTURE changes the state today (so the case runs now), and then the clock
// passes it without changing anything — same version, same deadline value, same
// hash. A hash-only rule would never fire it; a time-only rule fires it for
// ever. "Due AND not yet handled" is what threads that needle.
describe('§10.8 — a deadline fires exactly once', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('a follow-up set for the future fires when it arrives, then stops', () => {
    const db = seed()
    // reason once so a baseline state exists
    cycle(db, 'c1', T0 + 1)
    // set a follow-up in the FUTURE: a change, so it runs — but not yet due
    transitionCase(db, {
      caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'test',
      patch: { follow_up_at: T0 + 1000 },
    }, T0 + 2)
    const onSet = decideTrigger(db, 'personal', 'c1', T0 + 3)
    expect(onSet.shouldRun).toBe(true)
    expect(onSet.trigger).toBe('NEW_RELEVANT_EVENT') // not due yet
    recordProgressionState(db, 'personal', 'c1', onSet.effectiveStateHash, T0 + 3,
      dueDeadline(db, 'personal', 'c1', T0 + 3))

    // the clock passes it: nothing about the case changed, and it must STILL fire
    const whenDue = decideTrigger(db, 'personal', 'c1', T0 + 1001)
    expect(whenDue.shouldRun).toBe(true)
    expect(whenDue.trigger).toBe('FOLLOW_UP_DUE')
    recordProgressionState(db, 'personal', 'c1', whenDue.effectiveStateHash, T0 + 1001,
      dueDeadline(db, 'personal', 'c1', T0 + 1001))

    // and it must NOT fire again on the same, still-overdue deadline
    const after = decideTrigger(db, 'personal', 'c1', T0 + 2000)
    expect(after.shouldRun).toBe(false)
  })
})
