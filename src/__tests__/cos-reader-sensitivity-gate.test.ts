// §10 sensitivity gate on the READING path (review #4, N4-1).
//
// The finding this exists for: wiring the Reader chain created an egress path
// that did not exist while it was an island. Whole email bodies and extracted
// document text now go to an EXTERNAL provider, and the sensitivity field —
// which travels through the entire system and is printed into the prompt as a
// label — decided nothing. §10 is enforced on the sending path and was absent
// here.
//
// These tests assert the gate at the only place that matters: the last step
// before content leaves the machine.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { runReaderPass, contextSensitivity } from '../cos/reader-cycle.js'
import { buildCaseContext, docSensitivity } from '../cos/context-builder.js'
import { INTERPRETER_PROFILE } from '../cos/interpreter-provider.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

const T0 = 1_700_000_000

function llm(): LlmClient & { calls: number } {
  const o = {
    calls: 0,
    async complete() {
      o.calls += 1
      return JSON.stringify({
        readSources: ['c1'], unreadableSources: [],
        facts: [{ statement: 'x', sourceRef: 'c1' }], missingRequirements: [],
        ballHolder: 'EXTERNAL', candidateDecision: 'WAIT_EXTERNAL', confidence: 0.8, uncertainty: [],
      })
    },
  }
  return o
}

function seed(sensitivity: string, caseId = 'c1'): void {
  createCase(getDb(), { caseId, title: 'Ugy', caseType: 'FINANCE', sensitivity } as never, T0)
  runProgressionCycle(getDb(), 'personal', caseId, T0 + 10, { triggerType: 'INTAKE' })
}

describe('§10 sensitivity gate before the Reader', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a SENSITIVE_PERSONAL case is NOT sent to a cheap-tier profile', async () => {
    seed('SENSITIVE_PERSONAL')
    const model = llm()
    const r = await runReaderPass(getDb(), model, {
      limit: 5, now: T0 + 20, profile: 'analysis_efficient',
    })
    // The assertion that matters is not the counter — it is that no request was made.
    expect(model.calls).toBe(0)
    expect(r.sensitivityBlocked).toBe(1)
    expect(r.read).toBe(0)
  })

  it('the block is a stored row naming the tier, the profile and what would be allowed', async () => {
    seed('SENSITIVE_PERSONAL')
    await runReaderPass(getDb(), llm(), { limit: 5, now: T0 + 20, profile: 'analysis_efficient' })
    const row = getDb().prepare(
      `SELECT decided_by, refusal_reason, packet_json FROM case_evidence_packets WHERE case_id='c1'`,
    ).get() as Record<string, string | null>
    expect(row.decided_by).toBe('SENSITIVITY_BLOCKED')
    expect(row.packet_json).toBeNull()
    expect(row.refusal_reason).toContain('SENSITIVE_PERSONAL')
    expect(row.refusal_reason).toContain('analysis_efficient')
    expect(row.refusal_reason).toContain('premium_reasoning')
  })

  it('a PERSONAL case IS read by the same profile — the gate is not a blanket stop', async () => {
    // The counter-case. A gate that blocks everything is indistinguishable from
    // a broken pipeline, and would have been "passing" all night.
    seed('PERSONAL')
    const model = llm()
    const r = await runReaderPass(getDb(), model, { limit: 5, now: T0 + 20, profile: 'analysis_efficient' })
    expect(model.calls).toBe(1)
    expect(r.read).toBe(1)
    expect(r.sensitivityBlocked).toBe(0)
  })

  it('NO declared profile means nothing is sent', async () => {
    // A caller that cannot say what is about to read the data has not been
    // granted permission by omission.
    seed('PUBLIC')
    const model = llm()
    const r = await runReaderPass(getDb(), model, { limit: 5, now: T0 + 20 })
    expect(model.calls).toBe(0)
    expect(r.sensitivityBlocked).toBe(1)
  })

  it('CONTENT escalates the tier even when the case is labelled PERSONAL', async () => {
    // The declared label is a claim, not a measurement. A card number in a
    // document lifts the whole context regardless of what the case row says.
    const items = [
      { sensitivity: 'PERSONAL', content: 'semmi erdekes' },
      { sensitivity: 'PERSONAL', content: 'a kartya: 4111 1111 1111 1111' },
    ]
    expect(contextSensitivity(items)).toBe('HIGHLY_SENSITIVE')
    expect(contextSensitivity([{ sensitivity: 'PERSONAL', content: 'semmi' }])).toBe('PERSONAL')
  })

  it('an empty context is PUBLIC, not maximally sensitive', () => {
    // Fail-closed on CONTENT, not on absence: an empty context carries no
    // secret, and calling it HIGHLY_SENSITIVE would be a policy verdict about
    // data nobody has.
    expect(contextSensitivity([])).toBe('PUBLIC')
  })

  it('a document with no tier of its own inherits the CASE tier, not the fail-closed maximum', () => {
    // Measured on the live store 2026-08-11: all 92 document rows carry the
    // literal 'UNKNOWN'. Coercing that fail-closed would have blocked 36 of 40
    // cases on a data-quality gap rather than on their content — a gate that
    // fires on everything teaches people to switch it off.
    expect(docSensitivity('UNKNOWN', 'PERSONAL')).toBe('PERSONAL')
    expect(docSensitivity(null, 'PUBLIC')).toBe('PUBLIC')
    // ...but a document that DOES declare a higher tier still escalates.
    expect(docSensitivity('HIGHLY_SENSITIVE', 'PERSONAL')).toBe('HIGHLY_SENSITIVE')
    // ...and never de-escalates below the case.
    expect(docSensitivity('PUBLIC', 'SENSITIVE_PERSONAL')).toBe('SENSITIVE_PERSONAL')
  })

  it('the builder gives documents the case tier, end to end', () => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'x', caseType: 'FINANCE', sensitivity: 'PERSONAL' } as never, T0)
    getDb().prepare(
      `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
         mime_type, byte_size, sha256, stored_path, doc_kind, sensitivity, external_share_allowed,
         extracted_text, received_at, created_at, updated_at)
       VALUES ('d1','personal','c1','email','m1','t.txt','text/plain',10,'s','/tmp/x',
         'email_thread','UNKNOWN',0,'sima szoveg',@t,@t,@t)`,
    ).run({ t: T0 })
    const ctx = buildCaseContext(getDb(), 'personal', 'c1', T0 + 1)
    const doc = ctx.items.find(i => i.kind === 'EMAIL_THREAD')!
    expect(doc.sensitivity).toBe('PERSONAL')
  })

  it('both interpreters are cheap-tier, so neither may read SENSITIVE_PERSONAL', () => {
    // Pins the policy consequence of the provider choice. If someone later maps
    // an interpreter to premium_reasoning, this test makes that a deliberate,
    // visible edit rather than a side effect.
    expect(INTERPRETER_PROFILE.deepseek).not.toBe('premium_reasoning')
    expect(INTERPRETER_PROFILE.anthropic).not.toBe('premium_reasoning')
  })
})
