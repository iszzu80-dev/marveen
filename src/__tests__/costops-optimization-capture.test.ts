import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { monthWindow } from '../costops/ledger.js'
import { initOptimizationSchema } from '../costops/optimization.js'
import { SUBSCRIPTIONS_PATH } from '../costops/subscriptions.js'
import {
  gatherRecommendationCandidates,
  captureRecommendations,
  listRecommendations,
} from '../costops/optimization-capture.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function insertSource(db: ReturnType<typeof getDb>, id: string, provider: string, source_type: string): void {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'HUF', 1, ?, ?)`).run(id, id, provider, source_type, NOW, NOW)
}

function insertLine(db: ReturnType<typeof getDb>, opts: { source: string; start: number; end: number; amount: number; confidence: string; dedupKey: string }): void {
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at)
    VALUES (@source, @start, @end, 'usage', @amount, 'HUF', @confidence, @now, @dedupKey, @now)
  `).run({ source: opts.source, start: opts.start, end: opts.end, amount: opts.amount, confidence: opts.confidence, now: NOW, dedupKey: opts.dedupKey })
}

describe('gatherRecommendationCandidates -- duplicate hosting/SaaS (SQL-backed, no file I/O)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('flags two sources sharing the same provider + source_type', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    const candidates = gatherRecommendationCandidates(db, NOW)
    const dup = candidates.find(c => c.type === 'duplicate_hosting_saas')
    expect(dup).toBeDefined()
    expect(dup?.estimated_monthly_saving).toBe(8000) // 20000 total - 12000 max
  })

  it('does not flag a single source in a (provider, source_type) group', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    const candidates = gatherRecommendationCandidates(db, NOW)
    expect(candidates.find(c => c.type === 'duplicate_hosting_saas')).toBeUndefined()
  })
})

describe('gatherRecommendationCandidates -- automate long-manual-only source', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('fires after 3 consecutive manual-only periods, with zero fabricated saving', () => {
    const db = getDb()
    insertSource(db, 'always-manual', 'other', 'saas')
    const months = [NOW, NOW - 32 * 86400, NOW - 64 * 86400]
    months.forEach((t, i) => {
      const w = monthWindow(t)
      insertLine(db, { source: 'always-manual', start: w.start, end: w.end, amount: 500, confidence: 'manual', dedupKey: `m${i}` })
    })
    const candidates = gatherRecommendationCandidates(db, NOW)
    const a = candidates.find(c => c.type === 'automate_long_manual_source')
    expect(a).toBeDefined()
    expect(a?.estimated_monthly_saving).toBe(0)
    expect(a?.current_monthly_cost).toBe(500)
  })

  it('does not fire once a provider_api actual has landed', () => {
    const db = getDb()
    insertSource(db, 'now-real', 'render', 'hosting')
    const months = [NOW, NOW - 32 * 86400, NOW - 64 * 86400]
    months.forEach((t, i) => {
      const w = monthWindow(t)
      insertLine(db, { source: 'now-real', start: w.start, end: w.end, amount: 500, confidence: i === 0 ? 'provider_api' : 'manual', dedupKey: `p${i}` })
    })
    const candidates = gatherRecommendationCandidates(db, NOW)
    expect(candidates.find(c => c.type === 'automate_long_manual_source' && c.evidence.source_id === 'now-real')).toBeUndefined()
  })
})

describe('gatherRecommendationCandidates -- the 5 honestly-unwired types', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('never produces switch_to_annual_billing/unused_domain_or_storage/forgotten_service/oversized_fixed_package/provider_credit_or_discount (no live signal exists)', () => {
    const db = getDb()
    const candidates = gatherRecommendationCandidates(db, NOW)
    const unwired = ['switch_to_annual_billing', 'unused_domain_or_storage', 'forgotten_service', 'oversized_fixed_package', 'provider_credit_or_discount']
    for (const type of unwired) {
      expect(candidates.filter(c => c.type === type)).toEqual([])
    }
  })
})

function writeSubscriptionsFixture(content: unknown): void {
  mkdirSync(dirname(SUBSCRIPTIONS_PATH()), { recursive: true })
  writeFileSync(SUBSCRIPTIONS_PATH(), JSON.stringify(content))
}

describe('gatherRecommendationCandidates -- subscription-based (real file fixture)', () => {
  beforeEach(() => { initDatabase(':memory:') })
  afterEach(() => { if (existsSync(SUBSCRIPTIONS_PATH())) rmSync(SUBSCRIPTIONS_PATH()) })

  it('is empty (never fabricated) when no costops-subscriptions.json exists', () => {
    const db = getDb()
    const candidates = gatherRecommendationCandidates(db, NOW)
    expect(candidates.filter(c => c.type === 'underused_subscription_downgrade' || c.type === 'duplicate_subscription')).toEqual([])
  })

  it('flags an underused active subscription with a real usage_snapshot', () => {
    writeSubscriptionsFixture({
      version: 1,
      subscriptions: [
        { id: 'claude-max', name: 'Claude Max', provider: 'anthropic', source: 'config', status: 'active', amount: 22000, amount_source: 'manual_fallback', usage_snapshot: { as_of: '2026-07-15T00:00:00Z', session_pct: 2, weekly_pct: 3, weekly_reset_label: 'Tue' } },
      ],
    })
    const db = getDb()
    const candidates = gatherRecommendationCandidates(db, NOW)
    const rec = candidates.find(c => c.type === 'underused_subscription_downgrade')
    expect(rec).toBeDefined()
    expect(rec?.current_monthly_cost).toBe(22000)
    expect(rec?.risk).toBe('medium') // cancel-only path, no known downgrade tier
  })

  it('flags duplicate subscriptions sharing the same provider', () => {
    writeSubscriptionsFixture({
      version: 1,
      subscriptions: [
        { id: 'claude-max', name: 'Claude Max', provider: 'anthropic', source: 'config', status: 'active', amount: 22000, amount_source: 'manual_fallback' },
        { id: 'claude-pro', name: 'Claude Pro', provider: 'anthropic', source: 'config', status: 'active', amount: 8000, amount_source: 'manual_fallback' },
      ],
    })
    const db = getDb()
    const candidates = gatherRecommendationCandidates(db, NOW)
    const rec = candidates.find(c => c.type === 'duplicate_subscription')
    expect(rec).toBeDefined()
    expect(rec?.estimated_monthly_saving).toBe(8000)
  })

  it('does not flag a canceled subscription as underused', () => {
    writeSubscriptionsFixture({
      version: 1,
      subscriptions: [
        { id: 'old-sub', name: 'Old', provider: 'openai', source: 'config', status: 'canceled', amount: 5000, amount_source: 'manual_fallback', usage_snapshot: { as_of: '2026-07-15T00:00:00Z', session_pct: 1, weekly_pct: 1, weekly_reset_label: 'Tue' } },
      ],
    })
    const db = getDb()
    const candidates = gatherRecommendationCandidates(db, NOW)
    expect(candidates.find(c => c.type === 'underused_subscription_downgrade')).toBeUndefined()
  })
})

describe('captureRecommendations persistence round-trip', () => {
  beforeEach(() => { initDatabase(':memory:'); initOptimizationSchema(getDb()) })

  it('inserts new open recommendations on first capture', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    const summary = captureRecommendations(db, NOW)
    expect(summary.inserted).toBeGreaterThanOrEqual(1)
    const open = listRecommendations(db)
    expect(open.some(r => r.type === 'duplicate_hosting_saas' && r.status === 'open')).toBe(true)
  })

  it('dedups on a second capture -- no duplicate row, only a touch', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    captureRecommendations(db, NOW)
    const second = captureRecommendations(db, NOW + 3600)
    expect(second.inserted).toBe(0)
    const rows = db.prepare(`SELECT COUNT(*) as n FROM costops_recommendations WHERE type = 'duplicate_hosting_saas'`).get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('resolves a recommendation once its condition disappears', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    captureRecommendations(db, NOW)
    db.prepare(`UPDATE cost_line_items SET voided_at = ? WHERE dedup_key = 'd2'`).run(NOW + 100) // only one source left -- no more duplicate
    const summary = captureRecommendations(db, NOW + 3600)
    expect(summary.resolved).toBeGreaterThanOrEqual(1)
    const open = listRecommendations(db)
    expect(open.find(r => r.type === 'duplicate_hosting_saas')).toBeUndefined()
    const resolvedRow = listRecommendations(db, { status: 'resolved' }).find(r => r.type === 'duplicate_hosting_saas')
    expect(resolvedRow).toBeDefined()
  })

  it('freezes an accepted recommendation -- captureRecommendations never reverts it back to open', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    captureRecommendations(db, NOW)
    db.prepare(`UPDATE costops_recommendations SET status='accepted', status_changed_at=?, status_changed_by='istvan' WHERE type='duplicate_hosting_saas'`).run(NOW)
    const summary = captureRecommendations(db, NOW + 3600) // condition still detected this round
    expect(summary.touched).toBe(0)
    const row = db.prepare(`SELECT status FROM costops_recommendations WHERE type = 'duplicate_hosting_saas'`).get() as { status: string }
    expect(row.status).toBe('accepted')
  })

  it('expires an unaddressed open recommendation past its expiry window', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })
    captureRecommendations(db, NOW, { expirySeconds: 100 })
    const summary = captureRecommendations(db, NOW + 200, { expirySeconds: 100 }) // still detected, but past expiry
    expect(summary.expired).toBeGreaterThanOrEqual(1)
    const expiredRow = listRecommendations(db, { status: 'expired' }).find(r => r.type === 'duplicate_hosting_saas')
    expect(expiredRow).toBeDefined()
  })

  // COS-OPS-C1: an expired recommendation being re-detected used to be routed
  // into a plain INSERT against the UNIQUE dedup_key -- so the FIRST capture
  // after the ~90-day expiry threw SQLITE_CONSTRAINT_UNIQUE and (inserts
  // running first, no transaction) killed every other recommendation's
  // touch/resolve/expire in the same run, on every subsequent daily capture.
  it('COS-OPS-C1: detect -> expire -> re-detect on a third capture succeeds, the row is open again, and the OTHER recommendation is still processed in the same capture', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    // Recommendation A: the render hosting duplicate (will expire and resurface).
    insertSource(db, 'render-hosting-1', 'render', 'hosting')
    insertSource(db, 'render-hosting-2', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting-1', start: win.start, end: win.end, amount: 12000, confidence: 'manual', dedupKey: 'd1' })
    insertLine(db, { source: 'render-hosting-2', start: win.start, end: win.end, amount: 8000, confidence: 'manual', dedupKey: 'd2' })

    // Capture 1: A is inserted open with a short expiry.
    captureRecommendations(db, NOW, { expirySeconds: 100 })

    // Recommendation B: a netlify saas duplicate, appearing before capture 2 --
    // its later expiry keeps it open through capture 3.
    insertSource(db, 'netlify-saas-1', 'netlify', 'saas')
    insertSource(db, 'netlify-saas-2', 'netlify', 'saas')
    insertLine(db, { source: 'netlify-saas-1', start: win.start, end: win.end, amount: 6000, confidence: 'manual', dedupKey: 'n1' })
    insertLine(db, { source: 'netlify-saas-2', start: win.start, end: win.end, amount: 4000, confidence: 'manual', dedupKey: 'n2' })

    // Capture 2: A is still detected but past its expiry -> expired; B inserted open.
    const second = captureRecommendations(db, NOW + 200, { expirySeconds: 100 })
    expect(second.expired).toBe(1)
    expect(second.inserted).toBe(1)

    // Capture 3: A is re-detected while its row sits 'expired'. Pre-fix this
    // threw SQLITE_CONSTRAINT_UNIQUE and B's touch never ran.
    const third = captureRecommendations(db, NOW + 250, { expirySeconds: 100 })
    expect(third.inserted).toBe(1) // A resurfacing, as the reconciler's "fresh record"
    expect(third.touched).toBe(1)  // B's lifecycle still processed in the same capture

    // A is a single physical row again, open, with fully reset lifecycle fields.
    const a = db.prepare(`SELECT status, first_seen, last_seen, expires_at, status_changed_at, status_changed_by, COUNT(*) OVER () AS n FROM costops_recommendations WHERE dedup_key = 'duplicate_hosting_saas|render|hosting'`).get() as { status: string; first_seen: number; last_seen: number; expires_at: number; status_changed_at: number | null; status_changed_by: string | null; n: number }
    expect(a.n).toBe(1)
    expect(a.status).toBe('open')
    expect(a.first_seen).toBe(NOW + 250)
    expect(a.last_seen).toBe(NOW + 250)
    expect(a.expires_at).toBe(NOW + 250 + 100)
    expect(a.status_changed_at).toBeNull()
    expect(a.status_changed_by).toBeNull()

    // B is untouched by A's resurfacing -- still open, last_seen refreshed.
    const b = db.prepare(`SELECT status, last_seen FROM costops_recommendations WHERE dedup_key = 'duplicate_hosting_saas|netlify|saas'`).get() as { status: string; last_seen: number }
    expect(b.status).toBe('open')
    expect(b.last_seen).toBe(NOW + 250)
  })
})
