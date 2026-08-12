import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { enrichPendingGoals } from '../cos/goal-enrichment.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

// Review #5, Ö-2. The Reader got the §10 sensitivity gate in N4-1. The sibling
// path — goal enrichment, thirty lines above it in the same runner, reading the
// SAME stored email thread, up to 12 000 characters — did not.
//
// The exposure is not theoretical: resolveInterpreter's order ends in the vault
// DeepSeek key, so when the Anthropic key expires it silently switches provider,
// and a thread the Reader refuses in that very cycle leaves the machine here.

const NOW = 1_700_000_000

function client(name: string, calls: string[]): LlmClient {
  return { complete: async (prompt: string) => { calls.push(`${name}:${prompt.slice(0, 12)}`); return '{}' } } as unknown as LlmClient
}

function seedCase(caseId: string, sensitivity: string) {
  createCase(getDb(), { caseId, title: `T ${caseId}`, caseType: 'ADMIN', sensitivity: sensitivity as never }, NOW)
  // The sweep only considers progression-ENABLED cases, so the fixture has to
  // create that row too — without it there are zero candidates and every
  // assertion below passes vacuously.
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`,
  ).run(caseId, NOW, NOW)
}

describe('the enrichment sweep refuses what the Reader would refuse', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a THIRD_PARTY provider does not receive HIGHLY_SENSITIVE content', async () => {
    const calls: string[] = []
    seedCase('c-secret', 'HIGHLY_SENSITIVE')
    const r = await enrichPendingGoals(getDb(), {
      general: { client: client('deepseek', calls), provider: 'deepseek' },
      contracted: null,
    }, 5)
    expect(r.sensitivityBlocked, 'the case must be refused, not downgraded').toBe(1)
    expect(r.enriched).toBe(0)
    expect(calls, 'nothing may leave the machine').toEqual([])
  })

  it('the same content DOES go to a contracted provider', async () => {
    // The counter-check. A gate that blocks everything is not a gate, and this
    // is the assertion that tells the two apart.
    const calls: string[] = []
    seedCase('c-secret', 'HIGHLY_SENSITIVE')
    const r = await enrichPendingGoals(getDb(), {
      general: { client: client('deepseek', calls), provider: 'deepseek' },
      contracted: { client: client('anthropic', calls), provider: 'anthropic' },
    }, 5)
    expect(r.sensitivityBlocked).toBe(0)
    expect(calls.some(c => c.startsWith('anthropic:')), 'routed to the cleared provider').toBe(true)
    expect(calls.some(c => c.startsWith('deepseek:')), 'never to the third party').toBe(false)
  })

  it('ordinary content still takes the CHEAP route — this is routing, not an upgrade', async () => {
    const calls: string[] = []
    seedCase('c-plain', 'PERSONAL')
    await enrichPendingGoals(getDb(), {
      general: { client: client('deepseek', calls), provider: 'deepseek' },
      contracted: { client: client('anthropic', calls), provider: 'anthropic' },
    }, 5)
    expect(calls.some(c => c.startsWith('deepseek:')),
      'sending everything to the expensive provider would be a different bug').toBe(true)
  })

  it('a bare unlabelled client is treated as THIRD_PARTY, not as trusted', async () => {
    // Fail-closed by omission: a caller that hands over one client without
    // saying whose it is must not thereby get clearance for sensitive content.
    const calls: string[] = []
    seedCase('c-secret', 'SENSITIVE_PERSONAL')
    const r = await enrichPendingGoals(getDb(), client('mystery', calls), 5)
    expect(r.sensitivityBlocked).toBe(1)
    expect(calls).toEqual([])
  })

  // A sixth test lived here and was REMOVED rather than repaired. It claimed to
  // prove that content escalates past a mild declared tier, but its assertion was
  // `blocked + enriched + skipped > 0` — a disjunction that holds whenever the
  // sweep does anything at all, including with the gate deleted. It also never
  // stored real document bytes, so no escalation could occur to be observed.
  // Escalation itself is effectiveSensitivity's behaviour and is tested where
  // that function lives; asserting it vaguely here would have been decoration.
})
