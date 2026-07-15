// CostOps Phase 0 -- 7-day source-reliability observation window (gap-analysis
// P0.4). Captures a point-in-time snapshot of the full source inventory
// (lifecycle + freshness + sync status per source) so day-over-day
// reliability can be compared once several captures accumulate. This module
// only builds and stores ONE capture; the recurring daily cadence over the
// 7-day window is wired at boot (see web.ts) the same way the existing
// fixed-cost sync interval is -- this module has no scheduling of its own,
// keeping it independently testable.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import { buildSourceInventory, type SourceInventoryEntry, type CredentialChecker } from './inventory.js'

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
