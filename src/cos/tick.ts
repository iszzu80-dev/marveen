// Personal Chief of Staff (COS) — the tick orchestrator (one cycle of work).
//
// Composes the scheduler queries, the executor, and the radar runner into ONE
// idempotent-per-item cycle the runtime calls each period:
//   1. reconcile outbound_ledger — drive executeAction on every row needing
//      automated work (PLANNED/FAILED_RETRYABLE→send, SENDING/OUTCOME_UNKNOWN→
//      recover, APPLIED_UNVERIFIED→re-attempt readback). RECOVERY_REQUIRED is
//      surfaced for a human, not auto-driven.
//   2. run due radar checks through the rental adapter, collecting HITs.
//   3. surface how many cases are due to wake / have due follow-ups (the caller
//      / LLM decides what to do with those).
//
// This function is pure orchestration over the built modules — no timer of its
// own — so it is fully testable in one cycle. Wiring it into the live heartbeat
// (calling cosTick every N seconds) is the separate, owner-gated go-live step.

import type Database from 'better-sqlite3'
import { reconcileOutbound, dueCases, dueFollowUps } from './scheduler.js'
import { executeAction, type OutboundAdapter } from './executor.js'
import { dueRadarChecks } from './radar.js'
import { runRentalRadarCheck } from './radar-runner.js'
import type { RentalAdapter } from './rental-adapter.js'

export interface CosTickDeps {
  /** Outbound adapters keyed by action_type (e.g. { EMAIL_SEND: gmailAdapter }). */
  outboundAdapters?: Record<string, OutboundAdapter>
  rentalAdapter?: RentalAdapter
}

export interface CosTickResult {
  outboundProcessed: number
  outboundSkippedNoAdapter: number
  radarChecked: number
  radarHits: string[]
  dueCases: number
  dueFollowUps: number
  errors: Array<{ where: string; id: string; error: string }>
}

/** Run one COS cycle. Never throws for a single item's failure — it collects the
 *  error and continues, so one bad row can't stall the whole tick. */
export async function cosTick(db: Database.Database, deps: CosTickDeps, now: number): Promise<CosTickResult> {
  const errors: CosTickResult['errors'] = []
  const adapters = deps.outboundAdapters ?? {}

  // 1. outbound reconcile
  let outboundProcessed = 0
  let outboundSkippedNoAdapter = 0
  for (const w of reconcileOutbound(db)) {
    const ad = adapters[w.action_type]
    if (!ad) { outboundSkippedNoAdapter++; continue }
    try { await executeAction(db, ad, w.ledger_id, now); outboundProcessed++ }
    catch (e) { errors.push({ where: 'outbound', id: w.ledger_id, error: String((e as Error)?.message ?? e) }) }
  }

  // 2. radar checks
  const radarHits: string[] = []
  let radarChecked = 0
  for (const item of dueRadarChecks(db, now)) {
    if (item.kind !== 'RENTAL' || !deps.rentalAdapter) continue
    radarChecked++
    try {
      const res = await runRentalRadarCheck(db, item, deps.rentalAdapter, now)
      if (res.hit) radarHits.push(item.radar_id)
    } catch (e) { errors.push({ where: 'radar', id: item.radar_id, error: String((e as Error)?.message ?? e) }) }
  }

  // 3. surface due work (the caller acts on these)
  return {
    outboundProcessed,
    outboundSkippedNoAdapter,
    radarChecked,
    radarHits,
    dueCases: dueCases(db, now).length,
    dueFollowUps: dueFollowUps(db, now).length,
    errors,
  }
}
