// COS-CORE-M8: recommendations-store accept/dismiss were the two doors that
// could silently flip an already-decided (dismissed/resolved/expired/accepted)
// record and lose the earlier human decision -- every other status transition
// in this domain is 409-guarded. Only an 'open' record may take a decision;
// anything else refuses with the store's standard {ok:false, error, status}
// result shape (the routes map status straight to HTTP).

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initOptimizationSchema } from '../costops/optimization.js'
import {
  acceptRecommendationByKey,
  dismissRecommendationByKey,
  listRecommendations,
} from '../costops/recommendations-store.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function seedRecommendation(db: ReturnType<typeof getDb>, dedupKey: string, status: string, opts: { statusChangedBy?: string | null; statusChangedAt?: number | null } = {}): void {
  db.prepare(`
    INSERT INTO costops_recommendations
      (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving,
       switching_cost, risk, confidence, human_decision_required, rollback_note, status,
       status_changed_at, status_changed_by, expires_at, first_seen, last_seen, created_at)
    VALUES ('duplicate_tool', '[]', @dedup_key, 10000, 5000, 60000, 0, 'low', 'high', 'yes', 'n/a', @status,
       @status_changed_at, @status_changed_by, NULL, @now, @now, @now)
  `).run({ dedup_key: dedupKey, status, status_changed_at: opts.statusChangedAt ?? null, status_changed_by: opts.statusChangedBy ?? null, now: NOW })
}

describe('recommendations-store accept/dismiss status guard (COS-CORE-M8)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initOptimizationSchema(getDb())
  })

  it('an open recommendation accepts normally', () => {
    const db = getDb()
    seedRecommendation(db, 'rec-1', 'open')
    const r = acceptRecommendationByKey(db, 'rec-1', 'istvan', NOW + 10)
    expect(r.ok).toBe(true)
    expect(r.recommendation!.status).toBe('accepted')
    expect(r.recommendation!.status_changed_by).toBe('istvan')
  })

  it('an open recommendation dismisses normally', () => {
    const db = getDb()
    seedRecommendation(db, 'rec-1', 'open')
    const r = dismissRecommendationByKey(db, 'rec-1', 'istvan', NOW + 10)
    expect(r.ok).toBe(true)
    expect(r.recommendation!.status).toBe('dismissed')
  })

  for (const frozen of ['accepted', 'dismissed', 'resolved', 'expired'] as const) {
    it(`a '${frozen}' recommendation refuses accept with 409 and keeps the earlier decision`, () => {
      const db = getDb()
      seedRecommendation(db, 'rec-1', frozen, { statusChangedBy: 'istvan', statusChangedAt: NOW - 100 })
      const r = acceptRecommendationByKey(db, 'rec-1', 'someone-else', NOW + 10)
      expect(r.ok).toBe(false)
      expect(r.status).toBe(409)
      expect(r.error).toContain(`'${frozen}'`)
      const row = listRecommendations(db, { status: 'all' }).find(x => x.dedup_key === 'rec-1')!
      expect(row.status).toBe(frozen)
      expect(row.status_changed_by).toBe('istvan')       // the earlier decision stands
      expect(row.status_changed_at).toBe(NOW - 100)
    })

    it(`a '${frozen}' recommendation refuses dismiss with 409 and keeps the earlier decision`, () => {
      const db = getDb()
      seedRecommendation(db, 'rec-1', frozen, { statusChangedBy: 'istvan', statusChangedAt: NOW - 100 })
      const r = dismissRecommendationByKey(db, 'rec-1', 'someone-else', NOW + 10)
      expect(r.ok).toBe(false)
      expect(r.status).toBe(409)
      const row = listRecommendations(db, { status: 'all' }).find(x => x.dedup_key === 'rec-1')!
      expect(row.status).toBe(frozen)
      expect(row.status_changed_by).toBe('istvan')
    })
  }

  it('a missing dedup_key is still a 404, not a 409', () => {
    const db = getDb()
    const r = acceptRecommendationByKey(db, 'no-such-key', 'istvan', NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('a missing actor is still a 400 (unchanged validation)', () => {
    const db = getDb()
    seedRecommendation(db, 'rec-1', 'open')
    expect(acceptRecommendationByKey(db, 'rec-1', '  ', NOW).status).toBe(400)
    expect(dismissRecommendationByKey(db, 'rec-1', '', NOW).status).toBe(400)
  })
})
