import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, MAX_OUTSTANDING_QUESTIONS } from '../cos/owner-question.js'
import { planFromEvidence } from '../cos/evidence-planner.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'

// E2 — WHICH question gets the scarce slot.
//
// Measured on the live store, 2026-08-31: five open questions occupying the
// whole ceiling (a Cloudflare plan choice, a forwarded magnetic mount, a NAV
// notice from 07-10, a missing run log, a LinkedIn trial), seventeen more
// cases held behind them, and the Teraszszigetelés decision at 48+ engine
// wake-ups without ever having been asked. Nothing was broken; nothing was
// ordered either. The slot went to whoever the sweep reached first.
//
// An approval-driven phase whose approvals queue behind "which Waterpik" is a
// queue, not a capability. These tests are that sentence, executable.

const T0 = 1_700_000_000

function packet(caseId: string): ReaderEvidencePacket {
  return {
    caseId, domain: 'personal', readSources: [caseId], unreadableSources: [],
    facts: [{ statement: 'Tény.', sourceRef: caseId }],
    missingRequirements: [{ what: 'A döntés', whoHasIt: 'ISTVAN', why: 'ehhez kell' }],
    ballHolder: 'ISTVAN', candidateDecision: 'REQUEST_DECISION', confidence: 0.7,
    uncertainty: [],
  }
}

/** A candidate case with a fresh evidence packet, i.e. something to ask about. */
function candidate(caseId: string, opts: { status?: string; packetAt?: number } = {}): void {
  const db = getDb()
  // The case and its packet share a timestamp: a packet older than the case it
  // describes is STALE and is skipped before any ordering happens, so an
  // "old packet" fixture would prove nothing about the order.
  const at = opts.packetAt ?? T0
  createCase(db, { caseId, title: caseId, caseType: 'ADMIN', status: opts.status }, at)
  const p = packet(caseId)
  db.prepare(
    `INSERT INTO case_evidence_packets
       (packet_id, domain, case_id, created_at, packet_json, plan_json, confidence, policy_result)
     VALUES (?, 'personal', ?, ?, ?, ?, ?, 'WAIT_EXTERNAL')`,
  ).run(`pk-${caseId}`, caseId, at, JSON.stringify(p), JSON.stringify(planFromEvidence(p)), p.confidence)
}

/** An UNDECIDED action-approval request on a case: the authorization gate. */
function openApproval(caseId: string): void {
  getDb().prepare(
    `INSERT INTO cos_action_approval_requests
       (request_id, domain, case_id, case_version, goal_version, plan_step, action_id, action_type,
        description, target_reference, recipient, payload_hash, risk_classes_json, question_hash,
        progression_run_id, requested_at, expires_at, decided_at, decision, authorization_id, refusal)
     VALUES (?, 'personal', ?, 1, 1, 1, 'a1', 'EMAIL_SEND', 'd', 't', 'r', 'ph', '[]', ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(`req-${caseId}`, caseId, `qh-${caseId}`, T0, T0 + 86_400)
}

/** Fill the ceiling with unrelated open questions, so exactly one slot is free. */
function fillChannel(freeSlots: number): void {
  const db = getDb()
  for (let i = 0; i < MAX_OUTSTANDING_QUESTIONS - freeSlots; i++) {
    createCase(db, { caseId: `FILL${i}`, title: `FILL${i}`, caseType: 'ADMIN' }, T0)
    db.prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at, channel)
       VALUES (?, 'personal', ?, ?, ?, 'telegram:cos')`,
    ).run(`FILL${i}`, `hf-${i}`, `❓ tolelek ${i}`, T0)
  }
}

const askedCases = (): string[] => (getDb().prepare(
  `SELECT case_id FROM cos_owner_questions WHERE asked_at >= ? AND question_hash NOT LIKE 'hf-%'`,
).all(T0 + 1) as Array<{ case_id: string }>).map(r => r.case_id)

describe('E2: the scarce slot goes to the class that cannot wait', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('HEADLINE: an authorization gate outranks an ordinary reader question', () => {
    // One free slot, one of each class, and the NORMAL one is older -- so under
    // the previous order (deadline bucket, priority, age) it wins.
    fillChannel(1)
    candidate('NORMAL-OLD', { packetAt: T0 - 10_000 })
    candidate('APPROVAL-NEW', { packetAt: T0 })
    openApproval('APPROVAL-NEW')

    const r = askPendingOwnerQuestions(getDb(), { now: T0 + 1, limit: 1 })
    expect(r.asked).toBe(1)
    expect(askedCases()).toEqual(['APPROVAL-NEW'])
    expect(r.priorityOrdered).toBe(true)
  })

  it('a parked decision outranks a reader question, and loses to an approval', () => {
    fillChannel(1)
    candidate('NORMAL-1')
    candidate('BLOCKING-1', { status: 'AWAITING_SELECTION' })

    expect(askPendingOwnerQuestions(getDb(), { now: T0 + 1, limit: 1 }).asked).toBe(1)
    expect(askedCases()).toEqual(['BLOCKING-1'])
  })

  it('what does not fit is HELD and NAMED by class, not just counted', () => {
    fillChannel(0)                       // no room at all
    candidate('NORMAL-2')
    candidate('BLOCKING-2', { status: 'AWAITING_SELECTION' })
    candidate('APPROVAL-2')
    openApproval('APPROVAL-2')

    const r = askPendingOwnerQuestions(getDb(), { now: T0 + 1, limit: 5 })
    expect(r.asked).toBe(0)
    expect(r.heldBacklogFull).toBe(3)
    // The counter alone cannot tell "three trivia questions are waiting" from
    // "an authorization gate is waiting", and those need opposite responses.
    expect(r.heldByClass.SAFETY_APPROVAL).toBe(1)
    expect(r.heldByClass.BLOCKING_DECISION).toBe(1)
    expect(r.heldByClass.NORMAL).toBe(1)
    // And the held list leads with the class that cannot wait.
    expect(r.heldTop[0]?.cls).toBe('SAFETY_APPROVAL')
  })

  it('no starvation: within a class the oldest ask keeps climbing', () => {
    fillChannel(1)
    candidate('NORMAL-YOUNG', { packetAt: T0 })
    candidate('NORMAL-STARVED', { packetAt: T0 - 500_000 })

    expect(askPendingOwnerQuestions(getDb(), { now: T0 + 1, limit: 1 }).asked).toBe(1)
    expect(askedCases()).toEqual(['NORMAL-STARVED'])
  })

  it('ordering NEVER raises the ceiling: a full channel still asks nothing', () => {
    fillChannel(0)
    candidate('APPROVAL-3')
    openApproval('APPROVAL-3')

    const r = askPendingOwnerQuestions(getDb(), { now: T0 + 1, limit: 5 })
    // The class decides WHO gets a slot, never HOW MANY there are. An exemption
    // would have been the easy fix and the wrong one: past a handful, one more
    // question does not get answered faster, it gets the channel muted.
    expect(r.asked).toBe(0)
    expect(askedCases()).toEqual([])
  })
})
