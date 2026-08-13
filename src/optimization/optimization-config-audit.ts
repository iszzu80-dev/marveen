// Lean Optimization dashboard -- optimization-config change audit (OPT-M3,
// review 2026-08-12).
//
// The dashboard spec (optimization-dashboard-implementation-spec.md §8.1,
// acceptance: "minden configvaltozas auditalt" / every config change is
// audited) requires an audit record per config write, and until this module
// existed PATCH /api/optimization/settings and the emergency stop wrote the
// config file with no trace beyond the file's own version counter. The
// DECISION side already had exactly this shape (optimization_decision_events,
// optimization-decisions.ts): an append-only event table created idempotently
// at the route boundary. This is the parallel table for CONFIG writes,
// deliberately lean: one row per write, metadata only.
//
// METADATA-ONLY invariant, same as /api/optimization/audit: timestamps,
// version numbers, boolean flag names and a human-readable delta summary.
// No prompt text, no credentials, no account identifiers.
//
// Deterministic: pure SQLite. No LLM, no network, no fs.

import type Database from 'better-sqlite3'
import type { OptimizationConfig } from './optimization-config.js'

/**
 * Which write path produced the row:
 *  - settings:    PATCH /api/optimization/settings (dashboard form)
 *  - emergency:   POST /api/optimization/emergency-disable (kill switch)
 *  - propagation: the OFF-direction side effect inside writeOptimizationConfig
 *                 that flips the capacity-routing runner flag (O-1 seam) --
 *                 a real config change of ANOTHER file, so it gets its own row.
 */
export type OptimizationConfigAuditSurface = 'settings' | 'emergency' | 'propagation'

export interface OptimizationConfigAuditRow {
  id: number
  at: number
  surface: string
  version_from: number
  version_to: number
  master_enabled_from: number
  master_enabled_to: number
  /** Human-readable list of changed flags, or 'no flag changes'. */
  delta_summary: string
}

export function initOptimizationConfigAuditSchema(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS optimization_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      surface TEXT NOT NULL,
      version_from INTEGER NOT NULL,
      version_to INTEGER NOT NULL,
      master_enabled_from INTEGER NOT NULL,
      master_enabled_to INTEGER NOT NULL,
      delta_summary TEXT NOT NULL
    )
  `).run()
}

const MODULE_KEYS = [
  'measurement',
  'contextEfficiency',
  'capacityMonitoring',
  'runtimeRouting',
  'recommendations',
  'marketWatch',
  'benchmarkRecommendations',
] as const

const ROUTING_KEYS = [
  'automaticFallback',
  'trustedProvidersOnly',
  'maxFallbacksPerProfile',
  'maxAutomaticFallbacksPerDispatch',
] as const

/**
 * Human-readable summary of what actually changed between two configs:
 * masterEnabled, preset, every module flag and every routing knob, each as
 * `name from->to`. A write that changed nothing but the version says so
 * explicitly ('no flag changes') instead of leaving an empty string a reader
 * could mistake for a recording failure.
 */
export function summarizeConfigDelta(from: OptimizationConfig, to: OptimizationConfig): string {
  const parts: string[] = []
  if (from.masterEnabled !== to.masterEnabled) parts.push(`masterEnabled ${from.masterEnabled}->${to.masterEnabled}`)
  if (from.preset !== to.preset) parts.push(`preset ${from.preset}->${to.preset}`)
  for (const key of MODULE_KEYS) {
    if (from.modules[key] !== to.modules[key]) parts.push(`modules.${key} ${from.modules[key]}->${to.modules[key]}`)
  }
  for (const key of ROUTING_KEYS) {
    if (from.routing[key] !== to.routing[key]) parts.push(`routing.${key} ${from.routing[key]}->${to.routing[key]}`)
  }
  return parts.length > 0 ? parts.join('; ') : 'no flag changes'
}

export interface RecordConfigAuditInput {
  at: number
  surface: OptimizationConfigAuditSurface
  from: OptimizationConfig
  to: OptimizationConfig
  /** Overrides the derived summary -- used by the propagation surface, whose
   *  change lives in a DIFFERENT file than the two configs describe. */
  deltaSummary?: string
}

/** Append one audit row for a config write. Never updates or deletes. */
export function recordOptimizationConfigAudit(db: Database.Database, input: RecordConfigAuditInput): void {
  db.prepare(`
    INSERT INTO optimization_config_audit
      (at, surface, version_from, version_to, master_enabled_from, master_enabled_to, delta_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.at,
    input.surface,
    input.from.version,
    input.to.version,
    input.from.masterEnabled ? 1 : 0,
    input.to.masterEnabled ? 1 : 0,
    input.deltaSummary ?? summarizeConfigDelta(input.from, input.to),
  )
}

export function listOptimizationConfigAudit(db: Database.Database): OptimizationConfigAuditRow[] {
  return db.prepare(`
    SELECT * FROM optimization_config_audit ORDER BY id ASC
  `).all() as OptimizationConfigAuditRow[]
}
