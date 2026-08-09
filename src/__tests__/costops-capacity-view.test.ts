// P2-C: the subscription / capacity payload -- shape, freshness, confidence, and
// the hard Phase-2 boundary (no upgrade/downgrade recommendation).
//
// The endpoint used to return {"subscriptions":[],"config_present":false}: correct
// and useless. What matters now is not that numbers appear but that each one says
// how much it is worth and when it was observed, and that a figure with nothing
// behind it says so instead of showing 0.
//
// RED-ABILITY:
//  * make unknownFigure return `value: 0`               -> tests 2, 5, 6 go red
//  * let a derived figure keep 'measured' when its input was 'manual'
//                                                       -> test 4 goes red
//  * drop assertNoRecommendationLanguage from the builder, or add an
//    upgrade/downgrade label to the payload              -> tests 7, 8 go red
//  * report response time instead of observation time as freshness
//                                                       -> test 3 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  buildCapacityReport,
  assertNoRecommendationLanguage,
  weakestConfidence,
  freshnessOf,
  unknownFigure,
  CAPACITY_STALE_AFTER_SECONDS,
} from '../costops/capacity.js'
import { deriveLifecycle, type SubscriptionsConfig } from '../costops/subscriptions.js'
import { writeRateLimitSnapshot } from '../costops/capacity-snapshots.js'
import { recordSaturationEvent } from '../costops/saturation-events.js'
import { createDispatch } from '../costops/dispatch.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

const CONFIG: SubscriptionsConfig = {
  version: 1,
  subscriptions: [
    {
      id: 'plan-with-measured-usage', name: 'Plan A', provider: 'codex', source: 'openai',
      status: 'active', billing_period: 'monthly', next_renewal: '2026-08-15',
      amount_source: 'no_invoice_found',
    },
    {
      id: 'plan-with-manual-usage', name: 'Plan B', provider: 'anthropic', source: 'anthropic',
      status: 'active', billing_period: 'monthly', next_renewal: '2026-08-20',
      amount_source: 'no_invoice_found',
    },
    {
      id: 'plan-with-no-usage-source', name: 'Plan C', provider: 'someprovider', source: 'other',
      status: 'canceled', billing_period: 'annual', paid_until: '2026-09-01',
      amount_source: 'invoice',
    },
  ],
}

function report(now = NOW) {
  return buildCapacityReport(getDb(), deriveLifecycle(CONFIG, now), now)
}

describe('P2-C capacity view', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('1. every subscription carries a plan, a billing cycle and all five capacity figures', () => {
    const r = report()
    expect(r.phase).toBe('phase2_visibility_only')
    expect(r.subscriptions).toHaveLength(3)
    for (const s of r.subscriptions) {
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(s.status).toBeTruthy()
      expect(s.billing_cycle).toHaveProperty('period')
      expect(s.billing_cycle).toHaveProperty('days_until_next_date')
      expect(s.billing_cycle).toHaveProperty('past_due')
      for (const key of ['usage', 'unused_capacity', 'overflow', 'blocked_work', 'work_pushed_to_api'] as const) {
        const f = s[key]
        expect(f).toHaveProperty('value')
        expect(f).toHaveProperty('confidence')
        expect(f).toHaveProperty('freshness')
        expect(f).toHaveProperty('blocker')
        expect(f).toHaveProperty('unit')
        // Freshness is a real structure on EVERY figure, not just the nice ones.
        expect(f.freshness).toHaveProperty('as_of')
        expect(f.freshness).toHaveProperty('age_seconds')
        expect(f.freshness).toHaveProperty('stale')
      }
    }
    // The billing cycle is what the operator stated, never derived from a date.
    expect(r.subscriptions[2].billing_cycle.period).toBe('annual')
  })

  it('2. a subscription with no observation reports UNKNOWN with a reason -- not 0', () => {
    const s = report().subscriptions.find(x => x.id === 'plan-with-no-usage-source')!
    expect(s.usage.value).toBeNull()
    expect(s.usage.confidence).toBe('unknown')
    expect(s.usage.blocker).toMatch(/no capacity snapshot/)
    // The derived figures do not quietly become 0 either.
    expect(s.unused_capacity.value).toBeNull()
    expect(s.overflow.value).toBeNull()
    expect(s.unused_capacity.blocker).toMatch(/cannot be derived/)
    expect(s.overflow.blocker).toMatch(/cannot be derived/)
  })

  it('3. usage freshness is the age of the OBSERVATION, and old observations are flagged stale', () => {
    const db = getDb()
    const observedAt = NOW - 9 * 24 * 3600
    writeRateLimitSnapshot(db, {
      provider: 'codex', usedPercent: 30, source: 'provider_metadata_api', confidence: 'measured',
      dedupKey: 'codex|old', capturedAt: observedAt,
    })
    const s = report().subscriptions.find(x => x.id === 'plan-with-measured-usage')!
    expect(s.usage.value).toBe(0.3)
    expect(s.usage.confidence).toBe('measured')
    // Not "0 seconds because we just built the response".
    expect(s.usage.freshness.as_of).toBe(observedAt)
    expect(s.usage.freshness.age_seconds).toBe(9 * 24 * 3600)
    expect(s.usage.freshness.stale).toBe(true)
    expect(freshnessOf(NOW - 60, NOW).stale).toBe(false)
    expect(freshnessOf(NOW - CAPACITY_STALE_AFTER_SECONDS - 1, NOW).stale).toBe(true)
  })

  it('4. a derived figure never outranks its input: manual usage => manual unused/overflow', () => {
    const db = getDb()
    writeRateLimitSnapshot(db, {
      provider: 'anthropic', usedPercent: 120 > 100 ? 100 : 120, // clamp for the writer's 0..100 rule
      source: 'operator_manual_snapshot', confidence: 'manual',
      resetLabel: 'Tue 08:59', dedupKey: 'anthropic|manual|1', capturedAt: NOW - 3600,
    })
    const s = report().subscriptions.find(x => x.id === 'plan-with-manual-usage')!
    expect(s.usage.confidence).toBe('manual')
    expect(s.unused_capacity.confidence).toBe('manual')
    expect(s.overflow.confidence).toBe('manual')
    // Arithmetic does not upgrade evidence.
    expect(weakestConfidence('measured', 'manual')).toBe('manual')
    expect(weakestConfidence('manual', 'inferred')).toBe('inferred')
    expect(weakestConfidence('measured', 'measured')).toBe('measured')
    expect(weakestConfidence('inferred', 'unknown')).toBe('unknown')
    // usage 1.0 => unused 0, overflow 0: a DERIVED zero from a real figure is fine,
    // and it is distinguishable from the unknown case by its confidence.
    expect(s.unused_capacity.value).toBe(0)
    expect(s.unused_capacity.confidence).not.toBe('unknown')
  })

  it('4b. overflow is only positive when usage genuinely exceeds the window', () => {
    const db = getDb()
    writeRateLimitSnapshot(db, {
      provider: 'codex', usedPercent: 40, source: 'provider_metadata_api', confidence: 'measured',
      dedupKey: 'codex|40', capturedAt: NOW,
    })
    const s = report().subscriptions.find(x => x.id === 'plan-with-measured-usage')!
    expect(s.usage.value).toBe(0.4)
    expect(s.unused_capacity.value).toBe(0.6)
    expect(s.overflow.value).toBe(0)
  })

  it('5. blocked work: no MEASURED gate observation => unknown, not "nothing was blocked"', () => {
    const s = report().subscriptions[0]
    expect(s.blocked_work.value).toBeNull()
    expect(s.blocked_work.confidence).toBe('unknown')
    expect(s.blocked_work.blocker).toMatch(/not the same thing/)

    // With real observations it becomes measured -- including a refusal that has NO
    // dispatch row, which is the case nothing could previously see.
    const db = getDb()
    recordSaturationEvent(db, { agent: 'a1', state: 'ok', pct: 0.3, admitted: true, measured: true }, NOW * 1000)
    recordSaturationEvent(db, { agent: 'a1', state: 'hard_stop', pct: 0.95, admitted: false, refusalCode: 'saturated', measured: true }, NOW * 1000)
    const s2 = report().subscriptions[0]
    expect(s2.blocked_work.confidence).toBe('measured')
    expect(s2.blocked_work.value).toBe(1)
  })

  it('6. work pushed to API: no attributed dispatch => unknown, not 0', () => {
    const s = report().subscriptions.find(x => x.id === 'plan-with-measured-usage')!
    expect(s.work_pushed_to_api.value).toBeNull()
    expect(s.work_pushed_to_api.blocker).toMatch(/no dispatch was attributed/)

    // Two dispatches on this provider, one metered: measured, and the count is real.
    const db = getDb()
    createDispatch(db, { source: 'kanban', agent: 'a1', provider: 'codex', authProfile: 'p', billingMode: 'api_payg' }, NOW * 1000)
    createDispatch(db, { source: 'kanban', agent: 'a1', provider: 'codex', authProfile: 'p', billingMode: 'subscription_included' }, NOW * 1000)
    const s2 = report().subscriptions.find(x => x.id === 'plan-with-measured-usage')!
    expect(s2.work_pushed_to_api.value).toBe(1)
    expect(s2.work_pushed_to_api.confidence).toBe('measured')

    // An UNMAPPED billing_mode makes the count a lower bound, so it drops to inferred
    // rather than silently under-reporting as if it were complete.
    createDispatch(db, { source: 'kanban', agent: 'a1', provider: 'codex' }, NOW * 1000)
    const s3 = report().subscriptions.find(x => x.id === 'plan-with-measured-usage')!
    expect(s3.work_pushed_to_api.confidence).toBe('inferred')
    expect(s3.work_pushed_to_api.blocker).toMatch(/lower bound/)
  })

  it('7. Phase 2 emits NO upgrade/downgrade recommendation anywhere in the payload', () => {
    const db = getDb()
    writeRateLimitSnapshot(db, {
      provider: 'codex', usedPercent: 97, source: 'provider_metadata_api', confidence: 'measured',
      dedupKey: 'codex|97', capturedAt: NOW,
    })
    // 97% used is exactly the state a Phase 4 advisor would speak up about.
    const r = report()
    expect(() => assertNoRecommendationLanguage(r)).not.toThrow()
    const serialized = JSON.stringify(r).toLowerCase()
    for (const word of ['upgrade', 'downgrade', 'recommend', 'right-size', 'switch to']) {
      expect(serialized).not.toContain(word)
    }
  })

  it('8. the guard itself can go RED (it is not a no-op)', () => {
    expect(() => assertNoRecommendationLanguage({ hint: 'consider an upgrade to the larger plan' }))
      .toThrow(/visibility only/)
    expect(() => assertNoRecommendationLanguage({ nested: [{ label: 'DOWNGRADE candidate' }] }))
      .toThrow(/Phase 4/)
    // Keys are checked too, not just values.
    expect(() => assertNoRecommendationLanguage({ upgrade_path: 'x' })).toThrow()
    // And an innocent payload passes.
    expect(() => assertNoRecommendationLanguage({ usage: 0.5, note: 'observed via provider metadata read' })).not.toThrow()
  })

  it('9. an unknown figure is structurally incapable of carrying a number', () => {
    const f = unknownFigure('because there is no data')
    expect(f.value).toBeNull()
    expect(f.confidence).toBe('unknown')
    expect(f.blocker).toBe('because there is no data')
  })

  it('10. an empty config explains itself instead of returning a silent empty list', () => {
    const r = buildCapacityReport(getDb(), [], NOW)
    expect(r.subscriptions).toEqual([])
    expect(r.notes.join(' ')).toMatch(/no subscription is configured/)
  })
})
