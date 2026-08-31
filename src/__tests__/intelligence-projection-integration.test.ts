import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { projectIntelligence } from '../cos/intelligence/project.js'
import { opportunitiesForCase } from '../cos/intelligence/opportunities.js'

const NOW = 1_800_000_000
const DAY = 86_400

const ins = (over: Record<string, unknown>) => {
  const row = {
    case_id: 'c', title: 't', case_type: 'ADMIN', status: 'READY',
    next_action: null, blocked_reason: null, due_at: null, completed_at: null,
    created_at: NOW - 30 * DAY, updated_at: NOW - DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO personal_cases (case_id,title,case_type,status,next_action,blocked_reason,due_at,completed_at,created_at,updated_at)
     VALUES (@case_id,@title,@case_type,@status,@next_action,@blocked_reason,@due_at,@completed_at,@created_at,@updated_at)`,
  ).run(row)
}

describe('opportunities are conservative by construction', () => {
  const row = (over = {}) => ({
    case_id: 'c1', title: 't', status: 'READY', next_action: null,
    blocked_reason: null, due_at: null, follow_up_at: null, updated_at: NOW - DAY, ...over,
  })

  it('OWED WORK IS NOT AN OPPORTUNITY -- a date disqualifies it outright', () => {
    // Otherwise the same work appears in two bands, one of which can interrupt.
    expect(opportunitiesForCase(row({ due_at: NOW + DAY }) as never, 'personal', NOW)).toEqual([])
  })

  it('and follow_up_at counts as a date, because commitments count it', () => {
    // The live shadow run reported 43 personal cases derived as BOTH, and the
    // cause was two definitions of "has a date" in two files: this rule read
    // due_at, commitments read due_at ?? follow_up_at.
    expect(opportunitiesForCase(row({ due_at: null, follow_up_at: NOW + DAY }) as never, 'personal', NOW)).toEqual([])
  })

  it('a stalled case with no next action and no block is one', () => {
    const o = opportunitiesForCase(row() as never, 'personal', NOW)[0]
    expect(o.opportunityKind).toBe('STALLED_NO_ACTION')
    expect(o.suggestion).toContain('close it')
  })

  it('a BLOCKED case is not -- it has a reason, and that belongs to decisions', () => {
    expect(opportunitiesForCase(row({ status: 'BLOCKED', blocked_reason: 'legal' }) as never, 'personal', NOW)).toEqual([])
  })

  it('confidence is capped at MEDIUM -- a suggestion never claims to be an observation', () => {
    const o = opportunitiesForCase(row() as never, 'personal', NOW)[0]
    expect(o.confidence).toBe('MEDIUM')
    expect(o.kind).toBe('RECOMMENDATION')
  })

  it('and it carries no field that could be read as permission', () => {
    const o = opportunitiesForCase(row() as never, 'personal', NOW)[0]
    for (const f of ['approved', 'authorized', 'mayExecute', 'allow']) expect(f in o).toBe(false)
  })
})

describe('the cross-surface invariants, asserted rather than trusted', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    ins({ case_id: 'owed', status: 'READY', next_action: 'send it', due_at: NOW - DAY })
    ins({ case_id: 'claimed', status: 'COMPLETED', next_action: 'was done', completed_at: NOW - DAY })
    ins({ case_id: 'blocked', status: 'BLOCKED', blocked_reason: 'legal review' })
    // no next action, no date: nothing owed, so this is an OPPORTUNITY, and the
    // "never interrupts" assertions below are no longer vacuous.
    ins({ case_id: 'idle', status: 'READY', updated_at: NOW - 40 * DAY })
    ins({ case_id: 'stalled', status: 'READY', updated_at: NOW - 2 * DAY })
  })

  it('AN OPPORTUNITY NEVER INTERRUPTS, whatever else is going on', () => {
    const p = projectIntelligence(getDb(), 'personal', NOW)
    // NOT VACUOUS: there really are opportunities to exclude.
    expect(p.opportunities.length).toBeGreaterThan(0)
    expect(p.attention.interrupt.every((i) => i.band !== 'OPPORTUNITY')).toBe(true)
    expect(p.anomalies.filter((a) => a.includes('INVARIANT BREACH'))).toEqual([])
  })

  it('the overlap anomaly is REPORTED, not silently resolved', () => {
    // A case that derives as both owed and merely available means one of the two
    // rules is wrong about it. Dropping the opportunity is the safe resolution;
    // doing it QUIETLY would hide the disagreement that caused it.
    //
    // 'idle' is stalled (no next action) and long-idle, so it yields two
    // opportunities. Give it a next action -- now it is also a commitment.
    getDb().prepare(`UPDATE personal_cases SET next_action=? WHERE case_id='idle'`).run('do it')
    const p = projectIntelligence(getDb(), 'personal', NOW)
    expect(p.commitments.some((c) => c.caseId === 'idle')).toBe(true)
    expect(p.opportunities.some((o) => o.caseId === 'idle')).toBe(false)
    const said = p.anomalies.filter((a) => a.includes('idle'))
    expect(said.length).toBeGreaterThan(0)
    expect(said[0]).toContain('both a commitment and an opportunity')
    expect(said[0]).toContain('is not merely available')
  })

  it('a case cannot be both owed and merely available -- the obligation wins, and it is REPORTED', () => {
    // 'idle' is stalled AND long-idle, but has no due date, so it stays an
    // opportunity. Give it a next action and a date and it becomes owed.
    getDb().prepare(`UPDATE personal_cases SET due_at=?, next_action=? WHERE case_id='idle'`).run(NOW + DAY, 'do it')
    const p = projectIntelligence(getDb(), 'personal', NOW)
    expect(p.opportunities.some((o) => o.caseId === 'idle')).toBe(false)
    expect(p.commitments.some((c) => c.caseId === 'idle')).toBe(true)
  })

  it('WITH FREE SLOTS the opportunities still do not take them -- the discriminating case', () => {
    // The previous assertion passed even under a mutant that fed opportunities
    // in as obligations, because three commitments happened to fill a budget of
    // three. That is the fixture protecting the invariant, not the code.
    //
    // Here one obligation interrupts and TWO slots stay free. If band-ranking
    // were the only defence, the opportunities would walk into them.
    const db = getDb()
    db.prepare(`DELETE FROM personal_cases WHERE case_id IN ('claimed','blocked')`).run()
    const p = projectIntelligence(db, 'personal', NOW, [], { maxInterruptions: 3, quietSeconds: 3600 })

    expect(p.opportunities.length).toBeGreaterThan(0)
    expect(p.attention.interrupt.length).toBeLessThan(3)        // slots genuinely free
    expect(p.attention.interrupt.every((i) => i.band !== 'OPPORTUNITY')).toBe(true)
    expect(p.attention.quiet.some((q) => q.band === 'OPPORTUNITY')).toBe(true)
    expect(p.anomalies.filter((a) => a.includes('INVARIANT BREACH'))).toEqual([])
  })

  it('the unproven completion reaches the interrupt list as SAFETY', () => {
    const p = projectIntelligence(getDb(), 'personal', NOW)
    const top = p.attention.interrupt[0]
    expect(top.band).toBe('SAFETY')
    expect(top.element.caseId).toBe('claimed')
    expect(top.why).toContain('nothing evidences it')
  })

  it('the whole projection writes NOTHING', () => {
    const db = getDb()
    const snap = () => JSON.stringify(db.prepare('SELECT * FROM personal_cases ORDER BY case_id').all())
    const before = snap()
    projectIntelligence(db, 'personal', NOW)
    projectIntelligence(db, 'personal', NOW)
    expect(snap()).toBe(before)
  })

  it('and it is deterministic -- the same store twice gives the same answer', () => {
    const a = projectIntelligence(getDb(), 'personal', NOW)
    const b = projectIntelligence(getDb(), 'personal', NOW)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the interruption budget holds across all surfaces together, not per surface', () => {
    const p = projectIntelligence(getDb(), 'personal', NOW, [], { maxInterruptions: 2, quietSeconds: 3600 })
    expect(p.attention.interrupt.length).toBeLessThanOrEqual(2)
    // and nothing is lost
    const total = p.attention.interrupt.length + p.attention.quiet.length + p.attention.suppressed.length
    expect(total).toBeGreaterThanOrEqual(p.commitments.length)
  })
})
