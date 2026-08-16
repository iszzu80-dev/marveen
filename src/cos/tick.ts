// Personal Chief of Staff (COS) — the tick orchestrator (one cycle of work).
//
// Composes the scheduler queries, the executor, and the radar runner into ONE
// idempotent-per-item cycle the runtime calls each period:
//   1. reconcile outbound_ledger — drive executeAction on every row needing
//      automated RECOVERY work (SENDING/OUTCOME_UNKNOWN→recover,
//      APPLIED_UNVERIFIED→re-attempt readback). RECOVERY_REQUIRED is surfaced
//      for a human, not auto-driven.
//
//      NOT PLANNED, AND NOT FAILED_RETRYABLE. This comment used to name both,
//      and it was describing the tick as it was BEFORE F-7/N-3 (review
//      2026-08-13, R-12): `reconcileOutbound` excludes them, deliberately,
//      because either one starting here would be a FIRST delivery decided by a
//      loop that evaluates no gate. That check lives in dispatchApprovedSend /
//      dispatchZstSend. Leaving the old sentence in place is the failure mode
//      this codebase has been chasing all week — a comment asserting a wiring
//      that the code below it removed.
//
//      CONSEQUENCE, STATED SO IT IS NOT REDISCOVERED AS A BUG: the F-15 retry
//      ceiling and its backoff are therefore only reachable through a new
//      dispatch call (the owner re-sending from Mission Control), not through
//      this loop. That is the intended safety posture, not an oversight.
//   2. run due radar checks through the rental adapter, collecting HITs.
//   3. surface how many cases are due to wake / have due follow-ups (the caller
//      / LLM decides what to do with those).
//
// This function is pure orchestration over the built modules — no timer of its
// own — so it is fully testable in one cycle. Wiring it into the live heartbeat
// (calling cosTick every N seconds) is the separate, owner-gated go-live step.

import type Database from 'better-sqlite3'
import { reconcileOutbound, outboundNeedingHuman, dueCases, dueFollowUps, type DueCase } from './scheduler.js'
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
  /** Due radar items the tick declined to check because no adapter handles their
   *  kind. Counted, not silent: `radarChecked: 1` on its own cannot distinguish
   *  "one item due" from "one checked, eight skipped", and that ambiguity fed
   *  three wrong explanations for the radar's silence in a single evening. */
  radarSkippedNoAdapter: number
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
  /** The cases whose wake time has arrived — the ROWS, not a count.
   *
   *  This used to be `dueCases(db, now).length`, and that single `.length` was
   *  the whole bug: the write side (`setNextWake`) and the read side
   *  (`dueCases`) both existed, the tick called the reader every cycle, and
   *  then threw the identities away. A number cannot be acted on, so nothing
   *  ever acted, and `next_wake_at` sat at 0 of 61 open cases because filling
   *  it would have changed nothing. Measured 2026-08-16, after a decision
   *  deadline stated in prose expired unnoticed. */
  dueCases: DueCase[]
  dueFollowUps: DueCase[]
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
  let radarSkippedNoAdapter = 0
  for (const item of dueRadarChecks(db, now)) {
    // Dispatch by kind to the matching adapter; skip if no adapter for this kind.
    const canRental = item.kind === 'RENTAL' && deps.rentalAdapter
    const canProduct = item.kind === 'PRODUCT' && deps.shoppingAdapter
    // A SKIP IS REPORTED, NOT SWALLOWED.
    //
    // This `continue` was silent, and a silent skip is indistinguishable from
    // "checked it, found nothing" in every surface downstream. It caused no
    // outage — but on 2026-08-14/15 three separate wrong explanations for the
    // radar's week of silence were built on top of it, and each had to be
    // refuted by a side effect (observation rows, bus messages, task_runs)
    // because the tick itself reported nothing about what it declined to look
    // at. A branch that cannot be observed does not have to be wrong to be
    // expensive; it only has to be plausible.
    if (!canRental && !canProduct) { radarSkippedNoAdapter++; continue }
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
    radarSkippedNoAdapter,
    radarHits,
    radarNotifications,
    recoveryRequired: outboundNeedingHuman(db).map(w => w.ledger_id),
    dueCases: dueCases(db, now),
    dueFollowUps: dueFollowUps(db, now),
    errors,
  }
}
