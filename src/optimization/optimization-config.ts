import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { setCapacityRoutingEnabled } from '../web/capacity-routing-store.js'

export interface OptimizationModules {
  measurement: boolean
  contextEfficiency: boolean
  capacityMonitoring: boolean
  runtimeRouting: boolean
  recommendations: boolean
  marketWatch: boolean
  benchmarkRecommendations: boolean
}

export type OptimizationPreset = 'off' | 'observation' | 'advisory' | 'active' | 'custom'

export interface OptimizationRoutingConfig {
  automaticFallback: boolean
  trustedProvidersOnly: boolean
  maxFallbacksPerProfile: number
  maxAutomaticFallbacksPerDispatch: number
}

export interface OptimizationUiConfig {
  defaultWindow: string
  showAllocationCost: boolean
}

export interface OptimizationConfig {
  version: number
  masterEnabled: boolean
  preset: OptimizationPreset
  modules: OptimizationModules
  routing: OptimizationRoutingConfig
  ui: OptimizationUiConfig
  lastEnabledConfiguration: {
    preset: OptimizationPreset
    modules: OptimizationModules
    routing: OptimizationRoutingConfig
  } | null
}

export const PRESET_MODULES: Record<Exclude<OptimizationPreset, 'custom'>, OptimizationModules> = {
  off: {
    measurement: false,
    contextEfficiency: false,
    capacityMonitoring: false,
    runtimeRouting: false,
    recommendations: false,
    marketWatch: false,
    benchmarkRecommendations: false,
  },
  observation: {
    measurement: true,
    contextEfficiency: true,
    capacityMonitoring: true,
    runtimeRouting: false,
    recommendations: true,
    marketWatch: true,
    benchmarkRecommendations: false,
  },
  advisory: {
    measurement: true,
    contextEfficiency: true,
    capacityMonitoring: true,
    runtimeRouting: false,
    recommendations: true,
    marketWatch: true,
    benchmarkRecommendations: true,
  },
  active: {
    measurement: true,
    contextEfficiency: true,
    capacityMonitoring: true,
    runtimeRouting: true,
    recommendations: true,
    marketWatch: true,
    benchmarkRecommendations: true,
  },
}

export const DEFAULT_OPTIMIZATION_CONFIG: OptimizationConfig = {
  version: 1,
  masterEnabled: false,
  preset: 'off',
  modules: { ...PRESET_MODULES.off },
  routing: {
    automaticFallback: false,
    trustedProvidersOnly: true,
    maxFallbacksPerProfile: 2,
    maxAutomaticFallbacksPerDispatch: 1,
  },
  ui: {
    defaultWindow: '30d',
    showAllocationCost: true,
  },
  lastEnabledConfiguration: null,
}

export const OPTIMIZATION_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'optimization-config.json')

const MODULE_KEYS = [
  'measurement',
  'contextEfficiency',
  'capacityMonitoring',
  'runtimeRouting',
  'recommendations',
  'marketWatch',
  'benchmarkRecommendations',
] as const

const NAMED_PRESETS = ['off', 'observation', 'advisory', 'active'] as const

function asObject(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
}

function normalizeModules(raw: unknown): OptimizationModules {
  const o = asObject(raw)
  return {
    measurement: typeof o.measurement === 'boolean' ? o.measurement : DEFAULT_OPTIMIZATION_CONFIG.modules.measurement,
    contextEfficiency: typeof o.contextEfficiency === 'boolean' ? o.contextEfficiency : DEFAULT_OPTIMIZATION_CONFIG.modules.contextEfficiency,
    capacityMonitoring: typeof o.capacityMonitoring === 'boolean' ? o.capacityMonitoring : DEFAULT_OPTIMIZATION_CONFIG.modules.capacityMonitoring,
    runtimeRouting: typeof o.runtimeRouting === 'boolean' ? o.runtimeRouting : DEFAULT_OPTIMIZATION_CONFIG.modules.runtimeRouting,
    recommendations: typeof o.recommendations === 'boolean' ? o.recommendations : DEFAULT_OPTIMIZATION_CONFIG.modules.recommendations,
    marketWatch: typeof o.marketWatch === 'boolean' ? o.marketWatch : DEFAULT_OPTIMIZATION_CONFIG.modules.marketWatch,
    benchmarkRecommendations: typeof o.benchmarkRecommendations === 'boolean'
      ? o.benchmarkRecommendations
      : DEFAULT_OPTIMIZATION_CONFIG.modules.benchmarkRecommendations,
  }
}

function normalizeRouting(raw: unknown): OptimizationRoutingConfig {
  const o = asObject(raw)
  const defaults = DEFAULT_OPTIMIZATION_CONFIG.routing
  return {
    automaticFallback: typeof o.automaticFallback === 'boolean' ? o.automaticFallback : defaults.automaticFallback,
    trustedProvidersOnly: typeof o.trustedProvidersOnly === 'boolean' ? o.trustedProvidersOnly : defaults.trustedProvidersOnly,
    maxFallbacksPerProfile: typeof o.maxFallbacksPerProfile === 'number'
      && Number.isInteger(o.maxFallbacksPerProfile)
      && o.maxFallbacksPerProfile >= 0
      ? o.maxFallbacksPerProfile
      : defaults.maxFallbacksPerProfile,
    maxAutomaticFallbacksPerDispatch: typeof o.maxAutomaticFallbacksPerDispatch === 'number'
      && Number.isInteger(o.maxAutomaticFallbacksPerDispatch)
      && o.maxAutomaticFallbacksPerDispatch >= 0
      ? o.maxAutomaticFallbacksPerDispatch
      : defaults.maxAutomaticFallbacksPerDispatch,
  }
}

function normalizeLastEnabledConfiguration(raw: unknown): OptimizationConfig['lastEnabledConfiguration'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const modules = validateModuleDependencies(normalizeModules(o.modules)).correctedModules
  return {
    preset: presetForModules(modules),
    modules,
    routing: normalizeRouting(o.routing),
  }
}

export function presetForModules(modules: OptimizationModules): OptimizationPreset {
  for (const preset of NAMED_PRESETS) {
    if (MODULE_KEYS.every((key) => modules[key] === PRESET_MODULES[preset][key])) return preset
  }
  return 'custom'
}

export interface DependencyValidationResult {
  ok: boolean
  errors: string[]
  correctedModules: OptimizationModules
}

export function validateModuleDependencies(modules: OptimizationModules): DependencyValidationResult {
  const correctedModules = normalizeModules(modules)
  const errors: string[] = []

  if (!correctedModules.measurement) {
    if (correctedModules.runtimeRouting) {
      correctedModules.runtimeRouting = false
      errors.push('runtimeRouting was forced off because measurement is required.')
    }
    if (correctedModules.recommendations) {
      correctedModules.recommendations = false
      errors.push('recommendations was forced off because measurement is required.')
    }
  }

  if (correctedModules.runtimeRouting && correctedModules.capacityMonitoring === false) {
    correctedModules.runtimeRouting = false
    errors.push('runtimeRouting was forced off because capacityMonitoring is required.')
  }

  if (correctedModules.benchmarkRecommendations && !correctedModules.recommendations) {
    correctedModules.benchmarkRecommendations = false
    errors.push('benchmarkRecommendations was forced off because recommendations is required.')
  }

  return {
    ok: errors.length === 0,
    errors,
    correctedModules,
  }
}

/** Coerce untrusted parsed JSON into a valid config; junk/partial input degrades to safe defaults. */
export function normalizeOptimizationConfig(raw: unknown): OptimizationConfig {
  const o = asObject(raw)
  const defaults = DEFAULT_OPTIMIZATION_CONFIG
  const modules = validateModuleDependencies(normalizeModules(o.modules)).correctedModules
  const ui = asObject(o.ui)

  return {
    version: typeof o.version === 'number' && Number.isInteger(o.version) && o.version >= 1
      ? o.version
      : defaults.version,
    masterEnabled: typeof o.masterEnabled === 'boolean' ? o.masterEnabled : defaults.masterEnabled,
    preset: presetForModules(modules),
    modules,
    routing: normalizeRouting(o.routing),
    ui: {
      defaultWindow: typeof ui.defaultWindow === 'string' && ui.defaultWindow.trim()
        ? ui.defaultWindow
        : defaults.ui.defaultWindow,
      showAllocationCost: typeof ui.showAllocationCost === 'boolean'
        ? ui.showAllocationCost
        : defaults.ui.showAllocationCost,
    },
    lastEnabledConfiguration: normalizeLastEnabledConfiguration(o.lastEnabledConfiguration),
  }
}

export interface ReadOptimizationConfigResult {
  config: OptimizationConfig
  valid: boolean
  errors: string[]
}

export function readOptimizationConfig(path: string = OPTIMIZATION_CONFIG_PATH): ReadOptimizationConfigResult {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: DEFAULT_OPTIMIZATION_CONFIG,
        valid: false,
        errors: ['Optimization config must contain a JSON object.'],
      }
    }

    const o = parsed as Record<string, unknown>
    const dependencyResult = validateModuleDependencies(normalizeModules(o.modules))
    return {
      config: normalizeOptimizationConfig(parsed),
      valid: dependencyResult.ok,
      errors: dependencyResult.errors,
    }
  } catch (error) {
    return {
      config: DEFAULT_OPTIMIZATION_CONFIG,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }
}

export interface WriteOptimizationConfigResult {
  ok: boolean
  config: OptimizationConfig
  error: string | null
}

export function writeOptimizationConfig(
  next: Omit<OptimizationConfig, 'version' | 'lastEnabledConfiguration'>,
  opts: { expectedVersion?: number; path?: string } = {},
): WriteOptimizationConfigResult {
  const path = opts.path ?? OPTIMIZATION_CONFIG_PATH
  const current = readOptimizationConfig(path).config

  if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
    return { ok: false, config: current, error: 'version_conflict' }
  }

  const modules = validateModuleDependencies(next.modules).correctedModules
  const lastEnabledConfiguration = current.masterEnabled && !next.masterEnabled
    ? {
        preset: current.preset,
        modules: current.modules,
        routing: current.routing,
      }
    : current.lastEnabledConfiguration
  const config: OptimizationConfig = {
    version: current.version + 1,
    masterEnabled: next.masterEnabled,
    preset: presetForModules(modules),
    modules,
    routing: next.routing,
    ui: next.ui,
    lastEnabledConfiguration,
  }

  try {
    // Preserve the exact pre-write bytes in a sibling backup before replacing the live config.
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
    atomicWriteFileSync(path, JSON.stringify(config, null, 2) + '\n')

    // O-1 (review 2026-08-11): make the control panel CONTROL.
    //
    // The master switch, the runtimeRouting module toggle and the emergency
    // stop all write this file — and the capacity-routing runner gates on a
    // DIFFERENT file that nothing wrote. Measured that morning: the runner's
    // flag had been `true` since 2026-07-30, so the emergency stop reported
    // success while the sweep kept running. A switch that reports success
    // without acting is worse than no switch.
    //
    // Only the OFF direction is propagated automatically, and only when the
    // default path is in use. Arming routing is an owner decision (Phase 3);
    // a dashboard toggle may stop it, never start it.
    if (!opts.path) {
      const shouldRun = config.masterEnabled && config.modules.runtimeRouting === true
      if (!shouldRun) setCapacityRoutingEnabled(false)
    }
    return { ok: true, config, error: null }
  } catch (error) {
    return {
      ok: false,
      config: current,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function ensureOptimizationConfigExample(exampleDir: string): void {
  const examplePath = join(exampleDir, 'optimization-config.example.json')
  if (existsSync(examplePath)) return
  const example = {
    _doc: 'Illustrative Lean Optimization configuration only. The real deployment-local file lives gitignored at '
      + 'store/optimization-config.json.',
    version: 1,
    masterEnabled: true,
    preset: 'active',
    modules: {
      measurement: true,
      contextEfficiency: true,
      capacityMonitoring: true,
      runtimeRouting: true,
      recommendations: true,
      marketWatch: true,
      benchmarkRecommendations: true,
    },
    routing: {
      automaticFallback: true,
      trustedProvidersOnly: true,
      maxFallbacksPerProfile: 2,
      maxAutomaticFallbacksPerDispatch: 1,
    },
    ui: {
      defaultWindow: '30d',
      showAllocationCost: true,
    },
    lastEnabledConfiguration: null,
  }
  writeFileSync(examplePath, JSON.stringify(example, null, 2) + '\n')
}
