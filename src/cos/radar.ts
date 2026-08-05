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
}

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

/** ACTIVE items whose next check has arrived — the scheduler runs the adapter
 *  search for each and calls recordObservation. */
export function dueRadarChecks(db: Database.Database, now: number, limit = 100): RadarItemRow[] {
  return db.prepare(
    `SELECT * FROM radar_items WHERE status='ACTIVE' AND next_check_at IS NOT NULL AND next_check_at <= ?
     ORDER BY next_check_at ASC LIMIT ?`
  ).all(now, limit) as RadarItemRow[]
}

export interface Observation {
  bestPrice: number | null
  currency?: string
  offerCount?: number
  offerRef?: unknown
}

export interface ObservationResult {
  hit: boolean
  isNewLow: boolean
  status: RadarStatus
}

/**
 * Record one check's result: append an observation, advance next_check_at, track
 * the lowest price seen, and flip the item to HIT if the best price meets the
 * target. Returns whether this observation was a HIT and/or a new low.
 */
export function recordObservation(db: Database.Database, radarId: string, obs: Observation, now: number): ObservationResult {
  const item = getRadarItem(db, radarId)
  if (!item) throw new Error(`radar item not found: ${radarId}`)
  const tx = db.transaction((): ObservationResult => {
    db.prepare(
      `INSERT INTO radar_observations (radar_id, observed_at, best_price, currency, offer_count, offer_ref)
       VALUES (@radarId, @now, @best, @currency, @count, @ref)`
    ).run({
      radarId, now, best: obs.bestPrice, currency: obs.currency ?? item.currency,
      count: obs.offerCount ?? null, ref: obs.offerRef === undefined ? null : JSON.stringify(obs.offerRef),
    })
    const isNewLow = obs.bestPrice != null && (item.best_seen_price == null || obs.bestPrice < item.best_seen_price)
    const newLow = isNewLow ? obs.bestPrice! : item.best_seen_price
    const hit = obs.bestPrice != null && item.target_price != null && obs.bestPrice <= item.target_price
    const status: RadarStatus = hit ? 'HIT' : item.status
    db.prepare(
      `UPDATE radar_items SET best_seen_price=@newLow, status=@status, next_check_at=@next, updated_at=@now WHERE radar_id=@radarId`
    ).run({ newLow: newLow ?? null, status, next: now + item.check_interval_sec, radarId, now })
    return { hit, isNewLow, status }
  })
  return tx()
}

export function setRadarStatus(db: Database.Database, radarId: string, status: RadarStatus, now: number): void {
  const info = db.prepare(`UPDATE radar_items SET status=@status, updated_at=@now WHERE radar_id=@id`).run({ status, now, id: radarId })
  if (info.changes === 0) throw new Error(`radar item not found: ${radarId}`)
}
