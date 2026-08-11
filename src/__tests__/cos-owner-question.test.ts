// §10.4 Writer, first slice: the question that actually reaches Istvan.
//
// The chain ended in a table. The Reader named what was missing and who held
// it, the planner turned that into steps, and the sentence never left the
// machine — which is what Istvan asked about on 2026-08-11: "who thinks through
// what the lawyer wrote and what is needed from me, and it was supposed to come
// to me on Telegram."
//
// Two properties carry the weight here, and neither is about wording: it asks
// only when the answer is genuinely HIS, and it does not ask the same thing
// twice.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, listAgentMessages } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { buildOwnerQuestion, askPendingOwnerQuestions } from '../cos/owner-question.js'
import { planFromEvidence } from '../cos/evidence-planner.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'

const T0 = 1_700_000_000

function packet(over: Partial<ReaderEvidencePacket> = {}): ReaderEvidencePacket {
  return {
    caseId: 'c1', domain: 'personal',
    readSources: ['c1'], unreadableSources: [],
    facts: [
      { statement: 'Az ugyved valaszolt a tavolsagi tranzakciorol.', sourceRef: 'c1' },
      { statement: 'A vetelar meg nyitott.', sourceRef: 'c1' },
    ],
    missingRequirements: [
      { what: 'A vetelar megallapodasa', whoHasIt: 'ISTVAN', why: 'az adasveteli szerzodeshez kell' },
    ],
    ballHolder: 'ISTVAN', candidateDecision: 'REQUEST_DECISION', confidence: 0.7,
    uncertainty: ['a kozjegyzoi hitelesites modja nem tisztazott'],
    ...over,
  }
}

function storePacket(caseId: string, p: ReaderEvidencePacket): void {
  const plan = planFromEvidence(p)
  getDb().prepare(
    `INSERT INTO case_evidence_packets
       (packet_id, domain, case_id, created_at, packet_json, plan_json, confidence, policy_result)
     VALUES (?, 'personal', ?, ?, ?, ?, ?, 'WAIT_EXTERNAL')`,
  ).run(`pk-${caseId}-${Math.random()}`, caseId, T0, JSON.stringify(p), JSON.stringify(plan), p.confidence)
}

describe('§10.4 owner question', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'ZST uzletresz-adasvetel', caseType: 'ADMIN' }, T0)
  })

  it('HEADLINE: it asks only what is genuinely HIS to answer', () => {
    const q = buildOwnerQuestion({
      caseId: 'c1', domain: 'personal', title: 'ZST uzletresz-adasvetel',
      packet: packet(), plan: planFromEvidence(packet()),
    })!
    expect(q).toBeTruthy()
    expect(q.text).toContain('Ami Tőled kell')
    expect(q.text).toContain('A vetelar megallapodasa')
    // Context, so the question is answerable without opening the case.
    expect(q.text).toContain('Az ugyved valaszolt')
  })

  it('a case waiting on someone ELSE produces no question', () => {
    // The counter-case, and the one that decides whether this channel stays
    // readable: asking about a case that is waiting on a third party is how a
    // notification channel becomes noise and then gets muted.
    const external = packet({
      ballHolder: 'EXTERNAL', candidateDecision: 'WAIT_EXTERNAL',
      missingRequirements: [{ what: 'Ugyvedi szakvelemeny', whoHasIt: 'EXTERNAL', why: 'a jogi elokesziteshez' }],
    })
    expect(buildOwnerQuestion({
      caseId: 'c1', domain: 'personal', title: 't', packet: external, plan: planFromEvidence(external),
    })).toBeNull()
  })

  it('the SAME ask is not sent twice', () => {
    storePacket('c1', packet())
    const first = askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })
    expect(first.asked).toBe(1)

    // A second sweep over the same reading must stay quiet.
    const second = askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 2 })
    expect(second.asked).toBe(0)
    expect(second.alreadyAsked).toBe(1)
  })

  it('a NEW fact that does not change the ask does not re-ask', () => {
    // The hash covers the ASK, not the packet. Otherwise every re-read of an
    // unchanged case would ping him again — the §10.8 waste, on his phone.
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })

    storePacket('c1', packet({
      facts: [{ statement: 'Uj tenyt talaltunk, de a kerdes ugyanaz.', sourceRef: 'c1' }],
    }))
    const again = askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 3 })
    expect(again.asked).toBe(0)
  })

  it('a CHANGED ask does go out', () => {
    // ...and the suppression must not become a mute button.
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })

    storePacket('c1', packet({
      missingRequirements: [{ what: 'Panos adoazonositoja', whoHasIt: 'ISTVAN', why: 'a KYC-hez' }],
    }))
    expect(askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 4 }).asked).toBe(1)
  })

  it('the question reaches the owner channel, not just a table', () => {
    // The whole point. A row in cos_owner_questions with no message is the same
    // silence the Writer exists to end.
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })
    const messages = listAgentMessages(20)
    expect(messages.some(m => m.content.includes('A vetelar megallapodasa'))).toBe(true)
  })

  it('the per-sweep bound holds', () => {
    for (const id of ['c1', 'c2', 'c3']) {
      if (id !== 'c1') createCase(getDb(), { caseId: id, title: id, caseType: 'ADMIN' }, T0)
      storePacket(id, packet({ caseId: id }))
    }
    expect(askPendingOwnerQuestions(getDb(), { limit: 2, now: T0 + 1 }).asked).toBe(2)
  })

  it('STANDING CHECK: the cycle actually calls it', () => {
    // A Writer nothing invokes is the island again, one layer along.
    const runner = readFileSync(join(process.cwd(), 'scripts/progression-heartbeat-runner.ts'), 'utf8')
    expect(runner).toMatch(/askPendingOwnerQuestions\(db/)
    expect(runner).toMatch(/questions: asked/)
  })
})
