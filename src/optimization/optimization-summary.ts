import type Database from 'better-sqlite3'
import { buildPhase2Kpis, type KpiReport } from '../costops/kpi.js'
import { deriveLifecycle, loadSubscriptionsConfig } from '../costops/subscriptions.js'
import { buildCapacityReport, type CapacityReport } from '../costops/capacity.js'
import { loadPackageInventoryConfig } from '../costops/package-inventory.js'
import { loadFxRates } from '../costops/fx-config.js'
import {
  buildPortfolioReport,
  type PackageRecommendation,
} from '../costops/portfolio-recommendation.js'
import {
  buildMonthlyPortfolioReview,
  type MonthlyPortfolioReview,
} from '../costops/monthly-portfolio-review.js'
import {
  buildMarveenBenchmarkPack,
  type MarveenBenchmarkPack,
} from '../costops/marveen-benchmark-pack.js'
import { loadCostopsConfig } from '../costops/config.js'
import {
  listRuntimeOverlays,
  readCapacityRoutingConfig,
} from '../web/capacity-routing-store.js'
import {
  readOptimizationConfig,
  type OptimizationModules,
  type OptimizationPreset,
} from './optimization-config.js'

export interface OptimizationAttentionItem {
  severity: 'info' | 'warning' | 'critical'
  category: 'config' | 'capacity' | 'recommendation' | 'market_watch' | 'data_freshness'
  title: string
  explanation: string
  action: string
}

export interface OptimizationSummary {
  generated_at: number
  master_enabled: boolean
  preset: OptimizationPreset
  modules: OptimizationModules
  config_valid: boolean
  config_errors: string[]
  system_state: 'ok' | 'observation' | 'attention_needed' | 'partially_disabled' | 'disabled'
  active_module_count: number
  data_freshness: number | null
  attention_queue: OptimizationAttentionItem[]
  capacity: { available: boolean; report: CapacityReport | null; blocker: string | null }
  routing: {
    available: boolean
    overlay_count: number
    agents_on_fallback: string[]
    blocker: string | null
  }
  kpi: { available: boolean; report: KpiReport | null; blocker: string | null }
  top_recommendation: {
    available: boolean
    recommendation: PackageRecommendation | null
    blocker: string | null
  }
  monthly_review: {
    available: boolean
    review: MonthlyPortfolioReview | null
    blocker: string | null
  }
  benchmark: {
    available: boolean
    pack: MarveenBenchmarkPack | null
    blocker: string | null
  }
  market_watch: { wired: false; note: string }
  runtime_routing_config: {
    enabled: boolean
    candidate_count: number
    trusted_candidate_count: number
  }
}

const MODULE_KEYS: Array<keyof OptimizationModules> = [
  'measurement',
  'contextEfficiency',
  'capacityMonitoring',
  'runtimeRouting',
  'recommendations',
  'marketWatch',
  'benchmarkRecommendations',
]

const MARKET_WATCH_NOTE =
  'market watch scheduler not yet wired to any cron/runner -- runMarketWatchCycle exists but has no caller in production'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function topActionableRecommendation(
  recommendations: PackageRecommendation[],
): PackageRecommendation | null {
  const confidenceRank: Record<PackageRecommendation['confidence'], number> = {
    measured: 2,
    estimated: 1,
    unknown: 0,
  }
  return recommendations
    .filter(({ verdict }) =>
      verdict !== 'NO_DECISION'
      && verdict !== 'INSUFFICIENT_EVIDENCE'
      && verdict !== 'KEEP')
    .sort((a, b) => confidenceRank[b.confidence] - confidenceRank[a.confidence])[0] ?? null
}

function recommendationBlocker(recommendations: PackageRecommendation[]): string {
  if (recommendations.every(({ verdict }) =>
    verdict === 'NO_DECISION' || verdict === 'INSUFFICIENT_EVIDENCE')) {
    return 'every package returned NO_DECISION or INSUFFICIENT_EVIDENCE'
  }
  return 'no actionable package recommendation'
}

function buildAttentionQueue(input: {
  configValid: boolean
  configErrors: string[]
  capacityReport: CapacityReport | null
  topRecommendation: PackageRecommendation | null
  kpiReport: KpiReport | null
}): OptimizationAttentionItem[] {
  const items: OptimizationAttentionItem[] = []

  if (!input.configValid) {
    items.push({
      severity: 'critical',
      category: 'config',
      title: 'Invalid optimization configuration',
      explanation: input.configErrors.join('; '),
      action: 'Review Controls tab configuration',
    })
  }

  for (const subscription of input.capacityReport?.subscriptions ?? []) {
    if (
      subscription.overflow.confidence !== 'unknown'
      && subscription.overflow.value !== null
      && subscription.overflow.value > 0
    ) {
      items.push({
        severity: 'warning',
        category: 'capacity',
        title: `Capacity overflow for ${subscription.name}`,
        explanation:
          `${subscription.name} has observed overflow of ${subscription.overflow.value} `
          + `${subscription.overflow.unit ?? 'units'} (${subscription.overflow.confidence} confidence).`,
        action: 'Review the subscription capacity evidence',
      })
    }
  }

  if (input.topRecommendation) {
    const recommendation = input.topRecommendation
    items.push({
      severity: recommendation.verdict === 'CANCEL' || recommendation.verdict === 'DOWNGRADE'
        ? 'warning'
        : 'info',
      category: 'recommendation',
      title: `${recommendation.verdict} recommendation for ${recommendation.package_id}`,
      explanation:
        `The portfolio report returned ${recommendation.verdict} with ${recommendation.confidence} confidence.`,
      action: 'Review the recommendation evidence before deciding',
    })
  }

  const measuredFallback = input.kpiReport?.rows.find(({ fallback_rate: fallbackRate }) =>
    fallbackRate.state === 'measured'
    && fallbackRate.value !== null
    && fallbackRate.value > 0)
  if (measuredFallback) {
    items.push({
      severity: 'warning',
      category: 'capacity',
      title: 'Runtime fallback activity observed',
      explanation:
        `Measured fallback activity is present for ${measuredFallback.agent ?? 'an unassigned agent'} `
        + `at rate ${measuredFallback.fallback_rate.value}.`,
      action: 'Review capacity and routing state',
    })
  }

  const severityRank: Record<OptimizationAttentionItem['severity'], number> = {
    critical: 2,
    warning: 1,
    info: 0,
  }
  return items
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    .slice(0, 5)
}

export function buildOptimizationSummary(
  db: Database.Database,
  now: number,
  opts: { from?: number; to?: number } = {},
): OptimizationSummary {
  const configResult = readOptimizationConfig()
  const { config } = configResult
  const freshness: number[] = []

  // O-2 (review 2026-08-11): the master switch is part of every module gate.
  //
  // Every branch below read `config.modules.X` and the word `masterEnabled`
  // appeared nowhere in this file — while /api/optimization/routing already
  // gated on `masterEnabled && modules.runtimeRouting`. Since a master-OFF
  // write does NOT force the module flags to false (it stashes them in
  // lastEnabledConfiguration), "master OFF, modules still true" is an ordinary
  // state — and the summary reported every module as live in exactly that
  // state. The asymmetry between the two endpoints is what made it a gap
  // rather than a decision.
  const on = (module: boolean): boolean => config.masterEnabled && module === true

  let capacity: OptimizationSummary['capacity'] = {
    available: false,
    report: null,
    blocker: 'capacity monitoring module disabled',
  }
  if (on(config.modules.capacityMonitoring)) {
    try {
      const subscriptions = loadSubscriptionsConfig()
      const lifecycle = deriveLifecycle(subscriptions.config, now)
      const report = buildCapacityReport(db, lifecycle, now, {
        windowStart: opts.from,
        windowEnd: opts.to,
      })
      capacity = { available: true, report, blocker: null }
      freshness.push(report.generated_at)
    } catch (error) {
      capacity = { available: false, report: null, blocker: errorMessage(error) }
    }
  }

  let kpi: OptimizationSummary['kpi'] = {
    available: false,
    report: null,
    blocker: 'measurement module disabled',
  }
  if (on(config.modules.measurement)) {
    try {
      const report = buildPhase2Kpis(db, { from: opts.from, to: opts.to, now })
      kpi = { available: true, report, blocker: null }
      freshness.push(report.generated_at)
    } catch (error) {
      kpi = { available: false, report: null, blocker: errorMessage(error) }
    }
  }

  let routingConfig: ReturnType<typeof readCapacityRoutingConfig> | null = null
  let routingConfigError: string | null = null
  try {
    routingConfig = readCapacityRoutingConfig()
  } catch (error) {
    routingConfigError = errorMessage(error)
  }

  let overlays: ReturnType<typeof listRuntimeOverlays> | null = null
  let overlaysError: string | null = null
  try {
    overlays = listRuntimeOverlays()
  } catch (error) {
    overlaysError = errorMessage(error)
  }

  const routingErrors = [routingConfigError, overlaysError].filter((value): value is string => value !== null)
  const agentsOnFallback = overlays === null ? [] : Object.keys(overlays)
  const routing: OptimizationSummary['routing'] = {
    available: routingConfig !== null || overlays !== null,
    overlay_count: agentsOnFallback.length,
    agents_on_fallback: agentsOnFallback,
    blocker: routingConfig === null && overlays === null ? routingErrors.join('; ') || 'routing state unavailable' : null,
  }

  let topRecommendation: OptimizationSummary['top_recommendation'] = {
    available: false,
    recommendation: null,
    blocker: 'recommendations module disabled',
  }
  let monthlyReview: OptimizationSummary['monthly_review'] = {
    available: false,
    review: null,
    blocker: 'recommendations module disabled',
  }

  if (on(config.modules.recommendations)) {
    try {
      const inventory = loadPackageInventoryConfig()
      if (inventory.config.packages.length === 0) {
        topRecommendation = {
          available: false,
          recommendation: null,
          blocker: 'no package inventory configured',
        }
        monthlyReview = {
          available: false,
          review: null,
          blocker: 'no package inventory configured',
        }
      } else {
        const fxContext = { fxRates: loadFxRates().rates, fxRateRecords: [] }
        const window = {
          from: opts.from ?? (now - 30 * 24 * 60 * 60),
          to: opts.to ?? now,
        }

        try {
          const recommendations = buildPortfolioReport(inventory.config.packages, window, fxContext)
          for (const recommendation of recommendations) freshness.push(recommendation.generated_at)
          const recommendation = topActionableRecommendation(recommendations)
          topRecommendation = recommendation
            ? { available: true, recommendation, blocker: null }
            : {
                available: false,
                recommendation: null,
                blocker: recommendationBlocker(recommendations),
              }
        } catch (error) {
          topRecommendation = {
            available: false,
            recommendation: null,
            blocker: errorMessage(error),
          }
        }

        try {
          const review = buildMonthlyPortfolioReview(
            db,
            loadCostopsConfig().config,
            now,
            inventory.config.packages,
            fxContext,
          )
          monthlyReview = { available: true, review, blocker: null }
          freshness.push(review.generated_at)
        } catch (error) {
          monthlyReview = { available: false, review: null, blocker: errorMessage(error) }
        }
      }
    } catch (error) {
      const blocker = errorMessage(error)
      topRecommendation = { available: false, recommendation: null, blocker }
      monthlyReview = { available: false, review: null, blocker }
    }
  }

  let benchmark: OptimizationSummary['benchmark'] = {
    available: false,
    pack: null,
    blocker: 'benchmark module disabled',
  }
  if (on(config.modules.benchmarkRecommendations)) {
    try {
      const pack = buildMarveenBenchmarkPack(db, now, { from: opts.from, to: opts.to })
      benchmark = { available: true, pack, blocker: null }
      freshness.push(pack.generated_at)
    } catch (error) {
      benchmark = { available: false, pack: null, blocker: errorMessage(error) }
    }
  }

  const runtimeRoutingConfig: OptimizationSummary['runtime_routing_config'] = routingConfig
    ? {
        enabled: routingConfig.enabled,
        candidate_count: routingConfig.candidates.length,
        trusted_candidate_count: routingConfig.candidates.filter(candidate => candidate.enabledForRouting).length,
      }
    : { enabled: false, candidate_count: 0, trusted_candidate_count: 0 }

  const attentionQueue = buildAttentionQueue({
    configValid: configResult.valid,
    configErrors: configResult.errors,
    capacityReport: capacity.report,
    topRecommendation: topRecommendation.recommendation,
    kpiReport: kpi.report,
  })
  const activeModuleCount = MODULE_KEYS.filter(key => config.modules[key]).length
  const hasCriticalAttention = attentionQueue.some(item => item.severity === 'critical')

  let systemState: OptimizationSummary['system_state']
  if (!config.masterEnabled || activeModuleCount === 0) {
    systemState = 'disabled'
  } else if (activeModuleCount < MODULE_KEYS.length) {
    systemState = hasCriticalAttention ? 'attention_needed' : 'partially_disabled'
  } else if (hasCriticalAttention) {
    systemState = 'attention_needed'
  } else if (
    on(config.modules.runtimeRouting)
    && (!config.routing.automaticFallback || !runtimeRoutingConfig.enabled)
  ) {
    // No longer aspirational (OPT-H2, review 2026-08-12): the capacity-routing
    // sweep now reads routing.automaticFallback each pass and, when false,
    // refuses to SET new fallback overlays while still clearing/climbing back
    // existing ones (capacity-routing-runner.ts). 'observation' therefore
    // describes actual runner behaviour, not just this config field's value.
    systemState = 'observation'
  } else {
    systemState = 'ok'
  }

  return {
    generated_at: now,
    master_enabled: config.masterEnabled,
    preset: config.preset,
    modules: config.modules,
    config_valid: configResult.valid,
    config_errors: configResult.errors,
    system_state: systemState,
    active_module_count: activeModuleCount,
    data_freshness: freshness.length > 0 ? Math.max(...freshness) : null,
    attention_queue: attentionQueue,
    capacity,
    routing,
    kpi,
    top_recommendation: topRecommendation,
    monthly_review: monthlyReview,
    benchmark,
    market_watch: { wired: false, note: MARKET_WATCH_NOTE },
    runtime_routing_config: runtimeRoutingConfig,
  }
}
