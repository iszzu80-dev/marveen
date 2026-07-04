// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// No writes from the client: the only DB write is an idempotent reconciliation
// of the local config's fixed costs into the ledger on a summary read. No LLM,
// no provider API, no secrets in the response.

import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { loadPricingConfig } from '../../costops/pricing.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources } from '../../costops/ledger.js'
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

  return false
}
