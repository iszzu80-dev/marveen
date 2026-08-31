import { describe, it, expect } from 'vitest'
import {
  admitQuestion, assessStaleness, dedupeByDecisionProblem, isUrgentClass,
  DEFAULT_CAPACITY_POLICY, type CapacityPolicy,
} from '../cos/intelligence/question-capacity.js'

const NOW = 1_800_000_000
const DAY = 86_400

describe('reserved urgent capacity -- the hole E2 deliberately left', () => {
  it('E2 ordered the queue; it could not help when there is no next slot', () => {
    // Five trivia questions fill the channel exactly as well as five gates do.
    const full = admitQuestion('SAFETY_APPROVAL', { urgent: 0, normal: 5 })
    expect(full.admit).toBe(false)
    expect(full.reason).toContain('5/5')
  })

  it('a NORMAL question may not take a RESERVED slot', () => {
    // 3 general + 2 reserved. With 3 normals open, the channel has room but not
    // for another normal.
    const v = admitQuestion('NORMAL', { urgent: 0, normal: 3 })
    expect(v.admit).toBe(false)
    expect(v.disposition).toBe('HOLD')
    expect(v.reason).toContain('reserved for SAFETY_APPROVAL')
    expect(v.reason).toContain('ceiling is unchanged')
  })

  it('and an urgent one CAN take it -- that is what the seat was kept for', () => {
    expect(admitQuestion('SAFETY_APPROVAL', { urgent: 0, normal: 3 }).admit).toBe(true)
    expect(admitQuestion('BLOCKING_DECISION', { urgent: 0, normal: 3 }).admit).toBe(true)
  })

  it('a normal question is admitted while general slots remain', () => {
    expect(admitQuestion('NORMAL', { urgent: 0, normal: 2 }).admit).toBe(true)
    expect(admitQuestion('NORMAL', { urgent: 2, normal: 0 }).admit).toBe(true)
  })

  it('THE CEILING IS UNCHANGED -- reserving is not exempting', () => {
    // An urgent question at the cap is still refused. E2's rule that nobody is
    // exempt survives; only the composition of the five changed.
    const v = admitQuestion('SAFETY_APPROVAL', { urgent: 5, normal: 0 })
    expect(v.admit).toBe(false)
    expect(v.reason).toContain('Answering any open question frees a slot')
  })

  it('a refused question is HELD, never dropped', () => {
    for (const cls of ['NORMAL', 'SAFETY_APPROVAL'] as const) {
      const v = admitQuestion(cls, { urgent: 5, normal: 0 })
      if (!v.admit) expect(v.disposition).toBe('HOLD')
    }
  })

  it('the policy is a parameter -- reserving ALL slots starves normals, and the code says so plainly', () => {
    const greedy: CapacityPolicy = { cap: 5, reservedForUrgent: 5 }
    expect(admitQuestion('NORMAL', { urgent: 0, normal: 0 }, greedy).admit).toBe(false)
    expect(admitQuestion('SAFETY_APPROVAL', { urgent: 0, normal: 0 }, greedy).admit).toBe(true)
  })

  it('the default keeps three general slots, so the channel does not feel empty', () => {
    expect(DEFAULT_CAPACITY_POLICY.cap - DEFAULT_CAPACITY_POLICY.reservedForUrgent).toBe(3)
    expect(isUrgentClass('NORMAL')).toBe(false)
    expect(isUrgentClass('SAFETY_APPROVAL')).toBe(true)
  })
})

describe('expiry and staleness are two different things', () => {
  const ask = (over = {}) => ({ caseId: 'c1', axis: 'HUMAN_DEPENDENCY', askedAt: NOW - DAY, ...over })

  it('FRESH while it can still change something', () => {
    expect(assessStaleness(ask({ decisionHorizonAt: NOW + DAY }), NOW).state).toBe('FRESH')
  })

  it('MOOT once its horizon has passed -- an answer can no longer change the outcome', () => {
    const s = assessStaleness(ask({ decisionHorizonAt: NOW - 60 }), NOW)
    expect(s.state).toBe('MOOT')
    if (s.state === 'MOOT') expect(s.why).toContain('no longer change')
  })

  it('STALE when it has simply aged -- re-ask, do not withdraw', () => {
    const s = assessStaleness(ask({ askedAt: NOW - 9 * DAY }), NOW)
    expect(s.state).toBe('STALE')
    if (s.state === 'STALE') expect(s.why).toContain('re-ask')
  })

  it('MOOT outranks STALE: an old question past its horizon is withdrawn, not re-asked', () => {
    expect(assessStaleness(ask({ askedAt: NOW - 30 * DAY, decisionHorizonAt: NOW - DAY }), NOW).state).toBe('MOOT')
  })

  it('no horizon on the record means no MOOT verdict is invented', () => {
    expect(assessStaleness(ask({ decisionHorizonAt: null }), NOW).state).toBe('FRESH')
  })
})

describe('one decidable question per decision problem', () => {
  const a = (id: string, axis: string, askedAt: number) => ({ caseId: id, axis, askedAt })

  it('two asks on the same case AND axis collapse to one', () => {
    const r = dedupeByDecisionProblem([
      a('c1', 'HUMAN_DEPENDENCY', NOW - 2 * DAY),
      a('c1', 'HUMAN_DEPENDENCY', NOW - DAY),
    ])
    expect(r.ask).toHaveLength(1)
    expect(r.superseded).toHaveLength(1)
  })

  it('THE OLDEST SURVIVES -- an answer in flight still has its question', () => {
    const older = a('c1', 'HUMAN_DEPENDENCY', NOW - 2 * DAY)
    const r = dedupeByDecisionProblem([a('c1', 'HUMAN_DEPENDENCY', NOW - DAY), older])
    expect(r.ask[0].askedAt).toBe(older.askedAt)
    expect(r.superseded[0].why).toContain('answer in flight')
  })

  it('different AXES on the same case are different decisions and both survive', () => {
    const r = dedupeByDecisionProblem([
      a('c1', 'HUMAN_DEPENDENCY', NOW - DAY),
      a('c1', 'ENGINE_EXECUTION_PERMISSION', NOW - DAY),
    ])
    expect(r.ask).toHaveLength(2)
    expect(r.superseded).toEqual([])
  })

  it('the same axis on different cases are different decisions and both survive', () => {
    const r = dedupeByDecisionProblem([
      a('c1', 'HUMAN_DEPENDENCY', NOW - DAY),
      a('c2', 'HUMAN_DEPENDENCY', NOW - DAY),
    ])
    expect(r.ask).toHaveLength(2)
  })

  it('nothing is silently lost -- every dropped ask is reported with its survivor', () => {
    const r = dedupeByDecisionProblem([
      a('c1', 'X', NOW - 3 * DAY), a('c1', 'X', NOW - 2 * DAY), a('c1', 'X', NOW - DAY),
    ])
    expect(r.ask.length + r.superseded.length).toBe(3)
    expect(r.superseded.every((s) => s.keptCaseId === 'c1' && s.keptAxis === 'X')).toBe(true)
  })
})
