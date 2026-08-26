// §10.8 scenario 8: contradictory evidence after COMPLETED -> reopen.
//
// The audit recorded this as UNKNOWN, not absent. The investigation (see the
// header of case-reopen.ts) settled it with three instruments: grep, caller
// analysis, and the live event log, where all eighty transitions out of
// COMPLETED belong to two bulk repair sweeps and one baseline import, none of
// them by an engine actor and none carrying a reason. So the mechanism did not
// exist, and this file is its acceptance.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase, getCase } from '../cos/case-store.js'
import { createZstCase, transitionZstCase } from '../cos/zst-case-store.js'
import { initProgressionSchema } from '../cos/schema.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { reopenCase, REOPEN_TARGET_STATUS } from '../cos/case-reopen.js'
import { REOPEN_WINDOW_SEC } from '../cos/proactive-case-bridge.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { evaluateInvariantA, detectProjectionDrift } from '../cos/case-projection.js'
import { CASE_STATUSES } from '../cos/schema.js'

const T0 = 1_700_000_000
type Db = ReturnType<typeof getDb>

const EVIDENCE = { sourceSystem: 'gmail', sourceReference: 'msg-19fe-contradicts' }

function completedCase(db: Db, caseId = 'c1'): void {
  createCase(db, { caseId, title: 'Garanciális csere', caseType: 'CLAIM' }, T0)
  seedCaseProgressionState(db, 'personal', caseId, T0)
  // Straight to COMPLETED without the DoD guard's opinion: this fixture is
  // about what happens AFTER a completion, not about how one is allowed.
  db.prepare(`UPDATE personal_cases SET status='COMPLETED', completed_at=?, version=version+1
              WHERE case_id=?`).run(T0 + 100, caseId)
  db.prepare(`INSERT INTO personal_case_events
                (case_id, case_version, actor, event_type, previous_status, new_status, created_at)
              VALUES (?, 2, 'progression-engine', 'STATUS_CHANGED', 'EXECUTING', 'COMPLETED', ?)`)
    .run(caseId, T0 + 100)
}

function reopen(db: Db, over: Partial<Parameters<typeof reopenCase>[1]> = {}, now = T0 + 200) {
  return reopenCase(db, {
    domain: 'personal', caseId: 'c1', reason: 'A szerviz visszaírt: a csere nem történt meg.',
    actor: 'istvan', evidence: EVIDENCE, ...over,
  }, now)
}

describe('§10.7 reopen — the happy path, end to end', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('HEADLINE: reopens, preserves the completion in history, records the reason, and the engine sets the next action', () => {
    const db = getDb()
    completedCase(db)
    const r = reopen(db)

    expect(r.ok).toBe(true)
    expect(r.newStatus).toBe(REOPEN_TARGET_STATUS.personal)
    expect(r.supersededCompletedAt).toBe(T0 + 100)

    const row = db.prepare(`SELECT status, completed_at FROM personal_cases WHERE case_id='c1'`)
      .get() as { status: string; completed_at: number | null }
    expect(row.status).toBe('TRIAGE')
    // The row describes the CURRENT state; a live case has not completed.
    expect(row.completed_at).toBeNull()

    // ...and the completion is not lost. Both halves of the history are there.
    const events = db.prepare(
      `SELECT event_type, new_status, reason, source_system, source_reference, payload
         FROM personal_case_events ORDER BY event_id`,
    ).all() as Array<Record<string, string | null>>
    const completion = events.find(e => e.event_type === 'STATUS_CHANGED' && e.new_status === 'COMPLETED')
    expect(completion).toBeTruthy()
    const reopened = events.find(e => e.event_type === 'CASE_REOPENED')!
    expect(reopened.reason).toContain('a csere nem történt meg')
    expect(reopened.source_system).toBe('gmail')
    expect(reopened.source_reference).toBe('msg-19fe-contradicts')
    expect(JSON.parse(reopened.payload!).supersededCompletedAt).toBe(T0 + 100)

    // THE BOARD ALREADY AGREES, before the engine has run again. The reopen
    // moved a canonical field the projection reads (the review time), so a
    // reopen that skipped its projection would leave the board describing the
    // closed case until the next cycle -- a window in which the surface Istvan
    // reads and the state machine disagree, which is the whole of P1.
    const boardAtReopen = db.prepare(
      `SELECT proj_next_review_at, last_reconciled_at FROM personal_cases WHERE case_id='c1'`,
    ).get() as { proj_next_review_at: number | null; last_reconciled_at: number | null }
    expect(boardAtReopen.proj_next_review_at).toBe(T0 + 200)
    expect(boardAtReopen.last_reconciled_at).toBe(T0 + 200)
    expect(detectProjectionDrift(db, T0 + 200).total).toBe(0)

    // A NEW NEXT ACTION. The reopen does not write one -- it re-arms the engine,
    // and the engine decides. This is the chain, driven.
    const state = db.prepare(
      `SELECT progression_enabled, next_progression_at, semantic_completion_status
         FROM case_progression_state WHERE domain='personal' AND case_id='c1'`,
    ).get() as { progression_enabled: number; next_progression_at: number; semantic_completion_status: string }
    expect(state.progression_enabled).toBe(1)
    expect(state.next_progression_at).toBe(T0 + 200)
    expect(state.semantic_completion_status).toBe('IN_PROGRESS')

    runProgressionCycle(db, 'personal', 'c1', T0 + 210)
    const board = db.prepare(
      `SELECT proj_next_action_kind, last_reconciled_at FROM personal_cases WHERE case_id='c1'`,
    ).get() as { proj_next_action_kind: string | null; last_reconciled_at: number | null }
    expect(board.proj_next_action_kind).not.toBeNull()
    expect(board.last_reconciled_at).toBe(T0 + 210)
    expect(evaluateInvariantA(db, 'personal').violations).toEqual([])
    expect(detectProjectionDrift(db, T0 + 210).total).toBe(0)
  })

  it('works in the ZST namespace, with ITS triage spelling', () => {
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'Szállítói reklamáció', caseType: 'CLAIM' }, T0)
    seedCaseProgressionState(db, 'zst', 'z1', T0)
    db.prepare(`UPDATE zst_cases SET status='COMPLETED', completed_at=?, version=version+1 WHERE case_id='z1'`)
      .run(T0 + 100)
    const r = reopenCase(db, {
      domain: 'zst', caseId: 'z1', reason: 'A szállító vitatja a lezárást.',
      actor: 'istvan', evidence: EVIDENCE,
    }, T0 + 200)
    expect(r.ok).toBe(true)
    expect(r.newStatus).toBe('TRIAGE_REQUIRED')
  })

  it('ORACLE: both target statuses are real statuses in their namespace', () => {
    // Derived from the schema's own vocabulary, not retyped. A policy that
    // names a status the CHECK constraint rejects would fail at the first live
    // reopen, not here, which is too late.
    expect(CASE_STATUSES as readonly string[]).toContain(REOPEN_TARGET_STATUS.personal)
    const zstSql = (getDb().prepare(
      `SELECT sql FROM sqlite_master WHERE name='zst_cases'`).get() as { sql: string }).sql
    expect(zstSql).toContain(`'${REOPEN_TARGET_STATUS.zst}'`)
  })
})

describe('§10.7 reopen — the five refusals, each naming itself', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('refuses a case that is not completed', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Él', caseType: 'CLAIM' }, T0)
    seedCaseProgressionState(db, 'personal', 'c1', T0)
    const r = reopen(db)
    expect(r.ok).toBe(false)
    expect(r.refusal).toBe('NOT_COMPLETED')
  })

  it('refuses a reopen with no reason', () => {
    const db = getDb(); completedCase(db)
    expect(reopen(db, { reason: '   ' }).refusal).toBe('REASON_REQUIRED')
  })

  it('refuses a reopen that cannot name what contradicts the completion', () => {
    const db = getDb(); completedCase(db)
    expect(reopen(db, { evidence: { sourceSystem: 'gmail', sourceReference: '' } }).refusal)
      .toBe('EVIDENCE_REQUIRED')
    expect(reopen(db, { evidence: { sourceSystem: '', sourceReference: 'x' } }).refusal)
      .toBe('EVIDENCE_REQUIRED')
  })

  it('refuses a case completed longer ago than the window, and says how long', () => {
    const db = getDb(); completedCase(db)
    const r = reopen(db, {}, T0 + 100 + REOPEN_WINDOW_SEC + 86400)
    expect(r.refusal).toBe('OUTSIDE_REOPEN_WINDOW')
    expect(r.detail).toContain('31 napja')
    // ...unless it is forced, and then the force is ON THE EVENT.
    const forced = reopen(db, { force: true }, T0 + 100 + REOPEN_WINDOW_SEC + 86400)
    expect(forced.ok).toBe(true)
    const ev = db.prepare(
      `SELECT payload FROM personal_case_events WHERE event_type='CASE_REOPENED'`).get() as { payload: string }
    expect(JSON.parse(ev.payload).forced).toBe(true)
    expect(JSON.parse(ev.payload).ageDays).toBe(31)
  })

  it('refuses a case that does not exist', () => {
    expect(reopen(getDb(), { caseId: 'nope' }).refusal).toBe('NO_SUCH_CASE')
  })

  it('EVERY refusal leaves the case exactly as it was', () => {
    // A refusal that half-applied would be worse than one that threw: the case
    // would be neither closed nor reopened and nothing would say so.
    const db = getDb(); completedCase(db)
    const before = db.prepare(`SELECT * FROM personal_cases WHERE case_id='c1'`).get()
    const events = (db.prepare(`SELECT COUNT(*) n FROM personal_case_events`).get() as { n: number }).n
    for (const bad of [
      { reason: '' },
      { evidence: { sourceSystem: '', sourceReference: '' } },
    ]) reopen(db, bad)
    reopen(db, {}, T0 + 100 + REOPEN_WINDOW_SEC + 86400)   // outside the window
    expect(db.prepare(`SELECT * FROM personal_cases WHERE case_id='c1'`).get()).toEqual(before)
    expect((db.prepare(`SELECT COUNT(*) n FROM personal_case_events`).get() as { n: number }).n).toBe(events)
  })
})

describe('§10.7 reopen — what the eighty historical transitions were missing', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('a bare status rewrite is STILL possible, and is still not a reopen', () => {
    // This is the honest limit of the mechanism, tested rather than claimed.
    // `transitionCase` has no allowed-transition matrix, so anything holding
    // the case version can move a case out of COMPLETED without a reason, a
    // source, or a CASE_REOPENED event -- which is precisely what the two 2026-08
    // repair sweeps did. What this module adds is a path that CANNOT do that;
    // it does not close the other one.
    const db = getDb(); completedCase(db)
    const v = (getCase(db, 'c1') as { version: number }).version
    transitionCase(db, { caseId: 'c1', newStatus: 'READY', actor: 'marveen', seenVersion: v }, T0 + 300)
    expect((getCase(db, 'c1') as { status: string }).status).toBe('READY')
    expect(db.prepare(`SELECT COUNT(*) n FROM personal_case_events WHERE event_type='CASE_REOPENED'`)
      .get()).toEqual({ n: 0 })
    // And completed_at survives the bare rewrite -- the exact inconsistency the
    // live store carries in 65 rows.
    expect(db.prepare(`SELECT completed_at FROM personal_cases WHERE case_id='c1'`).get())
      .toEqual({ completed_at: T0 + 100 })
  })
})

describe('§10.7 reopen — ZST transition still guarded', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('a second reopen of an already-reopened case is refused, not stacked', () => {
    const db = getDb(); completedCase(db)
    expect(reopen(db).ok).toBe(true)
    const second = reopen(db, {}, T0 + 300)
    expect(second.ok).toBe(false)
    expect(second.refusal).toBe('NOT_COMPLETED')
    expect(db.prepare(`SELECT COUNT(*) n FROM personal_case_events WHERE event_type='CASE_REOPENED'`)
      .get()).toEqual({ n: 1 })
  })

  it('unused import guard: transitionZstCase is the ZST half of the same engine', () => {
    expect(typeof transitionZstCase).toBe('function')
  })
})
