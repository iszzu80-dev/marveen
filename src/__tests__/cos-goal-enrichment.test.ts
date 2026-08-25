// The goal-enrichment sweep (card ca33eb4b).
//
// Written alongside the wiring, because the defect being fixed is not a broken
// function -- it is a correct function nothing called, plus an idempotence guard
// that would have made calling it pointless. Both need a test that fails against
// yesterday's code.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { enrichCaseGoal } from '../cos/progression-pipeline.js'
import { casesNeedingGoal, enrichPendingGoals } from '../cos/goal-enrichment.js'
import type { LlmClient } from '../cos/progression-interpreter.js'

const NOW = 1_800_000_000

/** A stand-in for Haiku. Records what it was asked, answers in the shape the
 *  interpreter validates. No network, so the suite stays deterministic. */
function fakeLlm(over: { throws?: boolean; goal?: string } = {}): LlmClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async complete(_system: string, user: string): Promise<string> {
      calls.push(user)
      if (over.throws) throw new Error('model unavailable')
      return JSON.stringify({
        title: 'Értelmezett cím',
        summary: 'Két mondat arról, mi ez az ügy és mi kell hozzá.',
        goal: over.goal ?? 'Elintézni a konkrét dolgot, amiről a levél szól.',
      })
    },
  }
}

function seedCase(caseId: string, opts: { enabled?: number; status?: string; goal?: string; summary?: string } = {}): void {
  const db = getDb()
  createCase(db, { caseId, title: `Ügy ${caseId}`, caseType: 'ADMIN', description: 'Egy leírás.' }, NOW - 86400)
  if (opts.status) db.prepare(`UPDATE personal_cases SET status = ? WHERE case_id = ?`).run(opts.status, caseId)
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, goal, summary, progression_enabled, progression_mode, created_at, updated_at)
     VALUES ('personal', ?, ?, ?, ?, 'internal', ?, ?)`,
  ).run(caseId, opts.goal ?? null, opts.summary ?? null, opts.enabled ?? 1, NOW - 86400, NOW - 3600)
}

describe('goal enrichment', () => {
  beforeEach(() => { initDatabase(':memory:') })

  // THE test. Against yesterday's code this fails: enrichCaseGoal returned early
  // whenever `goal` was non-empty, and the deterministic pipeline writes `goal`
  // on every run -- so all 98 live cases carried one and the enricher could
  // never fire, however it was wired.
  it('a template-written goal does NOT count as interpreted', async () => {
    seedCase('c1', { goal: 'Elintezni a szemelyes ugyet, archiválni az eredményt' })
    const llm = fakeLlm()

    expect(casesNeedingGoal(getDb(), 0).map(c => c.caseId)).toContain('c1')

    const r = await enrichCaseGoal(getDb(), 'personal', 'c1', llm, undefined, { provider: 'anthropic' })
    expect(r.interpreted).toBe(true)
    expect(llm.calls.length).toBe(1)
  })

  it('an interpreted case is never interpreted twice', async () => {
    seedCase('c2', { goal: 'sablon', summary: 'Már értelmezve.' })
    const llm = fakeLlm()

    expect(casesNeedingGoal(getDb(), 0).map(c => c.caseId)).not.toContain('c2')
    const r = await enrichCaseGoal(getDb(), 'personal', 'c2', llm, undefined, { provider: 'anthropic' })
    expect(r.interpreted).toBe(false)
    expect(llm.calls.length).toBe(0)
  })

  it('writes the goal AND the summary, so the marker it checks is the one it sets', async () => {
    seedCase('c3')
    await enrichPendingGoals(getDb(), { general: { client: fakeLlm({ goal: 'Kifizetni a vízszámlát és visszaigazolást kérni.' }), provider: 'anthropic' } }, 5)
    const row = getDb().prepare(
      `SELECT goal, summary, goal_version FROM case_progression_state WHERE case_id = 'c3'`,
    ).get() as { goal: string; summary: string; goal_version: number }
    expect(row.goal).toContain('vízszámlát')
    expect(row.summary.length).toBeGreaterThan(10)
    expect(row.goal_version).toBeGreaterThan(0)
  })

  it('skips closed and frozen cases — a model call on those buys nothing', async () => {
    seedCase('c-closed', { status: 'COMPLETED' })
    seedCase('c-frozen', { enabled: 0 })
    seedCase('c-live')
    expect(casesNeedingGoal(getDb(), 0).map(c => c.caseId)).toEqual(['c-live'])
  })

  it('respects the per-cycle bound, and says how many are still waiting', async () => {
    for (let i = 0; i < 7; i++) seedCase(`c-many-${i}`)
    const r = await enrichPendingGoals(getDb(), { general: { client: fakeLlm(), provider: 'anthropic' } }, 3)
    expect(r.enriched).toBe(3)
    expect(r.remaining).toBe(4)
  })

  it('one failing case does not stop the sweep, and is reported', async () => {
    seedCase('c-a'); seedCase('c-b')
    const r = await enrichPendingGoals(getDb(), { general: { client: fakeLlm({ throws: true }), provider: 'anthropic' } }, 5)
    expect(r.enriched).toBe(0)
    expect(r.failures.length).toBe(2)
    expect(r.failures[0].error).toMatch(/model unavailable/)
    // and nothing was written, so the next cycle retries rather than skipping
    expect(casesNeedingGoal(getDb(), 0).length).toBe(2)
  })

  it('covers the corporate namespace too', async () => {
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'Céges ügy', caseType: 'ADMIN' }, NOW - 86400)
    db.prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode, created_at, updated_at)
       VALUES ('zst', 'z1', 1, 'internal', ?, ?)`,
    ).run(NOW - 86400, NOW - 3600)
    expect(casesNeedingGoal(db, 0).some(c => c.domain === 'zst' && c.caseId === 'z1')).toBe(true)
    const r = await enrichPendingGoals(db, { general: { client: fakeLlm(), provider: 'anthropic' } }, 5)
    expect(r.enriched).toBe(1)
  })

  it('feeds the stored email thread to the model when there is one', async () => {
    // The interpreter was built to read a thread. Handing it only a
    // one-line auto-generated title produces a goal barely better than the
    // template it replaces, so the content choice is part of the feature.
    seedCase('c-thread')
    const llm = fakeLlm()
    await enrichPendingGoals(getDb(), { general: { client: llm, provider: 'anthropic' } }, 5)
    expect(llm.calls[0]).toContain('Egy leírás.')   // description fallback reached the prompt
  })

  // W13 / §7.4 (2026-08-26). The five calls above gained an explicit
  // `provider: 'anthropic'`, and that is not test bookkeeping — it is the new
  // contract. The enrichment path now makes a DISCLOSURE decision per field,
  // and a decision needs a destination. A caller that does not name one is an
  // unknown destination, and an unknown destination receives nothing personal.
  //
  // This test pins that behaviour rather than letting it be discovered as a
  // silent regression by whoever next passes a bare client.
  it('a caller that does not name its destination discloses NOTHING, and says so', async () => {
    seedCase('c-unnamed')
    const llm = fakeLlm()
    const r = await enrichPendingGoals(getDb(), llm, 5)   // bare client → 'unknown'
    expect(r.enriched).toBe(0)
    expect(r.disclosureBlocked).toBe(1)
    expect(llm.calls.length).toBe(0)                       // the model was never called
    // and the refusal is recorded, with the reason, in the disclosure log
    const rec = getDb().prepare(
      `SELECT trust_class, disclosed_fields, any_denied FROM cos_disclosure_records ORDER BY at DESC LIMIT 1`,
    ).get() as { trust_class: string; disclosed_fields: string; any_denied: number }
    expect(rec.trust_class).toBe('UNKNOWN_UNTRUSTED')
    expect(JSON.parse(rec.disclosed_fields)).toEqual([])
    expect(rec.any_denied).toBe(1)
  })
})
