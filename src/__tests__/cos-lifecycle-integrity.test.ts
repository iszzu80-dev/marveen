import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase, appendCaseEvent } from '../cos/case-store.js'
import { projectCommitments } from '../cos/intelligence/commitments.js'
import { projectIntelligence } from '../cos/intelligence/project.js'
import { ForeignCaseStatusError } from '../cos/case-engine-core.js'
import { classifyReopen, classifyClosure } from '../cos/intelligence/lifecycle-classification.js'

// LIFECYCLE INTEGRITY (owner GO, 2026-09-03).
//
// Three defects found by the 2026-09-03 audit, fenced here:
//   1. an outbound delivery's `RECOVERY_REQUIRED -> VERIFIED` sat in a CASE
//      event's status columns and made PRI-CLAIM-2026-001 -- COMPLETED
//      throughout -- read as a reopened obligation;
//   2. 21 cases restored after a bad engine close read as "business reopened";
//   3. two rows are terminal with no event saying so, and that was reported as a
//      quiet UNKNOWN rather than as the integrity defect it is.

const NOW = 1_800_000_000
const DAY = 86_400

function newCase(id: string): void {
  createCase(getDb(), { caseId: id, title: `t-${id}`, caseType: 'ADMIN', status: 'READY', actor: 'test' } as never, NOW - 10 * DAY)
  getDb().prepare('UPDATE personal_cases SET next_action = ?, due_at = ? WHERE case_id = ?')
    .run(`do the ${id} thing`, NOW + DAY, id)
}
const commitmentFor = (id: string) => projectCommitments(getDb(), 'personal', NOW).find(c => c.caseId === id)

describe('a foreign status is not case evidence, on either side', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('WRITE SIDE: the engine refuses to record a non-case status on a case event', () => {
    newCase('fs-1')
    expect(() => appendCaseEvent(getDb(), {
      caseId: 'fs-1', caseVersion: 1, actor: 'test', eventType: 'STATUS_CHANGED',
      previousStatus: 'RECOVERY_REQUIRED', newStatus: 'VERIFIED', reason: 'outbound delivery verified',
    } as never, NOW)).toThrow(ForeignCaseStatusError)
  })

  it('the refusal names the field and the vocabulary, so the caller can see where it belongs', () => {
    newCase('fs-2')
    try {
      appendCaseEvent(getDb(), {
        caseId: 'fs-2', caseVersion: 1, actor: 'test', eventType: 'STATUS_CHANGED', newStatus: 'VERIFIED',
      } as never, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as ForeignCaseStatusError
      expect(err.name).toBe('ForeignCaseStatusError')
      expect(err.field).toBe('new_status')
      expect(err.message).toMatch(/belongs in the payload/)
    }
  })

  it('READ SIDE, the acceptance case: a COMPLETED case with a delivery-status event stays FULFILLED', () => {
    // The historical rows cannot be un-written, so the reader must survive them.
    // Inserted around the guard on purpose -- this is what the live store holds.
    newCase('claim-1')
    transitionCase(getDb(), { caseId: 'claim-1', newStatus: 'COMPLETED', seenVersion: 1, actor: 'test', reason: 'done' }, NOW - DAY)
    getDb().prepare(
      `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, previous_status, new_status, reason, created_at)
       VALUES ('claim-1', 2, 'istvan', 'STATUS_CHANGED', 'RECOVERY_REQUIRED', 'VERIFIED', 'outbound ob-1 verified', ?)`,
    ).run(NOW)

    const c = commitmentFor('claim-1')!
    expect(c.status).toBe('FULFILLED')
    expect(c.status).not.toBe('REOPENED')
    expect(c.foreignStatusEvents).toHaveLength(1)
    expect(c.foreignStatusEvents[0].value).toBe('RECOVERY_REQUIRED -> VERIFIED')
  })

  it('and the projection says so out loud, rather than leaving it as a quiet oddity', () => {
    newCase('claim-2')
    transitionCase(getDb(), { caseId: 'claim-2', newStatus: 'COMPLETED', seenVersion: 1, actor: 'test', reason: 'done' }, NOW - DAY)
    getDb().prepare(
      `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, previous_status, new_status, reason, created_at)
       VALUES ('claim-2', 2, 'istvan', 'STATUS_CHANGED', 'RECOVERY_REQUIRED', 'VERIFIED', 'outbound', ?)`,
    ).run(NOW)
    const p = projectIntelligence(getDb(), 'personal', NOW)
    expect(p.integrityFindings.some(a => a.startsWith('FOREIGN_STATUS_EVENT claim-2'))).toBe(true)
    // ...and NOT as a run fault. This row is history we do not rewrite, so it is
    // found on every run for ever; putting it in `anomalies` pinned the
    // 10-minute cycle permanently red on 2026-09-03.
    expect(p.anomalies).toEqual([])
  })
})

describe('a restore is not a business decision, and the classifier says which', () => {
  const ev = (over: Record<string, unknown>) => ({
    event_id: 1, event_type: 'STATUS_CHANGED', new_status: 'READY', created_at: NOW, ...over,
  }) as never

  it('RECOVERY_RESTORE: recognised by the source, not by the actor', () => {
    // The same `marveen` restores AND decides; only the source separates them.
    expect(classifyReopen(ev({ actor: 'marveen', source_system: 'manual_restore', reason: 'put back' })))
      .toBe('RECOVERY_RESTORE')
  })

  it('RECOVERY_RESTORE: or by the stated reason, when the source is silent', () => {
    expect(classifyReopen(ev({ actor: 'marveen', source_system: null,
      reason: 'Restored from event 259: closed by the progression engine on a generic, self-certified DoD' })))
      .toBe('RECOVERY_RESTORE')
  })

  it('IMPORT_OVERRIDE: an import moving a closed case, with no new business evidence', () => {
    expect(classifyReopen(ev({ actor: 'marveen-baseline-import', reason: 'ChatGPT CoS baseline: COMPLETED -> FOLLOW_UP_DUE' })))
      .toBe('IMPORT_OVERRIDE')
  })

  it('BUSINESS_REOPEN: a named actor with a stated reason, and nothing mechanical about it', () => {
    expect(classifyReopen(ev({ actor: 'istvan', source_system: 'gmail', reason: 'the supplier says it never arrived' })))
      .toBe('BUSINESS_REOPEN')
  })

  it('UNKNOWN_REOPEN: silence is reported as silence, never rounded up to a decision', () => {
    expect(classifyReopen(ev({ actor: null, reason: null }))).toBe('UNKNOWN_REOPEN')
    expect(classifyReopen(null)).toBe('UNKNOWN_REOPEN')
  })
})

describe('why a terminal row is terminal, when no transition says so', () => {
  const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED'])
  const e = (over: Record<string, unknown>) => ({ event_id: 1, event_type: 'CREATED', new_status: null, created_at: NOW, ...over }) as never

  it('IMPORTED_CLOSURE: the case was BORN closed by an import', () => {
    const r = classifyClosure([e({ event_type: 'CREATED', new_status: 'COMPLETED', actor: 'marveen-baseline-import' })], TERMINAL)
    expect(r?.klass).toBe('IMPORTED_CLOSURE')
  })

  it('SUPERSEDED_BY_TARGET: a namespace move, and the target is extracted as provenance', () => {
    const r = classifyClosure([e({
      event_type: 'MOVED_NAMESPACE', new_status: 'CANCELLED', actor: 'marveen',
      reason: 'Athelyezve a ZST nevterbe: zst-moved-19fe78e382f4c02c (Istvan dontese)',
    })], TERMINAL)
    expect(r?.klass).toBe('SUPERSEDED_BY_TARGET')
    expect(r?.targetCaseId).toBe('zst-moved-19fe78e382f4c02c')
  })

  it('TERMINAL_ROW_NO_EVENT: no event carries a terminal status at all', () => {
    const r = classifyClosure([e({ event_type: 'CREATED', new_status: 'WAITING_EXTERNAL' }),
                               e({ event_type: 'COMPLETION_PROPOSED', new_status: null })], TERMINAL)
    expect(r?.klass).toBe('TERMINAL_ROW_NO_EVENT')
  })

  it('and an ordinary close is NOT one of these -- the function stays silent about normal cases', () => {
    expect(classifyClosure([e({ event_type: 'STATUS_CHANGED', new_status: 'COMPLETED', actor: 'istvan' })], TERMINAL))
      .toBeNull()
  })
})

describe('WHICH contradicting event is asked', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the FIRST one -- the case living its life afterwards does not know why it was reopened', () => {
    // Closed, restored, and then moved on. Asking the LAST transition returns
    // UNKNOWN_REOPEN, because a later ordinary move carries no restore marker.
    // That mistake alone put 13 of the 21 live restore artifacts in the wrong
    // class, and it looked like a policy judgement rather than a missing lookup.
    newCase('order-1')
    transitionCase(getDb(), { caseId: 'order-1', newStatus: 'COMPLETED', seenVersion: 1, actor: 'test', reason: 'engine DoD' }, NOW - 3 * DAY)
    appendCaseEvent(getDb(), {
      caseId: 'order-1', caseVersion: 2, actor: 'marveen', eventType: 'STATUS_CHANGED',
      previousStatus: 'COMPLETED', newStatus: 'READY', sourceSystem: 'manual_restore',
      reason: 'Restored: closed by the progression engine on a generic, self-certified DoD',
    } as never, NOW - 2 * DAY)
    getDb().prepare(`UPDATE personal_cases SET status='READY' WHERE case_id='order-1'`).run()
    // …and then an ordinary later move, with nothing mechanical about it.
    appendCaseEvent(getDb(), {
      caseId: 'order-1', caseVersion: 2, actor: 'istvan', eventType: 'STATUS_CHANGED',
      previousStatus: 'READY', newStatus: 'EXECUTING', reason: 'picked it up',
    } as never, NOW - DAY)

    const c = commitmentFor('order-1')!
    expect(c.status).toBe('REOPENED')
    expect(c.reopenClass).toBe('RECOVERY_RESTORE')
  })
})

describe('the three classes reach the commitment, not just the classifier', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a terminal row with no terminal event is UNKNOWN and a NAMED INTEGRITY FINDING, not a quiet gap', () => {
    createCase(getDb(), { caseId: 'orphan', title: 't', caseType: 'ADMIN', status: 'WAITING_EXTERNAL', actor: 'test' } as never, NOW - DAY)
    getDb().prepare(`UPDATE personal_cases SET status='COMPLETED', next_action='do it', due_at=? WHERE case_id='orphan'`).run(NOW + DAY)
    const c = commitmentFor('orphan')!
    expect(c.status).toBe('UNKNOWN')
    expect(c.closureClass).toBe('TERMINAL_ROW_NO_EVENT')
    const p = projectIntelligence(getDb(), 'personal', NOW)
    expect(p.integrityFindings.some(a => a.startsWith('TERMINAL_ROW_NO_EVENT orphan'))).toBe(true)
    expect(p.anomalies).toEqual([])
  })
})
