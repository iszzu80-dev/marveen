import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import type { PackageRecommendation } from '../costops/portfolio-recommendation.js'
import {
  getOptimizationDecisionEvents,
  initOptimizationDecisionsSchema,
  listOptimizationDecisions,
  OPTIMIZATION_DECISIONS_FORBIDDEN_CALLS,
  setDecisionStatus,
  upsertDecisionsFromRecommendations,
} from '../optimization/optimization-decisions.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

function recommendation(
  overrides: Partial<PackageRecommendation> = {},
): PackageRecommendation {
  return {
    package_id: 'package-a',
    verdict: 'KEEP',
    evidence: [{
      label: 'price_huf',
      value: 30_000,
      currency: 'HUF',
      confidence: 'measured',
      blocker: null,
    }],
    confidence: 'measured',
    blocker: null,
    window: { from: NOW - 30 * 24 * 60 * 60, to: NOW },
    generated_at: NOW,
    ...overrides,
  }
}

describe('optimization decision schema and audit trail', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initOptimizationDecisionsSchema(getDb())
  })

  it('creates both tables idempotently', () => {
    expect(() => initOptimizationDecisionsSchema(getDb())).not.toThrow()
    const rows = getDb().prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'optimization_decisions',
        'optimization_decision_events'
      )
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(rows.map(row => row.name)).toEqual([
      'optimization_decision_events',
      'optimization_decisions',
    ])
  })

  it('inserts new and insufficient-evidence statuses with one first-observed event', () => {
    const result = upsertDecisionsFromRecommendations(getDb(), [
      recommendation(),
      recommendation({
        package_id: 'package-unknown',
        verdict: 'INSUFFICIENT_EVIDENCE',
        confidence: 'unknown',
        blocker: 'missing price',
      }),
    ], NOW)

    expect(result).toEqual({ inserted: 2, touched: 0 })
    expect(listOptimizationDecisions(getDb()).map(row => [row.package_id, row.status])).toEqual([
      ['package-a', 'new'],
      ['package-unknown', 'insufficient_evidence'],
    ])
    const events = getOptimizationDecisionEvents(getDb(), 'package-a')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      from_status: null,
      to_status: 'new',
      actor: 'system',
      note: 'first observed',
    })
  })

  it('refreshes data without audit spam when a new item has the same verdict', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation()], NOW)
    const refreshed = recommendation({
      evidence: [{
        label: 'price_huf',
        value: 31_000,
        currency: 'HUF',
        confidence: 'measured',
        blocker: null,
      }],
    })
    const result = upsertDecisionsFromRecommendations(getDb(), [refreshed], NOW + 60)

    expect(result).toEqual({ inserted: 0, touched: 1 })
    const [record] = listOptimizationDecisions(getDb())
    expect(record.updated_at).toBe(NOW + 60)
    expect(JSON.parse(record.evidence_json)[0].value).toBe(31_000)
    expect(getOptimizationDecisionEvents(getDb(), 'package-a')).toHaveLength(1)
  })

  it('reopens an executed package when its verdict changes and records why', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation()], NOW)
    setDecisionStatus(getDb(), 'package-a', 'executed', 'owner', NOW + 10)
    upsertDecisionsFromRecommendations(
      getDb(),
      [recommendation({ verdict: 'DOWNGRADE' })],
      NOW + 20,
    )

    const [record] = listOptimizationDecisions(getDb())
    expect(record.status).toBe('new')
    expect(record.verdict).toBe('DOWNGRADE')
    expect(record.status_changed_by).toBe('system')
    const events = getOptimizationDecisionEvents(getDb(), 'package-a')
    expect(events.at(-1)).toMatchObject({
      from_status: 'executed',
      to_status: 'new',
      actor: 'system',
      note: 'verdict changed from KEEP to DOWNGRADE, reopened for review',
    })
  })

  it('leaves a deferred human review untouched even when computed verdict data changes', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation()], NOW)
    setDecisionStatus(getDb(), 'package-a', 'deferred', 'owner', NOW + 10, {
      deferredUntil: NOW + 3600,
      note: 'awaiting contract detail',
    })
    const eventsBefore = getOptimizationDecisionEvents(getDb(), 'package-a')

    // Deliberate: deferred is mid-review, so even a changed verdict updates
    // evidence data but must not overwrite the human's workflow state.
    upsertDecisionsFromRecommendations(
      getDb(),
      [recommendation({ verdict: 'CANCEL' })],
      NOW + 20,
    )

    // Explicit read clock: OPT-M5's read-time promotion would otherwise use
    // the REAL wall clock, which is past this fixture's 2026-07-30 deferral.
    const [record] = listOptimizationDecisions(getDb(), {}, NOW + 20)
    expect(record.status).toBe('deferred')
    expect(record.verdict).toBe('CANCEL')
    expect(record.status_changed_by).toBe('owner')
    expect(record.deferred_until).toBe(NOW + 3600)
    expect(getOptimizationDecisionEvents(getDb(), 'package-a')).toEqual(eventsBefore)
  })

  it('OPT-M5: an insufficient_evidence decision reopens as new the moment an actionable verdict arrives', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation({
      package_id: 'package-thin',
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 'unknown',
      blocker: 'missing price',
    })], NOW)
    expect(listOptimizationDecisions(getDb(), {}, NOW)[0].status).toBe('insufficient_evidence')

    upsertDecisionsFromRecommendations(getDb(), [recommendation({
      package_id: 'package-thin',
      verdict: 'DOWNGRADE',
    })], NOW + 60)

    const [record] = listOptimizationDecisions(getDb(), {}, NOW + 60)
    expect(record.status).toBe('new')
    expect(record.verdict).toBe('DOWNGRADE')
    const events = getOptimizationDecisionEvents(getDb(), 'package-thin')
    expect(events.at(-1)).toMatchObject({
      from_status: 'insufficient_evidence',
      to_status: 'new',
      actor: 'system',
    })
  })

  it('OPT-M5 counterpart: a still-INSUFFICIENT_EVIDENCE refresh does NOT reopen -- there is nothing to act on yet', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation({
      package_id: 'package-thin',
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 'unknown',
      blocker: 'missing price',
    })], NOW)
    upsertDecisionsFromRecommendations(getDb(), [recommendation({
      package_id: 'package-thin',
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 'unknown',
      blocker: 'still missing price',
    })], NOW + 60)

    const [record] = listOptimizationDecisions(getDb(), {}, NOW + 60)
    expect(record.status).toBe('insufficient_evidence')
    expect(getOptimizationDecisionEvents(getDb(), 'package-thin')).toHaveLength(1)
  })

  it('OPT-M5: a deferred decision whose deferred_until has passed resurfaces as new at read time, with an audit event', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation()], NOW)
    setDecisionStatus(getDb(), 'package-a', 'deferred', 'owner', NOW + 10, {
      deferredUntil: NOW + 3600,
      note: 'revisit after renewal',
    })

    const [record] = listOptimizationDecisions(getDb(), {}, NOW + 3600)
    expect(record.status).toBe('new')
    expect(record.deferred_until).toBeNull()
    expect(record.status_changed_by).toBe('system')
    const events = getOptimizationDecisionEvents(getDb(), 'package-a')
    expect(events.at(-1)).toMatchObject({
      from_status: 'deferred',
      to_status: 'new',
      actor: 'system',
      note: 'deferred_until elapsed, resurfaced for review',
    })
  })

  it('OPT-M5 counterpart: a future deferred_until stays deferred, and an indefinite (NULL) defer is never promoted', () => {
    upsertDecisionsFromRecommendations(getDb(), [
      recommendation({ package_id: 'package-dated' }),
      recommendation({ package_id: 'package-indefinite' }),
    ], NOW)
    setDecisionStatus(getDb(), 'package-dated', 'deferred', 'owner', NOW + 10, { deferredUntil: NOW + 3600 })
    setDecisionStatus(getDb(), 'package-indefinite', 'deferred', 'owner', NOW + 10)

    const records = listOptimizationDecisions(getDb(), {}, NOW + 3599)
    expect(records.find(r => r.package_id === 'package-dated')!.status).toBe('deferred')
    expect(records.find(r => r.package_id === 'package-indefinite')!.status).toBe('deferred')
    // Even far past, the indefinite defer holds: NULL means "until a human returns".
    const later = listOptimizationDecisions(getDb(), {}, NOW + 10 * 24 * 3600)
    expect(later.find(r => r.package_id === 'package-indefinite')!.status).toBe('deferred')
  })

  it('returns package_not_found without throwing for an unknown package', () => {
    expect(setDecisionStatus(
      getDb(),
      'missing-package',
      'viewed',
      'owner',
      NOW,
    )).toEqual({ ok: false, error: 'package_not_found', record: null })
  })

  it('appends one event on every status call instead of overwriting audit history', () => {
    upsertDecisionsFromRecommendations(getDb(), [recommendation()], NOW)
    const baseline = getOptimizationDecisionEvents(getDb(), 'package-a').length

    setDecisionStatus(getDb(), 'package-a', 'viewed', 'owner', NOW + 1)
    setDecisionStatus(getDb(), 'package-a', 'accepted', 'owner', NOW + 2)
    setDecisionStatus(getDb(), 'package-a', 'executed', 'owner', NOW + 3)

    const events = getOptimizationDecisionEvents(getDb(), 'package-a')
    expect(events).toHaveLength(baseline + 3)
    expect(events.slice(-3).map(event => [event.from_status, event.to_status])).toEqual([
      ['new', 'viewed'],
      ['viewed', 'accepted'],
      ['accepted', 'executed'],
    ])
  })

  it('contains none of the forbidden network or process call substrings', () => {
    const source = readFileSync(
      join(__dirname, '../optimization/optimization-decisions.ts'),
      'utf-8',
    )
    for (const forbidden of OPTIMIZATION_DECISIONS_FORBIDDEN_CALLS) {
      expect(source.includes(forbidden)).toBe(false)
    }
  })
})
