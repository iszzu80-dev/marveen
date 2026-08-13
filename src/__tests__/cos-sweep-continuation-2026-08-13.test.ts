// §11 C-invariant: a bounded sweep must say the bound was reached.
//
// The audit of 2026-08-13 found one single place in the whole of src/cos that
// reported its own truncation (`followup-autodraft`'s `scan_window_exhausted`).
// Everywhere else a LIMIT silently decided what the system would not look at,
// and the report that followed was indistinguishable from a complete pass.
//
// That is not a reporting nicety. Both sweeps here take from the FRONT of a
// stable order, so if the queue is longer than the bound, the same head is
// processed every cycle and the tail is never reached — not "later", never. The
// only signal that this is happening is a number saying how much was left, and
// until now there was none.
//
// Each test drives the queue past the bound and asserts the count. A sweep that
// cannot be made to report a backlog cannot be trusted when it reports none.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { findDuePage, findDueCases } from '../cos/progression-scheduler.js'
import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'
import { askPendingOwnerQuestions, QUESTION_SCAN_WINDOW } from '../cos/owner-question.js'
import { planFromEvidence } from '../cos/evidence-planner.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'

const T0 = 1_700_000_000

describe('the progression sweep reports what its bound left behind', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  /** A case that is due for progression right now. */
  function dueCase(caseId: string): void {
    const db = getDb()
    createCase(db, { caseId, title: caseId, caseType: 'ADMIN' }, T0)
    db.prepare(
      `INSERT INTO case_progression_state
         (domain, case_id, progression_enabled, progression_mode, next_progression_at, created_at, updated_at)
       VALUES ('personal', ?, 1, 'internal', ?, ?, ?)`,
    ).run(caseId, T0 - 10, T0, T0)
  }

  it('HEADLINE: a full page says how many due cases it did not take', () => {
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) dueCase(id)
    const page = findDuePage(getDb(), 'personal', T0, 2)
    expect(page.cases).toHaveLength(2)
    expect(page.totalDue).toBe(5)
    expect(page.remaining).toBe(3)
    expect(page.hasMore).toBe(true)
  })

  it('a page that reached the end says so, even when it is exactly full', () => {
    // The ambiguous case, and the reason `remaining` is counted rather than
    // inferred from `cases.length === limit`: two due cases with a bound of two
    // is a COMPLETE sweep, and guessing here would report a backlog of unknown
    // size on a perfectly healthy system.
    for (const id of ['c1', 'c2']) dueCase(id)
    const page = findDuePage(getDb(), 'personal', T0, 2)
    expect(page.cases).toHaveLength(2)
    expect(page.hasMore).toBe(false)
    expect(page.remaining).toBe(0)
  })

  it('an empty domain is not a truncated one', () => {
    const page = findDuePage(getDb(), 'zst', T0, 50)
    expect(page.totalDue).toBe(0)
    expect(page.hasMore).toBe(false)
  })

  it('findDueCases keeps returning the page itself, so no caller had to change', () => {
    for (const id of ['c1', 'c2', 'c3']) dueCase(id)
    expect(findDueCases(getDb(), 'personal', T0, 2).map(c => c.case_id))
      .toEqual(findDuePage(getDb(), 'personal', T0, 2).cases.map(c => c.case_id))
  })

  it('the heartbeat carries the number out per domain', () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) dueCase(id)
    const r = runProgressionHeartbeat(getDb(), T0, 1)
    expect(r.remainingDue.personal).toBe(3)
    expect(r.remainingDue.zst).toBe(0)
    expect(r.truncated).toBe(true)
  })

  it('the heartbeat reports zero when it drained the queue', () => {
    dueCase('c1')
    const r = runProgressionHeartbeat(getDb(), T0, 50)
    expect(r.remainingDue).toEqual({ personal: 0, zst: 0 })
    expect(r.truncated).toBe(false)
  })
})

describe('the owner-question sweep reports its unexamined tail', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  function candidate(caseId: string): void {
    const db = getDb()
    createCase(db, { caseId, title: caseId, caseType: 'ADMIN' }, T0)
    const p: ReaderEvidencePacket = {
      caseId, domain: 'personal',
      readSources: [caseId], unreadableSources: [],
      facts: [{ statement: 'Az ugyved valaszolt.', sourceRef: caseId }],
      missingRequirements: [{ what: 'A vetelar', whoHasIt: 'ISTVAN', why: 'a szerzodeshez kell' }],
      ballHolder: 'ISTVAN', candidateDecision: 'REQUEST_DECISION', confidence: 0.7,
      uncertainty: [],
    }
    db.prepare(
      `INSERT INTO case_evidence_packets
         (packet_id, domain, case_id, created_at, packet_json, plan_json, confidence, policy_result)
       VALUES (?, 'personal', ?, ?, ?, ?, ?, 'WAIT_EXTERNAL')`,
    ).run(`pk-${caseId}`, caseId, T0, JSON.stringify(p), JSON.stringify(planFromEvidence(p)), p.confidence)
  }

  it('HEADLINE: cases past the scan window are counted, not dropped in silence', () => {
    for (let i = 0; i < QUESTION_SCAN_WINDOW + 3; i++) candidate(`c${String(i).padStart(3, '0')}`)
    const r = askPendingOwnerQuestions(getDb(), { limit: 1, now: T0 + 1, maxOutstanding: 10 })
    expect(r.windowExhausted).toBe(3)
  })

  it('a queue inside the window reports nothing left over', () => {
    for (let i = 0; i < 3; i++) candidate(`c${i}`)
    const r = askPendingOwnerQuestions(getDb(), { limit: 1, now: T0 + 1, maxOutstanding: 10 })
    expect(r.windowExhausted).toBe(0)
  })

  it('the count describes the CANDIDATE set, not every packet in the store', () => {
    // A completed case is excluded from the candidates, so it must not inflate
    // the leftover count either — the number and the list have to be about the
    // same population, which is why both read the same clause.
    for (let i = 0; i < 3; i++) candidate(`c${i}`)
    getDb().prepare(`UPDATE personal_cases SET status = 'COMPLETED' WHERE case_id IN ('c1','c2')`).run()
    const r = askPendingOwnerQuestions(getDb(), { limit: 10, now: T0 + 1, maxOutstanding: 10 })
    expect(r.windowExhausted).toBe(0)
    expect(r.asked).toBe(1)
  })
})
