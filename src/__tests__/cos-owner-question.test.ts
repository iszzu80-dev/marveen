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
import {
  buildOwnerQuestion, askPendingOwnerQuestions, recordOwnerAnswer, outstandingOwnerQuestions,
} from '../cos/owner-question.js'
import { planFromEvidence } from '../cos/evidence-planner.js'
import { validateEvidencePacket, type ReaderEvidencePacket } from '../cos/reader.js'

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

describe('the answer path', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'ZST uzletresz-adasvetel', caseType: 'ADMIN' }, T0)
  })

  it('HEADLINE: an answer closes the question AND lands as a case event', () => {
    // A question with nowhere to put the answer is half a channel. The event is
    // the half that matters: the engine's existing owner-answer consumption
    // reads events, not this table.
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })

    const rec = recordOwnerAnswer(getDb(), {
      caseId: 'c1', domain: 'personal', text: '1.2 millio forint, megegyeztunk.', now: T0 + 100,
    })!
    expect(rec.eventType).toBe('OWNER_INFORMATION')
    expect(rec.choice).toBeNull()

    const ev = getDb().prepare(
      `SELECT event_type, payload FROM personal_case_events WHERE case_id='c1' ORDER BY event_id DESC LIMIT 1`,
    ).get() as { event_type: string; payload: string }
    expect(ev.event_type).toBe('OWNER_INFORMATION')
    expect(JSON.parse(ev.payload).answer).toContain('1.2 millio')
  })

  it('a plain yes becomes a DECISION, free text stays INFORMATION', () => {
    // The only interpretation done here is the plainest one. Anything cleverer
    // would put words in his mouth on an append-only record — card 78e81155 is
    // the real version of that, as a proposal he confirms.
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })
    const yes = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen, mehet.', now: T0 + 2 })!
    expect(yes.eventType).toBe('OWNER_DECISION')
    expect(yes.choice).toBe('YES')
  })

  it('answering closes it, and the question can be asked again if it returns', () => {
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })
    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen', now: T0 + 2 })
    expect(outstandingOwnerQuestions(getDb())).toHaveLength(0)
  })

  it('an answer to a case nobody asked about is refused, not invented', () => {
    // Writing an event the engine cannot attribute is worse than losing the
    // sentence: it would look like an answer to whatever question comes next.
    expect(recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen', now: T0 + 2 })).toBeNull()
  })

  it('outstanding questions are queryable — "what did it ask me?"', () => {
    storePacket('c1', packet())
    askPendingOwnerQuestions(getDb(), { limit: 5, now: T0 + 1 })
    const open = outstandingOwnerQuestions(getDb())
    expect(open).toHaveLength(1)
    expect(open[0].text).toContain('Ami Tőled kell')
  })
})

describe('a question must say WHAT to decide', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'NAV ertesito', caseType: 'ADMIN' }, T0)
  })

  it('HEADLINE: "Istvan döntése szükséges" alone is replaced by what is BLOCKED', () => {
    // Live 2026-08-11: two of the first four questions degenerated to exactly
    // this, because the Reader put the ball on ISTVAN while attributing the
    // missing items to someone else. An unanswerable question is noise wearing
    // a question mark.
    const p = packet({
      ballHolder: 'ISTVAN',
      missingRequirements: [
        { what: 'A tarhelyen levo dokumentum tartalma', whoHasIt: 'EXTERNAL', why: 'enelkul nem eldontheto mi a teendo' },
      ],
    })
    const q = buildOwnerQuestion({ caseId: 'c1', domain: 'personal', title: 'NAV', packet: p, plan: planFromEvidence(p) })!
    expect(q.text).toContain('A tarhelyen levo dokumentum tartalma')
    expect(q.text).toContain('EXTERNAL')
    // The bare generic line must not be the whole ask.
    expect(q.text).not.toMatch(/Ami Tőled kell:\n• Istvan döntése szükséges\n\n/)
  })

  it('when the ask IS specific, it is left alone', () => {
    // The counter-case: the fallback must not overwrite a good question.
    const q = buildOwnerQuestion({
      caseId: 'c1', domain: 'personal', title: 't', packet: packet(), plan: planFromEvidence(packet()),
    })!
    expect(q.text).toContain('A vetelar megallapodasa')
    expect(q.text).not.toContain('ez akadályozza')
  })

  it('with nothing missing at all, it says so rather than pretending', () => {
    const p = packet({ ballHolder: 'ISTVAN', missingRequirements: [] })
    const q = buildOwnerQuestion({ caseId: 'c1', domain: 'personal', title: 't', packet: p, plan: planFromEvidence(p) })!
    expect(q.text).toContain('nem talált konkrét hiányzó tételt')
  })
})

describe('the channel has a global cap, not just a rate', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  it('HEADLINE: with too many unanswered, it holds back — and SAYS so', () => {
    // Two per sweep becomes twelve an hour if nobody answers. Past a handful,
    // one more question does not get answered sooner; it gets the channel muted.
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
      createCase(getDb(), { caseId: id, title: id, caseType: 'ADMIN' }, T0)
      storePacket(id, packet({ caseId: id }))
    }
    const first = askPendingOwnerQuestions(getDb(), { limit: 10, now: T0 + 1, maxOutstanding: 3 })
    expect(first.asked).toBe(3)
    expect(first.heldBacklogFull).toBeGreaterThan(0)

    // ...and it stays held while they are unanswered.
    const second = askPendingOwnerQuestions(getDb(), { limit: 10, now: T0 + 2, maxOutstanding: 3 })
    expect(second.asked).toBe(0)
  })

  it('answering releases the cap — it is a backlog limit, not a mute', () => {
    for (const id of ['c1', 'c2']) {
      createCase(getDb(), { caseId: id, title: id, caseType: 'ADMIN' }, T0)
      storePacket(id, packet({ caseId: id }))
    }
    askPendingOwnerQuestions(getDb(), { limit: 10, now: T0 + 1, maxOutstanding: 1 })
    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen', now: T0 + 2 })
    expect(askPendingOwnerQuestions(getDb(), { limit: 10, now: T0 + 3, maxOutstanding: 1 }).asked).toBe(1)
  })
})

// H-2 (review #6): the answer was written in a shape its own consumer discards.
//
// `consumeOwnerAnswer` refuses any owner event without a `source_reference`
// naming the progression run — without it there is no way to tell WHICH question
// was answered. The answer event was written without one. So every answer that
// arrived from Telegram was recorded, released the question, and was then
// dropped by the engine: the case did not move, the next Reader sweep produced
// the same packet, and the same question went out again. The review reproduced
// it: two identical messages, after answering.
//
// These tests pin the carrier — the run id travelling from question to answer —
// because that is the part that was missing, not the intent.
describe('H-2: the answer names the run it answers', () => {
  const RUN = 'run-abc-123'
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'ZST uzletresz-adasvetel', caseType: 'ADMIN' }, T0)
  })

  const storePacketWithRun = (runId: string | null): void => {
    const p = packet()
    const plan = planFromEvidence(p)
    getDb().prepare(
      `INSERT INTO case_evidence_packets
         (packet_id, domain, case_id, progression_run_id, created_at, packet_json, plan_json,
          confidence, policy_result)
       VALUES (?, 'personal', 'c1', ?, ?, ?, ?, ?, 'WAIT_EXTERNAL')`,
    ).run(`pk-${runId ?? 'none'}`, runId, T0, JSON.stringify(p), JSON.stringify(plan), p.confidence)
  }

  it('the question stores the run, and the answer event carries it as source_reference', () => {
    storePacketWithRun(RUN)
    expect(askPendingOwnerQuestions(getDb(), { now: T0 + 1 }).asked).toBe(1)
    expect((getDb().prepare(
      `SELECT progression_run_id AS r FROM cos_owner_questions WHERE case_id = 'c1'`,
    ).get() as { r: string }).r).toBe(RUN)

    const rec = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'igen', now: T0 + 2 })
    expect(rec).not.toBeNull()
    const ev = getDb().prepare(
      `SELECT source_reference AS ref, event_type AS t FROM personal_case_events
       WHERE case_id = 'c1' AND event_type IN ('OWNER_DECISION','OWNER_INFORMATION')
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as { ref: string | null; t: string }
    // THE ASSERTION THE OLD CODE FAILED. Everything else about the answer path
    // worked; this one NULL is what made it a no-op.
    expect(ev.ref).toBe(RUN)
    expect(ev.t).toBe('OWNER_DECISION')
  })

  it('a question asked before this column existed still takes an answer', () => {
    // Fail-safe direction: a legacy row has no run to name. Losing the sentence
    // would be worse than an answer the engine cannot attribute, and the engine
    // already handles the missing reference by treating it as stale.
    storePacketWithRun(null)
    expect(askPendingOwnerQuestions(getDb(), { now: T0 + 1 }).asked).toBe(1)
    const rec = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'nem', now: T0 + 2 })
    expect(rec?.choice).toBe('NO')
    expect((getDb().prepare(
      `SELECT source_reference AS ref FROM personal_case_events
       WHERE case_id = 'c1' AND event_type = 'OWNER_DECISION' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { ref: string | null }).ref).toBeNull()
  })

  it('an UNCHANGED question follows the newest run without asking twice', () => {
    // The case gets read again every sweep. When the ask is identical the
    // question must NOT go out a second time -- but the stored run must move,
    // or the answer would name a run the engine no longer recognises as current
    // and would be dropped as stale. Same H-2 loop, different door.
    storePacketWithRun(RUN)
    expect(askPendingOwnerQuestions(getDb(), { now: T0 + 1 }).asked).toBe(1)
    getDb().prepare(`DELETE FROM case_evidence_packets WHERE case_id = 'c1'`).run()
    storePacketWithRun('run-second')
    const second = askPendingOwnerQuestions(getDb(), { now: T0 + 2 })
    expect(second.asked).toBe(0)
    expect(second.alreadyAsked).toBe(1)

    const rows = getDb().prepare(
      `SELECT progression_run_id AS r FROM cos_owner_questions
       WHERE case_id = 'c1' AND answered_at IS NULL AND superseded_at IS NULL`,
    ).all() as Array<{ r: string }>
    expect(rows.map(x => x.r)).toEqual(['run-second'])

    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'igen', now: T0 + 3 })
    expect((getDb().prepare(
      `SELECT source_reference AS ref FROM personal_case_events
       WHERE case_id = 'c1' AND event_type = 'OWNER_DECISION' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { ref: string }).ref).toBe('run-second')
  })
})

// H-3 (review #6): "István" with the accent was not `ISTVAN`.
//
// The Reader prompt asks for Hungarian and `whoHasIt` is free text, so the
// accent arrives roughly as often as it does not. The comparisons were plain
// ASCII uppercase. On the SAME case, purely by that accent, Istvan got a
// specific question, a generic one, or nothing at all. Either behaviour could
// be argued; alternating between them at random cannot.
describe('H-3: the accent must not decide what he is asked', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'ZST uzletresz-adasvetel', caseType: 'ADMIN' }, T0)
  })

  const build = (who: string) => buildOwnerQuestion({
    caseId: 'c1', domain: 'personal', title: 'ZST uzletresz-adasvetel',
    packet: packet({ missingRequirements: [{ what: 'A vetelar megallapodasa', whoHasIt: who, why: 'a szerzodeshez kell' }] }),
    plan: planFromEvidence(packet({ missingRequirements: [{ what: 'A vetelar megallapodasa', whoHasIt: who, why: 'a szerzodeshez kell' }] })),
  })

  it('accented and unaccented produce the SAME question', () => {
    const plain = build('ISTVAN')
    const accented = build('István')
    expect(plain).not.toBeNull()
    expect(accented).not.toBeNull()
    // Same ask -> same hash. The hash is what suppresses re-asking, so if the
    // spellings hashed differently the owner would get both versions.
    expect(accented!.hash).toBe(plain!.hash)
    expect(accented!.text).toContain('A vetelar megallapodasa')
  })

  it('an accented ballHolder no longer throws the whole reading away', () => {
    // Fail-closed was not the problem: the packet was REJECTED entirely, so one
    // accent discarded a complete reading of the case.
    const ctx = { caseId: 'c1', domain: 'personal' as const, caseVersion: 1, items: [], excluded: [], unavailable: [] }
    const raw = {
      readSources: [], unreadableSources: [], facts: [], missingRequirements: [],
      ballHolder: 'István', candidateDecision: 'REQUEST_DECISION', confidence: 0.5, uncertainty: [],
    }
    const res = validateEvidencePacket(raw, ctx)
    expect(res.ok).toBe(true)
    // Stored folded, so every downstream comparison sees one spelling.
    expect(res.ok && res.packet.ballHolder).toBe('ISTVAN')
  })

  it('the fold does not widen the enum', () => {
    const ctx = { caseId: 'c1', domain: 'personal' as const, caseVersion: 1, items: [], excluded: [], unavailable: [] }
    const raw = {
      readSources: [], unreadableSources: [], facts: [], missingRequirements: [],
      ballHolder: 'Istvan Szabo', candidateDecision: 'REQUEST_DECISION', confidence: 0.5, uncertainty: [],
    }
    const res = validateEvidencePacket(raw, ctx)
    expect(res.ok).toBe(false)
  })
})
