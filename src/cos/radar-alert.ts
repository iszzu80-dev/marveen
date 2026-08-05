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

interface ItemRow { label: string; kind: string; target_price: number | null; currency: string | null; best_seen_price: number | null; notification_reason: string | null }
interface ObsRow {
  best_price: number | null; offer_ref: string | null
  original_currency: string | null; original_final_price: number | null
  comparison_currency: string | null; fx_rate: number | null; fx_rate_source: string | null
}

const REASON_TEXT: Record<string, string> = {
  NEW_HIT: 'új találat', NEW_OFFER: 'új ajánlat', PRICE_DROP: 'további áresés',
}

/** Build the human-facing HIT alert text from the radar item + its latest
 *  observation. Returns null if the item is gone. */
export function buildRadarHitAlert(db: Database.Database, radarId: string): string | null {
  const item = db.prepare(
    `SELECT label, kind, target_price, currency, best_seen_price, notification_reason FROM radar_items WHERE radar_id = ?`
  ).get(radarId) as ItemRow | undefined
  if (!item) return null
  const obs = db.prepare(
    `SELECT best_price, offer_ref, original_currency, original_final_price,
            comparison_currency, fx_rate, fx_rate_source
     FROM radar_observations WHERE radar_id = ? ORDER BY observed_at DESC LIMIT 1`
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
  // P1.5: if the merchant quoted a different currency, show the original + rate so
  // the converted comparison is auditable (not a silent number).
  let fxTxt = ''
  if (obs && obs.original_currency && obs.comparison_currency && obs.original_currency !== obs.comparison_currency && obs.original_final_price != null) {
    const rate = obs.fx_rate != null ? ` @ ${obs.fx_rate}` : ''
    const src = obs.fx_rate_source && obs.fx_rate_source !== 'none' ? ` (${obs.fx_rate_source})` : ''
    fxTxt = ` [eredeti ${Number(obs.original_final_price).toLocaleString()} ${obs.original_currency}${rate}${src}]`
  }
  const reason = item.notification_reason ? ` (${REASON_TEXT[item.notification_reason] ?? item.notification_reason})` : ''
  return `🎯 COS radar HIT${reason}: ${item.label} — legjobb ár ${bestTxt} ${cur}${fxTxt} (cél ${targetTxt} ${cur})${deal}. Az ár a célár alá esett. A foglalás a te döntésed.`
}

/** Surface a HIT: post it to the bus (marveen relays to Telegram) and the daily
 *  log. Uses the singleton DB helpers, so pass the same live/getDb() handle. */
export function alertRadarHit(db: Database.Database, radarId: string): void {
  const content = buildRadarHitAlert(db, radarId)
  if (!content) return
  createAgentMessage('cos-radar', 'marveen', content, 'cos-autonomous-radar')
  appendDailyLog('marveen', `## COS RADAR HIT\n${content}`)
}
