// Personal Chief of Staff (COS) — radar HIT alert.
//
// When the autonomous loop finds a radar HIT (best price fell to/under the
// target), Istvan should hear about it. The runtime posts an inter-agent bus
// message to `marveen` (the main agent relays it to Telegram) plus a daily-log
// entry. buildRadarHitAlert is pure (returns the text) so it is testable; the
// send is a thin wrapper over the existing bus + daily-log helpers. No purchase
// — the alert just surfaces the deal; booking stays the owner's decision.

import type Database from 'better-sqlite3'
import { createAgentMessage, appendDailyLog } from '../db.js'

interface ItemRow { label: string; kind: string; target_price: number | null; currency: string | null; best_seen_price: number | null }
interface ObsRow { best_price: number | null; offer_ref: string | null }

/** Build the human-facing HIT alert text from the radar item + its latest
 *  observation. Returns null if the item is gone. */
export function buildRadarHitAlert(db: Database.Database, radarId: string): string | null {
  const item = db.prepare(
    `SELECT label, kind, target_price, currency, best_seen_price FROM radar_items WHERE radar_id = ?`
  ).get(radarId) as ItemRow | undefined
  if (!item) return null
  const obs = db.prepare(
    `SELECT best_price, offer_ref FROM radar_observations WHERE radar_id = ? ORDER BY observed_at DESC LIMIT 1`
  ).get(radarId) as ObsRow | undefined

  const best = obs?.best_price ?? item.best_seen_price
  let deal = ''
  if (obs?.offer_ref) {
    try {
      const o = JSON.parse(obs.offer_ref)
      const parts = [o.car, o.category, o.supplier].filter(Boolean)
      if (parts.length) deal = ' — ' + parts.join(', ')
    } catch { /* ignore malformed snapshot */ }
  }
  const cur = item.currency ?? ''
  const bestTxt = best != null ? Number(best).toLocaleString() : '?'
  const targetTxt = item.target_price != null ? Number(item.target_price).toLocaleString() : '?'
  return `🎯 COS radar HIT: ${item.label} — legjobb ár ${bestTxt} ${cur} (cél ${targetTxt} ${cur})${deal}. Az ár a célár alá esett. A foglalás a te döntésed.`
}

/** Surface a HIT: post it to the bus (marveen relays to Telegram) and the daily
 *  log. Uses the singleton DB helpers, so pass the same live/getDb() handle. */
export function alertRadarHit(db: Database.Database, radarId: string): void {
  const content = buildRadarHitAlert(db, radarId)
  if (!content) return
  createAgentMessage('cos-radar', 'marveen', content, 'cos-autonomous-radar')
  appendDailyLog('marveen', `## COS RADAR HIT\n${content}`)
}
