import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { reopenCase } from '../cos/case-reopen.js'
import { projectCommitments } from '../cos/intelligence/commitments.js'
import { FULFILLING_EVENT_TYPES, REOPENING_EVENT_TYPES } from '../cos/case-event-types.js'

// PRODUCER AND CONSUMER, MEASURED AGAINST EACH OTHER (owner GO, 2026-09-03).
//
// The defect these tests fence: the fulfilment detector looked for an event
// named `STATUS_CHANGE` while the engine writes `STATUS_CHANGED`. Measured on
// the live store that day: 246 status events, zero matches, so not one closed
// case in the system's history had ever been classified FULFILLED, and the
// reopen path could never fire either.
//
// The unit tests were green throughout, because their fixture hard-coded the
// SAME wrong name the detector used. Producer and consumer disagreed and the
// test agreed with the consumer.
//
// So the rule these tests follow, and the reason they are integration tests:
// NO EVENT NAME IS TYPED HERE. The production engine writes the event, the
// production detector reads it back, and the assertions are about what the
// detector concluded -- a claim no literal in a fixture can make.

const NOW = 1_800_000_000
const DAY = 86_400

function newCase(id: string, over: Record<string, unknown> = {}): void {
  createCase(getDb(), {
    caseId: id, title: `t-${id}`, caseType: 'ADMIN',
    status: 'READY', actor: 'test', ...over,
  } as never, NOW - 10 * DAY)
  // A case-specific next_action, so the obligation gate admits it on its own
  // merit rather than on the "terminal but unevidenced" reason -- otherwise the
  // fix would remove the commitment and the test would prove nothing.
  getDb().prepare('UPDATE personal_cases SET next_action = ?, due_at = ? WHERE case_id = ?')
    .run(`do the ${id} thing`, NOW + DAY, id)
}

const commitmentFor = (id: string) =>
  projectCommitments(getDb(), 'personal', NOW).find((c) => c.caseId === id)

const statusEvents = (id: string) => getDb().prepare(
  `SELECT event_type, new_status FROM personal_case_events
    WHERE case_id = ? AND new_status IS NOT NULL ORDER BY event_id`).all(id) as
  Array<{ event_type: string; new_status: string }>

describe('the canonical lifecycle vocabulary is one vocabulary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('CLOSE: the engine writes the event, and the detector reads that same event as fulfilment', () => {
    newCase('close-1')
    const before = commitmentFor('close-1')
    expect(before?.status).toBe('OPEN')

    // The PRODUCTION transition. Nothing here says what the event will be called.
    transitionCase(getDb(), {
      caseId: 'close-1', newStatus: 'COMPLETED', seenVersion: 1,
      actor: 'test', reason: 'done',
    }, NOW)

    const written = statusEvents('close-1').at(-1)!
    // The bridge assertion: whatever the engine just wrote IS in the set the
    // detector consults. This is the check that would have caught the drift.
    expect(FULFILLING_EVENT_TYPES.has(written.event_type)).toBe(true)
    expect(written.new_status).toBe('COMPLETED')

    const after = commitmentFor('close-1')!
    expect(after.status).toBe('FULFILLED')
    expect(after.fulfillment.proven).toBe(true)
    // The proof points at the real event, not at the row's own status.
    expect(after.fulfillment.proof.some((p) => p.source === 'CASE_EVENT')).toBe(true)
  })

  it('NEGATIVE CONTROL: a transition to a NON-terminal status is not fulfilment', () => {
    newCase('wait-1')
    transitionCase(getDb(), {
      caseId: 'wait-1', newStatus: 'WAITING_EXTERNAL', seenVersion: 1,
      actor: 'test', reason: 'sent, waiting',
    }, NOW)

    const written = statusEvents('wait-1').at(-1)!
    // Same event NAME as a completion -- membership alone must not be enough.
    expect(FULFILLING_EVENT_TYPES.has(written.event_type)).toBe(true)
    expect(written.new_status).toBe('WAITING_EXTERNAL')

    const c = commitmentFor('wait-1')!
    expect(c.status).not.toBe('FULFILLED')
    expect(c.status).toBe('OPEN')
  })

  it('REOPEN: a proven fulfilment stops being treated as the current closure', () => {
    newCase('reopen-1')
    transitionCase(getDb(), {
      caseId: 'reopen-1', newStatus: 'COMPLETED', seenVersion: 1, actor: 'test', reason: 'done',
    }, NOW - DAY)
    expect(commitmentFor('reopen-1')!.status).toBe('FULFILLED')

    // The PRODUCTION reopen path, which transitions and then annotates.
    const r = reopenCase(getDb(), {
      domain: 'personal', caseId: 'reopen-1', reason: 'the supplier says it never arrived',
      actor: 'test', evidence: { sourceSystem: 'gmail', sourceReference: 'msg-1' },
    }, NOW)
    expect(r.ok).toBe(true)

    const evs = statusEvents('reopen-1')
    const last = evs.at(-1)!
    expect(REOPENING_EVENT_TYPES.has(last.event_type)).toBe(true)
    expect(last.new_status).toBe('TRIAGE')

    const after = commitmentFor('reopen-1')!
    expect(after.status).toBe('REOPENED')
    // and it is no longer presented as a settled closure
    expect(after.fulfillment.proven).toBe(false)
  })

  it('ORDER is the argument: reopen then close again is FULFILLED, not REOPENED', () => {
    newCase('recl-1')
    transitionCase(getDb(), {
      caseId: 'recl-1', newStatus: 'COMPLETED', seenVersion: 1, actor: 'test', reason: 'done',
    }, NOW - 2 * DAY)
    reopenCase(getDb(), {
      domain: 'personal', caseId: 'recl-1', reason: 'came back',
      actor: 'test', evidence: { sourceSystem: 'gmail', sourceReference: 'm' },
    }, NOW - DAY)
    const v = (getDb().prepare('SELECT version FROM personal_cases WHERE case_id = ?')
      .get('recl-1') as { version: number }).version
    transitionCase(getDb(), {
      caseId: 'recl-1', newStatus: 'COMPLETED', seenVersion: v, actor: 'test', reason: 'done again',
    }, NOW)

    expect(commitmentFor('recl-1')!.status).toBe('FULFILLED')
  })
})
