import { json, readBody } from '../http-helpers.js'
import { getDb } from '../../db.js'
import {
  readOptimizationConfig,
  validateModuleDependencies,
  writeOptimizationConfig,
  type OptimizationConfig,
  type OptimizationModules,
} from '../../optimization/optimization-config.js'
import { buildOptimizationSummary } from '../../optimization/optimization-summary.js'
import {
  buildRoutingSnapshot,
  previewRuntimeRouting,
  type RoutingPreviewInput,
} from '../../optimization/optimization-routing.js'
import {
  getOptimizationDecisionEvents,
  initOptimizationDecisionsSchema,
  listOptimizationDecisions,
  setDecisionStatus,
  upsertDecisionsFromRecommendations,
  type OptimizationDecisionStatus,
} from '../../optimization/optimization-decisions.js'
import {
  initOptimizationConfigAuditSchema,
  recordOptimizationConfigAudit,
} from '../../optimization/optimization-config-audit.js'
import { loadPackageInventoryConfig } from '../../costops/package-inventory.js'
import { loadFxRates } from '../../costops/fx-config.js'
import { buildPortfolioReport } from '../../costops/portfolio-recommendation.js'
import type { RouteContext } from './types.js'

const DECISION_STATUSES = new Set<OptimizationDecisionStatus>([
  'new',
  'viewed',
  'accepted',
  'rejected',
  'deferred',
  'canary_needed',
  'executed',
  'expired',
  'insufficient_evidence',
])

const OPTIMIZATION_PRESETS = new Set<OptimizationConfig['preset']>([
  'off',
  'observation',
  'advisory',
  'active',
  'custom',
])

const MODULE_KEYS: ReadonlyArray<keyof OptimizationModules> = [
  'measurement',
  'contextEfficiency',
  'capacityMonitoring',
  'runtimeRouting',
  'recommendations',
  'marketWatch',
  'benchmarkRecommendations',
]

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function tryHandleOptimization(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Idempotent CREATE TABLE IF NOT EXISTS -- must run before ANY handler below
  // touches optimization_decisions/optimization_decision_events, not only the
  // /recommendations GET. A caller reaching /audit or /recommendations/decision
  // before ever calling /recommendations would otherwise hit "no such table".
  // The config-audit table (OPT-M3) rides the same seam for the same reason.
  if (path.startsWith('/api/optimization/')) {
    initOptimizationDecisionsSchema(getDb())
    initOptimizationConfigAuditSchema(getDb())
  }

  if (path === '/api/optimization/summary' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const summary = buildOptimizationSummary(
      getDb(),
      Math.floor(Date.now() / 1000),
      {
        from: from ? parseInt(from) : undefined,
        to: to ? parseInt(to) : undefined,
      },
    )
    json(res, summary)
    return true
  }

  if (path === '/api/optimization/routing' && method === 'GET') {
    const { config } = readOptimizationConfig()
    let rows = buildRoutingSnapshot(
      getDb(),
      Math.floor(Date.now() / 1000),
      { runtimeRoutingEnabled: config.masterEnabled && config.modules.runtimeRouting },
    )
    const agent = url.searchParams.get('agent')
    const state = url.searchParams.get('state')
    const problematicOnly = url.searchParams.get('problematicOnly') === 'true'

    if (agent !== null) rows = rows.filter((row) => row.agent === agent)
    if (state !== null) rows = rows.filter((row) => row.routing_state === state)
    if (problematicOnly) {
      rows = rows.filter((row) =>
        row.routing_state === 'fallback'
        // OPT-C1: an agent whose runtime model differs from its configured
        // primary is a problem in ANY routing_state — in static_mode it is the
        // pinned-on-fallback case the emergency stop is supposed to prevent.
        || row.runtime_model !== row.configured_primary
        || row.capacity_state === 'limited'
        || row.capacity_state === 'blocked'
        || row.capacity_state === 'degraded')
    }

    json(res, rows)
    return true
  }

  if (path === '/api/optimization/routing/preview' && method === 'POST') {
    const raw = await readBody(req)
    const body = JSON.parse(raw.toString() || '{}') as Partial<RoutingPreviewInput>
    if (typeof body.agent !== 'string') {
      json(res, { error: 'agent is required' }, 400)
      return true
    }
    const result = previewRuntimeRouting(
      getDb(),
      { agent: body.agent },
      Math.floor(Date.now() / 1000),
    )
    json(res, result)
    return true
  }

  if (path === '/api/optimization/recommendations' && method === 'GET') {
    const packages = loadPackageInventoryConfig().config.packages
    if (packages.length === 0) {
      json(res, {
        recommendations: [],
        decisions: [],
        note: 'no package inventory configured',
      })
      return true
    }

    const now = Math.floor(Date.now() / 1000)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const recommendations = buildPortfolioReport(
      packages,
      {
        from: from ? parseInt(from) : now - 30 * 24 * 60 * 60,
        to: to ? parseInt(to) : now,
      },
      { fxRates: loadFxRates().rates, fxRateRecords: [] },
    )
    const db = getDb()
    // Deliberate GET exception: idempotently persist the fresh recommendation snapshot; this neither changes config nor starts screening/LLM work.
    upsertDecisionsFromRecommendations(db, recommendations, now)
    const status = url.searchParams.get('status') as OptimizationDecisionStatus | null
    const decisions = listOptimizationDecisions(db, { status: status ?? undefined })
    json(res, { recommendations, decisions })
    return true
  }

  if (path === '/api/optimization/recommendations/events' && method === 'GET') {
    const packageId = url.searchParams.get('package_id')
    if (!packageId) {
      json(res, { error: 'package_id is required' }, 400)
      return true
    }
    const events = getOptimizationDecisionEvents(getDb(), packageId)
    json(res, events)
    return true
  }

  if (path === '/api/optimization/recommendations/decision' && method === 'POST') {
    const raw = await readBody(req)
    const body = JSON.parse(raw.toString() || '{}') as Record<string, unknown>
    if (typeof body.package_id !== 'string' || body.package_id.trim() === '') {
      json(res, { error: 'package_id is required' }, 400)
      return true
    }
    if (typeof body.status !== 'string' || body.status.trim() === '') {
      json(res, { error: 'status is required' }, 400)
      return true
    }
    if (typeof body.actor !== 'string' || body.actor.trim() === '') {
      json(res, { error: 'actor is required' }, 400)
      return true
    }
    if (!DECISION_STATUSES.has(body.status as OptimizationDecisionStatus)) {
      json(res, { error: 'invalid status value' }, 400)
      return true
    }

    // Local decision-state only: this cannot enable plans, cancel subscriptions, or contact provider APIs.
    const result = setDecisionStatus(
      getDb(),
      body.package_id,
      body.status as OptimizationDecisionStatus,
      body.actor,
      Math.floor(Date.now() / 1000),
      {
        note: typeof body.note === 'string' ? body.note : undefined,
        deferredUntil: typeof body.deferredUntil === 'number' ? body.deferredUntil : undefined,
      },
    )
    if (!result.ok) {
      json(res, { error: result.error }, 404)
      return true
    }
    json(res, result.record)
    return true
  }

  if (path === '/api/optimization/settings' && method === 'GET') {
    const result = readOptimizationConfig()
    json(res, {
      config: result.config,
      valid: result.valid,
      errors: result.errors,
    })
    return true
  }

  if (path === '/api/optimization/settings' && method === 'PATCH') {
    const raw = await readBody(req)
    const parsed: unknown = JSON.parse(raw.toString() || '{}')
    const body = isObject(parsed) ? parsed : {}

    if (typeof body.masterEnabled !== 'boolean') {
      json(res, { error: 'masterEnabled must be a boolean' }, 400)
      return true
    }
    if (
      typeof body.preset !== 'string'
      || !OPTIMIZATION_PRESETS.has(body.preset as OptimizationConfig['preset'])
    ) {
      json(res, { error: 'preset must be a valid optimization preset' }, 400)
      return true
    }
    if (!isObject(body.modules)) {
      json(res, { error: 'modules must be an object' }, 400)
      return true
    }
    for (const key of MODULE_KEYS) {
      if (typeof body.modules[key] !== 'boolean') {
        json(res, { error: `modules.${key} must be a boolean` }, 400)
        return true
      }
    }
    if (!isObject(body.routing)) {
      json(res, { error: 'routing must be an object' }, 400)
      return true
    }
    if (!isObject(body.ui)) {
      json(res, { error: 'ui must be an object' }, 400)
      return true
    }

    const modules = body.modules as unknown as OptimizationModules
    if (body.preview === true) {
      const dependencyResult = validateModuleDependencies(modules)
      json(res, {
        preview: true,
        wouldApply: { ...dependencyResult.correctedModules },
        dependencyErrors: dependencyResult.errors,
      })
      return true
    }

    // OPT-M3 (review 2026-08-12): every config write leaves an audit row, per
    // the dashboard spec's "every config change is audited" acceptance. The
    // pre-write config is read HERE (not reconstructed from version-1 later)
    // so the recorded from-state is what was actually replaced.
    const before = readOptimizationConfig().config
    const result = writeOptimizationConfig(
      {
        masterEnabled: body.masterEnabled,
        preset: body.preset as OptimizationConfig['preset'],
        modules,
        routing: body.routing as unknown as OptimizationConfig['routing'],
        ui: body.ui as unknown as OptimizationConfig['ui'],
      },
      {
        expectedVersion: typeof body.expectedVersion === 'number'
          ? body.expectedVersion
          : undefined,
      },
    )
    if (!result.ok) {
      json(res, { error: result.error, config: result.config }, 409)
      return true
    }
    recordOptimizationConfigAudit(getDb(), {
      at: Math.floor(Date.now() / 1000),
      surface: 'settings',
      from: before,
      to: result.config,
    })
    json(res, { config: result.config })
    return true
  }

  if (path === '/api/optimization/audit' && method === 'GET') {
    const db = getDb()
    const decisions = listOptimizationDecisions(db)
    // Metadata-only invariant: never add prompts, credentials, secrets, or raw account identifiers to this response.
    const audit = decisions.map((decision) => ({
      package_id: decision.package_id,
      current_status: decision.status,
      events: getOptimizationDecisionEvents(db, decision.package_id),
    }))
    json(res, audit)
    return true
  }

  if (path === '/api/optimization/emergency-disable' && method === 'POST') {
    const current = readOptimizationConfig().config
    const result = writeOptimizationConfig(
      {
        masterEnabled: current.masterEnabled,
        preset: 'custom',
        modules: { ...current.modules, runtimeRouting: false },
        routing: { ...current.routing, automaticFallback: false },
        ui: current.ui,
      },
      {},
    )
    // O-7 (review 2026-08-11): report what happened, not what was attempted.
    //
    // This handler used to answer `{ok: true}` without looking at the write
    // result. A read-only store/ or a full disk would have produced a green
    // acknowledgement from an emergency stop that stopped nothing — the worst
    // failure mode a kill switch has, because the operator walks away.
    if (!result.ok) {
      json(res, { ok: false, error: result.error ?? 'write failed', config: result.config }, 500)
      return true
    }
    // OPT-M3: the kill switch is a config write like any other and gets its
    // audit row -- recorded AFTER the ok check so a failed stop is not logged
    // as a change that happened.
    recordOptimizationConfigAudit(getDb(), {
      at: Math.floor(Date.now() / 1000),
      surface: 'emergency',
      from: current,
      to: result.config,
    })
    // Ó-2 (review #2, 2026-08-11): the stop has TWO halves — this config and the
    // capacity-routing flag — and they can land separately. Reporting a single
    // verdict for both is how an operator walks away from a half-stopped system.
    //
    // OPT-C1 (review 2026-08-12): a THIRD half joined them — the surviving
    // runtime-model overlays. Not clearing those left agents pinned on their
    // fallback models with nothing (the sweep is now off) ever climbing them
    // back. Each half reports independently, and any failed half makes the
    // response partial.
    //
    // The config write succeeded, so this is not a 500. But if the flag or the
    // overlay wipe did not follow, the response says so in the same breath,
    // because "stopped" and "stopped except for the part that keeps
    // dispatching" are different states.
    if (result.routingFlagPropagated === false || result.overlaysCleared === false) {
      json(res, {
        ok: true,
        partial: true,
        config: result.config,
        warning: result.warning,
        stillRunning: result.routingFlagPropagated === false
          ? 'capacity-routing'
          : 'runtime-model-overlays',
      })
      return true
    }
    json(res, { ok: true, partial: false, config: result.config })
    return true
  }

  return false
}
