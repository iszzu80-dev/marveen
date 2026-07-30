// P2-C: an inferred or manual capacity figure is NEVER labelled 'measured'.
//
// This is the guard that makes the honesty rule structural rather than cultural.
// Anthropic publishes no quota/usage API, so a Claude weekly-usage number in this
// system is always an operator reading. Before P2-C the snapshot table had no
// column in which to say so, and a manual retype produced a row byte-identical to
// a real provider metadata read.
//
// RED-ABILITY (each test names the mutation that makes it fail):
//  * change MEASURED_SNAPSHOT_SOURCES to include 'operator_manual_snapshot', or
//    make assertSnapshotConfidence a no-op          -> tests 1, 2, 5 go red
//  * make anthropic-usage.ts pass confidence 'measured'  -> test 5 goes red
//  * make codex.ts stop stamping confidence/provenance   -> test 3 goes red
//  * drop the dedup_key idempotency                      -> test 6 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  writeRateLimitSnapshot,
  latestRateLimitSnapshot,
  assertSnapshotConfidence,
  defaultConfidenceForSource,
  MEASURED_SNAPSHOT_SOURCES,
} from '../costops/capacity-snapshots.js'
import { syncCodexRateLimit } from '../costops/collectors/codex.js'
import { syncAnthropicUsageSnapshot } from '../costops/collectors/anthropic-usage.js'
import type { SubscriptionsConfig } from '../costops/subscriptions.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

const CODEX_RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: NOW + 3 * 86400 },
    planType: 'plus',
  },
}

const MANUAL_CONFIG: SubscriptionsConfig = {
  version: 1,
  subscriptions: [{
    id: 'example-anthropic-plan',
    name: 'Example Plan',
    provider: 'anthropic',
    source: 'anthropic',
    status: 'active',
    amount_source: 'no_invoice_found',
    usage_snapshot: {
      as_of: '2026-07-29T21:00:00+02:00',
      session_pct: 5,
      weekly_pct: 62,
      weekly_reset_label: 'Tue 08:59',
    },
  }],
}

describe('P2-C: only a real provider read may claim "measured"', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('1. exactly one source is allowed to claim measured, and it is the provider read', () => {
    expect([...MEASURED_SNAPSHOT_SOURCES]).toEqual(['provider_metadata_api'])
    expect(defaultConfidenceForSource('provider_metadata_api')).toBe('measured')
    expect(defaultConfidenceForSource('operator_manual_snapshot')).toBe('manual')
    expect(defaultConfidenceForSource('derived_from_snapshots')).toBe('inferred')
  })

  it('2. the guard REFUSES measured for a manual or derived source, and says what to use instead', () => {
    expect(() => assertSnapshotConfidence('operator_manual_snapshot', 'measured'))
      .toThrow(/not available to source 'operator_manual_snapshot'/)
    expect(() => assertSnapshotConfidence('derived_from_snapshots', 'measured'))
      .toThrow(/store it as 'inferred'/)
    // The weaker labels stay legal for every source.
    expect(() => assertSnapshotConfidence('operator_manual_snapshot', 'manual')).not.toThrow()
    expect(() => assertSnapshotConfidence('derived_from_snapshots', 'inferred')).not.toThrow()
    expect(() => assertSnapshotConfidence('provider_metadata_api', 'measured')).not.toThrow()
  })

  it('3. the codex collector stores its snapshot as MEASURED with provider provenance', async () => {
    const db = getDb()
    const res = await syncCodexRateLimit(db, NOW, { reader: async () => CODEX_RESULT })
    expect(res.ok).toBe(true)
    expect(res.imported_count).toBe(1)
    const snap = latestRateLimitSnapshot(db, 'codex')
    expect(snap).not.toBeNull()
    expect(snap!.used_percent).toBe(41)
    expect(snap!.usage_confidence).toBe('measured')
    expect(snap!.snapshot_source).toBe('provider_metadata_api')
    // A real epoch reset was reported, so it is stored as one.
    expect(snap!.resets_at).toBe(NOW + 3 * 86400)
  })

  it('4. a write attempting to overstate a manual figure THROWS instead of storing it', () => {
    const db = getDb()
    expect(() => writeRateLimitSnapshot(db, {
      provider: 'anthropic', usedPercent: 62,
      source: 'operator_manual_snapshot', confidence: 'measured',
      dedupKey: 'attempted-overstatement', capturedAt: NOW,
    })).toThrow(/measured/)
    // And nothing landed -- the refusal is not a partial write.
    expect(latestRateLimitSnapshot(db, 'anthropic')).toBeNull()
  })

  it('5. the Claude usage collector stores MANUAL, with the verbatim reset label and NO fake timestamp', () => {
    const db = getDb()
    const res = syncAnthropicUsageSnapshot(db, NOW, { config: MANUAL_CONFIG })
    expect(res.status).toBe('ok')
    expect(res.imported_count).toBe(1)
    const snap = latestRateLimitSnapshot(db, 'anthropic')
    expect(snap).not.toBeNull()
    expect(snap!.used_percent).toBe(62)
    // The load-bearing assertion: never 'measured'.
    expect(snap!.usage_confidence).toBe('manual')
    expect(snap!.snapshot_source).toBe('operator_manual_snapshot')
    // No real reset timestamp exists, so none is invented; the label is kept verbatim.
    expect(snap!.resets_at).toBeNull()
    expect(snap!.reset_label).toBe('Tue 08:59')
  })

  it('6. re-running on the next tick does not turn one manual reading into many observations', () => {
    const db = getDb()
    expect(syncAnthropicUsageSnapshot(db, NOW, { config: MANUAL_CONFIG }).imported_count).toBe(1)
    // Same as_of, later clock: the operator has not re-read anything.
    expect(syncAnthropicUsageSnapshot(db, NOW + 3600, { config: MANUAL_CONFIG }).imported_count).toBe(0)
    expect(syncAnthropicUsageSnapshot(db, NOW + 7200, { config: MANUAL_CONFIG }).imported_count).toBe(0)
    const n = db.prepare("SELECT COUNT(*) c FROM provider_ratelimit_snapshots WHERE provider='anthropic'").get() as { c: number }
    expect(n.c).toBe(1)

    // A genuinely NEW reading does land.
    const newer: SubscriptionsConfig = {
      version: 1,
      subscriptions: [{
        ...MANUAL_CONFIG.subscriptions[0],
        usage_snapshot: { ...MANUAL_CONFIG.subscriptions[0].usage_snapshot!, as_of: '2026-07-30T09:00:00+02:00', weekly_pct: 71 },
      }],
    }
    expect(syncAnthropicUsageSnapshot(db, NOW + 10800, { config: newer }).imported_count).toBe(1)
    expect(latestRateLimitSnapshot(db, 'anthropic')!.used_percent).toBe(71)
  })

  it('7. no usage_snapshot => nothing is written and the blocker names the missing API', () => {
    const db = getDb()
    const res = syncAnthropicUsageSnapshot(db, NOW, {
      config: { version: 1, subscriptions: [{ ...MANUAL_CONFIG.subscriptions[0], usage_snapshot: undefined }] },
    })
    expect(res.status).toBe('skipped')
    expect(res.imported_count).toBe(0)
    expect(res.blocker).toMatch(/no quota API/i)
    // Crucially: no fabricated 0% row.
    expect(latestRateLimitSnapshot(db, 'anthropic')).toBeNull()
  })

  it('8. an out-of-range or non-finite percentage is refused, not clamped into a plausible row', () => {
    const db = getDb()
    for (const bad of [NaN, Infinity, -1, 101]) {
      expect(() => writeRateLimitSnapshot(db, {
        provider: 'x', usedPercent: bad, source: 'provider_metadata_api', confidence: 'measured',
        dedupKey: `bad-${bad}`, capturedAt: NOW,
      })).toThrow(/0\.\.100/)
    }
  })
})
