import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import type {
  OptimizationConfig,
  OptimizationModules,
  ReadOptimizationConfigResult,
} from '../optimization/optimization-config.js'
import type { SubscriptionsConfig } from '../costops/subscriptions.js'
import type { PackageInventoryConfig } from '../costops/package-inventory.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

const mockedState = vi.hoisted(() => ({
  optimization: null as unknown,
  subscriptions: { version: 1, subscriptions: [] } as unknown,
  inventory: { version: 1, packages: [] } as unknown,
}))

vi.mock('../optimization/optimization-config.js', async () => {
  const actual = await vi.importActual<typeof import('../optimization/optimization-config.js')>(
    '../optimization/optimization-config.js',
  )
  return {
    ...actual,
    readOptimizationConfig: () => mockedState.optimization,
  }
})

vi.mock('../costops/subscriptions.js', async () => {
  const actual = await vi.importActual<typeof import('../costops/subscriptions.js')>(
    '../costops/subscriptions.js',
  )
  return {
    ...actual,
    loadSubscriptionsConfig: () => ({
      config: mockedState.subscriptions,
      exists: true,
      errors: [],
    }),
  }
})

vi.mock('../costops/package-inventory.js', async () => {
  const actual = await vi.importActual<typeof import('../costops/package-inventory.js')>(
    '../costops/package-inventory.js',
  )
  return {
    ...actual,
    loadPackageInventoryConfig: () => ({
      config: mockedState.inventory,
      exists: true,
      errors: [],
    }),
  }
})

vi.mock('../costops/fx-config.js', () => ({
  loadFxRates: () => ({ rates: {}, source: 'unset' }),
}))

vi.mock('../costops/config.js', async () => {
  const actual = await vi.importActual<typeof import('../costops/config.js')>(
    '../costops/config.js',
  )
  return {
    ...actual,
    loadCostopsConfig: () => ({
      config: { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] },
      exists: true,
      errors: [],
    }),
  }
})

vi.mock('../web/capacity-routing-store.js', async () => {
  const actual = await vi.importActual<typeof import('../web/capacity-routing-store.js')>(
    '../web/capacity-routing-store.js',
  )
  return {
    ...actual,
    readCapacityRoutingConfig: () => ({
      enabled: false,
      candidates: [],
      limitedThreshold: 0.9,
      ttlMs: 1_800_000,
    }),
    listRuntimeOverlays: () => ({}),
  }
})

import { buildOptimizationSummary } from '../optimization/optimization-summary.js'

function modules(overrides: Partial<OptimizationModules> = {}): OptimizationModules {
  return {
    measurement: false,
    contextEfficiency: false,
    capacityMonitoring: false,
    runtimeRouting: false,
    recommendations: false,
    marketWatch: false,
    benchmarkRecommendations: false,
    ...overrides,
  }
}

function config(
  moduleValues: OptimizationModules,
  masterEnabled = true,
): OptimizationConfig {
  return {
    version: 1,
    masterEnabled,
    preset: 'custom',
    modules: moduleValues,
    routing: { automaticFallback: false },
    ui: { defaultWindow: '30d', showAllocationCost: true },
    lastEnabledConfiguration: null,
  }
}

function setOptimizationConfig(
  moduleValues: OptimizationModules,
  opts: { masterEnabled?: boolean; valid?: boolean; errors?: string[] } = {},
): void {
  mockedState.optimization = {
    config: config(moduleValues, opts.masterEnabled ?? true),
    valid: opts.valid ?? true,
    errors: opts.errors ?? [],
  } satisfies ReadOptimizationConfigResult
}

function hufPackage(): PackageInventoryConfig['packages'][number] {
  return {
    id: 'local-huf-package',
    kind: 'held',
    provider: 'anthropic',
    name: 'Local HUF package',
    price: {
      value: 30_000,
      currency: 'HUF',
      provenance: 'invoice',
      as_of: '2026-07-01',
      source_note: null,
    },
    contract_granularity: 'monthly',
    renewal_date: null,
    quota_shape: 'unknown',
    quota_limit: null,
    overage_available: null,
    overage_rate: null,
    usage_credit_available: null,
    enabled_for_routing: true,
  }
}

describe('buildOptimizationSummary', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    mockedState.subscriptions = { version: 1, subscriptions: [] } satisfies SubscriptionsConfig
    mockedState.inventory = { version: 1, packages: [] } satisfies PackageInventoryConfig
    setOptimizationConfig(modules(), {
      masterEnabled: false,
      valid: false,
      errors: ['configuration file is absent'],
    })
  })

  it('never throws on a fresh database and empty config, and returns the full gated shape', () => {
    const summary = buildOptimizationSummary(getDb(), NOW)

    expect(summary.generated_at).toBe(NOW)
    expect(summary.system_state).toBe('disabled')
    expect(summary.data_freshness).toBeNull()
    expect(summary.capacity).toEqual({
      available: false,
      report: null,
      blocker: 'capacity monitoring module disabled',
    })
    expect(summary.kpi.blocker).toBe('measurement module disabled')
    expect(summary.top_recommendation.blocker).toBe('recommendations module disabled')
    expect(summary.monthly_review.blocker).toBe('recommendations module disabled')
    expect(summary.benchmark.blocker).toBe('benchmark module disabled')
    expect(summary.routing).toMatchObject({
      available: true,
      overlay_count: 0,
      agents_on_fallback: [],
    })
    expect(summary.runtime_routing_config).toEqual({
      enabled: false,
      candidate_count: 0,
      trusted_candidate_count: 0,
    })
  })

  it('is disabled whenever masterEnabled is false, regardless of module flags', () => {
    setOptimizationConfig(modules({
      measurement: true,
      contextEfficiency: true,
      capacityMonitoring: true,
      runtimeRouting: true,
      recommendations: true,
      marketWatch: true,
      benchmarkRecommendations: true,
    }), { masterEnabled: false })

    expect(buildOptimizationSummary(getDb(), NOW).system_state).toBe('disabled')
  })

  it('always reports market watch as not wired', () => {
    setOptimizationConfig(modules({ marketWatch: true }))
    expect(buildOptimizationSummary(getDb(), NOW).market_watch).toEqual({
      wired: false,
      note: 'market watch scheduler not yet wired to any cron/runner -- runMarketWatchCycle exists but has no caller in production',
    })
  })

  it('uses exact blockers for every disabled report module', () => {
    const summary = buildOptimizationSummary(getDb(), NOW)
    expect(summary.capacity.blocker).toBe('capacity monitoring module disabled')
    expect(summary.kpi.blocker).toBe('measurement module disabled')
    expect(summary.top_recommendation.blocker).toBe('recommendations module disabled')
    expect(summary.monthly_review.blocker).toBe('recommendations module disabled')
    expect(summary.benchmark.blocker).toBe('benchmark module disabled')
  })

  it('populates enabled real report builders and records non-null freshness', () => {
    setOptimizationConfig(modules({
      measurement: true,
      capacityMonitoring: true,
      recommendations: true,
      benchmarkRecommendations: true,
    }))
    mockedState.subscriptions = {
      version: 1,
      subscriptions: [{
        id: 'anthropic-local',
        name: 'Anthropic local',
        provider: 'anthropic',
        source: 'manual',
        status: 'active',
        amount_source: 'manual_fallback',
        billing_period: 'monthly',
      }],
    } satisfies SubscriptionsConfig
    mockedState.inventory = {
      version: 1,
      packages: [hufPackage()],
    } satisfies PackageInventoryConfig

    const summary = buildOptimizationSummary(getDb(), NOW)
    expect(summary.capacity.available).toBe(true)
    expect(summary.capacity.report?.subscriptions).toHaveLength(1)
    expect(summary.kpi.available).toBe(true)
    expect(summary.kpi.report).not.toBeNull()
    expect(summary.monthly_review.available).toBe(true)
    expect(summary.monthly_review.review?.package_recommendations).toHaveLength(1)
    expect(summary.benchmark.available).toBe(true)
    expect(summary.benchmark.pack).not.toBeNull()
    // The current deterministic recommendation core honestly returns
    // NO_DECISION here, so there is no fabricated "top" action.
    expect(summary.top_recommendation.available).toBe(false)
    expect(summary.top_recommendation.blocker).toMatch(/NO_DECISION/)
    expect(summary.data_freshness).toBe(NOW)
  })

  it('caps the attention queue at five items and keeps critical items first', () => {
    setOptimizationConfig(modules({ capacityMonitoring: true }), {
      valid: false,
      errors: ['bad dependency'],
    })
    mockedState.subscriptions = {
      version: 1,
      subscriptions: Array.from({ length: 8 }, (_, index) => ({
        id: `sub-${index}`,
        name: `Subscription ${index}`,
        provider: `provider-${index}`,
        source: 'manual',
        status: 'active' as const,
        amount_source: 'manual_fallback' as const,
        billing_period: 'monthly' as const,
      })),
    } satisfies SubscriptionsConfig
    const insert = getDb().prepare(`
      INSERT INTO provider_ratelimit_snapshots (
        provider, auth_profile, limit_id, used_percent, window_duration_mins,
        resets_at, reset_label, plan_type, usage_confidence, snapshot_source,
        dedup_key, captured_at
      ) VALUES (?, NULL, NULL, 110, NULL, NULL, NULL, NULL, 'manual', 'manual_operator', ?, ?)
    `)
    for (let index = 0; index < 8; index += 1) {
      insert.run(`provider-${index}`, `overflow-${index}`, NOW)
    }

    const summary = buildOptimizationSummary(getDb(), NOW)
    expect(summary.attention_queue).toHaveLength(5)
    expect(summary.attention_queue[0].severity).toBe('critical')
  })
})
