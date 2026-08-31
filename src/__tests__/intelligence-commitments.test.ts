import { describe, it, expect } from 'vitest'
import { commitmentsForCase } from '../cos/intelligence/commitments.js'
import {
  makeElement, assertNotAuthorization, combineConfidence, IntelligenceInvariantError,
} from '../cos/intelligence/element.js'

// PHASE 2 -- COMMITMENTS. The owner's list, each item as its own test:
//   owner / source-provenance / due / status / fulfillment proof / reopen.
//
// Plus the two architectural invariants that outrank the feature: a
// RECOMMENDATION is never an authorization, and an element with no provenance
// cannot exist.

const NOW = 1_800_000_000
const HOUR = 3600

const caseRow = (over: Partial<Parameters<typeof commitmentsForCase>[0]> = {}) => ({
  case_id: 'case-1', title: 'Send the signed contract', status: 'READY', owner: 'istvan',
  due_at: NOW + 24 * HOUR, follow_up_at: null, waiting_on: null,
  next_action: 'Send the signed contract to the lawyer', next_action_owner: 'istvan',
  completed_at: null, closure_reason: null, created_at: NOW - 10 * HOUR, updated_at: NOW - HOUR,
  ...over,
}) as Parameters<typeof commitmentsForCase>[0]

const ev = (over: Partial<Parameters<typeof commitmentsForCase>[1][number]>) => ({
  event_id: 'e1', case_id: 'case-1', event_type: 'STATUS_CHANGE',
  new_status: 'COMPLETED', reason: null, created_at: NOW - 2 * HOUR, ...over,
}) as Parameters<typeof commitmentsForCase>[1][number]

const one = (row = caseRow(), events: Parameters<typeof commitmentsForCase>[1] = []) =>
  commitmentsForCase(row, events, 'personal', NOW)[0]

describe('the architectural invariants, before any feature', () => {
  it('an element with NO provenance cannot be constructed', () => {
    expect(() => makeElement({
      id: 'x', kind: 'FACT', caseId: 'c', namespace: 'personal',
      statement: 's', provenance: [], confidence: 'HIGH', contradiction: { state: 'NONE' },
    }, NOW)).toThrow(IntelligenceInvariantError)
  })

  it('a field that reads as PERMISSION is refused, by name', () => {
    // NO RELEVANT CONTRADICTION != ALLOW. The failure mode is a field meaning
    // "nothing objects" that an executor reads as "go ahead".
    for (const f of ['approved', 'authorized', 'mayExecute', 'externalActionApproved']) {
      expect(() => assertNotAuthorization({ [f]: true }, 'test')).toThrow(/never authorizes/)
    }
    expect(() => assertNotAuthorization({ statement: 'anything' }, 'test')).not.toThrow()
  })

  it('every commitment goes through that check -- none carries an authorization field', () => {
    const c = one()
    for (const f of ['approved', 'authorized', 'permitted', 'mayExecute', 'approval']) {
      expect(f in c).toBe(false)
    }
  })

  it('confidence takes the WEAKEST link, never the average', () => {
    expect(combineConfidence(['HIGH', 'LOW', 'HIGH'])).toBe('LOW')
    expect(combineConfidence(['HIGH', 'MEDIUM'])).toBe('MEDIUM')
    expect(combineConfidence([])).toBe('UNKNOWN')
  })
})

describe('the owner asked for six things', () => {
  it('1. OWNER is derived from the record, not assumed', () => {
    expect(one(caseRow({ next_action_owner: 'istvan' })).owner).toBe('OWNER')
    expect(one(caseRow({ next_action_owner: 'marveen' })).owner).toBe('ENGINE')
    expect(one(caseRow({ next_action_owner: 'the lawyer' })).owner).toBe('EXTERNAL')
    expect(one(caseRow({ next_action_owner: null, owner: null })).owner).toBe('UNKNOWN')
  })

  it('2. SOURCE/PROVENANCE names the row and the field it came from', () => {
    const c = one()
    expect(c.provenance[0]).toMatchObject({ source: 'CASE', ref: 'case-1', field: 'next_action' })
    // and it falls back to the title, saying so, rather than inventing one
    const t = one(caseRow({ next_action: null }))
    expect(t.provenance[0].field).toBe('title')
    expect(t.statement).toBe('Send the signed contract')
  })

  it('3. DUE comes from due_at, then follow_up_at, and null is null', () => {
    expect(one().dueAt).toBe(NOW + 24 * HOUR)
    expect(one(caseRow({ due_at: null, follow_up_at: NOW + 5 * HOUR })).dueAt).toBe(NOW + 5 * HOUR)
    expect(one(caseRow({ due_at: null, follow_up_at: null })).dueAt).toBeNull()
  })

  it('4. STATUS: open, and expired when its moment passed with nothing to show', () => {
    expect(one().status).toBe('OPEN')
    const e = one(caseRow({ due_at: NOW - HOUR }))
    expect(e.status).toBe('EXPIRED')
    expect(e.fulfillment.why).toContain('nothing evidences fulfilment')
  })

  it('5. FULFILLMENT PROOF -- fulfilled ONLY with an observation attached', () => {
    const c = one(caseRow({ status: 'COMPLETED' }), [ev({})])
    expect(c.status).toBe('FULFILLED')
    expect(c.fulfillment.proven).toBe(true)
    expect(c.fulfillment.proof[0]).toMatchObject({ source: 'CASE_EVENT', ref: 'e1' })
    expect(c.fulfillment.why).toContain('e1')
  })

  it('5b. THE HEADLINE: a case that SAYS done with nothing evidencing it is UNKNOWN, not FULFILLED', () => {
    // A fulfilment nobody can evidence is indistinguishable from one that never
    // happened. Rounding it up is the exact error SOURCE_COMMITTED made.
    const c = one(caseRow({ status: 'COMPLETED', completed_at: NOW - HOUR }), [])
    expect(c.status).toBe('UNKNOWN')
    expect(c.status).not.toBe('FULFILLED')
    expect(c.fulfillment.proven).toBe(false)
    expect(c.fulfillment.proof).toEqual([])
    expect(c.fulfillment.why).toContain('no event evidences')
    expect(c.confidence).toBe('LOW')
    expect(c.kind).toBe('INFERENCE')   // it is a judgement, and it says so
  })

  it('5c. proven is COMPUTED from the proof, so the two can never disagree', () => {
    const c = one(caseRow({ status: 'COMPLETED' }), [ev({})])
    expect(c.fulfillment.proven).toBe(c.fulfillment.proof.length > 0)
  })

  it('6. REOPEN: a later contradicting event flips a fulfilment back', () => {
    const c = one(caseRow({ status: 'READY' }), [
      ev({ event_id: 'done', new_status: 'COMPLETED', created_at: NOW - 5 * HOUR }),
      ev({ event_id: 'nope', event_type: 'REOPENED', new_status: 'READY', created_at: NOW - HOUR }),
    ])
    expect(c.status).toBe('REOPENED')
    expect(c.fulfillment.proven).toBe(false)
    expect(c.contradiction.state).toBe('UNRESOLVED')
    if (c.contradiction.state === 'UNRESOLVED') expect(c.contradiction.axis).toBe('TERMINALITY')
    expect(c.fulfillment.why).toContain('contradicted by nope')
  })

  it('6b. ORDER decides it -- the same two events the other way round stay FULFILLED', () => {
    // If the reopen came FIRST and the completion after, nothing is contradicted.
    const c = one(caseRow({ status: 'COMPLETED' }), [
      ev({ event_id: 'nope', event_type: 'REOPENED', new_status: 'READY', created_at: NOW - 5 * HOUR }),
      ev({ event_id: 'done', new_status: 'COMPLETED', created_at: NOW - HOUR }),
    ])
    expect(c.status).toBe('FULFILLED')
    expect(c.contradiction.state).toBe('NONE')
  })

  it('6c. reopening is DERIVED, so it needs no migration -- the same rows always give the same answer', () => {
    const rows = [
      ev({ event_id: 'done', new_status: 'COMPLETED', created_at: NOW - 5 * HOUR }),
      ev({ event_id: 'nope', event_type: 'REOPENED', new_status: 'READY', created_at: NOW - HOUR }),
    ]
    const a = one(caseRow(), rows)
    const b = one(caseRow(), rows)
    expect(a.id).toBe(b.id)
    expect(a.status).toBe(b.status)
  })
})

describe('recency and identity', () => {
  it('recency is the age of the FRESHEST provenance', () => {
    const c = one(caseRow({ updated_at: NOW - 3 * HOUR }), [ev({ created_at: NOW - HOUR })])
    expect(c.recencySeconds).toBe(HOUR)
  })

  it('the id is stable across evidence changes, so a refresh is not a new item', () => {
    const open = one()
    const done = one(caseRow({ status: 'COMPLETED' }), [ev({})])
    expect(open.id).toBe(done.id)
    expect(open.status).not.toBe(done.status)
  })

  it('a case with neither next action nor title yields NOTHING rather than an empty promise', () => {
    expect(commitmentsForCase(caseRow({ next_action: null, title: '' }), [], 'personal', NOW)).toEqual([])
  })

  it('A BARE TITLE IS NOT A PROMISE -- nothing owed, no commitment', () => {
    // Found by mutation: with `next_action || title`, every titled case became a
    // commitment, the overlap rule then dropped every opportunity as a
    // duplicate, and two tests were passing over an empty set.
    expect(commitmentsForCase(
      caseRow({ next_action: null, due_at: null, follow_up_at: null, title: 'Just a case' }),
      [], 'personal', NOW,
    )).toEqual([])
  })

  it('but a DATE makes it owed, and then the title is the wording', () => {
    const c = commitmentsForCase(
      caseRow({ next_action: null, due_at: NOW + 3600, title: 'Renew the licence' }),
      [], 'personal', NOW,
    )[0]
    expect(c.statement).toBe('Renew the licence')
    expect(c.provenance[0].field).toBe('title')
  })
})
