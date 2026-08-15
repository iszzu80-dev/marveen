// Personal Chief of Staff (COS) — shopping / price radar (Slice 4).
//
// A watched item (a rental search, a grocery product, a product to buy). The
// scheduler runs due checks through the matching adapter, records each
// observation, and flips the item to HIT when the best price meets the target.
// Purchase is NEVER autonomous — the adapters expose no checkout — so a HIT just
// surfaces the deal for the owner to act on. Pure DB logic; the adapter search
// is driven by the scheduler and passed in as observations.

import type Database from 'better-sqlite3'
import { rhythmFor, type WatchShape, type RhythmDecision } from './radar-rhythm.js'

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
  /** Ignored for the shaped path: the RHYTHM TABLE decides the interval. Kept
   *  for the legacy fixtures that set it directly. */
  checkIntervalSec?: number
  watchShape?: WatchShape
  expiresAt?: number
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
  watch_shape: WatchShape
  expires_at: number | null
  checks_count: number
  closed_at: number | null
  closure_reason: string | null
  closure_reported_at: number | null
}

/** A further drop must be at least this fraction below the last notified price to
 *  be worth a repeat notification (P1.6) — otherwise a jittering price re-pings. */
export const SIGNIFICANT_DROP_FRACTION = 0.03

/**
 * Why a radar item cannot be created, or null when it can.
 *
 * Pure, exported, and consulted by createRadarItem — so the RULE is testable
 * and every caller inherits it, rather than each new entry point remembering to
 * validate. Istvan's condition (2026-08-15): no target price and no search
 * terms, no item.
 *
 * The reason it is a HARD REFUSAL and not a warning is measurable in this same
 * file: `hit` requires `item.target_price != null`, so an item created without
 * one is checked on schedule, records observations for ever, and is
 * STRUCTURALLY INCAPABLE of ever alerting. Wired in, running, and mute — the
 * exact shape of every failure found today. A radar item that cannot speak is
 * worse than none, because it makes the board look attended.
 *
 * Kind-aware, for the same reason deliverability is: a PRODUCT is found by
 * search terms, a RENTAL by a structured pickup/dropoff query. Demanding
 * `terms` from a rental would reject the one radar path that demonstrably
 * works — the mistake this codebase has now made once and must not repeat.
 */
export function radarCreationRefusal(item: NewRadarItem): string | null {
  if (item.targetPrice == null) {
    return 'nincs celar -- egy celar nelkuli tetel sosem tud talalatot adni (hit megkoveteli a target_price-t), tehat futna es nema maradna'
  }
  if (!Number.isFinite(item.targetPrice) || item.targetPrice <= 0) {
    return `ervenytelen celar (${String(item.targetPrice)}) -- pozitiv szam kell`
  }
  const q = item.query as { terms?: unknown; search?: unknown } | undefined
  if (item.kind === 'PRODUCT') {
    const terms = typeof q?.terms === 'string' ? q.terms.trim() : ''
    if (terms === '') {
      // The fallback this replaces was `q.terms ?? item.label` in the runner: a
      // case title ("Teraszszigeteles es beazas") is rarely a search query, so
      // the radar would search for the wrong thing and report honest zeroes.
      return 'nincs keresokifejezes (query.terms) -- egy ugy CIME ritkan keresokifejezes, es a rossz kereses ures eredmenye ugy nez ki, mint a nincs jo ajanlat'
    }
  }
  if (item.watchShape === 'DEADLINE' && item.expiresAt == null) {
    // Refused rather than defaulted: a deadline watch whose date is missing
    // would run for ever under the standing rhythm, which is precisely the
    // "created, running, never ending" shape the gate exists to prevent.
    return 'HATARIDOS figyeles hatarido nelkul (expiresAt hianyzik) -- sosem zarulna le'
  }
  if (item.expiresAt != null && item.watchShape !== 'DEADLINE') {
    return `hatarido (expiresAt) csak HATARIDOS figyeleshez tartozik, ez ${item.watchShape ?? 'STANDING'}`
  }
  if (item.kind === 'RENTAL') {
    if (q?.search == null) {
      return 'nincs kereses-leiro (query.search) -- egy berles atveteli/leadasi hely es datum nelkul nem kerdezheto le'
    }
  }
  return null
}

export function createRadarItem(db: Database.Database, item: NewRadarItem, now: number): RadarItemRow {
  // THE GATE IS HERE, at the single choke point every caller passes through —
  // not in the callers, where the second one forgets it.
  const refusal = radarCreationRefusal(item)
  if (refusal) throw new Error(`radar item ${item.radarId} elutasitva: ${refusal}`)
  // THE TABLE DECIDES THE RHYTHM, not the caller. An explicit checkIntervalSec
  // is honoured only when no shape was given (the pre-2026-08-15 fixtures);
  // once a shape is stated, the interval is derived, so a model cannot talk the
  // radar into checking hourly and nobody can explain it a fortnight later.
  const shape: WatchShape = item.watchShape ?? 'STANDING'
  const interval = item.watchShape
    ? (rhythmFor(shape, item.expiresAt ?? null, now).intervalSec || 86400)
    : (item.checkIntervalSec ?? 86400)
  db.prepare(
    `INSERT INTO radar_items (radar_id, case_id, kind, label, query, target_price, max_price, currency,
        status, check_interval_sec, next_check_at, created_at, updated_at, watch_shape, expires_at)
     VALUES (@radarId, @caseId, @kind, @label, @query, @targetPrice, @maxPrice, @currency,
        'ACTIVE', @interval, @nextCheck, @now, @now, @shape, @expiresAt)`
  ).run({
    radarId: item.radarId, caseId: item.caseId ?? null, kind: item.kind, label: item.label,
    query: item.query === undefined ? null : JSON.stringify(item.query),
    targetPrice: item.targetPrice ?? null, maxPrice: item.maxPrice ?? null, currency: item.currency ?? null,
    interval, nextCheck: now + interval, now,
    shape, expiresAt: item.expiresAt ?? null,
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

/**
 * Can this offer be ordered from Hungary and delivered here?
 *
 * THREE values, not two, and the third is the one that matters. A web search
 * establishes a price far more often than it establishes delivery — a Spanish
 * or German brand's cheapest listing frequently says nothing about shipping to
 * Hungary. So 'UNKNOWN' is the common case, not the edge case, and it must be
 * its own value: "we could not establish it" and "it does not ship here" are
 * different facts, and a system that stores them the same way cannot tell
 * correct silence from blindness. That distinction is the entire point of the
 * 2026-08-15 card — the radar was silent for a week and looked fine.
 *
 * 'UNKNOWN' does NOT produce a hit (we will not tell Istvan to buy something we
 * cannot confirm he can receive), but it is never dropped: it surfaces on the
 * daily "szállítás nem igazolt" line.
 */
export type Shippability = 'YES' | 'NO' | 'UNKNOWN'

export interface Observation {
  bestPrice: number | null      // comparison-currency price used for HIT (= converted)
  currency?: string             // comparison currency (falls back to item.currency)
  offerCount?: number
  offerRef?: unknown
  offerId?: string | null       // stable id of the best offer (for dedup)
  /** Deliverability to Hungary. Omitted means 'UNKNOWN' — an observation whose
   *  source said nothing about delivery has not been verified, and must not be
   *  recorded as if it had. */
  shippableHu?: Shippability
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
  /** Price met AND (for products) delivery to Hungary confirmed. */
  hit: boolean
  /** Price met, regardless of deliverability. */
  priceMet: boolean
  /** What we know about delivery for this offer. */
  shippable: Shippability
  /** The rhythm decision applied after this observation (interval / close). */
  rhythm: RhythmDecision
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
  // RE-ENTRY. The item was NOT in HIT before this observation, so the price had
  // left the target zone and has now come back under it. That is news, whatever
  // was notified before.
  //
  // Without this, a single freak low permanently silences the radar: on
  // 2026-08-10 radar-spain-rental saw 64 471 HUF once, was back at 91 072 six
  // hours later, and stayed there. A later drop to 80 000 — genuinely under the
  // 85 000 target — would have matched the same offerId and been >= the notified
  // 64 471, so every branch below returns false and the owner is never told. The
  // memory of one better past state suppresses reporting of a true present one.
  //
  // This rule is only correct because recordObservation now lets the status LEAVE
  // HIT (see below); while status was latched at HIT forever, `item.status` could
  // never be anything else and this branch would be dead. The two changes are one
  // fix in two places.
  if (item.status !== 'HIT') return { should: true, reason: 'NEW_HIT' }
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
         fx_rate, fx_rate_source, fx_rate_timestamp, converted_final_price, shippable_hu)
       VALUES (@radarId, @now, @best, @currency, @count, @ref, @offerId,
         @origCur, @origPrice, @cmpCur, @rate, @rateSrc, @rateTs, @best, @shippable)`
    ).run({
      radarId, now, best: obs.bestPrice, currency: comparisonCurrency,
      count: obs.offerCount ?? null, ref: obs.offerRef === undefined ? null : JSON.stringify(obs.offerRef),
      offerId: obs.offerId ?? null,
      origCur: fx.originalCurrency, origPrice: fx.originalPrice, cmpCur: comparisonCurrency,
      rate: fx.rate, rateSrc: fx.rateSource, rateTs: fx.rateTimestamp,
      shippable: obs.shippableHu ?? 'UNKNOWN',
    })
    const isNewLow = obs.bestPrice != null && (item.best_seen_price == null || obs.bestPrice < item.best_seen_price)
    const newLow = isNewLow ? obs.bestPrice! : item.best_seen_price
    const priceMet = obs.bestPrice != null && item.target_price != null && obs.bestPrice <= item.target_price
    // DELIVERABILITY GATES THE HIT — FOR PRODUCTS ONLY.
    //
    // Istvan's condition (2026-08-15): a find is only a find if he can order it
    // from Hungary and have it delivered. A cheaper price he cannot receive is
    // not a deal, it is a distraction.
    //
    // Restricted to PRODUCT on purpose. A rental car is collected at a counter,
    // not shipped; asking whether it "delivers to Hungary" is meaningless, and
    // gating on it would silently kill the ONE radar path that demonstrably
    // works — the rental item is the only one that has ever alerted. A new
    // condition that breaks the only working case is not a stricter system, it
    // is a broken one.
    const needsDelivery = item.kind === 'PRODUCT'
    const shippable: Shippability = obs.shippableHu ?? 'UNKNOWN'
    const hit = priceMet && (!needsDelivery || shippable === 'YES')
    // The status reports THIS observation, not the best moment in the item's
    // history. It used to be `hit ? 'HIT' : item.status`, which could enter HIT
    // and never leave: radar-spain-rental still read HIT at 91 241 HUF against
    // an 85 000 target because it had touched 64 471 once, a day earlier. A
    // surface that says "found one" while today's price is above target is the
    // stale-green failure this system keeps producing.
    //
    // Only HIT is reversed, and only back to ACTIVE. PAUSED and CLOSED are owner
    // decisions about whether to watch at all; a price observation must not
    // quietly resurrect a radar the owner switched off. `best_seen_price` keeps
    // the historical minimum — that number is still true, it just is not the
    // status.
    let status: RadarStatus = hit ? 'HIT' : (item.status === 'HIT' ? 'ACTIVE' : item.status)
    const notify = decideNotify(item, obs.bestPrice, obs.offerId ?? null, hit)
    // THE RHYTHM IS RE-DERIVED ON EVERY OBSERVATION, not read back from the
    // stored interval. A DEADLINE watch has to TIGHTEN by itself as the date
    // approaches and END on the day; a stored number cannot do either, and a
    // deadline that passes in silence is worse than never having watched.
    const checks = (item.checks_count ?? 0) + 1
    const rhythm = rhythmFor(item.watch_shape ?? 'STANDING', item.expires_at ?? null, now, checks)
    // CLOSED only ever comes from the rhythm, and only from ACTIVE/HIT. PAUSED
    // is the owner's decision about whether to watch at all, and a clock must
    // not overrule it.
    const closing = rhythm.close && (status === 'ACTIVE' || status === 'HIT')
    if (closing) status = 'CLOSED'
    // The closure is WRITTEN DOWN, with the outcome folded into the reason, so
    // the digest can say something true without re-deriving why. `hit` here is
    // this observation's: a ONE_OFF that closes without one is exactly the
    // "nem volt olcsobb" case that must still be reported.
    const closureReason = closing
      ? (hit ? `${rhythm.reason} -- talalt` : `${rhythm.reason} -- NEM volt olcsobb a celar alatt`)
      : null
    const nextInterval = rhythm.intervalSec > 0 ? rhythm.intervalSec : item.check_interval_sec
    db.prepare(
      `UPDATE radar_items SET best_seen_price=@newLow, status=@status, next_check_at=@next,
          check_interval_sec=@interval, checks_count=@checks, updated_at=@now,
          closed_at=COALESCE(@closedAt, closed_at), closure_reason=COALESCE(@closureReason, closure_reason)
        WHERE radar_id=@radarId`
    ).run({
      newLow: newLow ?? null, status, next: now + nextInterval,
      interval: nextInterval, checks, radarId, now,
      closedAt: closing ? now : null, closureReason,
    })
    return {
      hit, isNewLow, status, bestPrice: obs.bestPrice, offerId: obs.offerId ?? null, notify,
      // priceMet and shippable travel SEPARATELY from `hit` because the daily
      // signal needs the difference: priceMet && !hit is precisely the "cheaper,
      // but delivery not verified" line. Returning only `hit` would leave the
      // caller unable to distinguish that from "nothing was cheap enough" —
      // rebuilding the exact ambiguity this change exists to remove.
      priceMet, shippable,
      /** Why the next check is when it is — and, when the watch ended, why. */
      rhythm,
    }
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
