// §12 / §13 / §26(17–18): stall and anomaly detection.
//
// The sentence §12 is built around: **not every old case is a stall.**
//
// That is the whole difficulty. A case waiting on a lawyer for three weeks is
// not stalled — it is waiting, correctly, and there is nothing useful to do
// about it. A detector that cannot tell those apart produces a list of every old
// case, which is the list the owner could get by sorting a column, and it is
// worth exactly as much.
//
// §13's rule is the sibling: only anomalies for which internal evidence ALREADY
// exists. No fetching, no re-reading, no asking — which is also what makes every
// finding citable, and §4.1 will not accept a signal that is not.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { ensureProactiveSchema } from '../cos/proactive/schema.js'
import { recordSignal, signalRefusal } from '../cos/proactive/signal-store.js'
import { qualifySignal } from '../cos/proactive/qualification.js'
import {
  detectStalls, stallSignal, detectAnomalies, anomalySignal,
  unsupportedAnomalyKinds, STALL_AGE_SEC, STALL_NO_PROGRESS_RUNS,
  LEGITIMATE_WAIT_STATUSES,
} from '../cos/proactive/detectors.js'

const T0 = 1_700_000_000
const DAY = 86400

function setup(): void {
  initDatabase(':memory:')
  initProgressionSchema(getDb())
  ensureProactiveSchema(getDb())
}

/** A case last touched `ageDays` ago, in `status`. */
function oldCase(id: string, ageDays: number, status = 'READY'): void {
  const db = getDb()
  createCase(db, { caseId: id, title: id, caseType: 'ADMIN' }, T0 - ageDays * DAY)
  db.prepare(`UPDATE personal_cases SET status = ?, updated_at = ? WHERE case_id = ?`)
    .run(status, T0 - ageDays * DAY, id)
}

function engineRuns(id: string, runs: number): void {
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
       no_progress_run_count, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', ?, ?, ?)`,
  ).run(id, runs, T0 - 100 * DAY, T0 - 100 * DAY)
}

describe('§12 stall detection — not every old case is a stall', () => {
  beforeEach(setup)

  it('HEADLINE: a case WAITING_EXTERNAL is not stalled, however old', () => {
    // The condition that does the work. Drop it and this becomes "list cases
    // older than three weeks" — which puts every correctly-waiting case in front
    // of the owner as though something were wrong.
    oldCase('waiting', 200, 'WAITING_EXTERNAL')
    engineRuns('waiting', 99)
    expect(detectStalls(getDb(), 'personal', T0)).toHaveLength(0)
  })

  it('every legitimate wait status is exempt, not just the obvious one', () => {
    for (const [i, status] of LEGITIMATE_WAIT_STATUSES.entries()) {
      oldCase(`c${i}`, 200, status)
      engineRuns(`c${i}`, 99)
    }
    expect(detectStalls(getDb(), 'personal', T0)).toHaveLength(0)
  })

  it('a recent case is not a stall, whatever the counter says', () => {
    oldCase('fresh', 1)
    engineRuns('fresh', 99)
    expect(detectStalls(getDb(), 'personal', T0)).toHaveLength(0)
  })

  it('an old case the engine has re-examined without moving IS a stall', () => {
    oldCase('stuck', 40)
    engineRuns('stuck', STALL_NO_PROGRESS_RUNS)
    const f = detectStalls(getDb(), 'personal', T0)
    expect(f).toHaveLength(1)
    expect(f[0].noProgressRuns).toBe(STALL_NO_PROGRESS_RUNS)
  })

  it('an old case the engine re-examined and DID move is not a stall', () => {
    oldCase('moving', 40)
    engineRuns('moving', 2)
    expect(detectStalls(getDb(), 'personal', T0)).toHaveLength(0)
  })

  it('HEADLINE: a case the engine has never touched qualifies on age alone', () => {
    // The stronger form of the same fact, and the one a counter-only rule misses
    // entirely: it has not reasoned even once. A rule that required twelve
    // fruitless runs would be permanently blind to cases the engine never
    // reached.
    oldCase('never', 40)
    const f = detectStalls(getDb(), 'personal', T0)
    expect(f).toHaveLength(1)
    expect(f[0].reason).toMatch(/nem járt rajta a motor/)
  })

  it('a completed case cannot stall', () => {
    oldCase('done', 200, 'COMPLETED')
    engineRuns('done', 99)
    expect(detectStalls(getDb(), 'personal', T0)).toHaveLength(0)
  })

  it('the age threshold is the floor, and it is real', () => {
    oldCase('justUnder', Math.floor(STALL_AGE_SEC / DAY) - 1)
    oldCase('justOver', Math.floor(STALL_AGE_SEC / DAY) + 1)
    expect(detectStalls(getDb(), 'personal', T0).map(f => f.caseId)).toEqual(['justOver'])
  })

  it('the two domains are detected separately', () => {
    oldCase('p1', 40)
    createZstCase(getDb(), { caseId: 'z1', title: 'z', caseType: 'ADMIN' }, T0 - 40 * DAY)
    getDb().prepare(`UPDATE zst_cases SET status='READY', updated_at=? WHERE case_id='z1'`).run(T0 - 40 * DAY)
    expect(detectStalls(getDb(), 'personal', T0).map(f => f.caseId)).toEqual(['p1'])
    expect(detectStalls(getDb(), 'zst', T0).map(f => f.caseId)).toEqual(['z1'])
  })

  it('HEADLINE: the signal it produces survives §4.1 — every claim is cited', () => {
    // The detector and the store are separate on purpose, and this is the join:
    // a finding that cannot become a signal is a finding nobody will ever see.
    oldCase('stuck', 40)
    engineRuns('stuck', STALL_NO_PROGRESS_RUNS)
    const draft = stallSignal(detectStalls(getDb(), 'personal', T0)[0])
    expect(signalRefusal(draft)).toBeNull()
    const r = recordSignal(getDb(), draft, T0)
    expect(r.outcome).toBe('RECORDED')
  })

  it('confidence is 0.7, not 1 — knowing it has not moved is not knowing it CAN', () => {
    oldCase('stuck', 40)
    engineRuns('stuck', STALL_NO_PROGRESS_RUNS)
    expect(stallSignal(detectStalls(getDb(), 'personal', T0)[0]).confidence).toBeLessThan(1)
  })
})

describe('§13 anomaly detection — contradictions between stored facts', () => {
  beforeEach(setup)

  it('HEADLINE: two different deadlines of the same kind on one case', () => {
    // §9 says fresh evidence wins and the old record is superseded, not deleted.
    // When nothing recorded WHICH superseded which, there is no answer to give —
    // so a human gets asked instead of the system picking one.
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'z', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE zst_cases SET due_at = ? WHERE case_id='z1'`).run(T0 + 10 * DAY)
    // One case, one CASE_DUE — no conflict yet.
    expect(detectAnomalies(db, 'zst', T0).filter(a => a.kind === 'CONFLICTING_DEADLINES')).toHaveLength(0)

    // Two contracts on the same case, each with its own termination date: two
    // versions of ONE fact, and nothing says which superseded which.
    db.prepare(
      `INSERT INTO zst_contracts (contract_id, case_id, title, termination_deadline, created_at, updated_at)
       VALUES ('k1','z1','A','2026-09-01',?,?)`,
    ).run(T0 - DAY, T0 - DAY)
    db.prepare(
      `INSERT INTO zst_contracts (contract_id, case_id, title, termination_deadline, created_at, updated_at)
       VALUES ('k2','z1','B','2026-10-01',?,?)`,
    ).run(T0 - DAY, T0 - DAY)
    const conflicts = detectAnomalies(db, 'zst', T0).filter(a => a.kind === 'CONFLICTING_DEADLINES')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].evidence).toHaveLength(2)
  })

  it('identical deadlines from two sources are not a conflict', () => {
    // Two records saying the same thing is corroboration, not contradiction.
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'z', caseType: 'ADMIN' }, T0 - DAY)
    for (const id of ['k1', 'k2']) {
      db.prepare(
        `INSERT INTO zst_contracts (contract_id, case_id, title, termination_deadline, created_at, updated_at)
         VALUES (?, 'z1','A','2026-09-01',?,?)`,
      ).run(id, T0 - DAY, T0 - DAY)
    }
    expect(detectAnomalies(db, 'zst', T0).filter(a => a.kind === 'CONFLICTING_DEADLINES')).toHaveLength(0)
  })

  it('HEADLINE: a READY case with an already-passed deadline contradicts itself', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', due_at=? WHERE case_id='c1'`).run(T0 - 5 * DAY)
    const a = detectAnomalies(db, 'personal', T0)
    expect(a.map(x => x.kind)).toContain('STATUS_CONTRADICTS_DEADLINE')
    expect(a[0].evidence).toHaveLength(2)
  })

  it('a future deadline on a READY case is not an anomaly', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', due_at=? WHERE case_id='c1'`).run(T0 + 5 * DAY)
    expect(detectAnomalies(db, 'personal', T0)).toHaveLength(0)
  })

  it('HEADLINE: the anomaly becomes a SIGNAL, never an alert', () => {
    // §13 is explicit: "anomaly → signal → qualification → existing Case update,
    // not an automatic alert". So it goes through the same policy as everything
    // else, and the policy is what decides whether it deserves attention.
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', due_at=? WHERE case_id='c1'`).run(T0 - 5 * DAY)
    const draft = anomalySignal(detectAnomalies(db, 'personal', T0)[0])
    expect(signalRefusal(draft)).toBeNull()
    const rec = recordSignal(db, draft, T0)
    expect(rec.outcome).toBe('RECORDED')
    if (rec.outcome !== 'RECORDED') return
    // ...and it is the qualification, not the detector, that decides.
    const q = qualifySignal(rec.signal, T0)
    expect(['PROMOTE', 'ANNOTATE', 'SUPPRESS']).toContain(q.decision)
  })

  it('detection is certain even where significance is not', () => {
    // A contradiction between two stored facts is not a guess: high confidence,
    // moderate materiality. We are sure of what we saw, not of what it means.
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'c', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', due_at=? WHERE case_id='c1'`).run(T0 - 5 * DAY)
    const s = anomalySignal(detectAnomalies(db, 'personal', T0)[0])
    expect(s.confidence).toBeGreaterThan(0.8)
    expect(s.estimatedMateriality).toBe('MEDIUM')
  })

  it('HEADLINE: unsupported anomaly kinds are NAMED, not silently absent', () => {
    // §22: "any capability gap is reported as a capability gap rather than a
    // false zero/green metric". An empty anomaly list from a detector that only
    // implements three of six kinds is a false zero.
    expect(unsupportedAnomalyKinds.length).toBeGreaterThanOrEqual(3)
    for (const u of unsupportedAnomalyKinds) expect(u.needs.length).toBeGreaterThan(15)
  })

  it('an empty store produces nothing, and does not throw', () => {
    expect(detectAnomalies(getDb(), 'personal', T0)).toEqual([])
    expect(detectStalls(getDb(), 'zst', T0)).toEqual([])
  })
})
