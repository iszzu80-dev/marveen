// CostOps Phase 0 -- 7-day source-reliability observation window (gap-analysis
// P0.4). Captures a point-in-time snapshot of the full source inventory
// (lifecycle + freshness + sync status per source) so day-over-day
// reliability can be compared once several captures accumulate. This module
// only builds and stores ONE capture; the recurring daily cadence over the
// 7-day window is wired at boot (see web.ts) the same way the existing
// fixed-cost sync interval is -- this module has no scheduling of its own,
// keeping it independently testable.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { loadCostopsConfig, type CostOpsConfig } from './config.js'
import { buildSourceInventory, type SourceInventoryEntry, type CredentialChecker } from './inventory.js'
import { captureForecastSnapshots } from './forecast-capture.js'
import { captureAlerts } from './alerts-capture.js'
import { captureRecommendations } from './optimization-capture.js'
import { COLLECTOR_TICK_MS } from './collectors/scheduled-sync.js'
import { isTestRun } from '../test-run-marker.js'
import { logger } from '../logger.js'

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface ReliabilitySnapshot {
  captured_at: number
  source_count: number
  inventory: SourceInventoryEntry[]
}

/** Build and persist one reliability snapshot. Returns the row that was written. */
export function captureReliabilitySnapshot(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  deps: { credentialChecker?: CredentialChecker } = {},
): ReliabilitySnapshot {
  const inventory = buildSourceInventory(db, config, now, deps)
  db.prepare(`
    INSERT INTO costops_reliability_snapshots (captured_at, source_count, inventory_json)
    VALUES (@now, @count, @json)
  `).run({ now, count: inventory.length, json: JSON.stringify(inventory) })
  return { captured_at: now, source_count: inventory.length, inventory }
}

/** All snapshots captured so far, oldest first -- the growing 7-day observation window. */
export function listReliabilitySnapshots(db: Database.Database, limit = 30): Array<{ captured_at: number; source_count: number }> {
  return db.prepare(`
    SELECT captured_at, source_count FROM costops_reliability_snapshots
    ORDER BY captured_at ASC LIMIT ?
  `).all(limit) as Array<{ captured_at: number; source_count: number }>
}

/** The single most recent snapshot's full inventory, or null if none exist yet. */
export function getLatestReliabilitySnapshot(db: Database.Database): ReliabilitySnapshot | null {
  const row = db.prepare(`
    SELECT captured_at, source_count, inventory_json FROM costops_reliability_snapshots
    ORDER BY captured_at DESC LIMIT 1
  `).get() as { captured_at: number; source_count: number; inventory_json: string } | undefined
  if (!row) return null
  return { captured_at: row.captured_at, source_count: row.source_count, inventory: JSON.parse(row.inventory_json) }
}

function captureNowSafely(): void {
  const now = Math.floor(Date.now() / 1000)
  try {
    const { config } = loadCostopsConfig()
    captureReliabilitySnapshot(getDb(), config, now)
  } catch (err) {
    logger.warn({ err }, 'CostOps reliability snapshot capture failed')
  }
  // Phase 1 (GAP-10): forecast snapshots, same daily cadence. Independent
  // try/catch so a failure in one capture never blocks the other.
  try {
    captureForecastSnapshots(getDb(), now)
  } catch (err) {
    logger.warn({ err }, 'CostOps forecast snapshot capture failed')
  }
  // Phase 3 (GAP-12): alerts capture/reconcile, same daily cadence.
  try {
    const { config } = loadCostopsConfig()
    captureAlerts(getDb(), config, now)
  } catch (err) {
    logger.warn({ err }, 'CostOps alerts capture failed')
  }
  // Phase 4 (GAP-17): optimization recommendation capture/reconcile, same daily cadence.
  try {
    captureRecommendations(getDb(), now)
  } catch (err) {
    logger.warn({ err }, 'CostOps optimization recommendation capture failed')
  }
}

/**
 * Phase 2 / P2-C: run every DUE provider collector. Deliberately on its OWN,
 * faster tick rather than folded into captureNowSafely's 24h cadence -- a weekly
 * rate-limit percentage and a prepaid balance are capacity signals that are worth
 * nothing a day stale, while a reliability snapshot genuinely is a daily artifact.
 * The per-collector cadence lives in the plan (scheduled-sync.ts); this tick only
 * asks what is due, so raising the tick rate does not raise provider call volume.
 *
 * Fault-isolated end to end (runScheduledCollectorSyncSafe never rejects), so a
 * provider outage cannot take the background loop down.
 */
export function collectorSyncTickSafely(): void {
  // A unit test must never spawn `codex app-server` or reach a provider API, and
  // this tick is the one CostOps background task that does outbound work. Same
  // rationale as src/test-run-marker.ts's own guard (2026-07-27 incident: a test
  // suite firing the production outbound path). The WIRING is still proven --
  // source-level in costops-collector-schedule-wiring.test.ts and behaviourally by
  // startCostOpsBackgroundTasks returning this interval -- and the sweep itself is
  // tested offline with injected runners.
  if (isTestRun()) return
  const now = Math.floor(Date.now() / 1000)
  void (async () => {
    try {
      const { runScheduledCollectorSyncSafe } = await import('./collectors/scheduled-sync.js')
      await runScheduledCollectorSyncSafe(getDb(), now)
    } catch (err) {
      logger.warn({ err }, 'CostOps scheduled collector sync tick failed')
    }
  })()
}

/**
 * Boot-time seam entry point (docs/fork-upstream-policy.md §2a): the ONE
 * call web.ts makes for every CostOps background task, present and future
 * (currently: reliability-observation snapshots, Phase 1 forecast snapshots,
 * and the P2-C provider-collector sync). Runs both immediately, then on their
 * own cadences. Returns every interval handle so the caller can clear them all
 * on shutdown, matching every other start*Runner()/start*Monitor() in this
 * codebase (e.g. startAutoRestartRunner).
 */
export function startCostOpsBackgroundTasks(): NodeJS.Timeout[] {
  captureNowSafely()
  collectorSyncTickSafely()
  return [
    setInterval(captureNowSafely, SNAPSHOT_INTERVAL_MS),
    setInterval(collectorSyncTickSafely, COLLECTOR_TICK_MS),
  ]
}
