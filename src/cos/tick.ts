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
import { reconcileOutbound, outboundNeedingHuman, dueCases, dueFollowUps } from './scheduler.js'
import { executeAction, type OutboundAdapter } from './executor.js'
import { dueRadarChecks } from './radar.js'
import { runRentalRadarCheck, runProductRadarCheck } from './radar-runner.js'
import type { ShoppingAdapter } from './shopping-adapter.js'
import type { RentalAdapter } from './rental-adapter.js'

export interface CosTickDeps {
  /** Outbound adapters keyed by action_type (e.g. { EMAIL_SEND: gmailAdapter }). */
  outboundAdapters?: Record<string, OutboundAdapter>
  rentalAdapter?: RentalAdapter
  /** Price source for PRODUCT radar items (personal BUY-*, ZST procurement). */
  shoppingAdapter?: ShoppingAdapter
}

/** One radar hit the owner has NOT been told about yet, with everything
 *  markNotified needs. The tick deliberately does not persist it — see the
 *  radarNotifications note on CosTickResult. */
export interface PendingRadarNotification {
  radarId: string
  offerId: string | null
  price: number | null
  reason: string | null
}

export interface CosTickResult {
  outboundProcessed: number
  outboundSkippedNoAdapter: number
  radarChecked: number
  radarHits: string[]
  /** Hits that still owe the owner an alert. The tick does NOT call markNotified:
   *  radar.ts:markNotified's contract is "call AFTER the alert is posted", and
   *  the alert (alertRadarHit) happens in the caller, one `.then()` later. Marking
   *  here meant a crash — or an alertRadarHit that threw on its first statement —
   *  left the item recorded as notified while the owner heard nothing; and because
   *  the status stays HIT for as long as the price stays under target, every
   *  branch of decideNotify then returns should:false and the deal is NEVER
   *  surfaced. Silence is the one failure mode the radar cannot have, so the
   *  decision travels out unpersisted and the caller marks it once the alert has
   *  actually returned. */
  radarNotifications: PendingRadarNotification[]
  /** Outbound rows in RECOVERY_REQUIRED — provider claimed success but the marker
   *  is provably absent; a human must resolve them (never auto-resent). */
  recoveryRequired: string[]
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
  // E1: the queue's SENDING grace window is measured against a clock, and the
  // tick has its own. Letting it default to wall time would make a test that
  // injects `now` reason about two different clocks.
  for (const w of reconcileOutbound(db, 100, now)) {
    const ad = adapters[w.action_type]
    if (!ad) { outboundSkippedNoAdapter++; continue }
    try { await executeAction(db, ad, w.ledger_id, now); outboundProcessed++ }
    catch (e) { errors.push({ where: 'outbound', id: w.ledger_id, error: String((e as Error)?.message ?? e) }) }
  }

  // 2. radar checks
  const radarHits: string[] = []
  const radarNotifications: PendingRadarNotification[] = []
  let radarChecked = 0
  for (const item of dueRadarChecks(db, now)) {
    // Dispatch by kind to the matching adapter; skip if no adapter for this kind.
    const canRental = item.kind === 'RENTAL' && deps.rentalAdapter
    const canProduct = item.kind === 'PRODUCT' && deps.shoppingAdapter
    if (!canRental && !canProduct) continue
    radarChecked++
    try {
      const res = canRental
        ? await runRentalRadarCheck(db, item, deps.rentalAdapter!, now)
        : await runProductRadarCheck(db, item, deps.shoppingAdapter!, now)
      // P1.6: only surface a HIT the owner has not already heard about (new/
      // different offer, or a significant further drop). The dedup state
      // (markNotified) is written by whoever posts the alert, not here.
      if (res.notify.should) {
        radarHits.push(item.radar_id)
        radarNotifications.push({
          radarId: item.radar_id, offerId: res.offerId, price: res.bestPrice, reason: res.notify.reason,
        })
      }
    } catch (e) { errors.push({ where: 'radar', id: item.radar_id, error: String((e as Error)?.message ?? e) }) }
  }

  // 3. surface due work (the caller acts on these)
  return {
    outboundProcessed,
    outboundSkippedNoAdapter,
    radarChecked,
    radarHits,
    radarNotifications,
    recoveryRequired: outboundNeedingHuman(db).map(w => w.ledger_id),
    dueCases: dueCases(db, now).length,
    dueFollowUps: dueFollowUps(db, now).length,
    errors,
  }
}
