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
import { ingestTriagedEmail, type TriagedEmail } from '../../cos/triage-bridge.js'
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

  return false
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
