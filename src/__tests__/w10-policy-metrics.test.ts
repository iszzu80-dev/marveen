// W10 §4.7 — the counters, and the liveness question they make answerable.
//
// The point of this file is one distinction: a check that reads VIOLATIONS can
// only report absence, and absence is what a healthy quiet gate produces as well
// as a dead one. These tests assert that the new signal can actually be false,
// and that it is false for the right reason.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  POLICY_COUNTERS, bumpPolicyCounter, counterForVerdict, initPolicyMetricsSchema,
  policyGateLiveness, readPolicyMetrics,
} from '../identity/policy-metrics.js'

const HOUR = 3600

describe('W10 policy counters', () => {
  let db: Database.Database
  const now = 1_787_600_000

  beforeEach(() => { db = new Database(':memory:'); initPolicyMetricsSchema(db) })

  it('every verdict maps to a counter, and the mapping is total', () => {
    const seen = new Set<string>()
    for (const v of ['ALLOW', 'DENY', 'REDACT', 'REQUIRE_APPROVAL'] as const) {
      const c = counterForVerdict(v)
      expect(POLICY_COUNTERS).toContain(c)
      seen.add(c)
    }
    expect(seen.size).toBe(4)
  })

  it('counts aggregate by hour, so rows grow with TIME and not with traffic', () => {
    for (let i = 0; i < 500; i++) bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM policy_decision_counters').get() as { n: number }
    expect(rows.n).toBe(1)                       // 500 decisions, ONE row
    const m = readPolicyMetrics(db, now)
    expect(m.totals.policy_allow).toBe(500)
  })

  it('allow is counted — the thing the violation log structurally could not do', () => {
    bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now, 52)
    const m = readPolicyMetrics(db, now)
    expect(m.totals.policy_allow).toBe(52)
    expect(m.decisions).toBe(52)
  })

  it('diagnostic counters do not inflate the decision count', () => {
    bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now, 3)
    bumpPolicyCounter(db, 'fleet_dispatch', 'identity_resolution_failure', now, 3)
    bumpPolicyCounter(db, 'fleet_dispatch', 'sensitivity_unknown', now, 2)
    const m = readPolicyMetrics(db, now)
    // 3 decisions happened; the other 5 rows are ATTRIBUTES of those decisions.
    expect(m.decisions).toBe(3)
    expect(m.totals.identity_resolution_failure).toBe(3)
  })

  it('LIVE is a presence claim: quiet-but-allowing reads LIVE, unlike the old check', () => {
    // This is precisely the August 2026 situation: fifteen days, 52 messages,
    // every one allowed, zero violations logged. The old signal called that
    // FAILED. The new one must call it LIVE.
    bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now, 52)
    expect(policyGateLiveness(db, now).state).toBe('LIVE')
  })

  it('and it can genuinely be FALSE: no decisions in the window is NO_DECISIONS_RECORDED', () => {
    // Decisions exist, but all of them are older than the window.
    bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now - 48 * HOUR, 10)
    const r = policyGateLiveness(db, now, 24)
    expect(r.state).toBe('NO_DECISIONS_RECORDED')
    expect(r.decisions).toBe(0)
  })

  it('never-measured is reported as NOT_INSTRUMENTED, not as a failure', () => {
    // "We never measured" and "it is broken" are different facts, and only one
    // of them should wake somebody up.
    expect(policyGateLiveness(db, now).state).toBe('NOT_INSTRUMENTED')
  })

  it('surfaces are counted separately so one live gate cannot vouch for another', () => {
    bumpPolicyCounter(db, 'fleet_dispatch', 'policy_allow', now, 5)
    const m = readPolicyMetrics(db, now)
    expect(m.bySurface.fleet_dispatch).toBe(5)
    expect(m.bySurface.cos_send).toBeUndefined()
  })

  it('the window boundary is inclusive of the oldest hour it claims to cover', () => {
    bumpPolicyCounter(db, 'x', 'policy_deny', now - 23 * HOUR, 1)
    bumpPolicyCounter(db, 'x', 'policy_deny', now - 24 * HOUR, 1)
    const m = readPolicyMetrics(db, now, 24)
    expect(m.totals.policy_deny).toBe(1)   // the 24h-old one is outside
  })
})
