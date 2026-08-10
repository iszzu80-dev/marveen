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
import { reconcileOutbound, outboundNeedingHuman, dueCases, dueFollowUps } from './scheduler.js';
import { executeAction } from './executor.js';
import { dueRadarChecks, markNotified } from './radar.js';
import { runRentalRadarCheck, runProductRadarCheck } from './radar-runner.js';
/** Run one COS cycle. Never throws for a single item's failure — it collects the
 *  error and continues, so one bad row can't stall the whole tick. */
export async function cosTick(db, deps, now) {
    const errors = [];
    const adapters = deps.outboundAdapters ?? {};
    // 1. outbound reconcile
    let outboundProcessed = 0;
    let outboundSkippedNoAdapter = 0;
    for (const w of reconcileOutbound(db)) {
        const ad = adapters[w.action_type];
        if (!ad) {
            outboundSkippedNoAdapter++;
            continue;
        }
        try {
            await executeAction(db, ad, w.ledger_id, now);
            outboundProcessed++;
        }
        catch (e) {
            errors.push({ where: 'outbound', id: w.ledger_id, error: String(e?.message ?? e) });
        }
    }
    // 2. radar checks
    const radarHits = [];
    let radarChecked = 0;
    for (const item of dueRadarChecks(db, now)) {
        // Dispatch by kind to the matching adapter; skip if no adapter for this kind.
        const canRental = item.kind === 'RENTAL' && deps.rentalAdapter;
        const canProduct = item.kind === 'PRODUCT' && deps.shoppingAdapter;
        if (!canRental && !canProduct)
            continue;
        radarChecked++;
        try {
            const res = canRental
                ? await runRentalRadarCheck(db, item, deps.rentalAdapter, now)
                : await runProductRadarCheck(db, item, deps.shoppingAdapter, now);
            // P1.6: only surface a HIT the owner has not already heard about (new/
            // different offer, or a significant further drop). markNotified records
            // what we alerted so an unchanged offer never re-pings next cycle.
            if (res.notify.should) {
                radarHits.push(item.radar_id);
                markNotified(db, item.radar_id, { offerId: res.offerId, price: res.bestPrice, reason: res.notify.reason }, now);
            }
        }
        catch (e) {
            errors.push({ where: 'radar', id: item.radar_id, error: String(e?.message ?? e) });
        }
    }
    // 3. surface due work (the caller acts on these)
    return {
        outboundProcessed,
        outboundSkippedNoAdapter,
        radarChecked,
        radarHits,
        recoveryRequired: outboundNeedingHuman(db).map(w => w.ledger_id),
        dueCases: dueCases(db, now).length,
        dueFollowUps: dueFollowUps(db, now).length,
        errors,
    };
}
