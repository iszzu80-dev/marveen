// OPT-C1 (lean-optimization full review, 2026-08-12): the emergency stop must
// bring the fleet BACK, not freeze it where it fell.
//
// The chain before this fix: emergency-disable wrote runtimeRouting:false and
// flipped the runner's flag, but never touched store/runtime-model-overlay.json.
// With the flag off, the sweep -- the ONLY climb-back path -- never ran again,
// and resolveRuntimeModel did not consult `config.enabled`, so every respawn
// re-applied the surviving overlay. An agent that had fallen back to model X
// stayed on X forever, while the routing view reported its configured primary.
// A stop button whose lasting effect is "pin everything on the fallback" is
// the opposite of its name.
//
// Three layers, each tested here or in its sibling files:
//   (a) resolveRuntimeModel gates on config.enabled  (capacity-routing-store.test.ts + here)
//   (b) the OFF-propagation clears overlays and records routing events  (here)
//   (c) buildRoutingSnapshot's static_mode reports a surviving overlay honestly
//       (optimization-routing.test.ts)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { listAgentNames, resolveAgentModelDetailed } from '../web/agent-config.js'
import {
  writeRuntimeOverlay,
  readRuntimeOverlay,
  clearAllRuntimeOverlays,
  resolveRuntimeModel,
  setCapacityRoutingEnabled,
  type RuntimeOverlayEntry,
} from '../web/capacity-routing-store.js'
import {
  writeOptimizationConfig,
  clearRuntimeOverlaysForRoutingOff,
} from '../optimization/optimization-config.js'

let dir: string
let optCfgPath: string
let capCfgPath: string
let overlayPath: string

const ACTIVE = {
  masterEnabled: true,
  preset: 'active' as const,
  modules: {
    measurement: true, contextEfficiency: true, capacityMonitoring: true, runtimeRouting: true,
    recommendations: true, marketWatch: true, benchmarkRecommendations: true,
  },
  routing: { automaticFallback: true, trustedProvidersOnly: true, maxFallbacksPerProfile: 2, maxAutomaticFallbacksPerDispatch: 1 },
  ui: { defaultWindow: '30d' as const, showAllocationCost: true },
}

/** The exact shape the emergency-disable handler writes (routes/optimization.ts). */
const EMERGENCY = {
  ...ACTIVE,
  preset: 'custom' as const,
  modules: { ...ACTIVE.modules, runtimeRouting: false },
  routing: { ...ACTIVE.routing, automaticFallback: false },
}

const ARMED_CAPACITY_CONFIG = {
  enabled: true,
  candidates: [{ provider: 'deepseek', authProfile: 'configdir:.claude-deepseek', model: 'deepseek-v4-pro', enabledForRouting: true, subscriptionIncluded: false }],
  limitedThreshold: 0.9,
  ttlMs: 1_800_000,
}

const OVERLAY: RuntimeOverlayEntry = {
  model: 'deepseek-v4-pro',
  provider: 'deepseek',
  authProfile: 'configdir:.claude-deepseek',
  dispatchId: 'd-emergency-1',
  fallbacksUsedThisPackage: 1,
  setAtMs: 1_770_000_000_000,
  reasonCode: 'primary_constrained_fallback_applied',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opt-emergency-'))
  optCfgPath = join(dir, 'optimization-config.json')
  capCfgPath = join(dir, 'capacity-routing-config.json')
  overlayPath = join(dir, 'runtime-model-overlay.json')
  writeFileSync(optCfgPath, JSON.stringify({ version: 1, ...ACTIVE, lastEnabledConfiguration: null }, null, 2))
  writeFileSync(capCfgPath, JSON.stringify(ARMED_CAPACITY_CONFIG, null, 2))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** The live wiring, pointed at this test's temp files instead of store/. */
function emergencyDisable(overrides: {
  propagate?: (enabled: boolean) => void
  clearOverlays?: () => number
} = {}) {
  return writeOptimizationConfig(EMERGENCY, {
    path: optCfgPath,
    propagate: overrides.propagate ?? ((enabled) => { setCapacityRoutingEnabled(enabled, capCfgPath) }),
    clearOverlays: overrides.clearOverlays ?? (() => clearAllRuntimeOverlays(overlayPath).length),
  })
}

describe('OPT-C1: after emergency-disable, a respawn launches the configured primary', () => {
  it('HEADLINE: overlay set -> emergency stop -> resolveRuntimeModel returns the configured primary', () => {
    writeRuntimeOverlay('devops', OVERLAY, overlayPath)
    // Sanity: before the stop, the respawn choke point WOULD apply the fallback.
    expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath: capCfgPath })).toBe('deepseek-v4-pro')

    const result = emergencyDisable()

    expect(result.ok).toBe(true)
    expect(result.routingFlagPropagated).toBe(true)
    expect(result.overlaysCleared).toBe(true)
    // The overlay is GONE, not merely masked.
    expect(readRuntimeOverlay('devops', overlayPath)).toBeNull()
    // And the respawn choke point launches the configured primary.
    expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath: capCfgPath })).toBe('claude-opus-5')
  })

  it('DEFENSE IN DEPTH: even when the overlay wipe FAILS, the surviving overlay is not applied at spawn', () => {
    // Layer (a) covers layer (b)'s failure: the flag landed enabled:false, so
    // resolveRuntimeModel refuses the overlay although the file survived.
    writeRuntimeOverlay('devops', OVERLAY, overlayPath)
    const result = emergencyDisable({
      clearOverlays: () => { throw new Error('EROFS: read-only file system') },
    })

    expect(result.overlaysCleared).toBe(false)
    expect(readRuntimeOverlay('devops', overlayPath)).not.toBeNull() // the file DID survive
    expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath: capCfgPath })).toBe('claude-opus-5')
  })
})

describe('OPT-C1: an overlay-clearing failure surfaces through the partial mechanism', () => {
  it('HEADLINE: clearOverlays throwing makes the write partial-honest, not green', () => {
    const result = emergencyDisable({
      clearOverlays: () => { throw new Error('EROFS: read-only file system') },
    })

    expect(result.ok).toBe(true)                    // the config WAS written
    expect(result.routingFlagPropagated).toBe(true) // the flag half landed
    expect(result.overlaysCleared).toBe(false)      // the overlay half did NOT
    expect(result.warning).toMatch(/overlay/)
    expect(result.error).toBeNull()
  })

  it('BOTH halves failing reports BOTH, in one warning', () => {
    const result = emergencyDisable({
      propagate: () => { throw new Error('flag write failed') },
      clearOverlays: () => { throw new Error('overlay wipe failed') },
    })
    expect(result.ok).toBe(true)
    expect(result.routingFlagPropagated).toBe(false)
    expect(result.overlaysCleared).toBe(false)
    expect(result.warning).toMatch(/capacity-routing/)
    expect(result.warning).toMatch(/overlay/)
  })

  it('the overlay wipe is attempted EVEN IF the flag propagation failed -- independent halves', () => {
    const clearOverlays = vi.fn(() => clearAllRuntimeOverlays(overlayPath).length)
    writeRuntimeOverlay('devops', OVERLAY, overlayPath)
    const result = emergencyDisable({
      propagate: () => { throw new Error('flag write failed') },
      clearOverlays,
    })
    expect(result.routingFlagPropagated).toBe(false)
    expect(clearOverlays).toHaveBeenCalledTimes(1)
    expect(result.overlaysCleared).toBe(true)
    expect(readRuntimeOverlay('devops', overlayPath)).toBeNull()
  })

  it('a write that KEEPS routing on clears nothing (only the OFF direction acts)', () => {
    const clearOverlays = vi.fn(() => 0)
    const result = writeOptimizationConfig(ACTIVE, {
      path: optCfgPath,
      propagate: vi.fn(),
      clearOverlays,
    })
    expect(result.ok).toBe(true)
    expect(result.overlaysCleared).toBeNull()
    expect(clearOverlays).not.toHaveBeenCalled()
  })
})

describe('OPT-C1: the live clearer records routing events the way the runner does', () => {
  it('one clear-side event per cleared agent: configured identity, fallbackUsed 0, dedicated reason code', () => {
    initDatabase(':memory:')
    const agent = listAgentNames()[0]
    expect(agent).toBeTruthy()
    writeRuntimeOverlay(agent, OVERLAY, overlayPath)

    expect(clearRuntimeOverlaysForRoutingOff(overlayPath)).toBe(1)

    expect(readRuntimeOverlay(agent, overlayPath)).toBeNull()
    const events = getDb().prepare(
      `SELECT * FROM routing_events WHERE reason_code = 'routing_disabled_overlay_cleared'`,
    ).all() as Array<Record<string, unknown>>
    expect(events).toHaveLength(1)
    expect(events[0].agent).toBe(agent)
    expect(events[0].dispatch_id).toBe('d-emergency-1')
    expect(events[0].fallback_used).toBe(0)
    // Clear-side convention (capacity-routing-runner.ts): runtime == configured.
    const configuredModel = resolveAgentModelDetailed(agent).model
    expect(events[0].configured_model).toBe(configuredModel)
    expect(events[0].runtime_model).toBe(configuredModel)
  })

  it('nothing to clear -> zero, no events, no overlay file created', () => {
    initDatabase(':memory:')
    expect(clearRuntimeOverlaysForRoutingOff(overlayPath)).toBe(0)
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM routing_events`).get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('STANDING CHECKS: the wiring stays wired', () => {
  it('writeOptimizationConfig binds the live clearer as the DEFAULT clearOverlays', () => {
    // Same rationale as the O-1 standing check: the missing property was never
    // the helper, it was the CALL. A seam nothing binds is the bug returning.
    const src = readFileSync(join(process.cwd(), 'src/optimization/optimization-config.ts'), 'utf8')
    expect(src).toMatch(/opts\.clearOverlays \?\?[^\n]*clearRuntimeOverlaysForRoutingOff/)
    expect(src).toMatch(/clearOverlays\(\)/)
  })

  it('the emergency-disable route reports a failed overlay wipe as partial', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/routes/optimization.ts'), 'utf8')
    const at = src.indexOf("if (path === '/api/optimization/emergency-disable'")
    expect(at).toBeGreaterThan(-1)
    const handler = src.slice(at)
    expect(handler).toMatch(/result\.overlaysCleared === false/)
  })

  it('the frontend branches on `partial` instead of alerting unconditional success (OPT-H3)', () => {
    const src = readFileSync(join(process.cwd(), 'web/optimization/optimization-controls.js'), 'utf8')
    expect(src).toMatch(/response\.body\?\.partial/)
    expect(src).toMatch(/emergency_partial/)
  })
})
