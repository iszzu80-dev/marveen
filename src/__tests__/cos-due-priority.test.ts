// §10.4 closure C — bounded priority in the due queue.
//
// Owner, 2026-08-27: "A jelenlegi 1 due case / cycle limit miatt egy fulfilled
// wait nagy backlogban órákig késhet."
//
// THE PREMISE WAS MINE AND IT WAS WRONG, which is worth stating here because the
// fix depends on which mechanism is real. The sweep takes FIFTY per domain, not
// one; I read `limit: 1` out of the progression block of the cycle report and
// attributed it to the sweep, when it belongs to GoalEnrichment's canary
// throttle in the same merged payload.
//
// The starvation is real and comes from the ORDERING: the due page sorts
// `next_progression_at ASC`, and arming a wait pushes that value FORWARD -- so a
// wait that has just been satisfied sorts to the BACK of the queue it most needs
// to be at the front of. Measured live before the fix: 49 and 50 cases due, and
// 49 sorting ahead of each active typed wait. A bigger limit moves the cliff; it
// does not move the ordering, which is why the wrong diagnosis mattered.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { armWaitCondition } from '../cos/wait-condition.js'
import { findDuePage, DUE_BANDS, BAND_SHARE, MAX_SELECTION_SCAN } from '../cos/progression-scheduler.js'

const NOW = 1_700_000_000
type Db = ReturnType<typeof getDb>

/** A due case whose next_progression_at is `age` seconds in the past. */
function dueCase(db: Db, id: string, age: number, opts: { dueAt?: number } = {}): void {
  createCase(db, { caseId: id, title: id, caseType: 'X' }, NOW - 10_000)
  if (opts.dueAt !== undefined) {
    db.prepare(`UPDATE personal_cases SET due_at = ? WHERE case_id = ?`).run(opts.dueAt, id)
  }
  seedCaseProgressionState(db, 'personal', id, NOW - 10_000)
  db.prepare(
    `UPDATE case_progression_state SET next_progression_at = ?, progression_enabled = 1
      WHERE domain='personal' AND case_id = ?`,
  ).run(NOW - age, id)
}

/** Arm a wait that is ALREADY satisfied (its clock has passed), and push the
 *  case's next_progression_at forward the way arming really does. */
function wokenCase(db: Db, id: string): void {
  dueCase(db, id, 5)
  armWaitCondition(db, {
    domain: 'personal', caseId: id, kind: 'EXTERNAL_RESPONSE',
    subject: 'reply from someone', expectedBy: NOW + 3600, wakePolicy: 'EITHER', runId: 'r',
  }, NOW - 100)
  // Satisfied by the clock, and sorted to the BACK: exactly the live shape.
  db.prepare(`UPDATE case_wait_conditions SET expected_by = ? WHERE case_id = ?`).run(NOW - 1, id)
  db.prepare(
    `UPDATE case_progression_state SET next_progression_at = ? WHERE domain='personal' AND case_id = ?`,
  ).run(NOW - 1, id)
}

describe('due priority — a freshly woken case does not queue behind the backlog', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: 64 older due cases, and the woken one is still selected', () => {
    // The owner's test, in his numbers. Before the bands, `next_progression_at
    // ASC` put all 64 ahead of it.
    const db = getDb()
    for (let i = 0; i < 64; i++) dueCase(db, `bulk-${i}`, 3600 + i)
    wokenCase(db, 'woken-1')

    const page = findDuePage(db, 'personal', NOW, 50)
    const ids = page.cases.map(c => c.case_id)
    expect(ids).toContain('woken-1')
    expect(page.cases.find(c => c.case_id === 'woken-1')?.band).toBe('WOKEN')
    // And it is not merely present: it is in the first band's share.
    expect(ids.indexOf('woken-1')).toBeLessThan(Math.floor(50 * BAND_SHARE.WOKEN))
  })

  it('the ordering ALONE would have starved it — the control this test needs', () => {
    // Without this, the test above could pass on a board where the woken case
    // happened to be old enough anyway, and would prove nothing about bands.
    const db = getDb()
    for (let i = 0; i < 64; i++) dueCase(db, `bulk-${i}`, 3600 + i)
    wokenCase(db, 'woken-1')
    const byFreshness = db.prepare(
      `SELECT case_id FROM case_progression_state
        WHERE domain='personal' AND next_progression_at <= ?
        ORDER BY next_progression_at ASC LIMIT 50`,
    ).all(NOW) as Array<{ case_id: string }>
    expect(byFreshness.map(r => r.case_id)).not.toContain('woken-1')
  })

  it('reports all six numbers the owner asked for', () => {
    const db = getDb()
    for (let i = 0; i < 64; i++) dueCase(db, `bulk-${i}`, 3600 + i)
    wokenCase(db, 'woken-1')
    const m = findDuePage(db, 'personal', NOW, 50).metrics
    expect(m.backlog).toBe(65)                     // due backlog size
    expect(m.oldestDueAgeSec).toBeGreaterThan(3600) // oldest due age
    expect(m.wakeLatencySec).toBeGreaterThanOrEqual(0)
    expect(m.selected.WOKEN + m.selected.DEADLINE + m.selected.NORMAL).toBe(50) // processed per cycle
    expect(m.due.WOKEN).toBe(1)
    expect(m.starvedWoken).toBe(0)                 // starvation count
  })

  it('starvedWoken is NON-zero when woken cases genuinely exceed the band', () => {
    // The counter-case: a starvation counter that is always zero is not a
    // counter. With more woken cases than the band's share, the leftovers ARE
    // starved and the number must say so rather than round down to comfortable.
    const db = getDb()
    for (let i = 0; i < 40; i++) wokenCase(db, `w-${i}`)
    const m = findDuePage(db, 'personal', NOW, 10).metrics
    expect(m.due.WOKEN).toBe(40)
    // Ten selected, thirty left behind. The first implementation said 35 here,
    // because the spare-capacity pass relabelled five woken cases as NORMAL --
    // so the audit field claimed they ran as ordinary work AND the starvation
    // counter claimed they had not run at all. The band now travels with the
    // case, and both numbers agree with what happened.
    expect(m.selected.WOKEN).toBe(10)
    expect(m.starvedWoken).toBe(30)
    expect(m.selected.NORMAL).toBe(0)
  })

  it('FAIRNESS: a flood of woken cases does not shut the ordinary queue out', () => {
    // Unbounded priority is starvation with extra steps, pointed the other way.
    const db = getDb()
    for (let i = 0; i < 100; i++) wokenCase(db, `w-${i}`)
    for (let i = 0; i < 100; i++) dueCase(db, `bulk-${i}`, 7200 + i)
    const page = findDuePage(db, 'personal', NOW, 20)
    expect(page.metrics.selected.WOKEN).toBeLessThanOrEqual(Math.max(1, Math.floor(20 * BAND_SHARE.WOKEN)))
    expect(page.metrics.selected.NORMAL).toBeGreaterThan(0)
  })

  it('a deadline that has come due outranks ordinary freshness', () => {
    const db = getDb()
    for (let i = 0; i < 60; i++) dueCase(db, `bulk-${i}`, 3600 + i)
    dueCase(db, 'deadline-1', 5, { dueAt: NOW - 60 })
    const page = findDuePage(db, 'personal', NOW, 20)
    expect(page.cases.find(c => c.case_id === 'deadline-1')?.band).toBe('DEADLINE')
  })

  it('an unused band gives its share DOWN rather than idling the page', () => {
    // A fairness rule that leaves a page half empty is the same starvation from
    // the other end.
    const db = getDb()
    for (let i = 0; i < 40; i++) dueCase(db, `bulk-${i}`, 3600 + i)
    const page = findDuePage(db, 'personal', NOW, 20)
    expect(page.cases).toHaveLength(20)
    expect(page.metrics.selected.WOKEN).toBe(0)
    expect(page.metrics.selected.NORMAL).toBe(20)
  })

  it('no case is selected twice, whatever the bands do', () => {
    // The batch must not cause duplicate progression. Exclusion is the claim's
    // job, but a page that lists a case twice would defeat it before the claim
    // is ever taken.
    const db = getDb()
    for (let i = 0; i < 30; i++) wokenCase(db, `w-${i}`)
    for (let i = 0; i < 30; i++) dueCase(db, `bulk-${i}`, 3600 + i, { dueAt: NOW - 5 })
    const page = findDuePage(db, 'personal', NOW, 50)
    expect(new Set(page.cases.map(c => c.case_id)).size).toBe(page.cases.length)
  })

  it('a quiet board behaves exactly as it did before the bands existed', () => {
    // The regression this change most needs to not be: on a small due set every
    // case is returned, oldest first, as always.
    const db = getDb()
    for (let i = 0; i < 5; i++) dueCase(db, `bulk-${i}`, 100 + i * 10)
    const page = findDuePage(db, 'personal', NOW, 50)
    expect(page.cases).toHaveLength(5)
    expect(page.remaining).toBe(0)
    expect(page.hasMore).toBe(false)
  })

  it('the selection scan is bounded, and the bound is declared', () => {
    // A scan that silently stopped at the page size could not see a woken case
    // at position 51 -- the entire defect. It looks deeper, but not forever.
    expect(MAX_SELECTION_SCAN).toBeGreaterThan(50)
    expect(DUE_BANDS).toEqual(['WOKEN', 'DEADLINE', 'NORMAL'])
  })
})
