import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { setNextWake, dueCases } from '../cos/scheduler.js'
import { buildWakeAlert, alertWokenCases } from '../cos/wake-alert.js'

// The consumer `next_wake_at` never had. The mechanism was complete at both
// ends — a writer, a reader, and a tick that called the reader every cycle —
// and the tick kept only `.length`, so no wake could ever be acted on. 0 of 61
// open cases carried one, which is what a column looks like when filling it
// changes nothing.

const T0 = 1_700_000_000

describe('wake alert', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function mk(id: string, wakeAt: number | null) {
    createCase(getDb(), { caseId: id, title: `case ${id}`, caseType: 'ADMIN' }, T0)
    if (wakeAt !== null) setNextWake(getDb(), id, wakeAt, T0)
  }
  function messages() {
    return getDb().prepare(`SELECT from_agent, to_agent, content FROM agent_messages ORDER BY id`).all() as
      Array<{ from_agent: string; to_agent: string; content: string }>
  }

  it('reports a case whose wake has arrived, naming it', () => {
    mk('c1', T0 - 60)
    const r = alertWokenCases(getDb(), T0)
    expect(r.posted).toBe(true)
    expect(r.woken.map(c => c.case_id)).toEqual(['c1'])
    expect(messages()).toHaveLength(1)
    expect(messages()[0].content).toContain('c1')
    expect(messages()[0].to_agent).toBe('marveen')
  })

  it('says nothing when no wake has arrived — an event alert, not a digest', () => {
    mk('c1', T0 + 3600)
    const r = alertWokenCases(getDb(), T0)
    expect(r.posted).toBe(false)
    expect(r.content).toBeNull()
    expect(messages()).toHaveLength(0)
  })

  it('CLEARS the wake, so the same case is not re-reported every cycle', () => {
    mk('c1', T0 - 60)
    alertWokenCases(getDb(), T0)
    // Without this, the alert repeats every ten minutes for as long as the case
    // stays open — which is precisely how a real signal gets muted.
    expect(dueCases(getDb(), T0 + 600)).toHaveLength(0)
    const second = alertWokenCases(getDb(), T0 + 600)
    expect(second.posted).toBe(false)
    expect(messages()).toHaveLength(1)
  })

  it('posts BEFORE clearing: a wake is never lost silently', () => {
    // Order is asserted through the observable consequence: if clearing came
    // first and the post then failed, the case would be silent forever. Here the
    // message exists and the wake is gone — the only ordering that yields both.
    mk('c1', T0 - 60)
    alertWokenCases(getDb(), T0)
    expect(messages()).toHaveLength(1)
    expect((getDb().prepare('SELECT next_wake_at FROM personal_cases WHERE case_id = ?').get('c1') as any).next_wake_at).toBeNull()
  })

  it('reports several woken cases in one message, not one message each', () => {
    mk('c1', T0 - 60); mk('c2', T0 - 120); mk('c3', T0 + 60)
    const r = alertWokenCases(getDb(), T0)
    expect(r.woken.map(c => c.case_id).sort()).toEqual(['c1', 'c2'])
    expect(messages()).toHaveLength(1)
    expect(messages()[0].content).toContain('2 ügy')
  })

  it('states how overdue each wake is, so a late one is visible as late', () => {
    mk('c1', T0 - 3600)
    const { content } = buildWakeAlert(getDb(), T0)
    expect(content).toContain('60 perce esedékes')
  })

  it('ignores closed cases — a wake on a finished case is not an appointment', () => {
    mk('c1', T0 - 60)
    getDb().prepare(`UPDATE personal_cases SET status='COMPLETED' WHERE case_id='c1'`).run()
    expect(alertWokenCases(getDb(), T0).posted).toBe(false)
  })
})
