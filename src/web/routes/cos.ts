// LOCAL-FORK: cos seam (keep on rebase). Read-only Mission Control API for the
// Personal Chief of Staff (COS) case store. Serves the "Ma" (today) and
// "Ügyek" (all active) views from personal_cases. Read-only by design: this
// route never mutates a case — writes go through the domain-command layer
// (src/cos/case-store.ts), not the dashboard.
//
// Auth is centralized in src/web.ts (requiresAuth gates all /api/*), so every
// /api/cos/* path here is already Bearer-protected; no auth code needed.

import { json, readBody } from '../http-helpers.js'
import { getDb } from '../../db.js'
import { listActiveCases, listTodayCases } from '../../cos/case-store.js'
import { listActiveZstCases, listTodayZstCases } from '../../cos/zst-case-store.js'
import { ingestTriagedEmail, type TriagedEmail } from '../../cos/triage-bridge.js'
import { validateSkillMd, validateSkillPermissions } from '../../cos/skill-permission-validator.js'
import { APP_TZ } from '../../config.js'
import type { RouteContext } from './types.js'

// End of "today" in the app timezone, as a Unix-seconds horizon. Computed from
// the wall clock in APP_TZ so a case due later today is included but tomorrow's
// is not. Falls back to now+24h if the timezone math is unavailable.
export function endOfTodaySec(now: Date): number {
  try {
    // Seconds elapsed into the current local day (APP_TZ), then seconds left
    // until local midnight. No offset arithmetic, no DST edge cases.
    const [h, m, s] = new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(now).split(':').map(Number)
    const secsIntoDay = h * 3600 + m * 60 + s
    return Math.floor(now.getTime() / 1000) + (86400 - secsIntoDay) - 1 // local 23:59:59
  } catch {
    return Math.floor(now.getTime() / 1000) + 86400
  }
}

export async function tryHandleCos(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // The email-triage → COS intake bridge. The triage heartbeat POSTs a real
  // candidate here (with its verdict) to open/update a case. Idempotent per
  // (account, message). This is the ONLY /api/cos/* write path — the mutation
  // is confined to the intake domain logic.
  if (path === '/api/cos/intake' && method === 'POST') {
    let input: TriagedEmail
    try { input = JSON.parse((await readBody(req)).toString()) as TriagedEmail }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!input?.accountId || !input?.messageId || !input?.subject) {
      json(res, { error: 'accountId, messageId, subject required' }, 400); return true
    }
    const result = ingestTriagedEmail(getDb(), input, Math.floor(Date.now() / 1000))
    json(res, result)
    return true
  }

  // #5c: validate a skill's declared permissions before it is written/run. Accepts
  // either a raw SKILL.md (`{skillMd}`) or a parsed decl (`{permissions, sensitiveApproved}`).
  if (path === '/api/cos/skill-validate' && method === 'POST') {
    let input: { skillMd?: string; permissions?: string[]; sensitiveApproved?: boolean }
    try { input = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    const result = typeof input?.skillMd === 'string'
      ? validateSkillMd(input.skillMd)
      : validateSkillPermissions({ permissions: input?.permissions, sensitiveApproved: input?.sensitiveApproved })
    json(res, result)
    return true
  }

  if (path === '/api/cos/cases' && method === 'GET') {
    const cases = listActiveCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  // ZST Corporate Case Engine read views (Slice 0). Read-only, separate
  // namespace (zst_cases) — mirrors the personal cases/today endpoints. Writes
  // go through src/cos/zst-case-store.ts, never the dashboard.
  if (path === '/api/cos/zst-cases' && method === 'GET') {
    const cases = listActiveZstCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/zst-today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayZstCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  if (path === '/api/cos/outbound' && method === 'GET') {
    const outbound = listOutbound(getDb())
    json(res, { outbound, count: outbound.length })
    return true
  }

  if (path === '/api/cos/campaigns' && method === 'GET') {
    const campaigns = listCampaignsSummary(getDb())
    json(res, { campaigns, count: campaigns.length })
    return true
  }

  if (path === '/api/cos/radar' && method === 'GET') {
    const radar = listRadarSummary(getDb())
    json(res, { radar, count: radar.length })
    return true
  }

  if (path === '/api/cos/monitoring' && method === 'GET') {
    json(res, listMonitoring(getDb()))
    return true
  }

  if (path === '/api/cos/analytics' && method === 'GET') {
    json(res, listAnalytics(getDb()))
    return true
  }

  return false
}

/** GROUP BY helper → {value: count}. */
function countBy(db: ReturnType<typeof getDb>, sql: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of db.prepare(sql).all() as Array<{ k: string; n: number }>) out[r.k] = r.n
  return out
}
function scalar(db: ReturnType<typeof getDb>, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0
}

/**
 * COS analytics roll-up (#5d): aggregate counts over cases, the price radar, and
 * campaigns/outbound. Read-only, cheap GROUP BYs — the "campaign/radar analytics"
 * the spec §F names, plus a case overview.
 */
export function listAnalytics(db: ReturnType<typeof getDb>): {
  cases: { total: number; byStatus: Record<string, number>; bySensitivity: Record<string, number> }
  radar: { total: number; byStatus: Record<string, number>; observations: number; hits: number; notifications: number }
  campaigns: { total: number; byStatus: Record<string, number> }
  outbound: { total: number; byStatus: Record<string, number> }
} {
  return {
    cases: {
      total: scalar(db, `SELECT COUNT(*) n FROM personal_cases WHERE archived_at IS NULL`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY status`),
      bySensitivity: countBy(db, `SELECT sensitivity k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY sensitivity`),
    },
    radar: {
      total: scalar(db, `SELECT COUNT(*) n FROM radar_items`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM radar_items GROUP BY status`),
      observations: scalar(db, `SELECT COUNT(*) n FROM radar_observations`),
      hits: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE status='HIT'`),
      notifications: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE last_notified_at IS NOT NULL`),
    },
    campaigns: {
      total: scalar(db, `SELECT COUNT(*) n FROM campaigns`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM campaigns GROUP BY status`),
    },
    outbound: {
      total: scalar(db, `SELECT COUNT(*) n FROM outbound_ledger`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM outbound_ledger GROUP BY status`),
    },
  }
}

// Read-only summaries for the Mission Control views. Exported so they are unit-
// testable against a seeded DB (the route wrapper is not).

export function listOutbound(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT ledger_id, case_id, action_type, sequence_number, status, external_ref, attempt, updated_at
     FROM outbound_ledger ORDER BY created_at DESC LIMIT 50`
  ).all()
}

export function listCampaignsSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT c.campaign_id, c.case_id, c.campaign_type, c.status, c.version, c.allows_free_text,
        (SELECT COUNT(*) FROM campaign_approvals a WHERE a.campaign_id=c.campaign_id AND a.status='APPROVED'
           AND a.campaign_version=c.version) AS approved_current
     FROM campaigns c ORDER BY c.updated_at DESC LIMIT 50`
  ).all()
}

export function listRadarSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT r.radar_id, r.case_id, r.kind, r.label, r.target_price, r.currency, r.status,
        r.best_seen_price, r.next_check_at,
        (SELECT best_price FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_price,
        (SELECT observed_at FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_at
     FROM radar_items r ORDER BY r.updated_at DESC LIMIT 50`
  ).all()
}

/**
 * Operational monitoring for the Mission Control "Monitoring" view (#5b): the
 * connector-health matrix, an outbound-status roll-up with the rows that need a
 * HUMAN (RECOVERY_REQUIRED / FAILED_TERMINAL — the executor never auto-resolves
 * these), and send-quota usage. All read-only.
 */
export function listMonitoring(db: ReturnType<typeof getDb>): {
  connectors: unknown[]; outboundHealth: { byStatus: Record<string, number>; needsAttention: unknown[] }; quotas: unknown[]
} {
  const connectors = db.prepare(
    `SELECT connector_id, kind, mode, status, consecutive_failures, last_ok_at, last_error_at, last_error
     FROM connector_health ORDER BY connector_id`
  ).all()
  const statusRows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM outbound_ledger GROUP BY status`
  ).all() as Array<{ status: string; n: number }>
  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status] = r.n
  const needsAttention = db.prepare(
    `SELECT ledger_id, case_id, action_type, status, last_error, updated_at
     FROM outbound_ledger WHERE status IN ('RECOVERY_REQUIRED','FAILED_TERMINAL')
     ORDER BY updated_at DESC LIMIT 50`
  ).all()
  const quotas = db.prepare(
    `SELECT quota_key, used_count, max_count, window_sec, window_start FROM send_quotas ORDER BY quota_key`
  ).all()
  return { connectors, outboundHealth: { byStatus, needsAttention }, quotas }
}
