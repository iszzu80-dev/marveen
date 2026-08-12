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
