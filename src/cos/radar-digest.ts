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

export interface ClosedWatch {
  radarId: string
  label: string
  closedAt: number
  reason: string
}

export interface RadarDigest {
  count: number
  finds: UnverifiedFind[]
  /** Watches that ENDED since the last digest and have not been reported. */
  closures: ClosedWatch[]
  text: string
}

/**
 * Watches that closed and whose closure nobody has told Istvan about.
 *
 * This is the other half of "the zero case speaks". A ONE_OFF that ran and
 * found nothing cheaper closes with `notify.should === false` — so the alert
 * path, which hangs entirely off that flag, says nothing. From outside, a
 * search that answered "no" is indistinguishable from one that never ran, and
 * a deadline that arrived is indistinguishable from a radar that died.
 *
 * Measured before this existed: `rhythm.close` and its reason travelled back in
 * the observation result and had NO consumer at all.
 */
export function unreportedClosures(db: Database.Database, limit = 20): ClosedWatch[] {
  const rows = db.prepare(
    `SELECT radar_id, label, closed_at, closure_reason
       FROM radar_items
      WHERE status = 'CLOSED' AND closed_at IS NOT NULL AND closure_reported_at IS NULL
      ORDER BY closed_at ASC LIMIT ?`
  ).all(limit) as Array<{ radar_id: string; label: string; closed_at: number; closure_reason: string | null }>
  return rows.map(r => ({
    radarId: r.radar_id, label: r.label, closedAt: r.closed_at,
    reason: r.closure_reason ?? 'lezarva (indok nincs rogzitve)',
  }))
}

/** Mark closures as told. Called AFTER the digest is posted, never before —
 *  same ordering rule as markNotified, and for the same reason: a crash between
 *  the two must cost a repeat, not a silence. */
export function markClosuresReported(db: Database.Database, radarIds: string[], now: number): void {
  const stmt = db.prepare('UPDATE radar_items SET closure_reported_at=? WHERE radar_id=?')
  for (const id of radarIds) stmt.run(now, id)
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

/**
 * The per-branch wording. EXPORTED so a standing test can assert the property
 * that actually matters — that the branches are TELLABLE APART — rather than
 * only that each one appears somewhere.
 */
export const SHIPPABLE_TEXT: Record<Shippability, string> = {
  UNKNOWN: 'a szallitas nem igazolt',
  NO: 'nem szallit Magyarorszagra',
  // 'szallit' alone was a SUBSTRING of the NO wording, so a report containing
  // "nem szallit Magyarorszagra" also technically contained the YES label. The
  // standing test rejects that: labels a reader must tell apart cannot be
  // nested inside one another either.
  YES: 'igazoltan szallit', // unreachable here; present so the map is total
}

/**
 * Watched products whose latest observation carries NO price at all.
 *
 * This number exists because the zero case lied without it. Today all seven
 * shoe/shirt items return `best_price = NULL` from the eMAG adapter on every
 * tick — so "nothing under target with unverified delivery" is true, and
 * completely misleading: there is nothing under target because there is no
 * price, not because prices are high. Reporting the first without the second
 * would rebuild, inside the very digest written to prevent it, the exact
 * misreading that hid a week of silence: absence of data read as absence of
 * news.
 */
export function pricelessProducts(db: Database.Database): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM radar_items i
      WHERE i.kind = 'PRODUCT' AND i.status IN ('ACTIVE','HIT')
        AND NOT EXISTS (
          SELECT 1 FROM radar_observations o
           WHERE o.radar_id = i.radar_id
             AND o.observed_at = (SELECT MAX(o2.observed_at) FROM radar_observations o2 WHERE o2.radar_id = i.radar_id)
             AND o.best_price IS NOT NULL)`
  ).get() as { n: number }).n
}

export function buildRadarDigest(db: Database.Database, limit = 20): RadarDigest {
  const finds = unverifiedFinds(db, limit)
  const closures = unreportedClosures(db, limit)
  const blind = pricelessProducts(db)
  // "No price at all" is its own sentence wherever it is true, zero case or not.
  const blindLine = blind > 0
    ? `\n(${blind} figyelt termekre a legutobbi ellenorzes EGYALTALAN NEM adott arat -- ezekrol nem tudunk semmit, nem azt tudjuk hogy dragak.)`
    : ''
  // A closed watch is reported WHETHER OR NOT it found anything. This is the
  // line that makes "megneztuk, nem volt olcsobb" different from "a radar
  // meghalt".
  const closureLines = closures.length > 0
    ? `\nLEZART FIGYELESEK:\n${closures.map(c => `- ${c.label}: ${c.reason}`).join('\n')}`
    : ''
  if (finds.length === 0) {
    // The zero case is a REPORT, not an absence — and it must not claim more
    // than it checked. The first version of this line said "every under-target
    // find's deliverability is verified", which reads as "we looked and they
    // are fine" when the truth may be that there was nothing to look at.
    return {
      count: 0, finds, closures,
      text: `${RADAR_DIGEST_HEADER}: 0 tetel. Nincs olyan celar alatti termek-talalat,`
        + ` aminek a szallithatosaga ne lenne igazolva.${blindLine}${closureLines}`,
    }
  }
  const lines = finds.map(f =>
    `- ${f.label}: ${f.bestPrice.toLocaleString('hu-HU')} ${f.currency}`
    + ` (cel ${f.targetPrice.toLocaleString('hu-HU')} ${f.currency}) -- ${f.shop}, ${SHIPPABLE_TEXT[f.shippable]}`)
  return {
    count: finds.length, finds, closures,
    // The summary must NOT repeat any per-branch wording. It used to end with
    // "de a szallitas nem igazolt", which is the UNKNOWN label verbatim — so an
    // assertion against the whole digest held for every non-empty report,
    // whatever the item lines said. Fixing the test alone left that trap in
    // place for the next person; the standing test below now forbids it.
    text: `${RADAR_DIGEST_HEADER}: ${finds.length} olcsobb ajanlat NEM riasztott,`
      + ` mert a kiszallitas Magyarorszagra nincs megerositve.`
      + ` Azert latod oket, hogy a hallgatas ne legyen megkulonboztethetetlen a vaksagtol.`
      + `\n${lines.join('\n')}${blindLine}${closureLines}`,
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
  /** How many ended watches this digest reported. */
  closures: number
}

/** Post the radar's "not verified" digest once per Budapest calendar day. */
export function reportUnverifiedFinds(
  db: Database.Database, todayOverride?: string, now = Math.floor(Date.now() / 1000),
): RadarDigestResult {
  const digest = buildRadarDigest(db)
  if (radarDigestPostedToday(db, todayOverride)) {
    return { posted: false, alreadyToday: true, count: digest.count, closures: 0 }
  }
  createAgentMessage('cos-radar', 'marveen', digest.text, 'cos-radar-digest')
  appendDailyLog('marveen', digest.text)
  // AFTER the post, never before. A crash in between costs a repeated line;
  // the other order costs the only sentence a closed watch ever gets.
  markClosuresReported(db, digest.closures.map(c => c.radarId), now)
  return { posted: true, alreadyToday: false, count: digest.count, closures: digest.closures.length }
}
