/**
 * The radar's daily signal — and specifically, the finds it did NOT alert on.
 *
 * A hit reaches Istvan the moment it happens (alertRadarHit). This file carries
 * the other half, the half that has never had a surface: offers that met the
 * target price but whose delivery to Hungary we could not confirm. Those are
 * not deals — we will not tell him to buy something we cannot confirm he can
 * receive — but they are also not nothing, and the difference between
 *
 *     "nothing was cheap enough"            (correct silence)
 *     "three were, and we could not check"  (blindness)
 *
 * is exactly the difference that hid a week of radar silence in August 2026.
 * A counter in the cycle telemetry does not close that gap: `heldBacklogFull`
 * has been counting all along and never reached the person it concerns.
 *
 * THE ZERO CASE SPEAKS. When there is nothing unverified, the digest says so,
 * for the same reason the PLANNED digest does: a message that only ever appears
 * when something is wrong cannot be distinguished from one that stopped running.
 *
 * Mechanics are deliberately copied from reportPlannedOutbound rather than
 * invented: once per Budapest calendar day, gated on its OWN receipt in
 * daily_logs (a missing receipt re-fires; a spurious "already done" is
 * impossible), posted from the ten-minute cycle so it is alive whenever the
 * cycle is. That path is proven — it fired this morning — and a second delivery
 * mechanism is the thing this whole card is about not building.
 */
import type Database from 'better-sqlite3'
import { createAgentMessage, appendDailyLog } from '../db.js'
import { APP_TZ } from '../config.js'
import type { Shippability } from './radar.js'

export const RADAR_DIGEST_HEADER = '## COS radar -- szallitas nem igazolt'

export interface UnverifiedFind {
  radarId: string
  label: string
  bestPrice: number
  targetPrice: number
  currency: string
  shippable: Shippability
  shop: string
  observedAt: number
}

export interface RadarDigest {
  count: number
  finds: UnverifiedFind[]
  text: string
}

/** The shop name from an offer_ref snapshot, best-effort. Never throws: an
 *  unreadable ref must not remove the find from the report. */
function shopOf(offerRef: string | null, offerId: string | null): string {
  if (offerRef) {
    try {
      const parsed = JSON.parse(offerRef) as { shop?: unknown; name?: unknown }
      if (typeof parsed.shop === 'string' && parsed.shop.trim() !== '') return parsed.shop
      if (typeof parsed.name === 'string' && parsed.name.trim() !== '') return parsed.name
    } catch { /* fall through to the offer id */ }
  }
  return offerId ?? '(ismeretlen forras)'
}

/**
 * Products whose LATEST observation met the target price but is not confirmed
 * deliverable to Hungary.
 *
 * Latest per item, not every historical row: the question the digest answers is
 * "what is true now", and a find that was under target last Tuesday and is not
 * today would otherwise be reported forever. Restricted to PRODUCT because
 * deliverability does not gate rentals (see recordObservation).
 */
export function unverifiedFinds(db: Database.Database, limit = 20): UnverifiedFind[] {
  const rows = db.prepare(
    `SELECT o.radar_id, o.best_price, o.currency, o.offer_ref, o.offer_id,
            o.shippable_hu, o.observed_at, i.label, i.target_price, i.currency AS item_currency
       FROM radar_observations o
       JOIN radar_items i ON i.radar_id = o.radar_id
      WHERE i.kind = 'PRODUCT'
        AND i.status IN ('ACTIVE','HIT')
        AND o.observed_at = (SELECT MAX(o2.observed_at) FROM radar_observations o2 WHERE o2.radar_id = o.radar_id)
        AND o.best_price IS NOT NULL
        AND i.target_price IS NOT NULL
        AND o.best_price <= i.target_price
        AND o.shippable_hu <> 'YES'
      ORDER BY o.best_price ASC
      LIMIT ?`
  ).all(limit) as Array<{
    radar_id: string; best_price: number; currency: string | null; offer_ref: string | null
    offer_id: string | null; shippable_hu: Shippability; observed_at: number
    label: string; target_price: number; item_currency: string | null
  }>
  return rows.map(r => ({
    radarId: r.radar_id, label: r.label, bestPrice: r.best_price, targetPrice: r.target_price,
    currency: (r.currency ?? r.item_currency ?? 'HUF'), shippable: r.shippable_hu,
    shop: shopOf(r.offer_ref, r.offer_id), observedAt: r.observed_at,
  }))
}

const SHIPPABLE_TEXT: Record<Shippability, string> = {
  UNKNOWN: 'a szallitas nem igazolt',
  NO: 'nem szallit Magyarorszagra',
  YES: 'szallit', // unreachable here; present so the map is total
}

export function buildRadarDigest(db: Database.Database, limit = 20): RadarDigest {
  const finds = unverifiedFinds(db, limit)
  if (finds.length === 0) {
    // The zero case is a REPORT, not an absence. See the file header.
    return { count: 0, finds, text: `${RADAR_DIGEST_HEADER}: 0 tetel. Minden celar alatti talalat szallithatosaga igazolt.` }
  }
  const lines = finds.map(f =>
    `- ${f.label}: ${f.bestPrice.toLocaleString('hu-HU')} ${f.currency}`
    + ` (cel ${f.targetPrice.toLocaleString('hu-HU')} ${f.currency}) -- ${f.shop}, ${SHIPPABLE_TEXT[f.shippable]}`)
  return {
    count: finds.length, finds,
    text: `${RADAR_DIGEST_HEADER}: ${finds.length} olcsobb ajanlat, de a szallitas nem igazolt.`
      + ` Ezek NEM riasztottak -- azert latod oket, hogy a hallgatas ne legyen megkulonboztethetetlen a vaksagtol.\n${lines.join('\n')}`,
  }
}

/** Today's receipt, read the same way the PLANNED digest reads its own. */
export function radarDigestPostedToday(db: Database.Database, todayOverride?: string): boolean {
  const today = todayOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  const hit = db.prepare(
    `SELECT 1 AS x FROM daily_logs
      WHERE agent_id='marveen' AND date=? AND content LIKE ? LIMIT 1`
  ).get(today, `${RADAR_DIGEST_HEADER}%`) as { x: number } | undefined
  return hit !== undefined
}

export interface RadarDigestResult {
  posted: boolean
  alreadyToday: boolean
  count: number
}

/** Post the radar's "not verified" digest once per Budapest calendar day. */
export function reportUnverifiedFinds(
  db: Database.Database, todayOverride?: string,
): RadarDigestResult {
  const digest = buildRadarDigest(db)
  if (radarDigestPostedToday(db, todayOverride)) {
    return { posted: false, alreadyToday: true, count: digest.count }
  }
  createAgentMessage('cos-radar', 'marveen', digest.text, 'cos-radar-digest')
  appendDailyLog('marveen', digest.text)
  return { posted: true, alreadyToday: false, count: digest.count }
}
