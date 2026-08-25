import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { enrichPendingGoals } from '../cos/goal-enrichment.js'
import { clearKnownSecrets, registerKnownSecret } from '../known-secrets.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

// W13 final-proof point (Istvan, 2026-08-26):
//
//   "A first-class disclosure record ne utólagos audit-log legyen. Bizonyítsd,
//    hogy az external payload abból a már eldöntött field-setből épül, és nincs
//    olyan normál execution path, ahol előbb elkészül/kimegy a raw payload,
//    majd utána készül disclosure record. Negatív tesztben a disclosure
//    decision/persist failure ne eredményezhessen sensitive external egress-t."
//
// The distinction he is drawing is the one between a SEAL and a RECEIPT. A
// receipt written after the fact proves what happened; a seal decides whether it
// happens. These tests are about the seal, and they use the live enrichment
// sweep — the one production path that sends case content to an LLM — with a
// client that records every call it receives. The "external egress" in a unit
// test is that client: nothing else in this path leaves the process.

const NOW = 1_800_000_000

/** Records everything it is asked. The stand-in for the outside world. */
function capturingLlm(): LlmClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async complete(_system: string, user: string): Promise<string> {
      calls.push(user)
      return JSON.stringify({ title: 'T', summary: 'S', goal: 'G' })
    },
  }
}

function seedCase(caseId: string, description: string): void {
  const db = getDb()
  createCase(db, { caseId, title: `Ugy ${caseId}`, caseType: 'ADMIN', description }, NOW - 86400)
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, goal, summary, progression_enabled, progression_mode, created_at, updated_at)
     VALUES ('personal', ?, NULL, NULL, 1, 'internal', ?, ?)`,
  ).run(caseId, NOW - 86400, NOW - 3600)
}

describe('W13 — the payload is BUILT FROM the decision, not merely logged after it', () => {
  beforeEach(() => { initDatabase(':memory:'); clearKnownSecrets() })
  afterEach(() => { clearKnownSecrets() })

  it('what reaches the model is the DISCLOSED text, not the stored text', () => {
    const llm = capturingLlm()
    seedCase('c-body', 'Ird meg a kovacs.jozsef@example.hu cimre. IBAN HU42117730161111101800000000. Hatarido 2026-09-01.')
    return enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5).then(() => {
      expect(llm.calls.length).toBe(1)
      const sent = llm.calls[0]
      // The identifiers never reach the provider...
      expect(sent).not.toContain('kovacs.jozsef@example.hu')
      expect(sent).not.toContain('HU42117730161111101800000000')
      // ...and the redaction markers are there, which is only possible if the
      // prompt was assembled from the decided values rather than the raw row.
      expect(sent).toContain('[EMAIL]')
      expect(sent).toContain('[IBAN]')
      // The task's own fact survives.
      expect(sent).toContain('2026-09-01')
    })
  })

  it('a KNOWN credential inside the case body never reaches the model either', async () => {
    const secret = 'sk-live-in-a-case-body-0123456789abcdef'
    registerKnownSecret(secret)
    const llm = capturingLlm()
    seedCase('c-secret', 'A kulcs: ' + secret + ' , kerlek ellenorizd.')
    await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)
    expect(llm.calls.length).toBe(1)
    expect(llm.calls[0]).not.toContain(secret)
  })

  it('the record exists BEFORE the call could have happened — one row, one prompt', async () => {
    const llm = capturingLlm()
    seedCase('c-order', 'Egy egyszeru leiras.')
    await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)
    const rows = getDb().prepare(
      `SELECT destination, task_tier, disclosed_fields FROM cos_disclosure_records`,
    ).all() as Array<{ destination: string; task_tier: string; disclosed_fields: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].destination).toBe('llm:anthropic')
    expect(rows[0].task_tier).toBe('SUMMARIZE_EXTRACT')
    // The fields the model was given are exactly the fields the record names.
    expect(JSON.parse(rows[0].disclosed_fields).sort()).toEqual(['BODY_FULL', 'SUBJECT', 'SUMMARY'])
  })
})

describe('W13 — a disclosure FAILURE cannot produce external egress (fail-closed)', () => {
  beforeEach(() => { initDatabase(':memory:'); clearKnownSecrets() })
  afterEach(() => { clearKnownSecrets() })

  /** Make the record write fail the way a real storage failure would: inside
   *  SQLite, on the real statement, not by stubbing the function that is being
   *  tested. */
  function breakDisclosureWrites(): void {
    getDb().exec(`CREATE TRIGGER w13_fail_disclosure BEFORE INSERT ON cos_disclosure_records
                  BEGIN SELECT RAISE(ABORT, 'simulated disclosure store failure'); END`)
  }

  it('NOTHING is sent when the decision cannot be persisted', async () => {
    breakDisclosureWrites()
    const llm = capturingLlm()
    seedCase('c-fail', 'Szemelyes tartalom, ami nem mehet ki bizonyitek nelkul.')

    const r = await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)

    // The model was never called. This is the whole point: if the record were
    // written after the send, this assertion would be impossible to satisfy.
    expect(llm.calls).toEqual([])
    // And the failure is REPORTED, not swallowed into a quiet zero.
    expect(r.enriched).toBe(0)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].caseId).toBe('personal/c-fail')
    expect(r.failures[0].error).toMatch(/simulated disclosure store failure/)
  })

  it('and no case state is written either — a failed sweep leaves no half-enriched case', async () => {
    breakDisclosureWrites()
    const llm = capturingLlm()
    seedCase('c-fail-2', 'Szemelyes tartalom.')
    await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)
    const state = getDb().prepare(
      `SELECT goal, summary FROM case_progression_state WHERE case_id = 'c-fail-2'`,
    ).get() as { goal: string | null; summary: string | null }
    expect(state.summary).toBeNull()
    expect(state.goal).toBeNull()
  })

  it('CONTROL: with the store healthy, the same case DOES go out', async () => {
    // Without this, every assertion above would also pass on a sweep that never
    // does anything at all.
    const llm = capturingLlm()
    seedCase('c-ok', 'Szemelyes tartalom.')
    const r = await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)
    expect(r.enriched).toBe(1)
    expect(llm.calls.length).toBe(1)
  })
})
