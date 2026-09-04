// THE GUARD THAT WOULD HAVE STOPPED ME.
//
// On 2026-09-04 I recorded an architectural backlog note as a ZST case. The live
// reconcile went red the same minute -- `Invariant A: NO_NEXT_ACTION_AND_NO_WAIT`
// -- and stayed red for two cycles until the case was archived. The invariant
// was right; the write should never have been possible.
//
// Owner ruling: move that same question BEFORE the write. And explicitly: do not
// invent a fake wait, a fake deadline or a fake review date to get past it.

import { describe, it, expect } from 'vitest'
import { admitActiveCase, ActiveCaseAdmissionError } from '../cos/active-case-admission.js'
import { evaluateInvariantA } from '../cos/case-projection.js'
import { initDatabase, getDb } from '../db.js'

const TERMINAL = ['COMPLETED', 'CANCELLED', 'ARCHIVED'] as const
const base = { caseId: 'c1', status: 'NEW', terminalStatuses: TERMINAL }

describe('what may become an active operational case', () => {
  it('HEADLINE: the exact row that broke production is refused', () => {
    // DIRECTION_AWARE_ESCALATION as I wrote it: SCHEDULED, no next action, and
    // a wait on an architectural precondition with no review moment.
    const r = admitActiveCase({
      ...base, caseId: 'zst-zst-backlog-direction-aware-escalation', status: 'SCHEDULED',
      nextAction: null,
      waitingOn: 'the canonical case-event model, once it can store field-level provenance',
      reviewAt: null,
    })
    expect(r.admitted).toBe(false)
    expect(r.refusal).toBe('WAIT_WITHOUT_REVIEW_TIME')
    expect(r.detail).toContain('backlog document')
  })

  it('a case with a real next action is admitted', () => {
    expect(admitActiveCase({ ...base, nextAction: 'Ring the accountant about the invoice' }).admitted)
      .toBe(true)
  })

  it('a wait WITH a review moment is admitted', () => {
    expect(admitActiveCase({
      ...base, nextAction: null, waitingOn: 'Piscinarium', reviewAt: 1_800_000_000,
    }).admitted).toBe(true)
  })

  it('neither an action nor a wait is refused, and named as such', () => {
    const r = admitActiveCase({ ...base, nextAction: null, waitingOn: null, reviewAt: null })
    expect(r.refusal).toBe('NO_ACTION_AND_NO_WAIT')
  })

  it('whitespace is not a next action', () => {
    // The cheapest way past a guard like this is a space, so it must not work.
    const r = admitActiveCase({ ...base, nextAction: '   ', waitingOn: '  ', reviewAt: null })
    expect(r.admitted).toBe(false)
  })

  it('TERMINAL rows are outside the rule -- or nothing could ever be closed', () => {
    for (const status of TERMINAL) {
      expect(admitActiveCase({ ...base, status, nextAction: null, waitingOn: null, reviewAt: null })
        .admitted, `${status} must be admissible`).toBe(true)
    }
  })

  it('the refusal never suggests inventing a value', () => {
    // The owner forbade fake waits, deadlines and review dates. A guard whose
    // advice is "add a date" teaches exactly the workaround it exists to stop.
    const r = admitActiveCase({ ...base, nextAction: null, waitingOn: 'something', reviewAt: null })
    expect(r.detail).toMatch(/Do not invent/)
  })
})

describe('the guard and the detector agree', () => {
  it('HEADLINE: anything the guard admits, Invariant A also accepts', () => {
    // If they disagreed, a row admitted at write time would be reported as a
    // violation moments later -- which is worse than having only one of them.
    initDatabase(':memory:')
    const db = getDb()
    const now = 1_800_000_000
    // Admitted by the guard: has a next action.
    db.prepare(
      `INSERT INTO zst_cases (case_id,title,case_type,status,next_action,created_at,updated_at)
       VALUES ('ok','has an action','GENERAL_OPERATION','NEW','do the thing',?,?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO case_progression_state (domain,case_id,created_at,updated_at)
       VALUES ('zst','ok',?,?)`,
    ).run(now, now)
    db.prepare(
      `UPDATE zst_cases SET proj_next_action_kind='ACT' WHERE case_id='ok'`,
    ).run()

    expect(admitActiveCase({
      caseId: 'ok', status: 'NEW', nextAction: 'do the thing', terminalStatuses: TERMINAL,
    }).admitted).toBe(true)
    const inv = evaluateInvariantA(db, 'zst')
    expect(inv.violations.filter((v) => v.caseId === 'ok')).toEqual([])
  })
})

describe('refusing loudly', () => {
  it('the error carries the machine-readable reason, not just prose', () => {
    const r = admitActiveCase({ ...base, nextAction: null, waitingOn: null, reviewAt: null })
    const err = new ActiveCaseAdmissionError(r as never)
    expect(err.refusal).toBe('NO_ACTION_AND_NO_WAIT')
    expect(err.message).toContain('NO_ACTION_AND_NO_WAIT')
  })
})
