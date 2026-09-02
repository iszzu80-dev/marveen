import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, outstandingOwnerQuestions } from '../cos/owner-question.js'
import {
  markQuestionStaleBlocked, clearStaleBlock, staleBlockedCases,
  exhaustedStaleQuestions, MAX_STALE_RETRIES,
} from '../cos/stale-question-regeneration.js'
import { casesNeedingReading } from '../cos/reader-cycle.js'

// STALE-EVIDENCE REGENERATION — the owner's acceptance list, 2026-09-02.
//
// The second freeze. The channel recovery freed five slots and the reader asked
// the held questions; none of the three oldest blocking decisions reached the
// owner, because the delivery gate refused them as stale — their packets were 8
// to 22 days old and the cases had moved. The refusal was right. What was
// missing was what happens next: nothing gave a stale-blocked case a reason to
// be re-read, so the question sat undeliverable and kept a seat.

const NOW = 1_700_000_000
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

function seedQuestion(caseId: string, ask = 'Melyik ajanlat?', at = NOW): string {
  const db = getDb()
  createCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, at)
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, at, at)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'teny', source: 'e' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }], uncertainty: [], confidence: 0.7,
  }
  db.prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet),
        JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }), at)
  askPendingOwnerQuestions(db, { now: at, channel: { channel: CHANNEL, target: CHAT } })
  return (db.prepare(
    `SELECT question_hash h FROM cos_owner_questions WHERE case_id = ?`).get(caseId) as { h: string }).h
}

describe('stale-evidence regeneration', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a stale-blocked question stops holding a capacity slot', () => {
    const db = getDb()
    const h = seedQuestion('C-1')
    expect(outstandingOwnerQuestions(db).length).toBe(1)

    markQuestionStaleBlocked(db, {
      caseId: 'C-1', questionHash: h,
      error: 'STALE_EVIDENCE: new case event after evidence watermark: 423 -> 517',
    })

    // Still open, still answerable, still visible — but no longer blocking the
    // channel, which is the whole point.
    expect(outstandingOwnerQuestions(db).length).toBe(0)
    const row = db.prepare(
      `SELECT answered_at, superseded_at, stale_blocked_at, stale_retry_count n
         FROM cos_owner_questions WHERE case_id='C-1'`).get() as
      { answered_at: number | null; superseded_at: number | null; stale_blocked_at: number | null; n: number }
    expect(row.answered_at).toBeNull()
    expect(row.superseded_at).toBeNull()
    expect(row.stale_blocked_at).not.toBeNull()
    expect(row.n).toBe(1)
  })

  it('the reader is given a reason to re-read the case — which nothing did before', () => {
    const db = getDb()
    const h = seedQuestion('C-1')
    // No newer progression run, so the ordinary rule yields nothing for it.
    expect(casesNeedingReading(db, 10).some(c => c.caseId === 'C-1')).toBe(false)

    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })

    const cands = casesNeedingReading(db, 10)
    expect(cands.some(c => c.caseId === 'C-1')).toBe(true)
    expect(cands[0].policyDecision).toBe('STALE_REGENERATION')  // ahead of the ordinary ones
  })

  it('regeneration keeps the SAME identity: same hash, same token, same row', () => {
    const db = getDb()
    const h = seedQuestion('C-1')
    const tokenBefore = (db.prepare(`SELECT token t FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { t: string }).t
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })

    // A fresh reading of the same unchanged ask, from a newer run.
    const packet = {
      ballHolder: 'ISTVAN', facts: [{ statement: 'ujabb teny', source: 'e' }],
      missingRequirements: [{ what: 'Melyik ajanlat?', whoHasIt: 'ISTVAN', why: null }],
      uncertainty: [], confidence: 0.8,
    }
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, progression_run_id, created_at)
       VALUES ('C-1','personal',?,?,'run-2',?)`,
    ).run(JSON.stringify(packet),
          JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: 'Melyik ajanlat?', blockedBy: 'ISTVAN' }] }), NOW + 600)
    db.prepare(
      `INSERT INTO case_progression_runs
         (progression_run_id, domain, case_id, status, trigger_type, started_at, case_version_after)
       VALUES ('run-2','personal','C-1','COMPLETED','MANUAL',?,1)`).run(NOW + 600)

    askPendingOwnerQuestions(db, { now: NOW + 700, channel: { channel: CHANNEL, target: CHAT } })

    const rows = db.prepare(`SELECT question_hash h, token t, stale_blocked_at s, progression_run_id r
                               FROM cos_owner_questions WHERE case_id='C-1'`).all() as
      Array<{ h: string; t: string; s: number | null; r: string | null }>
    expect(rows).toHaveLength(1)          // ONE row, not a second question
    expect(rows[0].h).toBe(h)             // same semantic identity
    expect(rows[0].t).toBe(tokenBefore)   // same token he may already have copied
    expect(rows[0].r).toBe('run-2')       // now points at the fresh run
    expect(rows[0].s).toBeNull()          // block lifted -> deliverable again
    expect(outstandingOwnerQuestions(db).length).toBe(1)  // and it counts again
  })

  it('BOUNDED: after the third stale it stops regenerating and becomes a visible failure', () => {
    // THE BOUND IS ASSERTED AS A NUMBER, NOT AS THE CONSTANT.
    //
    // The first version of this test looped `i < MAX_STALE_RETRIES` and checked
    // the result against MAX_STALE_RETRIES. Raising the constant to 9999
    // therefore left it green -- the detector matched its own parameter, so the
    // one thing it existed to pin was the one thing it could not see. Caught by
    // the mutation run, which is what that run is for.
    expect(MAX_STALE_RETRIES).toBe(3)

    const db = getDb()
    const h = seedQuestion('C-1')
    // Two strikes: still being regenerated.
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    expect(staleBlockedCases(db).some(c => c.caseId === 'C-1')).toBe(true)
    expect(exhaustedStaleQuestions(db)).toHaveLength(0)

    // The third is the bound.
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    // No longer offered for regeneration...
    expect(staleBlockedCases(db).some(c => c.caseId === 'C-1')).toBe(false)
    // ...and LOUD instead of quietly retrying for ever.
    const ex = exhaustedStaleQuestions(db)
    expect(ex.map(e => e.caseId)).toContain('C-1')
    expect(ex[0].retryCount).toBe(3)
  })

  it('a successful delivery lifts the block but does NOT reset the counter', () => {
    const db = getDb()
    const h = seedQuestion('C-1')
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    clearStaleBlock(db, 'C-1', h)

    const row = db.prepare(`SELECT stale_blocked_at s, stale_retry_count n
                              FROM cos_owner_questions WHERE case_id='C-1'`).get() as
      { s: number | null; n: number }
    expect(row.s).toBeNull()   // deliverable again
    expect(row.n).toBe(1)      // a case that alternates must still reach the bound
  })

  it('a stale-blocked question is not superseded — it is still his to answer', () => {
    // The owner was explicit that supersede is for a genuinely changed ask and
    // never for freeing a slot. Freeing the slot here is done by excluding it
    // from the count, not by closing it.
    const db = getDb()
    const h = seedQuestion('C-1')
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    const row = db.prepare(`SELECT superseded_at, answered_at FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { superseded_at: number | null; answered_at: number | null }
    expect(row.superseded_at).toBeNull()
    expect(row.answered_at).toBeNull()
  })

  it('the freed slot is usable: another question can take it while the stale one waits', () => {
    const db = getDb()
    const h = seedQuestion('C-1')
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })
    seedQuestion('C-2', 'Masik kerdes?', NOW + 10)
    // C-2 counts, C-1 does not — the channel is not starved by an undeliverable.
    expect(outstandingOwnerQuestions(db).map(q => q.caseId)).toEqual(['C-2'])
  })
})

describe('regeneration defects found by live readback, 2026-09-02', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a regenerated question carries a REAL progression run id, not null', () => {
    // The first cut passed runId: null for a stale candidate, so the rebuilt
    // question had no progression_run_id and delivery refused it with
    // EVIDENCE_UNKNOWN — the same undeliverability under a different name.
    const db = getDb()
    const h = seedQuestion('C-1')
    db.prepare(
      `INSERT INTO case_progression_runs
         (progression_run_id, domain, case_id, status, trigger_type, started_at, case_version_after)
       VALUES ('run-live','personal','C-1','COMPLETED','MANUAL',?,1)`).run(NOW + 500)
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h, error: 'STALE_EVIDENCE: x' })

    const cand = casesNeedingReading(db, 10).find(c => c.caseId === 'C-1')
    expect(cand?.runId).toBe('run-live')
  })

  it('THE TOKEN SURVIVES A REWORDING: a supersede hands its name to the replacement', () => {
    // Measured live: PRI-DQ-2026-001 went Q39FB -> Q4ABB in one cycle, because
    // the model reworded the ask, which changed the hash, which opened a new
    // row with a new token. A name that changes while he is deciding is worse
    // than no name — he copies it and answers ten minutes later.
    const db = getDb()
    seedQuestion('C-1', 'Melyik ajanlat?')
    const first = (db.prepare(`SELECT token t FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { t: string }).t

    // The same case, re-read, with a DIFFERENTLY WORDED ask -> new hash.
    const packet = {
      ballHolder: 'ISTVAN', facts: [{ statement: 'f', source: 'e' }],
      missingRequirements: [{ what: 'Melyik ajanlatot valasztod a harombol?', whoHasIt: 'ISTVAN', why: null }],
      uncertainty: [], confidence: 0.8,
    }
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, progression_run_id, created_at)
       VALUES ('C-1','personal',?,?,'run-2',?)`,
    ).run(JSON.stringify(packet),
          JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: 'Melyik ajanlatot valasztod a harombol?', blockedBy: 'ISTVAN' }] }),
          NOW + 600)
    db.prepare(
      `INSERT INTO case_progression_runs
         (progression_run_id, domain, case_id, status, trigger_type, started_at, case_version_after)
       VALUES ('run-2','personal','C-1','COMPLETED','MANUAL',?,1)`).run(NOW + 600)

    askPendingOwnerQuestions(db, { now: NOW + 700, channel: { channel: CHANNEL, target: CHAT } })

    const open = db.prepare(
      `SELECT token t, question_hash h FROM cos_owner_questions
        WHERE case_id='C-1' AND answered_at IS NULL AND superseded_at IS NULL`).all() as
      Array<{ t: string; h: string }>
    expect(open).toHaveLength(1)
    expect(open[0].t).toBe(first)          // SAME NAME, new wording

    // And the retired row does not keep the token, so uniqueness holds.
    const retired = db.prepare(
      `SELECT token t FROM cos_owner_questions WHERE case_id='C-1' AND superseded_at IS NOT NULL`)
      .all() as Array<{ t: string | null }>
    expect(retired.every(r => r.t === null)).toBe(true)
  })
})

describe('the bound must survive a rewording', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the retry count is inherited across a regeneration, so the bound is reachable', () => {
    // Measured live: PRI-HOME-2026-004 accumulated FOUR question rows with
    // stale counts 2, 1, 2, 1 and never reached three, because every reworded
    // regeneration opened a new row starting from zero. A bound that resets
    // whenever the model picks different words is not a bound.
    const db = getDb()
    const h1 = seedQuestion('C-1', 'Melyik ajanlat?')
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h1, error: 'STALE_EVIDENCE: x' })
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: h1, error: 'STALE_EVIDENCE: x' })

    // Reworded regeneration -> new hash, new row.
    const packet = {
      ballHolder: 'ISTVAN', facts: [{ statement: 'f', source: 'e' }],
      missingRequirements: [{ what: 'Melyik ajanlatot valasztod vegul?', whoHasIt: 'ISTVAN', why: null }],
      uncertainty: [], confidence: 0.8,
    }
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, progression_run_id, created_at)
       VALUES ('C-1','personal',?,?,'run-2',?)`,
    ).run(JSON.stringify(packet),
          JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: 'Melyik ajanlatot valasztod vegul?', blockedBy: 'ISTVAN' }] }),
          NOW + 600)
    db.prepare(
      `INSERT INTO case_progression_runs
         (progression_run_id, domain, case_id, status, trigger_type, started_at, case_version_after)
       VALUES ('run-2','personal','C-1','COMPLETED','MANUAL',?,1)`).run(NOW + 600)
    askPendingOwnerQuestions(db, { now: NOW + 700, channel: { channel: CHANNEL, target: CHAT } })

    const open = db.prepare(
      `SELECT question_hash h, stale_retry_count n FROM cos_owner_questions
        WHERE case_id='C-1' AND answered_at IS NULL AND superseded_at IS NULL`).get() as
      { h: string; n: number }
    expect(open.h).not.toBe(h1)   // it really is a new row
    expect(open.n).toBe(2)        // and it carries the history

    // One more strike reaches the bound, which the old behaviour could never do.
    markQuestionStaleBlocked(db, { caseId: 'C-1', questionHash: open.h, error: 'STALE_EVIDENCE: x' })
    expect(exhaustedStaleQuestions(db).map(e => e.caseId)).toContain('C-1')
  })
})
