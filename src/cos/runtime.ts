// Personal Chief of Staff (COS) — autonomous runtime loop.
//
// Wires cosTick into a background interval so the COS runs hands-off. The whole
// safety posture lives in safeCosDeps(): it wires ONLY the rental adapter, so
// the loop does the safe, read-only work (radar price checks). NO outbound
// adapter is wired → cosTick skips every outbound row → nothing sends or buys
// autonomously until a real connector + Istvan's write-scope consent are added.
// The loop is therefore safe to run live today.

import { cosTick, type CosTickDeps, type CosTickResult, type PendingRadarNotification } from './tick.js'
import type Database from 'better-sqlite3'
import { DiscoverCarsAdapter } from './adapters/discovercars.js'
import { EmagAdapter } from './adapters/emag.js'
import { markNotified } from './radar.js'
import { alertRadarHit } from './radar-alert.js'
import { alertOutboundRecovery } from './outbound-alert.js'
import { registerConnector, recordSuccess } from './connector-health.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

/** Register the COS connectors in connector_health at boot so the Monitoring view
 *  reflects them and the dispatch gate has a row to check. SAFE default: gmail is
 *  READ_ONLY (send stays inert until deliberately flipped READ_WRITE); the rental
 *  adapter is a working read-only price source. registerConnector is ON CONFLICT
 *  DO NOTHING, so a later READ_WRITE flip is never clobbered by a restart. */
export function registerCosConnectors(db = getDb(), now = Math.floor(Date.now() / 1000)): void {
  registerConnector(db, 'gmail', 'email', 'READ_ONLY', now)
  registerConnector(db, 'rental', 'shopping', 'READ_ONLY', now)
  registerConnector(db, 'emag', 'shopping', 'READ_ONLY', now)
  // the rental + eMAG price sources are live/working read-only
  try { recordSuccess(db, 'rental', now) } catch { /* row may not exist on a read-only db */ }
  try { recordSuccess(db, 'emag', now) } catch { /* row may not exist on a read-only db */ }
}

/** Interval between autonomous ticks (radar re-checks). */
export const COS_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

/** The SAFE autonomous deps: radar price checks via the DiscoverCars API (RENTAL)
 *  and the eMAG webshop (PRODUCT) — both read-only price sources with NO checkout
 *  surface (assertNoCheckoutSurface), so no send/buy can happen autonomously. */
export function safeCosDeps(): CosTickDeps {
  return { rentalAdapter: new DiscoverCarsAdapter(), shoppingAdapter: new EmagAdapter() }
}

/** Run one tick. Extracted so tests inject deps + clock; the loop below uses the
 *  safe defaults. */
export async function runCosTickOnce(
  db = getDb(), deps: CosTickDeps = safeCosDeps(), now = Math.floor(Date.now() / 1000),
): Promise<CosTickResult> {
  return cosTick(db, deps, now)
}

/**
 * Post every pending radar HIT and only then record it as notified.
 *
 * The ORDER is the whole point. markNotified used to run inside cosTick, one
 * `.then()` earlier than the alert it claims to describe, so anything that went
 * wrong in between — a crash, an alertRadarHit that threw on its first statement
 * — left the item stamped "the owner knows" while the owner knew nothing. That is
 * unrecoverable, not merely late: while the price stays at/under target the item
 * stays HIT, so decideNotify's every branch returns should:false and the deal is
 * never mentioned again. A price falls below target once.
 *
 * Consequently a failed alert leaves the dedup state UNTOUCHED, so the next tick
 * re-offers the same hit. Re-telling the owner about a deal is a nuisance; never
 * telling him is the radar failing at its only job.
 */
export function deliverRadarNotifications(
  db: Database.Database, res: CosTickResult, now = Math.floor(Date.now() / 1000),
): void {
  for (const n of res.radarNotifications) deliverRadarNotification(db, n, now)
}

/**
 * Deliver ONE pending radar notification: alert, then mark.
 *
 * Extracted from the loop above so the websearch sweep is a SECOND CALLER of
 * this exact ordering rather than a fifth copy of it. That distinction is the
 * whole point: the ordering rule documented above (alert first, mark only on
 * success) is the kind of rule that survives in one place and rots in five.
 *
 * The sweep needs it because delivery there used to be prompt-only. The
 * recording script printed `notify` to stdout and a model was expected to read
 * it and send the alert; on 2026-08-07 and 2026-08-09 three at-target product
 * observations were recorded and NONE reached the owner — the only radar alert
 * ever posted to the bus came from this code path, the rental one. Whoever
 * calls the recorder now cannot drop the alert, because the alert is no longer
 * theirs to forget.
 *
 * Returns true when the owner was told AND the item was marked; false when the
 * alert failed (dedup state deliberately untouched, so the next run retries).
 */
export function deliverRadarNotification(
  db: Database.Database, n: PendingRadarNotification, now = Math.floor(Date.now() / 1000),
): boolean {
  logger.warn({ radarId: n.radarId }, 'COS radar HIT — target price met')
  try {
    alertRadarHit(db, n.radarId)
    markNotified(db, n.radarId, { offerId: n.offerId, price: n.price, reason: n.reason }, now)
    return true
  } catch (err) {
    logger.error({ err, radarId: n.radarId }, 'radar HIT alert failed — NOT marked notified, will retry next tick')
    return false
  }
}

let timer: ReturnType<typeof setInterval> | undefined

/** Start the autonomous COS loop (radar only). Idempotent. Does NOT tick at boot
 *  (avoids slowing startup); first tick after the interval. */
export function startCosBackgroundTasks(): ReturnType<typeof setInterval> {
  if (timer) return timer
  try { registerCosConnectors() } catch (err) { logger.error({ err }, 'COS connector registration failed') }
  timer = setInterval(() => {
    runCosTickOnce()
      .then((res) => {
        if (res.radarChecked || res.radarHits.length || res.recoveryRequired.length || res.errors.length) {
          logger.info({ cos: res }, 'cosTick (autonomous)')
        }
        // A radar HIT is a real deal — post it to the bus (marveen relays it to
        // Telegram) + the daily log, THEN record the dedup state.
        deliverRadarNotifications(getDb(), res)
        // Outbound rows stuck in RECOVERY_REQUIRED need a human — surface them
        // (the executor will never auto-resend a provider-claimed success).
        if (res.recoveryRequired.length) {
          logger.warn({ ledgerIds: res.recoveryRequired }, 'COS outbound RECOVERY_REQUIRED — human resolution needed')
          try { alertOutboundRecovery(getDb()) } catch (err) { logger.error({ err }, 'outbound recovery alert failed') }
        }
      })
      .catch((err) => logger.error({ err }, 'cosTick failed'))
  }, COS_TICK_INTERVAL_MS)
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  return timer
}

export function stopCosBackgroundTasks(): void {
  if (timer) { clearInterval(timer); timer = undefined }
}
