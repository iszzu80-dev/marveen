// Lean Optimization Phase 3 -- I/O layer for capacity-aware runtime routing.
//
// Card 59b383a9. Pure decisions live in src/capacity-routing.js; this module
// is the ONLY place that touches the filesystem for this feature: the runtime
// overlay (what an agent is CURRENTLY running on, if different from its
// configured model) and the deployment-local routing config (fallback
// candidates + trust gate + thresholds).
//
// THE CENTRAL RULE: resolveRuntimeModel() below is the choke point every spawn
// site calls INSTEAD of reading the agent config for launch purposes. It never
// writes agent config, never touches .claude/settings.json or agent-config.json
// -- it only ever reads the overlay file (or falls through to the caller-
// supplied configured model). Deleting store/runtime-model-overlay.json is
// therefore the entire rollback: every resolveRuntimeModel call then returns
// exactly the configured model, with zero code path left to disagree.
//
// Defense in depth: even a stale/tampered overlay entry naming a provider that
// current config no longer trusts is refused at READ time, not just at the
// time the overlay was written -- enabled_for_routing:false must exclude a
// provider from every routing decision, not merely from the write path.

import { join } from 'node:path'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import type { FallbackCandidate } from '../capacity-routing.js'

export const OVERLAY_PATH = join(PROJECT_ROOT, 'store', 'runtime-model-overlay.json')
export const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'capacity-routing-config.json')

// ---------------------------------------------------------------------------
// Runtime overlay: agent name -> what it is CURRENTLY running on
// ---------------------------------------------------------------------------

export interface RuntimeOverlayEntry {
  model: string
  provider: string
  authProfile: string
  /** The dispatch/package this overlay was applied for -- the sticky routing key. */
  dispatchId: string | null
  /** How many automatic fallbacks this package has consumed (ceiling enforcement). */
  fallbacksUsedThisPackage: number
  setAtMs: number
  reasonCode: string
}

type OverlayFile = Record<string, RuntimeOverlayEntry>

// Every function below takes an optional path override (defaulting to the
// real store/ location) so tests can point at a throwaway temp file and
// exercise REAL filesystem I/O -- mirroring the mkdtempSync pattern already
// used for fable-overage-consent / claude-credentials-guard, rather than
// mocking fs.

function readOverlayFile(path: string): OverlayFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as OverlayFile : {}
  } catch {
    return {}
  }
}

/** The overlay entry for one agent, or null when the agent is on its configured primary. */
export function readRuntimeOverlay(agent: string, path: string = OVERLAY_PATH): RuntimeOverlayEntry | null {
  const file = readOverlayFile(path)
  const entry = file[agent]
  return entry ?? null
}

export function writeRuntimeOverlay(agent: string, entry: RuntimeOverlayEntry, path: string = OVERLAY_PATH): void {
  const file = readOverlayFile(path)
  file[agent] = entry
  atomicWriteFileSync(path, JSON.stringify(file, null, 2))
}

/** Removing an agent's overlay entry is what "climb back to primary" IS -- no separate revert code path. */
export function clearRuntimeOverlay(agent: string, path: string = OVERLAY_PATH): void {
  const file = readOverlayFile(path)
  if (!(agent in file)) return
  delete file[agent]
  atomicWriteFileSync(path, JSON.stringify(file, null, 2))
}

export function listRuntimeOverlays(path: string = OVERLAY_PATH): OverlayFile {
  return readOverlayFile(path)
}

// ---------------------------------------------------------------------------
// Deployment-local routing config: fallback candidates + trust gate + thresholds
// ---------------------------------------------------------------------------

export interface CapacityRoutingConfig {
  /** Master toggle. Default false: an upgrade is inert until the operator turns it on. */
  enabled: boolean
  /** At most MAX_FALLBACK_CANDIDATES entries; enforced by withinCandidateCeiling at read time. */
  candidates: FallbackCandidate[]
  /** Usage fraction at/above which a key is 'limited' rather than 'degraded'. */
  limitedThreshold: number
  /** Backoff TTL used when no provider-stated reset time is observable. */
  ttlMs: number
}

const DEFAULT_CAPACITY_ROUTING_CONFIG: CapacityRoutingConfig = {
  enabled: false,
  candidates: [],
  limitedThreshold: 0.9,
  ttlMs: 30 * 60_000,
}

function normalizeCandidate(raw: unknown): FallbackCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.provider !== 'string' || !o.provider.trim()) return null
  if (typeof o.authProfile !== 'string' || !o.authProfile.trim()) return null
  if (typeof o.model !== 'string' || !o.model.trim()) return null
  return {
    provider: o.provider,
    authProfile: o.authProfile,
    model: o.model,
    // Fail-closed: absent/non-boolean enabledForRouting means NOT enabled.
    // A malformed config entry must never silently become routable.
    enabledForRouting: o.enabledForRouting === true,
    subscriptionIncluded: o.subscriptionIncluded === true,
  }
}

/** Coerce untrusted parsed JSON into a valid config; junk/partial input degrades to safe defaults. */
export function normalizeCapacityRoutingConfig(raw: unknown): CapacityRoutingConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  const rawCandidates = Array.isArray(o.candidates) ? o.candidates : []
  // Hard ceiling enforced HERE, at config load: silently accepting more than
  // MAX_FALLBACK_CANDIDATES would let a config file bypass the ceiling the
  // pure resolver only asserts about the list it is HANDED. Extra entries are
  // dropped, not silently truncated-and-hidden -- callers reading the config
  // object see exactly what will be used.
  const candidates = rawCandidates
    .map(normalizeCandidate)
    .filter((c): c is FallbackCandidate => c !== null)
    .slice(0, 2)
  const limitedThreshold = (typeof o.limitedThreshold === 'number' && o.limitedThreshold > 0 && o.limitedThreshold <= 1)
    ? o.limitedThreshold : DEFAULT_CAPACITY_ROUTING_CONFIG.limitedThreshold
  const ttlMs = (typeof o.ttlMs === 'number' && Number.isFinite(o.ttlMs) && o.ttlMs > 0)
    ? o.ttlMs : DEFAULT_CAPACITY_ROUTING_CONFIG.ttlMs
  return { enabled, candidates, limitedThreshold, ttlMs }
}

export function readCapacityRoutingConfig(path: string = CONFIG_PATH): CapacityRoutingConfig {
  try {
    return normalizeCapacityRoutingConfig(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { ...DEFAULT_CAPACITY_ROUTING_CONFIG }
  }
}

/**
 * Set the runtime routing master flag (review 2026-08-11, lean-opt O-1).
 *
 * WHY THIS EXISTS. The Optimalizálás page offered a master switch, seven module
 * toggles and an emergency stop, and none of them reached the runner: the page
 * writes `store/optimization-config.json`, and `startCapacityRoutingRunner`
 * gates on `enabled` in THIS file, which nothing in the codebase wrote. Measured
 * 2026-08-11: `enabled` was true and had been since 2026-07-30, so pressing the
 * emergency stop would have reported success while the sweep kept running.
 *
 * A switch that reports success without acting is worse than no switch: it is
 * the one you press in the minute you actually need it.
 *
 * Everything else in the file is preserved — this writes ONE field. The routing
 * candidates and their trust flags are an owner decision and are not touched.
 */
export function setCapacityRoutingEnabled(enabled: boolean, path: string = CONFIG_PATH): boolean {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    // No config on disk: write one that is OFF whatever was asked. Creating an
    // ENABLED config as a side effect of a dashboard toggle would arm routing
    // from a UI action, and arming is an owner decision (Phase 3, 2026-07-30).
    if (enabled) return false
    raw = { ...DEFAULT_CAPACITY_ROUTING_CONFIG }
  }
  if (raw.enabled === enabled) return false
  atomicWriteFileSync(path, JSON.stringify({ ...raw, enabled }, null, 2))
  return true
}

/** Whether a (provider, authProfile) pair is currently trusted for routing, per the LIVE config -- read fresh, not cached from write time. */
export function isEnabledForRouting(provider: string, authProfile: string, config: CapacityRoutingConfig = readCapacityRoutingConfig()): boolean {
  return config.candidates.some((c) => c.provider === provider && c.authProfile === authProfile && c.enabledForRouting)
}

// ---------------------------------------------------------------------------
// THE CHOKE POINT: every spawn site calls this instead of reading config directly
// ---------------------------------------------------------------------------

/**
 * The model to actually launch an agent with. `configuredModel` is what the
 * caller already resolved via resolveAgentModelDetailed/readAgentModel --
 * NEVER computed in here, NEVER written by here.
 *
 * Returns the overlay's model ONLY when:
 *   (a) an overlay entry exists for this agent, AND
 *   (b) that entry's (provider, authProfile) is STILL enabled_for_routing per
 *       the current config -- re-checked now, not trusted from write time, so
 *       revoking trust takes effect on the very next resolution even before
 *       any sweep clears the stale entry.
 * Any other case falls through to configuredModel. This IS the rollback: an
 * absent overlay file makes every call fall through, unconditionally.
 */
export function resolveRuntimeModel(
  agent: string,
  configuredModel: string,
  paths: { overlayPath?: string; configPath?: string } = {},
): string {
  const overlay = readRuntimeOverlay(agent, paths.overlayPath ?? OVERLAY_PATH)
  if (!overlay) return configuredModel
  const config = readCapacityRoutingConfig(paths.configPath ?? CONFIG_PATH)
  if (!isEnabledForRouting(overlay.provider, overlay.authProfile, config)) return configuredModel
  return overlay.model
}

// ---------------------------------------------------------------------------
// config-examples scaffold (mirrors the other CostOps *.example.json files)
// ---------------------------------------------------------------------------

export function ensureCapacityRoutingConfigExample(exampleDir: string): void {
  const examplePath = join(exampleDir, 'capacity-routing-config.example.json')
  if (existsSync(examplePath)) return
  const example = {
    _doc: 'Lean Optimization Phase 3 capacity-routing config (gitignored real copy: store/capacity-routing-config.json). '
      + 'enabled=false is safe-by-default. Each candidate needs enabledForRouting:true to ever be used -- an external/'
      + 'non-trusted provider stays false until a separate owner GO. At most 2 candidates (hard ceiling).',
    enabled: false,
    candidates: [
      { provider: 'anthropic', authProfile: 'plan:secondary', model: 'claude-sonnet-5', enabledForRouting: true, subscriptionIncluded: true },
    ],
    limitedThreshold: 0.9,
    ttlMs: 1_800_000,
  }
  writeFileSync(examplePath, JSON.stringify(example, null, 2) + '\n')
}
