// Personal Chief of Staff (COS) — autonomous runtime loop.
//
// Wires cosTick into a background interval so the COS runs hands-off. The whole
// safety posture lives in safeCosDeps(): it wires ONLY the rental adapter, so
// the loop does the safe, read-only work (radar price checks). NO outbound
// adapter is wired → cosTick skips every outbound row → nothing sends or buys
// autonomously until a real connector + Istvan's write-scope consent are added.
// The loop is therefore safe to run live today.

import { cosTick, type CosTickDeps, type CosTickResult } from './tick.js'
import { DiscoverCarsAdapter } from './adapters/discovercars.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

/** Interval between autonomous ticks (radar re-checks). */
export const COS_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

/** The SAFE autonomous deps: radar price checks via the DiscoverCars API only —
 *  no outbound adapter, so no send/buy can happen autonomously. */
export function safeCosDeps(): CosTickDeps {
  return { rentalAdapter: new DiscoverCarsAdapter() }
}

/** Run one tick. Extracted so tests inject deps + clock; the loop below uses the
 *  safe defaults. */
export async function runCosTickOnce(
  db = getDb(), deps: CosTickDeps = safeCosDeps(), now = Math.floor(Date.now() / 1000),
): Promise<CosTickResult> {
  return cosTick(db, deps, now)
}

let timer: ReturnType<typeof setInterval> | undefined

/** Start the autonomous COS loop (radar only). Idempotent. Does NOT tick at boot
 *  (avoids slowing startup); first tick after the interval. */
export function startCosBackgroundTasks(): ReturnType<typeof setInterval> {
  if (timer) return timer
  timer = setInterval(() => {
    runCosTickOnce()
      .then((res) => {
        if (res.radarChecked || res.radarHits.length || res.errors.length) {
          logger.info({ cos: res }, 'cosTick (autonomous)')
        }
        // A radar HIT is a real deal — surfaced loudly. (Telegram alert = follow-up.)
        for (const hit of res.radarHits) logger.warn({ radarId: hit }, 'COS radar HIT — target price met')
      })
      .catch((err) => logger.error({ err }, 'cosTick failed'))
  }, COS_TICK_INTERVAL_MS)
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  return timer
}

export function stopCosBackgroundTasks(): void {
  if (timer) { clearInterval(timer); timer = undefined }
}
