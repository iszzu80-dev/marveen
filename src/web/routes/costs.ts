// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// No writes from the client: the only DB write is an idempotent reconciliation
// of the local config's fixed costs into the ledger on a summary read. No LLM,
// no provider API, no secrets in the response.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { loadPricingConfig } from '../../costops/pricing.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources, monthWindow } from '../../costops/ledger.js'
import { getPeriodTrend } from '../../costops/period.js'
import { loadSubscriptionsConfig, deriveLifecycle } from '../../costops/subscriptions.js'
import { getWarnings } from '../../costops/warnings.js'
import { exportCostRows, rowsToCsv } from '../../costops/export.js'
import { ingestWorkspaceAlerts, buildWorkspaceAlertWarnings } from '../../costops/workspace-alerts.js'
import { checkRenderBuildMinutes } from '../../costops/render-live-checks.js'
import { loadDomainsConfig, checkSslExpiry, checkDomainExpiry } from '../../costops/expiry-checks.js'
import { getTokenCostByAgent } from '../../costops/pricing.js'
import { getLimitStatus } from '../../costops/limits.js'
import type { RouteContext } from './types.js'

export async function tryHandleCosts(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/costs/summary' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const { pricing, exists: pricingExists } = loadPricingConfig()
      const db = getDb()
      // Idempotent: reflect the local config's fixed monthly costs into the
      // ledger for this month (upsert by dedup_key). Deterministic, no LLM.
      syncFixedCostsToLedger(db, config, now, monthKey)
      const summary = getCostSummary(db, config, now, {
        monthKey, configExists: exists, configErrors: errors, pricing, pricingExists,
      })
      json(res, summary)
    } catch (err) {
      logger.error({ err }, 'CostOps summary failed')
      json(res, { error: 'Cost summary failed' }, 500)
    }
    return true
  }

  // v0.5: sync spine -- run the Render collector LIVE (read-only GET) + idempotent import.
  // Bearer-gated (like every /api/*). NO provider-side write; same-month re-run is idempotent.
  if (path === '/api/costs/sync' && method === 'POST') {
    try {
      const provider = url.searchParams.get('provider') || 'render'
      const now = Math.floor(Date.now() / 1000)
      const db = getDb()
      let result: { ok: boolean }
      if (provider === 'render') {
        const { syncRenderCollector } = await import('../../costops/collectors/render.js')
        result = await syncRenderCollector(db, now)
      } else if (provider === 'openai') {
        // LIVE read-only OpenAI Costs API sync; admin key pulled from the Vault, never logged.
        const { syncOpenAiCollector } = await import('../../costops/collectors/openai.js')
        result = await syncOpenAiCollector(db, now)
      } else if (provider === 'github') {
        // LIVE read-only GitHub billing usage sync; PAT pulled from the Vault, never logged.
        const { syncGitHubCollector } = await import('../../costops/collectors/github.js')
        result = await syncGitHubCollector(db, now)
      } else if (provider === 'deepseek') {
        // LIVE read-only DeepSeek prepaid-balance sync; key from the Vault, never logged.
        const { syncDeepSeekBalance } = await import('../../costops/collectors/deepseek.js')
        result = await syncDeepSeekBalance(db, now)
      } else {
        json(res, { error: `unsupported provider '${provider}' (supported: render, openai, github, deepseek)` }, 400); return true
      }
      json(res, result, result.ok ? 200 : 502)
    } catch (err) {
      logger.error({ err }, 'CostOps sync failed')
      json(res, { ok: false, error: 'sync failed' }, 500)
    }
    return true
  }

  // Email-sourced cost ingest: an agent-side Gmail sweep POSTs structured receipt
  // entries here. Idempotent per (email, month). No raw email content is stored.
  if (path === '/api/costs/email-ingest' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}') as { entries?: unknown }
      const entries = Array.isArray(body?.entries) ? body.entries : []
      const now = Math.floor(Date.now() / 1000)
      let fxUsdHuf = 0
      let fxEurHuf = 0
      try {
        const { loadRenderPricing } = await import('../../costops/collectors/render.js')
        const p = loadRenderPricing().pricing
        fxUsdHuf = p.fx_usd_huf || 0
        fxEurHuf = p.fx_eur_huf || 0
      } catch { /* fx 0 -> USD/EUR entries flagged */ }
      const { ingestEmailCosts } = await import('../../costops/email-ingest.js')
      const result = ingestEmailCosts(getDb(), entries as import('../../costops/email-ingest.js').EmailCostEntry[], { fxUsdHuf, fxEurHuf, now })
      json(res, { ok: result.errors.length === 0, ...result })
    } catch (err) {
      logger.error({ err }, 'CostOps email-ingest failed')
      json(res, { ok: false, error: 'email-ingest failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/sources' && method === 'GET') {
    try {
      json(res, getCostSources(getDb()))
    } catch (err) {
      logger.error({ err }, 'CostOps sources failed')
      json(res, { error: 'Cost sources failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      json(res, config.budgets)
    } catch (err) {
      logger.error({ err }, 'CostOps budgets failed')
      json(res, { error: 'Cost budgets failed' }, 500)
    }
    return true
  }

  // v0.7: monthly close / period view -- current + previous + last-N trend,
  // per provider. READ-ONLY (no fixed-cost sync), so a month before a
  // subscription existed correctly reports no_data, never a fabricated 0.
  if (path === '/api/costs/period' && method === 'GET') {
    try {
      const monthsBack = Math.min(Math.max(parseInt(url.searchParams.get('months') || '6', 10) || 6, 1), 24)
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config } = loadCostopsConfig()
      const trend = getPeriodTrend(getDb(), config, now, monthsBack, monthKey)
      json(res, trend)
    } catch (err) {
      logger.error({ err }, 'CostOps period failed')
      json(res, { error: 'Cost period failed' }, 500)
    }
    return true
  }

  // v0.7: subscription lifecycle (active/canceled/paid_until/next_renewal),
  // config-derived facts only -- no Gmail access, no raw email/PII.
  if (path === '/api/costs/subscriptions' && method === 'GET') {
    try {
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadSubscriptionsConfig()
      json(res, { subscriptions: deriveLifecycle(config, now), config_present: exists, config_errors: errors })
    } catch (err) {
      logger.error({ err }, 'CostOps subscriptions failed')
      json(res, { error: 'Cost subscriptions failed' }, 500)
    }
    return true
  }

  // v0.8 (card 6f4d1332 §5/§6.2): agent-grouped token cost + run-rate forecast, and the
  // normalized limits/quota pass (subscription lifecycle + DeepSeek balance + workspace alerts +
  // Render build-minutes + SSL/domain expiry, all into one shape). Separate from /summary so a
  // live TLS/RDAP/Render round trip never slows down the primary (DB-only) summary load --
  // matches how /warnings already keeps its own live checks out of /summary.
  if (path === '/api/costs/limits' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const win = monthWindow(now, monthKey)
      const { pricing } = loadPricingConfig()
      const tokenByAgent = getTokenCostByAgent(getDb(), pricing, win.start, win.end, win.fractionElapsed)
      const { config: subsConfig } = loadSubscriptionsConfig()
      const subscriptions = deriveLifecycle(subsConfig, now)
      const limits = await getLimitStatus(getDb(), now, subscriptions)
      json(res, { token_by_agent: tokenByAgent, limits })
    } catch (err) {
      logger.error({ err }, 'CostOps limits failed')
      json(res, { error: 'Cost limits failed' }, 500)
    }
    return true
  }

  // v0.7/v2: deterministic + LIVE-wired warnings. Deterministic rules (budget/
  // sync/lifecycle/pending_permission) are DB-only and instant; the 2 live
  // checks (Render build-minutes, workspace alerts) add a real network round
  // trip (Render) / a stored agent-fed signal (workspace) -- never fabricated,
  // "no_api_or_no_access" surfaces where there genuinely is no data source.
  if (path === '/api/costs/warnings' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const { pricing, exists: pricingExists } = loadPricingConfig()
      const db = getDb()
      syncFixedCostsToLedger(db, config, now, monthKey)
      const summary = getCostSummary(db, config, now, { monthKey, configExists: exists, configErrors: errors, pricing, pricingExists })
      const { config: subsConfig } = loadSubscriptionsConfig()
      const subscriptions = deriveLifecycle(subsConfig, now)
      // v0.8 (card 6f4d1332 §6): getLimitStatus() re-runs the same Render/SSL/domain live checks
      // internally (normalized shape, for rule 11's uniform tiered alert) -- accepted duplicate
      // round trip rather than threading raw+normalized dual output through fromLiveChecks; this
      // route is a low-QPS internal dashboard call, not latency-sensitive.
      const limits = await getLimitStatus(db, now, subscriptions)
      const deterministic = getWarnings(db, config, now, summary, subscriptions, limits)
      const workspaceAlerts = buildWorkspaceAlertWarnings(db, now)
      const renderBuildMinutes = await checkRenderBuildMinutes(now)
      const { config: domainsConfig } = loadDomainsConfig()
      const sslWarnings = await checkSslExpiry(domainsConfig.ssl_hosts, now)
      const domainWarnings = await checkDomainExpiry(domainsConfig.domains, now)
      json(res, { warnings: [...deterministic, ...workspaceAlerts, ...renderBuildMinutes, ...sslWarnings, ...domainWarnings] })
    } catch (err) {
      logger.error({ err }, 'CostOps warnings failed')
      json(res, { error: 'Cost warnings failed' }, 500)
    }
    return true
  }

  // v0.7/v2: agent-side Gmail sweep POSTs a sanitized workspace-alert signal
  // here (payment failure / suspension notice). No raw email content stored.
  if (path === '/api/costs/workspace-alerts' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}') as { entries?: unknown }
      const entries = Array.isArray(body?.entries) ? body.entries : []
      const now = Math.floor(Date.now() / 1000)
      const result = ingestWorkspaceAlerts(getDb(), entries as import('../../costops/workspace-alerts.js').WorkspaceAlertEntry[], now)
      json(res, { ok: result.errors.length === 0, ...result })
    } catch (err) {
      logger.error({ err }, 'CostOps workspace-alerts ingest failed')
      json(res, { ok: false, error: 'workspace-alerts ingest failed' }, 500)
    }
    return true
  }

  // v0.7: sanitized export -- provider/period/amount/confidence/source_type only.
  // No raw email body, no raw invoice ID, no account reference, no PII.
  if (path === '/api/costs/export' && method === 'GET') {
    try {
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
      const month = url.searchParams.get('month') || undefined
      const fromMonth = url.searchParams.get('from') || undefined
      const toMonth = url.searchParams.get('to') || undefined
      const now = Math.floor(Date.now() / 1000)
      const rows = exportCostRows(getDb(), now, { month, fromMonth, toMonth })
      if (format === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store' })
        res.end(rowsToCsv(rows))
      } else {
        json(res, { rows })
      }
    } catch (err) {
      logger.error({ err }, 'CostOps export failed')
      json(res, { error: 'Cost export failed' }, 500)
    }
    return true
  }

  return false
}
