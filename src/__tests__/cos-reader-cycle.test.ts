// The Reader chain ON THE LIVE PATH (§10.1 → §10.2 → §12 → §13.1).
//
// The bug these tests exist for is not a wrong answer, it is an absent one.
// Context Builder, Reader and evidence planner were finished, green and
// committed, and nothing called any of them: the three modules imported each
// other and no production file imported the outermost one. Every cycle reported
// `problems: []`, truthfully, about the part that ran.
//
// So the last test here does not check behaviour at all. It checks that the live
// runner still contains a route into this module, because that is the property
// that was missing, and a property nobody asserts is a property that goes away.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { runReaderPass, casesNeedingReading } from '../cos/reader-cycle.js'
import { engageKillSwitch } from '../cos/kill-switch.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

const T0 = 1_700_000_000

/** A model that answers with whatever the test hands it. `seen` records the
 *  prompt so a test can assert what the Reader was actually shown. */
function stubLlm(reply: string | ((user: string) => string)): LlmClient & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async complete(_system: string, user: string) {
      seen.push(user)
      return typeof reply === 'function' ? reply(user) : reply
    },
  }
}

/** A packet the Reader could legitimately return for case c1. `ref` must be a
 *  source the Context Builder really supplied, or provenance validation refuses
 *  it — which is the point of the provenance check and is exercised below. */
function packetJson(over: Record<string, unknown> = {}, ref = 'c1'): string {
  return JSON.stringify({
    readSources: [ref],
    unreadableSources: [],
    facts: [{ statement: 'A szallito nem valaszolt a hataridore.', sourceRef: ref }],
    missingRequirements: [
      { what: 'szallitasi datum', whoHasIt: 'EXTERNAL', why: 'enelkul nem tervezheto a beszereles' },
    ],
    ballHolder: 'EXTERNAL',
    candidateDecision: 'WAIT_EXTERNAL',
    confidence: 0.8,
    uncertainty: [],
    ...over,
  })
}

function seedRanCase(caseId = 'c1'): void {
  const db = getDb()
  createCase(db, { caseId, title: 'Medence szallitas', caseType: 'HOME_REPAIR' }, T0)
  // A COMPLETED progression run is what makes a case a reading candidate: the
  // §10.8 trigger contract already decided it had a reason to think.
  runProgressionCycle(db, 'personal', caseId, T0 + 10, { triggerType: 'INTAKE' })
}

describe('Reader pass on the live path', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('reads a case that ran, and STORES the packet, the plan and the arbitration', async () => {
    seedRanCase()
    const llm = stubLlm(packetJson())
    const r = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek', model: 'test-model' } }, { limit: 5, now: T0 + 20 })

    expect(r.read).toBe(1)
    expect(r.refused).toBe(0)
    expect(r.failures).toEqual([])

    const row = getDb().prepare(
      `SELECT * FROM case_evidence_packets WHERE case_id = 'c1'`,
    ).get() as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.refusal_reason).toBeNull()
    expect(row.model).toBe('test-model')
    // §12: the plan is derived and stored, and it names the missing thing rather
    // than a template step.
    const plan = JSON.parse(String(row.plan_json)) as { steps: Array<{ label: string; evidenceRefs: string[] }> }
    expect(plan.steps[0].label).toContain('szallitasi datum')
    expect(plan.steps[0].evidenceRefs.length).toBeGreaterThan(0)
    // §13.1 audit fields.
    expect(row.reader_candidate).toBe('WAIT_EXTERNAL')
    expect(row.policy_result).toBeTruthy()
    expect(row.final_decision).toBeTruthy()
  })

  it('a case is read ONCE per progression run, not once per cycle', async () => {
    // The §10.8 waste, one layer up: without this binding every unchanged case
    // would cost a model call every ten minutes.
    seedRanCase()
    const llm = stubLlm(packetJson())
    const first = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })
    expect(first.read).toBe(1)

    const second = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 30 })
    expect(second.read).toBe(0)
    expect(casesNeedingReading(getDb(), 0)).toHaveLength(0)
    expect(llm.seen).toHaveLength(1)

    // ...and it becomes a candidate again once it genuinely progresses.
    runProgressionCycle(getDb(), 'personal', 'c1', T0 + 40, { triggerType: 'USER_INPUT' })
    expect(casesNeedingReading(getDb(), 0)).toHaveLength(1)
  })

  it('a refused reading is STORED with its reason, not dropped', async () => {
    // "The Reader looked and found little" and "the Reader produced nothing
    // usable" need opposite responses, so they must not both be an absent row.
    seedRanCase()
    const llm = stubLlm('I am not going to answer with JSON today.')
    const r = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })

    expect(r.read).toBe(0)
    expect(r.refused).toBe(1)
    const row = getDb().prepare(
      `SELECT refusal_reason, packet_json, plan_json, final_decision, decided_by
       FROM case_evidence_packets WHERE case_id = 'c1'`,
    ).get() as Record<string, unknown>
    expect(String(row.refusal_reason)).toMatch(/no JSON object/)
    expect(row.packet_json).toBeNull()
    expect(row.plan_json).toBeNull()
    // The engine's own decision still stands; the discarded reading changed nothing.
    expect(row.decided_by).toBe('INVALID_PACKET')
    expect(row.final_decision).toBeTruthy()
  })

  it('a packet citing a source it was never given is refused (§10.3 provenance)', async () => {
    seedRanCase()
    const llm = stubLlm(packetJson({}, 'doc-that-does-not-exist'))
    const r = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })

    expect(r.read).toBe(0)
    expect(r.refused).toBe(1)
    const reason = getDb().prepare(
      `SELECT refusal_reason FROM case_evidence_packets WHERE case_id = 'c1'`,
    ).get() as { refusal_reason: string }
    expect(reason.refusal_reason).toMatch(/not in the context/)
  })

  it('the kill switch stops the chain at arbitration, and the row says so', async () => {
    seedRanCase()
    engageKillSwitch(getDb(), { reason: 'test', actor: 'test' }, T0 + 15)
    const llm = stubLlm(packetJson({ candidateDecision: 'CONTINUE_AUTONOMOUSLY', confidence: 0.99 }))
    const r = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })

    expect(r.conflicts).toBe(1)
    const row = getDb().prepare(
      `SELECT decided_by, final_decision, conflict_reason FROM case_evidence_packets WHERE case_id = 'c1'`,
    ).get() as Record<string, string>
    expect(row.decided_by).toBe('HARD_GATE')
    expect(row.final_decision).toBe('RECOVERY_REQUIRED')
  })

  it('one failing case does not stop the sweep', async () => {
    seedRanCase('c1')
    seedRanCase('c2')
    let n = 0
    const llm = stubLlm(() => {
      n += 1
      if (n === 1) throw new Error('model exploded')
      return packetJson({}, 'c2')
    })
    const r = await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })
    // The thrown call is a refusal (readCase catches it), the other is read.
    expect(r.read + r.refused).toBe(2)
    expect(r.read).toBe(1)
  })

  it('the Reader is shown the trust labels, not bare text', async () => {
    // §10.2's boundary is only real if the labels reach the model. Asserted on
    // the actual prompt rather than on the builder's return value.
    seedRanCase()
    const llm = stubLlm(packetJson())
    await runReaderPass(getDb(), { general: { client: llm, provider: 'deepseek' } }, { limit: 5, now: T0 + 20 })
    expect(llm.seen[0]).toContain('TRUSTED_CASE_FIELD')
    expect(llm.seen[0]).toContain('case_id: c1')
  })

  it('STANDING CHECK: the live runner still imports the reader pass', () => {
    // This is the test for the failure that actually happened. The chain was
    // correct and unreachable; every behavioural test above passed the night it
    // was unreachable. Only a check on the CALLER can see that.
    const runner = readFileSync(
      resolve(process.cwd(), 'scripts/progression-heartbeat-runner.ts'), 'utf8',
    )
    expect(runner).toMatch(/reader-cycle\.js/)
    expect(runner).toMatch(/runReaderPass\(/)
    // Two routes, not one client: the §10 routing lives in the caller.
    expect(runner).toMatch(/resolveReaderInterpreters/)
    // The counter has to be printed too: a pass whose result nobody prints is
    // the same silence one level further along.
    expect(runner).toMatch(/'Reader:'/)
  })
})
