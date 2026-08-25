import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { recordFeatureRun, standardFeatureResult } from '../cos/consumer-manifest.js'
import {
  staleRuns, unverifiedCompletions, operationalHealth,
  STALE_RUN_MAX_AGE_SEC, UNVERIFIED_GRACE_SEC,
} from '../cos/operational-health.js'
import { listMonitoring } from '../web/routes/cos.js'

// W14 / §8.6 — the two metrics the audit found with nothing behind them.
//
// They answer opposite questions: a STALE RUN is silence where there should be
// noise; an UNVERIFIED COMPLETION is noise that was never resolved into a fact.
// A surface reporting only one of them can be perfectly green while the other is
// the outage, which is why they are two metrics and not one "health" number.
//
// The unverified metric had a finding before it existed: two APPLIED_UNVERIFIED
// rows on the live store from 2026-08-10, sixteen days old, surfaced by nothing.

const NOW = 1_800_000_000

function run(featureId: string, at: number, opts: { verified?: boolean; acted?: boolean } = {}) {
  const acted = opts.acted ?? true
  recordFeatureRun(getDb(), {
    runId: `${featureId}-${at}`, featureId, domain: 'personal',
    result: standardFeatureResult({
      examined: 1, matched: 1, acted: acted ? 1 : 0, failed: 0, reason: 'test run',
    }),
    startedAt: at - 1, finishedAt: at,
    integrity: { verificationStatus: opts.verified === false ? 'UNVERIFIED' : opts.verified ? 'VERIFIED' : 'NOT_APPLICABLE' },
  })
}

describe('W14 §8.6 — stale runs', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a feature that stopped recording runs is stale', () => {
    run('cos-close-batches', NOW - STALE_RUN_MAX_AGE_SEC - 60)
    const stale = staleRuns(getDb(), NOW)
    expect(stale.map(s => s.featureId)).toEqual(['cos-close-batches'])
    expect(stale[0].ageSeconds).toBeGreaterThan(STALE_RUN_MAX_AGE_SEC)
  })

  it('a feature that ran within the window is NOT stale', () => {
    run('cos-close-batches', NOW - 600)
    expect(staleRuns(getDb(), NOW)).toEqual([])
  })

  it('the NEWEST run decides, not the oldest — a feature that resumed is healthy', () => {
    run('cos-channel-send', NOW - 40_000)
    run('cos-channel-send', NOW - 300)
    expect(staleRuns(getDb(), NOW)).toEqual([])
  })

  it('the stalest comes first, so the list reads as a priority order', () => {
    run('a', NOW - 100_000)
    run('b', NOW - 10_000)
    expect(staleRuns(getDb(), NOW).map(s => s.featureId)).toEqual(['a', 'b'])
  })

  it('WHAT IT CANNOT SEE, asserted so the limit is measured: a feature that NEVER ran', () => {
    // No row means no staleness — absence is a different question, answered by
    // comparing against a declared expected set, not by this function. Stated in
    // the module header and pinned here so nobody reads more into a green.
    expect(staleRuns(getDb(), NOW)).toEqual([])
  })
})

describe('W14 §8.6 — unverified completion', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100_000)
  })

  function outbound(id: string, status: string, updatedAt: number) {
    getDb().prepare(
      `INSERT INTO outbound_ledger
        (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
         status, attempt, last_error, created_at, updated_at)
       VALUES (?, 'c1', 'EMAIL_SEND', ?, ?, ?, 1, 'readback unavailable', ?, ?)`
    ).run(id, Math.floor(Math.random() * 1e6), `idem-${id}`, status, updatedAt, updatedAt)
  }

  it('a RUN that acted without a readback is reported after the grace', () => {
    run('cos-channel-send', NOW - UNVERIFIED_GRACE_SEC - 60, { verified: false })
    const u = unverifiedCompletions(getDb(), NOW)
    expect(u).toHaveLength(1)
    expect(u[0].source).toBe('RUN')
    expect(u[0].detail).toMatch(/acted without a readback/)
  })

  it('within the grace it is a MOMENT, not a problem — the executor re-reads on later ticks', () => {
    run('cos-channel-send', NOW - 60, { verified: false })
    expect(unverifiedCompletions(getDb(), NOW)).toEqual([])
  })

  it('an APPLIED_UNVERIFIED ledger row is reported too — the concrete side effect', () => {
    // The shape that actually existed on the live store: the provider accepted
    // the letter, the marker never came back, the executor will never resend,
    // and nothing surfaced it for sixteen days.
    outbound('ob-old', 'APPLIED_UNVERIFIED', NOW - 16 * 86400)
    const u = unverifiedCompletions(getDb(), NOW)
    expect(u).toHaveLength(1)
    expect(u[0].source).toBe('OUTBOUND')
    expect(u[0].reference).toBe('ob-old')
    expect(u[0].ageSeconds).toBeGreaterThan(15 * 86400)
  })

  it('a VERIFIED row is not reported — the metric is about the unresolved, not the busy', () => {
    outbound('ob-ok', 'VERIFIED', NOW - 16 * 86400)
    expect(unverifiedCompletions(getDb(), NOW)).toEqual([])
  })

  it('both sources appear together, oldest first', () => {
    run('cos-channel-send', NOW - 2 * 86400, { verified: false })
    outbound('ob-older', 'APPLIED_UNVERIFIED', NOW - 16 * 86400)
    const u = unverifiedCompletions(getDb(), NOW)
    expect(u.map(x => x.source)).toEqual(['OUTBOUND', 'RUN'])
  })
})

describe('W14 §8.6 — the surface carries both, and the zero case speaks', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100_000)
  })

  it('operationalHealth says CLEAN explicitly rather than returning two empty lists', () => {
    const h = operationalHealth(getDb(), NOW)
    expect(h.clean).toBe(true)
    expect(h.checkedAt).toBe(NOW)
  })

  it('/api/cos/monitoring carries the health block', () => {
    // The endpoint reads the REAL clock (production has no injected `now`), so
    // the fixture is placed relative to real time. Using the fixed NOW here
    // would put the run in the future and the metric would correctly report
    // nothing — a green that means the test was wrong, not the code.
    run('cos-close-batches', Math.floor(Date.now() / 1000) - 100_000)
    const mon = listMonitoring(getDb())
    expect(mon.health).toBeDefined()
    expect(mon.health.clean).toBe(false)
    expect((mon.health.stale as Array<{ featureId: string }>)[0].featureId).toBe('cos-close-batches')
  })

  it('the internal UI renders it, including the zero case', () => {
    // Grep-level on the rendered source, paired with the API test above: the
    // block exists, and it says something when there is nothing to say.
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'coscontrol.js'), 'utf-8')
    expect(src).toContain('Futás-egészség')
    expect(src).toContain('Nincs elakadt futás és nincs igazolatlan befejezés.')
    expect(src).toContain('mon.health')
  })
})
