import { describe, it, expect } from 'vitest'
import { commitmentsForCase } from '../cos/intelligence/commitments.js'

// PHASE 2 -- the obligation gate. Owner ruling 2026-09-01:
//
//   "a motor sajat next_action / follow-up sablonja onmagaban SOHA ne legyen
//    commitment evidence. A motor sajat terve csak execution metadata."
//
// Written as a REQUIREMENT rather than a filter of known bad strings. A
// blocklist of the two templates seen on the live store today would pass the
// third one; requiring positive evidence fails closed for templates nobody has
// written yet.

const NOW = 1_800_000_000
const DAY = 86_400

const row = (over: Record<string, unknown> = {}) => ({
  case_id: 'c1', title: 'NAV document on the company portal', status: 'NEW', owner: 'istvan',
  due_at: null, follow_up_at: null, waiting_on: null,
  next_action: null, next_action_owner: 'ISTVAN',
  completed_at: null, closure_reason: null, created_at: NOW - 7 * DAY, updated_at: NOW - 7 * DAY,
  ...over,
}) as Parameters<typeof commitmentsForCase>[0]

const one = (over: Record<string, unknown> = {}, shared = 0) =>
  commitmentsForCase(row(over), [], 'zst', NOW, shared)

describe('a commitment needs positive, provenanced obligation evidence', () => {
  it('an explicit deadline is evidence, and names itself', () => {
    const c = one({ due_at: NOW - DAY })[0]
    expect(c.obligationEvidence).toBe('EXPLICIT_DEADLINE')
  })

  it('a next action stated for THIS case and no other is evidence', () => {
    const c = one({ next_action: 'Collect the NAV document from the portal' }, 0)[0]
    expect(c.obligationEvidence).toBe('CASE_SPECIFIC_ACTION')
  })

  it('THE RULING: the same action text on other cases is NOT evidence', () => {
    // 16 other cases carry the identical sentence. One case's promise is not,
    // word for word, seventeen other cases' promise.
    expect(one({ next_action: 'Review the latest company source and define the next concrete operational step' }, 16))
      .toEqual([])
  })

  it('it takes only ONE other case to make the text boilerplate', () => {
    expect(one({ next_action: 'Do the thing' }, 1)).toEqual([])
    expect(one({ next_action: 'Do the thing' }, 0)).toHaveLength(1)
  })

  it('the gate is a requirement, not a blocklist -- an UNSEEN template is caught too', () => {
    // Nothing in the code knows this sentence. It is refused for being shared,
    // which is the property that makes it a template.
    expect(one({ next_action: 'Kovetkezo lepes meghatarozasa a beerkezett forras alapjan' }, 4))
      .toEqual([])
  })

  it('a deadline rescues a shared action -- the promise is then the DATE, not the text', () => {
    const c = one({ next_action: 'Review the latest company source', due_at: NOW - DAY }, 16)[0]
    expect(c).toBeDefined()
    expect(c.obligationEvidence).toBe('EXPLICIT_DEADLINE')
    expect(c.status).toBe('EXPIRED')
  })

  it('a case with neither is not a commitment, whatever its title', () => {
    expect(one({ title: 'Something important' })).toEqual([])
    expect(one({ follow_up_at: NOW - 40 * DAY })).toEqual([])
  })

  it('an unevidenced closure is still admitted, and says which reason let it in', () => {
    const c = one({ status: 'COMPLETED' })[0]
    expect(c.obligationEvidence).toBe('UNEVIDENCED_CLOSURE')
    expect(c.status).toBe('UNKNOWN')
  })

  it('every admitted commitment names its evidence -- the field is never absent', () => {
    for (const c of [
      one({ due_at: NOW - DAY })[0],
      one({ next_action: 'unique thing' }, 0)[0],
      one({ status: 'CANCELLED' })[0],
    ]) {
      expect(c.obligationEvidence).toBeTruthy()
    }
  })
})
