import { describe, it, expect } from 'vitest'
import { commitmentsForCase } from '../cos/intelligence/commitments.js'
import { commitmentToAttention } from '../cos/intelligence/attention.js'

// PHASE 2 P0 SEMANTIC FIX -- `follow_up_at` is not a deadline.
//
// Owner ruling 2026-09-01, on a measurement rather than a preference: of 81
// expired commitments on the live store only SEVEN had a real `due_at`; the
// other 74 were overdue against an engine review timer, 48 of them with no
// stated action at all. The canonical rule:
//
//   A commitment MAY have no deadline. It can only be OVERDUE when there is
//   explicit due evidence, that date has passed, and nothing evidences
//   fulfilment. `follow_up_at` is never a fallback for that date.

const NOW = 1_800_000_000
const HOUR = 3600, DAY = 86_400

const row = (over: Record<string, unknown> = {}) => ({
  case_id: 'c1', title: 'Pool ledge replacement', status: 'READY', owner: 'istvan',
  due_at: null, follow_up_at: null, waiting_on: null,
  next_action: null, next_action_owner: 'istvan',
  completed_at: null, closure_reason: null, created_at: NOW - 30 * DAY, updated_at: NOW - HOUR,
  ...over,
}) as Parameters<typeof commitmentsForCase>[0]

const list = (over: Record<string, unknown> = {}) => commitmentsForCase(row(over), [], 'personal', NOW)

describe('A -- due_at is the only deadline', () => {
  it('a passed due_at with nothing evidencing fulfilment is EXPIRED', () => {
    const c = list({ next_action: 'Order the ledges', due_at: NOW - 2 * DAY })[0]
    expect(c.status).toBe('EXPIRED')
    expect(c.dueAt).toBe(NOW - 2 * DAY)
  })

  it('a future due_at is OPEN', () => {
    expect(list({ next_action: 'Order the ledges', due_at: NOW + 2 * DAY })[0].status).toBe('OPEN')
  })
})

describe('B -- follow_up_at WITH a next_action: owed, but never overdue', () => {
  const b = () => list({ next_action: 'Chase the supplier', follow_up_at: NOW - 30 * DAY })[0]

  it('the commitment EXISTS -- something is genuinely owed', () => {
    expect(b()).toBeDefined()
    expect(b().statement).toBe('Chase the supplier')
  })

  it('but it is OPEN, not EXPIRED, however long the wake-up has been elapsed', () => {
    expect(b().status).toBe('OPEN')
    expect(b().status).not.toBe('EXPIRED')
  })

  it('it carries NO deadline, and the wake-up is kept in its own field', () => {
    expect(b().dueAt).toBeNull()
    expect(b().reviewWakeAt).toBe(NOW - 30 * DAY)
  })

  it('the reason says so in words, so a reader cannot mistake the two', () => {
    expect(b().fulfillment.why).toContain('wake-up and not a promise')
  })

  it('and it claims NO urgency -- urgency comes from a deadline or from nothing', () => {
    expect(commitmentToAttention(b(), NOW).factors.urgency).toBe(0)
  })
})

describe('C -- follow_up_at WITHOUT a next_action is engine metadata, not a commitment', () => {
  it('no commitment is emitted at all, however overdue the timer', () => {
    expect(list({ follow_up_at: NOW - 90 * DAY })).toEqual([])
  })

  it('a title alone never rescues it -- a title is not a promise', () => {
    expect(list({ title: 'Something', follow_up_at: NOW - 90 * DAY })).toEqual([])
  })

  it('but a title WITH a real deadline is still a dated obligation', () => {
    const c = list({ title: 'Pay the invoice', due_at: NOW - DAY })[0]
    expect(c).toBeDefined()
    expect(c.status).toBe('EXPIRED')
    expect(c.statement).toBe('Pay the invoice')
  })
})

describe('the shape of the live baseline, in miniature', () => {
  it('the three cases together: one overdue, one owed-not-overdue, one not a commitment', () => {
    const a = list({ case_id: 'a', next_action: 'do it', due_at: NOW - DAY })
    const bb = list({ case_id: 'b', next_action: 'do it', follow_up_at: NOW - DAY })
    const cc = list({ case_id: 'c', follow_up_at: NOW - DAY })
    expect([a.length, bb.length, cc.length]).toEqual([1, 1, 0])
    expect([a[0].status, bb[0].status]).toEqual(['EXPIRED', 'OPEN'])
  })

  // ADDED after a surviving mutant. Filling `reviewWakeAt` from `due_at` kept
  // the whole file green: every assertion looked at a case that HAD a
  // follow_up_at, so the two fields never had to disagree. A deadline leaking
  // into the wake-up field is precisely the conflation this fix exists to stop,
  // so it needs a case where only ONE of them is set.
  it('the two fields never borrow from each other, in either direction', () => {
    const deadlineOnly = list({ next_action: 'do it', due_at: NOW + DAY })[0]
    expect(deadlineOnly.dueAt).toBe(NOW + DAY)
    expect(deadlineOnly.reviewWakeAt).toBeNull()      // a deadline is NOT a wake-up

    const wakeOnly = list({ next_action: 'do it', follow_up_at: NOW + DAY })[0]
    expect(wakeOnly.reviewWakeAt).toBe(NOW + DAY)
    expect(wakeOnly.dueAt).toBeNull()                 // a wake-up is NOT a deadline

    const both = list({ next_action: 'do it', due_at: NOW + DAY, follow_up_at: NOW + 2 * DAY })[0]
    expect(both.dueAt).toBe(NOW + DAY)
    expect(both.reviewWakeAt).toBe(NOW + 2 * DAY)     // and they keep their own values
  })

  it('a commitment with NO date at all is still a commitment -- deadlines are optional', () => {
    const c = list({ next_action: 'Think about the roof' })[0]
    expect(c.status).toBe('OPEN')
    expect(c.dueAt).toBeNull()
    expect(c.reviewWakeAt).toBeNull()
  })
})
