import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { recordFeatureRun, standardFeatureResult } from '../cos/consumer-manifest.js'
import {
  startCanary, canaryStatus, canaryLimit, evaluateCanary, resumeCanary,
} from '../cos/canary.js'

// W14 / §8.5 — canary rollout for a new critical behaviour.
//
// §8.5 asks for four things, and they are four mechanisms: a limited workload,
// explicit metrics, an abort threshold, and a promotion gate. The one design
// decision worth defending is that the metrics are the RUN LEDGER (§8.7) rather
// than counters this module keeps: a canary with a private opinion about health
// is a second opinion, and two opinions drift.

const F = 'cos-goal-enrichment-disclosure'
const NOW = 1_800_000_000

function run(status: 'SUCCESS' | 'PARTIAL' | 'FAILED', at: number, runId = `r-${at}`) {
  // Written through the real recorder, so a run this test calls SUCCESS is a run
  // the ledger would also call SUCCESS — including §8.7's verification rule.
  const result = status === 'FAILED'
    ? standardFeatureResult({ examined: 1, matched: 1, acted: 0, failed: 1, reason: 'boom' })
    : standardFeatureResult({ examined: 1, matched: 1, acted: 1, failed: 0, reason: 'ok' })
  recordFeatureRun(getDb(), {
    runId, featureId: F, domain: 'personal', result, startedAt: at - 1, finishedAt: at,
    integrity: { verificationStatus: status === 'SUCCESS' ? 'VERIFIED' : 'UNVERIFIED' },
  })
}

describe('W14 §8.5 — the canary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('limits the workload while in CANARY, and only narrows', () => {
    startCanary(getDb(), { featureId: F, maxPerRun: 1, promoteAfterRuns: 10 }, NOW)
    expect(canaryLimit(getDb(), F, 5)).toBe(1)
    // It can only narrow: a caller asking for less than the canary cap gets its
    // own number, not the cap.
    expect(canaryLimit(getDb(), F, 0)).toBe(0)
  })

  it('a feature nobody put under canary is NOT silently throttled', () => {
    expect(canaryLimit(getDb(), 'some-other-feature', 5)).toBe(5)
  })

  it('promotes after N CONSECUTIVE clean runs, not N total', () => {
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW)
    run('SUCCESS', NOW + 10)
    run('SUCCESS', NOW + 20)
    expect(evaluateCanary(db, F, NOW + 25)?.changed).toBeNull()
    expect(canaryStatus(db, F)?.consecutiveSuccesses).toBe(2)
    run('SUCCESS', NOW + 30)
    const e = evaluateCanary(db, F, NOW + 35)
    expect(e?.changed).toBe('PROMOTED')
    expect(canaryLimit(db, F, 5)).toBe(5)     // the full budget is released
  })

  it('a FAILED run aborts immediately, whatever the streak was', () => {
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW)
    run('SUCCESS', NOW + 10); run('SUCCESS', NOW + 20)
    run('FAILED', NOW + 30)
    const e = evaluateCanary(db, F, NOW + 35)
    expect(e?.changed).toBe('ABORTED')
    expect(e?.status.abortReason).toMatch(/FAILED/)
    // ZERO, not "reduced": an aborted rollout does no work at all.
    expect(canaryLimit(db, F, 5)).toBe(0)
  })

  it('a PARTIAL run aborts too — §8.7 says SUCCESS needs verification, and so does this', () => {
    // The run that ACTED but could not be verified is exactly the shape a
    // canary exists to catch: something happened outside and we cannot say what.
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW)
    run('PARTIAL', NOW + 10)
    expect(evaluateCanary(db, F, NOW + 15)?.changed).toBe('ABORTED')
  })

  it('a fresh failure outvotes a long clean streak', () => {
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 10 }, NOW)
    for (let i = 1; i <= 9; i++) run('SUCCESS', NOW + i * 10)
    run('FAILED', NOW + 200)
    expect(evaluateCanary(db, F, NOW + 210)?.changed).toBe('ABORTED')
  })

  it('restarting a running canary does NOT reset its promotion count', () => {
    // Otherwise a feature could live under canary forever, restarted on every
    // boot, and nobody would notice it never promoted.
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW)
    run('SUCCESS', NOW + 10); run('SUCCESS', NOW + 20)
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW + 25)
    expect(canaryStatus(db, F)?.consecutiveSuccesses).toBe(2)
    expect(canaryStatus(db, F)?.startedAt).toBe(NOW)
  })

  it('an abort is cleared by a HUMAN, never by the loop', () => {
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 3 }, NOW)
    run('FAILED', NOW + 10)
    evaluateCanary(db, F, NOW + 15)
    expect(canaryLimit(db, F, 5)).toBe(0)
    // Evaluating again does not un-abort it: an abort that clears itself is a
    // retry loop with a ceremony.
    evaluateCanary(db, F, NOW + 20)
    expect(canaryStatus(db, F)?.state).toBe('ABORTED')

    resumeCanary(db, F, NOW + 100)
    expect(canaryStatus(db, F)?.state).toBe('CANARY')
    expect(canaryLimit(db, F, 5)).toBe(1)
    // The streak restarts from the resume, so the runs BEFORE the abort do not
    // count towards promotion.
    expect(canaryStatus(db, F)?.consecutiveSuccesses).toBe(0)
  })

  it('metrics come from the ledger, so a run nobody recorded counts for nothing', () => {
    const db = getDb()
    startCanary(db, { featureId: F, maxPerRun: 1, promoteAfterRuns: 1 }, NOW)
    // No recordFeatureRun call: nothing happened as far as the system knows.
    expect(evaluateCanary(db, F, NOW + 100)?.changed).toBeNull()
    expect(canaryStatus(db, F)?.consecutiveSuccesses).toBe(0)
  })
})

describe('W14 §8.5 — it is wired to the path W13 changed', () => {
  const RUNNER = readFileSync(join(__dirname, '..', '..', 'scripts', 'progression-heartbeat-runner.ts'), 'utf-8')

  it('the enrichment sweep asks the canary for its limit', () => {
    // Source-level: the runner spawns as its own process and cannot be executed
    // inside the suite. What is asserted is that the limit the sweep receives
    // passes through the canary — the behaviour of the canary itself is above.
    expect(RUNNER).toContain("canaryLimit(db, 'cos-goal-enrichment-disclosure'")
    expect(RUNNER).toMatch(/enrichPendingGoals\(db, enrichRoutes, limit\)/)
  })

  it('and it evaluates the canary after the sweep, so a bad run stops the next one', () => {
    expect(RUNNER).toContain("evaluateCanary(db, 'cos-goal-enrichment-disclosure'")
  })
})
