// Personal Chief of Staff (COS) — shopping / price radar (Slice 4).
//
// A watched item (a rental search, a grocery product, a product to buy). The
// scheduler runs due checks through the matching adapter, records each
// observation, and flips the item to HIT when the best price meets the target.
// Purchase is NEVER autonomous — the adapters expose no checkout — so a HIT just
// surfaces the deal for the owner to act on. Pure DB logic; the adapter search
// is driven by the scheduler and passed in as observations.

import type Database from 'better-sqlite3'

export type RadarStatus = 'ACTIVE' | 'PAUSED' | 'HIT' | 'CLOSED'

export interface NewRadarItem {
  radarId: string
  caseId?: string
  kind: string
  label: string
  query?: unknown
  targetPrice?: number
  maxPrice?: number
  currency?: string
  checkIntervalSec?: number
}

export interface RadarItemRow {
  radar_id: string
  case_id: string | null
  kind: string
  label: string
  query: string | null
  target_price: number | null
  max_price: number | null
  currency: string | null
  status: RadarStatus
  check_interval_sec: number
  next_check_at: number | null
  best_seen_price: number | null
  last_notified_offer_id: string | null
  last_notified_price: number | null
  last_notified_at: number | null
  notification_reason: string | null
}

/** A further drop must be at least this fraction below the last notified price to
 *  be worth a repeat notification (P1.6) — otherwise a jittering price re-pings. */
export const SIGNIFICANT_DROP_FRACTION = 0.03

export function createRadarItem(db: Database.Database, item: NewRadarItem, now: number): RadarItemRow {
  const interval = item.checkIntervalSec ?? 86400
  db.prepare(
    `INSERT INTO radar_items (radar_id, case_id, kind, label, query, target_price, max_price, currency,
        status, check_interval_sec, next_check_at, created_at, updated_at)
     VALUES (@radarId, @caseId, @kind, @label, @query, @targetPrice, @maxPrice, @currency,
        'ACTIVE', @interval, @nextCheck, @now, @now)`
  ).run({
    radarId: item.radarId, caseId: item.caseId ?? null, kind: item.kind, label: item.label,
    query: item.query === undefined ? null : JSON.stringify(item.query),
    targetPrice: item.targetPrice ?? null, maxPrice: item.maxPrice ?? null, currency: item.currency ?? null,
    interval, nextCheck: now + interval, now,
  })
  return getRadarItem(db, item.radarId)!
}

export function getRadarItem(db: Database.Database, radarId: string): RadarItemRow | undefined {
  return db.prepare(`SELECT * FROM radar_items WHERE radar_id = ?`).get(radarId) as RadarItemRow | undefined
}

/** Items still being watched whose next check has arrived — the scheduler runs
 *  the adapter search for each and calls recordObservation. A HIT item stays in
 *  the queue (we keep watching for a better/new offer); P1.6 dedup stops it from
 *  re-alerting on an unchanged offer. PAUSED/CLOSED are excluded. */
export function dueRadarChecks(db: Database.Database, now: number, limit = 100): RadarItemRow[] {
  return db.prepare(
    `SELECT * FROM radar_items WHERE status IN ('ACTIVE','HIT') AND next_check_at IS NOT NULL AND next_check_at <= ?
     ORDER BY next_check_at ASC LIMIT ?`
  ).all(now, limit) as RadarItemRow[]
}

export interface Observation {
  bestPrice: number | null      // comparison-currency price used for HIT (= converted)
  currency?: string             // comparison currency (falls back to item.currency)
  offerCount?: number
  offerRef?: unknown
  offerId?: string | null       // stable id of the best offer (for dedup)
  /** P1.5 FX breakdown when the merchant quotes a different currency than the
   *  target. Omit for a single-currency merchant (recorded as identity fx). */
  fx?: {
    originalPrice: number | null
    originalCurrency: string
    rate: number
    rateSource: string
    rateTimestamp: number
  }
}

/** P1.6 notification decision: whether this observation is worth alerting on, and
 *  why. `null` reason means no alert (unchanged offer / not a HIT). */
export interface NotifyDecision {
  should: boolean
  reason: 'NEW_HIT' | 'NEW_OFFER' | 'PRICE_DROP' | null
}

export interface ObservationResult {
  hit: boolean
  isNewLow: boolean
  status: RadarStatus
  /** The comparison-currency price recorded (= converted_final_price). */
  bestPrice: number | null
  offerId: string | null
  /** Whether the owner should be alerted about THIS observation (deduped). */
  notify: NotifyDecision
}

/** Decide whether an at/under-target observation deserves a (repeat) alert.
 *  Pure over the item's pre-observation last_notified_* state. */
export function decideNotify(item: RadarItemRow, best: number | null, offerId: string | null, hit: boolean): NotifyDecision {
  if (!hit) return { should: false, reason: null }
  if (item.last_notified_at == null) return { should: true, reason: 'NEW_HIT' }
  // A different offer now meets the target (includes the prior offer expiring and
  // being replaced) → worth surfacing.
  if (offerId != null && offerId !== item.last_notified_offer_id) return { should: true, reason: 'NEW_OFFER' }
  // The same offer dropped significantly further since we last told him.
  if (item.last_notified_price != null && best != null && best < item.last_notified_price) {
    const rel = (item.last_notified_price - best) / item.last_notified_price
    if (rel >= SIGNIFICANT_DROP_FRACTION) return { should: true, reason: 'PRICE_DROP' }
  }
  // Same offer, no material change → do not re-notify.
  return { should: false, reason: null }
}

/**
 * Record one check's result: append an observation (with FX breakdown), advance
 * next_check_at, track the lowest price seen, flip the item to HIT if the best
 * price meets the target, and compute the notification decision (deduped against
 * what we last alerted). Persisting the decision is the caller's job via
 * markNotified() once the alert is actually posted.
 */
export function recordObservation(db: Database.Database, radarId: string, obs: Observation, now: number): ObservationResult {
  const item = getRadarItem(db, radarId)
  if (!item) throw new Error(`radar item not found: ${radarId}`)
  const comparisonCurrency = obs.currency ?? item.currency
  // FX: identity when the merchant already quotes the comparison currency.
  const fx = obs.fx ?? {
    originalPrice: obs.bestPrice, originalCurrency: comparisonCurrency ?? '',
    rate: 1, rateSource: 'none', rateTimestamp: now,
  }
  const tx = db.transaction((): ObservationResult => {
    db.prepare(
      `INSERT INTO radar_observations
        (radar_id, observed_at, best_price, currency, offer_count, offer_ref, offer_id,
         original_currency, original_final_price, comparison_currency,
         fx_rate, fx_rate_source, fx_rate_timestamp, converted_final_price)
       VALUES (@radarId, @now, @best, @currency, @count, @ref, @offerId,
         @origCur, @origPrice, @cmpCur, @rate, @rateSrc, @rateTs, @best)`
    ).run({
      radarId, now, best: obs.bestPrice, currency: comparisonCurrency,
      count: obs.offerCount ?? null, ref: obs.offerRef === undefined ? null : JSON.stringify(obs.offerRef),
      offerId: obs.offerId ?? null,
      origCur: fx.originalCurrency, origPrice: fx.originalPrice, cmpCur: comparisonCurrency,
      rate: fx.rate, rateSrc: fx.rateSource, rateTs: fx.rateTimestamp,
    })
    const isNewLow = obs.bestPrice != null && (item.best_seen_price == null || obs.bestPrice < item.best_seen_price)
    const newLow = isNewLow ? obs.bestPrice! : item.best_seen_price
    const hit = obs.bestPrice != null && item.target_price != null && obs.bestPrice <= item.target_price
    const status: RadarStatus = hit ? 'HIT' : item.status
    const notify = decideNotify(item, obs.bestPrice, obs.offerId ?? null, hit)
    db.prepare(
      `UPDATE radar_items SET best_seen_price=@newLow, status=@status, next_check_at=@next, updated_at=@now WHERE radar_id=@radarId`
    ).run({ newLow: newLow ?? null, status, next: now + item.check_interval_sec, radarId, now })
    return { hit, isNewLow, status, bestPrice: obs.bestPrice, offerId: obs.offerId ?? null, notify }
  })
  return tx()
}

/** Persist that we alerted the owner about this observation, so an unchanged
 *  offer will not re-notify next cycle (P1.6). Call AFTER the alert is posted. */
export function markNotified(
  db: Database.Database, radarId: string,
  n: { offerId: string | null; price: number | null; reason: string | null }, now: number,
): void {
  db.prepare(
    `UPDATE radar_items SET last_notified_offer_id=@offerId, last_notified_price=@price,
        last_notified_at=@now, notification_reason=@reason, updated_at=@now WHERE radar_id=@id`
  ).run({ offerId: n.offerId, price: n.price, reason: n.reason, now, id: radarId })
}

export function setRadarStatus(db: Database.Database, radarId: string, status: RadarStatus, now: number): void {
  const info = db.prepare(`UPDATE radar_items SET status=@status, updated_at=@now WHERE radar_id=@id`).run({ status, now, id: radarId })
  if (info.changes === 0) throw new Error(`radar item not found: ${radarId}`)
}
