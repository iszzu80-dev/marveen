import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, outstandingOwnerQuestions, STALE_READING_GRACE_SEC } from '../cos/owner-question.js'

// Live 2026-08-11: I read a contract case's email body and wrote its real
// content onto the case at 16:51. Minutes later the sweep asked Istvan the
// ORIGINAL question -- "the intake contains no contract information" -- because
// the question is composed from the stored packet, and that packet was from
// 08:40. Eight hours of new facts, invisible to the sentence he would read.

const NOW = 1_700_000_000

function seed(caseId: string, packetAt: number, caseUpdatedAt: number) {
  createCase(getDb(), { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, NOW)
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, NOW, NOW)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'régi tény', source: 'e' }],
    missingRequirements: [{ what: 'a szerződés tartalma', whoHasIt: 'ISTVAN', why: null }],
    uncertainty: [], confidence: 0.5,
  }
  getDb().prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet),
        JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: 'a szerződés tartalma', blockedBy: 'ISTVAN' }] }), packetAt)
  getDb().prepare(`UPDATE personal_cases SET updated_at=? WHERE case_id=?`).run(caseUpdatedAt, caseId)
}

describe('a reading older than the case is not a reading of this case', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('does not ask from a packet that predates the case update', () => {
    seed('c-stale', NOW, NOW + 8 * 3600)           // 8 óra új tény a packet után
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 9 * 3600 })
    expect(r.staleReading).toBe(1)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(0)
  })

  it('DOES ask from a fresh packet — this must not silence the channel', () => {
    // The counter-check. A guard that suppresses everything is not a guard.
    seed('c-fresh', NOW + 8 * 3600, NOW)
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 9 * 3600 })
    expect(r.staleReading).toBe(0)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(1)
  })

  it('tolerates same-cycle ordering jitter within the grace window', () => {
    // Measured live: intake, reading and the case update landed 22 seconds apart
    // in arbitrary order. A strict comparison would call that staleness.
    seed('c-jitter', NOW, NOW + STALE_READING_GRACE_SEC - 1)
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 3600 })
    expect(r.staleReading).toBe(0)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(1)
  })
})

// ── The owner's own words do not get a grace window ───────────────────────
//
// MEASURED 2026-08-16. Istvan answered the OneDrive question at 00:44:15
// ("Én voltam, rendben volt"). At 00:44:52 -- 37 seconds later, well inside the
// 120s window -- the sweep asked him about the same case from a pre-answer
// packet, and what it asked was whether his earlier YES was ambiguous. The
// exact thing he had just cleared up.
//
// The jitter test above is the reason the window exists; these are the reason
// it must not cover him.

function ownerAnswer(caseId: string, at: number, eventType = 'OWNER_INFORMATION') {
  getDb().prepare(
    `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, reason, created_at)
     VALUES (?, 1, 'istvan', ?, 'Én voltam, rendben volt', ?)`,
  ).run(caseId, eventType, at)
}

describe('an owner answer invalidates the reading with NO grace window', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('does not re-ask from a packet taken before he answered, even 1 second before', () => {
    seed('c-answered', NOW, NOW)
    ownerAnswer('c-answered', NOW + 1)              // deep inside the grace window
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 37 })
    expect(r.staleReading).toBe(1)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(0)
  })

  it('the live timings, to the second', () => {
    // packet 00:44:00, answer 00:44:15, sweep 00:44:52.
    seed('c-onedrive', NOW, NOW)
    ownerAnswer('c-onedrive', NOW + 15)
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 52 })
    expect(r.staleReading).toBe(1)
  })

  it('all three owner event types count', () => {
    for (const [i, t] of ['OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION'].entries()) {
      initDatabase(':memory:')
      seed(`c-${i}`, NOW, NOW)
      ownerAnswer(`c-${i}`, NOW + 1, t)
      expect(askPendingOwnerQuestions(getDb(), { now: NOW + 37 }).staleReading).toBe(1)
    }
  })

  it('POSITIVE CONTROL: an answer taken BEFORE the reading does not suppress', () => {
    // Otherwise every case he has ever answered goes permanently silent -- a
    // far worse failure than the one being fixed.
    seed('c-old-answer', NOW + 100, NOW)
    ownerAnswer('c-old-answer', NOW + 50)           // he spoke, then we re-read
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 200 })
    expect(r.staleReading).toBe(0)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(1)
  })

  it('POSITIVE CONTROL: a machine event inside the window still passes', () => {
    // The jitter tolerance must survive. Only HIS events skip the grace.
    seed('c-machine', NOW, NOW)
    getDb().prepare(
      `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, reason, created_at)
       VALUES (?, 1, 'progression-engine', 'STATUS_CHANGED', 'gépi', ?)`,
    ).run('c-machine', NOW + 1)
    const r = askPendingOwnerQuestions(getDb(), { now: NOW + 37 })
    expect(r.staleReading).toBe(0)
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(1)
  })
})
