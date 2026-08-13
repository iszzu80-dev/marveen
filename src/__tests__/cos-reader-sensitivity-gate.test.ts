// §10 on the READING path: which PROVIDER may see which tier.
//
// Istvan's decision, 2026-08-11: sensitive content goes to a provider that is
// acceptable on data handling (Anthropic); everything else may go to DeepSeek.
//
// The first version of this gate keyed on the MODEL PROFILE — HIGHLY_SENSITIVE
// only on `premium_reasoning`, and so on. That table was written when the price
// tier happened to coincide with the provider (premium = Opus = Anthropic,
// cheap = DeepSeek). The coincidence broke the moment an Anthropic key arrived:
// Haiku and Opus are the same provider under the same terms, so refusing Haiku
// a sensitive case protected nothing and only made the same egress dearer.
//
// What these tests pin is the axis: WHERE the content lands, not how clever the
// model is.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { runReaderPass, contextSensitivity } from '../cos/reader-cycle.js'
import { buildCaseContext, docSensitivity } from '../cos/context-builder.js'
import {
  isProviderAllowedForSensitivity, dataClassOf, PROVIDER_DATA_CLASS,
} from '../cos/provider-data-policy.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

const T0 = 1_700_000_000

function stub(): LlmClient & { calls: number } {
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

describe('§10 provider routing before the Reader', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a SENSITIVE_PERSONAL case goes to the CONTRACTED provider, not the cheap one', () => {
    seed('SENSITIVE_PERSONAL')
    const cheap = stub()
    const cleared = stub()
    return runReaderPass(getDb(), {
      general: { client: cheap, provider: 'deepseek' },
      contracted: { client: cleared, provider: 'anthropic' },
    }, { limit: 5, now: T0 + 20 }).then(r => {
      expect(cheap.calls).toBe(0)      // the assertion that matters: it never left to DeepSeek
      expect(cleared.calls).toBe(1)
      expect(r.read).toBe(1)
      expect(r.byProvider).toEqual({ anthropic: 1 })
    })
  })

  it('a PERSONAL case goes to the CHEAP provider — routing, not a blanket upgrade', async () => {
    // The counter-case, and the cost argument: if everything went to the
    // contracted provider the rule would be "spend more", not "route".
    seed('PERSONAL')
    const cheap = stub()
    const cleared = stub()
    const r = await runReaderPass(getDb(), {
      general: { client: cheap, provider: 'deepseek' },
      contracted: { client: cleared, provider: 'anthropic' },
    }, { limit: 5, now: T0 + 20 })
    expect(cheap.calls).toBe(1)
    expect(cleared.calls).toBe(0)
    expect(r.byProvider).toEqual({ deepseek: 1 })
  })

  it('with NO contracted provider, a sensitive case is blocked — never downgraded', async () => {
    // Falling back to the cheap route here would defeat the whole rule at
    // exactly the moment it matters.
    seed('SENSITIVE_PERSONAL')
    const cheap = stub()
    const r = await runReaderPass(getDb(), { general: { client: cheap, provider: 'deepseek' } },
      { limit: 5, now: T0 + 20 })
    expect(cheap.calls).toBe(0)
    expect(r.sensitivityBlocked).toBe(1)
    expect(r.read).toBe(0)
  })

  it('the block is a stored row naming the tier and what WOULD have been allowed', async () => {
    seed('HIGHLY_SENSITIVE')
    await runReaderPass(getDb(), { general: { client: stub(), provider: 'deepseek' } },
      { limit: 5, now: T0 + 20 })
    const row = getDb().prepare(
      `SELECT decided_by, refusal_reason, packet_json FROM case_evidence_packets WHERE case_id='c1'`,
    ).get() as Record<string, string | null>
    expect(row.decided_by).toBe('SENSITIVITY_BLOCKED')
    expect(row.packet_json).toBeNull()
    expect(row.refusal_reason).toContain('HIGHLY_SENSITIVE')
    expect(row.refusal_reason).toContain('anthropic')
  })

  it('no provider at all means nothing is sent', async () => {
    seed('PUBLIC')
    const r = await runReaderPass(getDb(), { general: null }, { limit: 5, now: T0 + 20 })
    expect(r.sensitivityBlocked).toBe(1)
    expect(r.read).toBe(0)
  })

  it('the policy is fail-closed on both axes', () => {
    // An unknown tier coerces to HIGHLY_SENSITIVE, an unknown provider to
    // THIRD_PARTY — so an unconfigured question always answers no.
    expect(dataClassOf('some-new-vendor')).toBe('THIRD_PARTY')
    expect(isProviderAllowedForSensitivity('some-new-vendor', 'HIGHLY_SENSITIVE')).toBe(false)
    expect(isProviderAllowedForSensitivity('deepseek', 'not-a-tier')).toBe(false)
    expect(isProviderAllowedForSensitivity('anthropic', 'not-a-tier')).toBe(true)
    // ...and the cheap provider is fine for the lower tiers.
    expect(isProviderAllowedForSensitivity('deepseek', 'PERSONAL')).toBe(true)
    expect(isProviderAllowedForSensitivity('deepseek', 'PUBLIC')).toBe(true)
  })

  it('the table says exactly what Istvan decided', () => {
    // Pins the decision so a later edit is deliberate rather than incidental.
    expect(PROVIDER_DATA_CLASS.anthropic).toBe('CONTRACTED')
    expect(PROVIDER_DATA_CLASS.deepseek).toBe('THIRD_PARTY')
  })

  it('CONTENT escalates the tier even when the case is labelled PERSONAL', () => {
    const items = [
      { sensitivity: 'PERSONAL', content: 'semmi erdekes' },
      { sensitivity: 'PERSONAL', content: 'a kartya: 4111 1111 1111 1111' },
    ]
    expect(contextSensitivity('personal', items)).toBe('HIGHLY_SENSITIVE')
    expect(contextSensitivity('personal', [{ sensitivity: 'PERSONAL', content: 'semmi' }])).toBe('PERSONAL')
  })

  it('an empty context is PUBLIC, not maximally sensitive', () => {
    expect(contextSensitivity('personal', [])).toBe('PUBLIC')
  })

  it('a document with no tier of its own inherits the CASE tier', () => {
    // Measured on the live store 2026-08-11: all 92 document rows carry the
    // literal 'UNKNOWN'. Coercing that fail-closed would have blocked 36 of 40
    // cases on a data-quality gap rather than on their content.
    expect(docSensitivity('UNKNOWN', 'PERSONAL')).toBe('PERSONAL')
    expect(docSensitivity(null, 'PUBLIC')).toBe('PUBLIC')
    expect(docSensitivity('HIGHLY_SENSITIVE', 'PERSONAL')).toBe('HIGHLY_SENSITIVE')
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
    expect(ctx.items.find(i => i.kind === 'EMAIL_THREAD')!.sensitivity).toBe('PERSONAL')
  })
})
