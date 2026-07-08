// CostOps v0.8 -- limits/quota normalization (card 6f4d1332 §6.2).
//
// Genuinely additive glue code: reads 4 already-existing raw sources (subscription lifecycle,
// DeepSeek balance snapshots, Workspace alerts, Render build-minutes + SSL/domain expiry) and
// normalizes them into ONE shape so warnings.ts's tiered limit rule (§6) can apply uniformly.
// No new storage. usage_pct is ALWAYS "fraction of the limit consumed" (0 = nothing used, 1 =
// fully consumed) across every limit_type, so a single threshold ladder works for all of them.
// Honest gaps stay honest: no numeric ceiling exists for Claude Max/ChatGPT/Render build-minutes
// (confirmed against costops-subscriptions.json's schema and Render's events API) -- those
// render usage_pct: null, status: 'unknown', never an invented percentage.

import type Database from 'better-sqlite3'
import type { SubscriptionLifecycle } from './subscriptions.js'
import { getActiveWorkspaceAlerts } from './workspace-alerts.js'
import { checkRenderBuildMinutes } from './render-live-checks.js'
import { loadDomainsConfig, checkSslExpiry, checkDomainExpiry, EXPIRY_THRESHOLDS } from './expiry-checks.js'

export type LimitStatusTier = 'ok' | 'warning' | 'critical' | 'blocked' | 'unknown'

export interface LimitStatus {
  provider: string
  limit_type: string
  current_usage: number | null
  limit_value: number | null
  usage_pct: number | null       // 0..1, fraction CONSUMED (never a %-remaining inversion)
  reset_date: string | null
  paid_until: string | null
  expiry_date: string | null
  status: LimitStatusTier
  source: string                 // 'config' | 'ledger' | 'render_api' | 'workspace_alert' | 'tls' | 'rdap'
}

function tierForPct(pct: number | null): LimitStatusTier {
  if (pct === null) return 'unknown'
  if (pct >= 1.0) return 'blocked'
  if (pct >= 0.9) return 'critical'
  if (pct >= 0.7) return 'warning'
  return 'ok'
}

function tierForDays(days: number | null): LimitStatusTier {
  if (days === null) return 'unknown'
  if (days < 0) return 'blocked'
  if (days <= EXPIRY_THRESHOLDS.critical) return 'critical'
  if (days <= EXPIRY_THRESHOLDS.warn) return 'warning'
  return 'ok'
}

// ---- 1. Subscription lifecycle (renewal/cancellation dates -- date-based, not %-based unless
// an optional weekly_limit_tokens/five_hour_limit_tokens ceiling is present, see SubscriptionEntry) ---
function fromSubscriptions(subs: SubscriptionLifecycle[]): LimitStatus[] {
  const out: LimitStatus[] = []
  for (const s of subs) {
    const targetDate = s.status === 'canceled' ? s.paid_until : s.next_renewal
    if (!targetDate) continue
    out.push({
      provider: s.provider, limit_type: 'subscription_renewal',
      current_usage: null, limit_value: null, usage_pct: null,
      reset_date: s.status === 'active' ? s.next_renewal ?? null : null,
      paid_until: s.status === 'canceled' ? s.paid_until ?? null : null,
      expiry_date: null,
      status: s.past_due ? 'blocked' : tierForDays(s.days_until_next_date),
      source: 'config',
    })
    // Optional token ceiling (v0.8): only emitted when Istvan has actually supplied one --
    // never a fabricated limit_value. Current usage cross-referencing against token_usage by
    // agent is future work (no agent<->subscription mapping exists yet) -- honestly unknown
    // for now, matching the spec's "recommend, don't build speculatively" instruction.
    if (s.weekly_limit_tokens || s.five_hour_limit_tokens) {
      out.push({
        provider: s.provider, limit_type: s.weekly_limit_tokens ? 'weekly_tokens' : 'five_hour_tokens',
        current_usage: null, limit_value: s.weekly_limit_tokens ?? s.five_hour_limit_tokens ?? null,
        usage_pct: null, reset_date: null, paid_until: null, expiry_date: null,
        status: 'unknown', source: 'config',
      })
    }
  }
  return out
}

// ---- 2. DeepSeek prepaid balance (same data/logic already in warnings.ts rule 10, normalized) ---
function fromDeepSeekBalance(db: Database.Database): LimitStatus[] {
  const rows = db.prepare(
    `SELECT balance, currency, captured_at FROM provider_balance_snapshots WHERE provider = 'deepseek' ORDER BY captured_at DESC`,
  ).all() as Array<{ balance: number; currency: string; captured_at: number }>
  if (rows.length === 0) {
    return [{
      provider: 'deepseek', limit_type: 'balance', current_usage: null, limit_value: null,
      usage_pct: null, reset_date: null, paid_until: null, expiry_date: null,
      status: 'unknown', source: 'ledger',
    }]
  }
  const latest = rows[0].balance
  const peak = Math.max(...rows.map(r => r.balance))
  const hadObservedDrop = peak > latest
  // usage_pct here means fraction of the peak (last top-up) already SPENT -- consistent with
  // every other limit_type's "fraction consumed" convention (inverse of warnings.ts's own
  // "% remaining vs peak" framing, which is display-oriented, not a consumed-fraction).
  const usage_pct = hadObservedDrop ? Math.round((1 - latest / peak) * 10000) / 10000 : null
  return [{
    provider: 'deepseek', limit_type: 'balance', current_usage: latest, limit_value: peak,
    usage_pct, reset_date: null, paid_until: null, expiry_date: null,
    status: tierForPct(usage_pct), source: 'ledger',
  }]
}

// ---- 3. Workspace payment/suspension alerts -----------------------------------------------
function fromWorkspaceAlerts(db: Database.Database, now: number): LimitStatus[] {
  const rows = getActiveWorkspaceAlerts(db, now)
  const seen = new Set<string>()
  const out: LimitStatus[] = []
  for (const r of rows) {
    const key = `${r.account}|${r.issue_type}`
    if (seen.has(key)) continue
    seen.add(key)
    const daysRemaining = r.suspension_date !== null ? Math.floor((r.suspension_date - now) / 86400) : null
    out.push({
      provider: 'google-workspace', limit_type: 'workspace_payment',
      current_usage: null, limit_value: null, usage_pct: null,
      reset_date: null, paid_until: null,
      expiry_date: r.suspension_date !== null ? new Date(r.suspension_date * 1000).toISOString().slice(0, 10) : null,
      status: r.issue_type === 'suspended' ? 'blocked' : tierForDays(daysRemaining) === 'unknown' ? 'warning' : tierForDays(daysRemaining),
      source: 'workspace_alert',
    })
  }
  return out
}

// ---- 4. Render build-minutes + SSL/domain expiry (live network checks -> normalized) --------
async function fromLiveChecks(now: number, sslHosts: string[], domains: string[]): Promise<LimitStatus[]> {
  const out: LimitStatus[] = []
  const [renderWarnings, sslWarnings, domainWarnings] = await Promise.all([
    checkRenderBuildMinutes(now),
    checkSslExpiry(sslHosts, now),
    checkDomainExpiry(domains, now),
  ])
  for (const w of renderWarnings) {
    if (w.code !== 'render_build_minutes_exhausted') continue // access-failure warnings aren't a limit signal
    out.push({
      provider: 'render', limit_type: 'build_minutes', current_usage: null, limit_value: null,
      usage_pct: 1.0, reset_date: null, paid_until: null, expiry_date: null,
      status: 'blocked', source: 'render_api',
    })
  }
  for (const w of sslWarnings) {
    out.push({
      provider: String(w.provider || 'ssl'), limit_type: 'ssl_expiry',
      current_usage: w.current_value ?? null, limit_value: w.threshold ?? null, usage_pct: null,
      reset_date: null, paid_until: null, expiry_date: w.expiry_date ?? w.due_date ?? null,
      status: w.severity === 'high' ? 'critical' : w.severity === 'medium' ? 'warning' : 'warning',
      source: 'tls',
    })
  }
  for (const w of domainWarnings) {
    out.push({
      provider: String(w.provider || 'domain'), limit_type: 'domain_expiry',
      current_usage: w.current_value ?? null, limit_value: w.threshold ?? null, usage_pct: null,
      reset_date: null, paid_until: null, expiry_date: w.expiry_date ?? w.due_date ?? null,
      status: w.severity === 'high' ? 'critical' : w.severity === 'medium' ? 'warning' : 'warning',
      source: 'rdap',
    })
  }
  return out
}

/**
 * Normalize every known limit/quota signal into one shape. Never fabricates a percentage --
 * a source with no real ceiling data (Claude Max weekly, ChatGPT, Render build-minutes below
 * 100%) reports usage_pct: null, status: 'unknown' rather than a guess.
 */
export async function getLimitStatus(
  db: Database.Database,
  now: number,
  subscriptions: SubscriptionLifecycle[],
): Promise<LimitStatus[]> {
  const { config: domainsConfig } = loadDomainsConfig()
  const [live] = await Promise.all([
    fromLiveChecks(now, domainsConfig.ssl_hosts, domainsConfig.domains),
  ])
  return [
    ...fromSubscriptions(subscriptions),
    ...fromDeepSeekBalance(db),
    ...fromWorkspaceAlerts(db, now),
    ...live,
  ]
}
