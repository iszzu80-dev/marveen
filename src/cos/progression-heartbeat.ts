// Progression heartbeat — periodic runner for the progression scheduler.
// Card 52250c7f, thin vertical slice (GATE 0-2).
//
// This is the ONE function that a cron/scheduled-task should call. It:
//   1. Finds all due cases (next_progression_at <= now) across both domains
//   2. For each, atomically claims it (tryClaimProgression)
//   3. Runs one progression cycle
//   4. Releases the claim
//
// All mutations are domain-scoped and internal only (no external side effects).
// At GATE 2, nothing here can send email, dispatch, or reach outside the DB.
//
// Usage from a cron / scheduled task:
//   import { getDb } from '../db.js'
//   import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'
//   const db = getDb()
//   const result = runProgressionHeartbeat(db)
//   // result: { personal: N, zst: N, errors: [...] }

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  findDueCases,
  tryClaimProgression,
  releaseProgressionClaim,
} from './progression-scheduler.js'
import { runProgressionCycle, type PipelineOptions } from './progression-pipeline.js'

export interface HeartbeatResult {
  personal: number
  zst: number
  errors: string[]
  /** Cases that were claimed by another runner and skipped. */
  skippedClaimed: number
  /** Cases that threw during the cycle. */
  cycleErrors: number
}

/** Run one heartbeat sweep across both domains.
 *
 *  Processes up to 50 cases per domain per sweep (configurable).
 *  Each case is claimed atomically — if two runners overlap, only one
 *  processes a given case.
 *
 *  The heartbeat is SAFE to call from a cron running every few minutes.
 *  Idempotent claim + lease means no case is double-processed. */
export function runProgressionHeartbeat(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
  maxPerDomain: number = 50,
): HeartbeatResult {
  const result: HeartbeatResult = {
    personal: 0,
    zst: 0,
    errors: [],
    skippedClaimed: 0,
    cycleErrors: 0,
  }

  for (const domain of ['personal', 'zst'] as const) {
    const due = findDueCases(db, domain, now, maxPerDomain)

    for (const dc of due) {
      // Skip cases already claimed by another runner
      if (dc.claimed_by_other) {
        result.skippedClaimed++
        continue
      }

      const runId = randomUUID()
      const claimed = tryClaimProgression(db, domain, dc.case_id, runId, 300, now)

      if (!claimed) {
        // Lost the race to another runner — skip
        result.skippedClaimed++
        continue
      }

      try {
        const opts: PipelineOptions = {
          triggerType: 'SCHEDULED',
          triggerReference: `heartbeat-${runId.slice(0, 8)}`,
        }
        runProgressionCycle(db, domain, dc.case_id, now, opts)

        if (domain === 'personal') result.personal++
        else result.zst++
      } catch (err) {
        result.cycleErrors++
        result.errors.push(
          `${domain}/${dc.case_id}: ${(err as Error).message}`,
        )
      } finally {
        releaseProgressionClaim(db, domain, dc.case_id, runId, now)
      }
    }
  }

  return result
}
