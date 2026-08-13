import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { roundRobinByDomain, casesNeedingReading } from '../cos/reader-cycle.js'
import { casesNeedingGoal } from '../cos/goal-enrichment.js'

// P11 (review 2026-08-13). Both bounded sweeps enumerated the `personal` domain
// in FULL and then `zst`, and only then sliced to the per-cycle limit of 3-5.
// With any personal backlog — and the backlog is refilled by the same sweeps —
// corporate cases were not read "later", they were not read at all.

const NOW = 1_800_000_000

describe('roundRobinByDomain', () => {
  it('interleaves the domains and honours the limit', () => {
    const items = [
      { domain: 'personal', id: 'p1' }, { domain: 'personal', id: 'p2' }, { domain: 'personal', id: 'p3' },
      { domain: 'zst', id: 'z1' }, { domain: 'zst', id: 'z2' },
    ]
    expect(roundRobinByDomain(items, 4).map(i => i.id)).toEqual(['p1', 'z1', 'p2', 'z2'])
  })

  it('preserves the order WITHIN a domain', () => {
    const items = [
      { domain: 'personal', id: 'p1' }, { domain: 'personal', id: 'p2' },
      { domain: 'zst', id: 'z1' }, { domain: 'zst', id: 'z2' },
    ]
    expect(roundRobinByDomain(items, 0).map(i => i.id)).toEqual(['p1', 'z1', 'p2', 'z2'])
  })

  it('a domain that runs out does not hold a slot back', () => {
    const items = [
      { domain: 'personal', id: 'p1' }, { domain: 'personal', id: 'p2' }, { domain: 'personal', id: 'p3' },
      { domain: 'zst', id: 'z1' },
    ]
    expect(roundRobinByDomain(items, 4).map(i => i.id)).toEqual(['p1', 'z1', 'p2', 'p3'])
  })

  it('limit 0 means "everything"', () => {
    expect(roundRobinByDomain([{ domain: 'zst', id: 'z1' }], 0)).toHaveLength(1)
  })
})

function seedProgressionCase(domain: 'personal' | 'zst', caseId: string, startedAt: number) {
  const db = getDb()
  if (domain === 'personal') createCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN' }, NOW - 1000)
  else createZstCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN' }, NOW - 1000)
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode, created_at, updated_at)
     VALUES (?, ?, 1, 'internal', ?, ?)`,
  ).run(domain, caseId, NOW - 1000, NOW - 1000)
  db.prepare(
    `INSERT INTO case_progression_runs
       (progression_run_id, domain, case_id, trigger_type, status, decision, started_at)
     VALUES (?, ?, ?, 'SCHEDULED', 'COMPLETED', 'CONTINUE_AUTONOMOUSLY', ?)`,
  ).run(`run-${caseId}`, domain, caseId, startedAt)
}

describe('the bounded sweeps do not starve the corporate namespace', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the Reader reaches a zst case despite a personal backlog', () => {
    // Six personal cases queued ahead of the only corporate one.
    for (let i = 0; i < 6; i++) seedProgressionCase('personal', `p${i}`, NOW - i)
    seedProgressionCase('zst', 'z1', NOW - 100)
    const picked = casesNeedingReading(getDb(), 3)
    expect(picked).toHaveLength(3)
    expect(picked.some(c => c.domain === 'zst'), 'zst waited behind six personal cases, every cycle').toBe(true)
  })

  it('the goal-enrichment sweep does the same', () => {
    for (let i = 0; i < 6; i++) seedProgressionCase('personal', `p${i}`, NOW - i)
    seedProgressionCase('zst', 'z1', NOW - 100)
    const picked = casesNeedingGoal(getDb(), 3)
    expect(picked).toHaveLength(3)
    expect(picked.some(c => c.domain === 'zst')).toBe(true)
  })
})
