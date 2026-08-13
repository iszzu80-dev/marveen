import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { setCapacityRoutingEnabled, clearAllRuntimeOverlays } from '../web/capacity-routing-store.js'
import { getDb } from '../db.js'
import { initOptimizationConfigAuditSchema, recordOptimizationConfigAudit } from './optimization-config-audit.js'
import { insertRoutingEvent } from '../costops/dispatch.js'
import { resolveAuthProfile } from '../costops/dispatch-identity.js'
import { deriveProvider } from '../costops/pricing.js'
import { resolveAgentModelDetailed } from '../web/agent-config.js'
import { resolveAgentConfigDir } from '../web/claude-plans.js'

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

/**
 * The routing block holds exactly ONE knob, and that is deliberate.
 *
 * OPT-H2 (review 2026-08-12, remainder closed 2026-08-13): three more fields
 * used to live here -- `trustedProvidersOnly`, `maxFallbacksPerProfile` and
 * `maxAutomaticFallbacksPerDispatch` -- and all three had zero readers in any
 * decision path. They were deleted rather than wired, because each of them is
 * already answered somewhere better:
 *
 *  - trust is enforced per-candidate by `enabledForRouting` in
 *    capacity-routing-config, i.e. at the granularity where the operator can
 *    actually say WHICH provider is trusted, not as one global boolean;
 *  - `maxFallbacksPerProfile` had no enforcement point anywhere and no design
 *    for one;
 *  - the per-dispatch fallback limit is a HARD CEILING in code
 *    (`MAX_AUTO_FALLBACKS_PER_PACKAGE = 1` and `MAX_FALLBACK_CANDIDATES = 2` in
 *    capacity-routing.ts, documented there as "ceilings, not defaults to grow
 *    later"). Making it configurable would let a dashboard edit RAISE a safety
 *    ceiling, which is the opposite of what a ceiling is for.
 *
 * So: the ceilings stay code constants by design. Do not re-add config knobs
 * for them. A field here that nothing reads is exactly the "a switch that
 * reports success without acting" class this program keeps closing.
 */
export interface OptimizationRoutingConfig {
  /** Wired: the capacity-routing sweep reads this each pass and refuses to set
   *  new fallback overlays when it is false (capacity-routing-runner.ts). */
  automaticFallback: boolean
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

/**
 * Whitelist normalizer: it builds the routing block field by field and never
 * spreads the input, so an on-disk config still carrying the three deleted
 * OPT-H2 knobs (or any other unknown field) loads cleanly -- the extras are
 * simply dropped on the next write. No migration is needed for existing files.
 */
function normalizeRouting(raw: unknown): OptimizationRoutingConfig {
  const o = asObject(raw)
  const defaults = DEFAULT_OPTIMIZATION_CONFIG.routing
  return {
    automaticFallback: typeof o.automaticFallback === 'boolean' ? o.automaticFallback : defaults.automaticFallback,
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
  /** Did the OFF direction reach the capacity-routing flag?
   *
   *  `true` when it was propagated, `false` when the propagation itself failed,
   *  and `null` when there was nothing to propagate (routing stays on, or a
   *  caller-supplied path means this is not the live config).
   *
   *  Separate from `ok` on purpose — see the comment at the call site: the two
   *  writes can land independently, and reporting one verdict for both is what
   *  made the emergency stop lie in the more dangerous direction. */
  routingFlagPropagated?: boolean | null
  /** Did the OFF direction clear the surviving runtime-model overlays?
   *
   *  OPT-C1 (review 2026-08-12): stopping routing while an agent sits on a
   *  fallback overlay left it pinned there FOREVER -- the sweep (the only
   *  climb-back path) is exactly what the stop turns off, and every respawn
   *  re-applied the overlay. Same true/false/null semantics as
   *  `routingFlagPropagated`: `null` means there was nothing to do (routing
   *  stays on, or a caller-supplied path means this is not the live config). */
  overlaysCleared?: boolean | null
  /** Human-readable note when the config WAS written but the propagation was
   *  not. Not an `error`: the write happened, and calling it an error is the
   *  bug this field exists to prevent. */
  warning?: string | null
}

/**
 * The live implementation behind writeOptimizationConfig's `clearOverlays`
 * seam: wipe every runtime-model overlay and record one routing event per
 * cleared agent -- the same bookkeeping the capacity-routing runner does when
 * it clears a single overlay on climb-back (capacity-routing-runner.ts), so
 * the routing_events trail shows WHY an agent went back to its primary.
 * Returns how many overlays were cleared; recording failures do not undo the
 * clear (the overlay wipe is the safety action, the event is the audit trail).
 * `overlayPath` is test-injectable, mirroring the store's own functions; the
 * live default is the real overlay file.
 */
export function clearRuntimeOverlaysForRoutingOff(overlayPath?: string): number {
  const cleared = clearAllRuntimeOverlays(overlayPath)
  if (cleared.length === 0) return 0
  const db = getDb()
  const nowSec = Math.floor(Date.now() / 1000)
  for (const { agent, entry } of cleared) {
    // Mirror the runner's clear-side event: the agent is back on its
    // CONFIGURED identity, so the event carries the configured model/provider/
    // profile with fallbackUsed: 0.
    let configuredModel: string | null = null
    let provider: string | null = null
    let authProfile: string | null = null
    try {
      configuredModel = resolveAgentModelDetailed(agent).model
      provider = deriveProvider(configuredModel)
      authProfile = resolveAuthProfile(agent, { resolveConfigDir: resolveAgentConfigDir, homeDir: homedir() })
    } catch { /* an unresolvable agent still gets its clear event, with nulls */ }
    insertRoutingEvent(db, {
      dispatchId: entry.dispatchId,
      agent,
      configuredModel,
      runtimeModel: configuredModel,
      provider,
      authProfile,
      capacityState: null,
      reasonCode: 'routing_disabled_overlay_cleared',
      fallbackUsed: 0,
    }, nowSec)
  }
  return cleared.length
}

export function writeOptimizationConfig(
  next: Omit<OptimizationConfig, 'version' | 'lastEnabledConfiguration'>,
  opts: {
    expectedVersion?: number
    path?: string
    /** The OFF-propagation, injectable so BOTH outcomes can be driven in a test.
     *  Default: the real setter, and only when the live path is in use — a
     *  caller writing to its own file must not touch the machine's routing flag.
     *  Without this seam the failure branch was untestable, and an untested
     *  failure branch on an emergency stop is the branch that matters.
     *  May return whether the flag actually changed (setCapacityRoutingEnabled
     *  does); a true return earns a 'propagation' audit row (OPT-M3). */
    propagate?: (enabled: boolean) => boolean | void
    /** The overlay-wipe half of the OFF direction (OPT-C1), injectable for the
     *  same reason as `propagate` and defaulting the same way: the real
     *  implementation only when the live path is in use. */
    clearOverlays?: () => number
  } = {},
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
    // Normalized on the way in, not passed through: `next.routing` arrives
    // from a PATCH body, and writing it verbatim would let a caller reintroduce
    // the deleted OPT-H2 knobs into the on-disk file where a future reader
    // could mistake them for live settings. The whitelist keeps the file
    // honest about what actually controls anything.
    routing: normalizeRouting(next.routing),
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
    // THE CONFIG IS NOW WRITTEN. Whatever happens below, that is a fact, and
    // the caller must not be told otherwise.
    //
    // Review #2 (Ó-2, 2026-08-11): the propagation used to sit inside this same
    // try, so a failure to flip the routing flag returned `{ok: false, config:
    // <the PRE-write config>}`. At the emergency stop that is the worse
    // direction of lying: the operator is told "the stop failed" and handed the
    // OLD state, while the master switch has in fact been turned off and only
    // the routing flag is still on. Half-landed, reported as not-landed.
    //
    // So the propagation gets its own try, and its outcome travels in its own
    // field. "The switch was written, the flag was not" is a state the caller
    // can act on; `ok: false` with stale config is not.
    let routingFlagPropagated: boolean | null = null
    let overlaysCleared: boolean | null = null
    const warnings: string[] = []
    const propagate = opts.propagate ?? (opts.path ? null : setCapacityRoutingEnabled)
    const clearOverlays = opts.clearOverlays ?? (opts.path ? null : clearRuntimeOverlaysForRoutingOff)
    const shouldRun = config.masterEnabled && config.modules.runtimeRouting === true
    if (propagate && !shouldRun) {
      try {
        const flagChanged = propagate(false)
        routingFlagPropagated = true
        // OPT-M3 (review 2026-08-12): the propagation is a config change of
        // ANOTHER file (the capacity-routing runner flag), so when it actually
        // flipped something it gets its own audit row -- the dashboard spec's
        // "every config change is audited" covers this write too, and the
        // route-level rows only describe the optimization-config file itself.
        // Best-effort by design: the audit is bookkeeping about a safety
        // action that already happened, so a recording failure must never
        // convert a successful stop into a reported one.
        if (flagChanged === true) {
          try {
            const db = getDb()
            initOptimizationConfigAuditSchema(db)
            recordOptimizationConfigAudit(db, {
              at: Math.floor(Date.now() / 1000),
              surface: 'propagation',
              from: current,
              to: config,
              deltaSummary: 'capacity-routing-config.enabled true->false (runtime routing off propagated)',
            })
          } catch { /* audit is best-effort; the propagation itself succeeded */ }
        }
      } catch (error) {
        routingFlagPropagated = false
        warnings.push('az optimalizacio-config KIIRODOTT, de a capacity-routing kapcsolo NEM lett kikapcsolva: '
          + (error instanceof Error ? error.message : String(error)))
      }
    }
    // OPT-C1 (review 2026-08-12): the OFF direction has a THIRD half — the
    // surviving runtime-model overlays. With the flag off the sweep never
    // clears them, and every respawn used to re-apply them, so an agent on a
    // fallback stayed there forever while the routing view showed its primary.
    // Attempted even when the flag propagation itself failed: the two failures
    // are independent, and each cleared overlay helps on its own. Each outcome
    // travels in its own field, same as `routingFlagPropagated`.
    if (clearOverlays && !shouldRun) {
      try {
        clearOverlays()
        overlaysCleared = true
      } catch (error) {
        overlaysCleared = false
        warnings.push('a runtime-model overlay-ek torlese NEM sikerult -- fallback modellen ragadt agent a kovetkezo respawnig ott is marad: '
          + (error instanceof Error ? error.message : String(error)))
      }
    }
    const warning = warnings.length > 0 ? warnings.join(' | ') : null
    return { ok: true, config, error: null, routingFlagPropagated, overlaysCleared, warning }
  } catch (error) {
    return {
      ok: false,
      config: current,
      error: error instanceof Error ? error.message : String(error),
      routingFlagPropagated: null,
      overlaysCleared: null,
      warning: null,
    }
  }
}

// The runtime scaffold ensureOptimizationConfigExample() that used to sit here
// was dead code with zero callers (OPT-M8, review 2026-08-12): the example it
// would have written already exists as the committed
// config-examples/optimization-config.example.json, so the function only
// duplicated that content in a place nothing executed.
