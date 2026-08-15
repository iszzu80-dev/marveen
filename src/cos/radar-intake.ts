/**
 * The radar's two entry points — one creator, two callers.
 *
 * Istvan asks for something on Telegram, or a CoS case turns out to be worth
 * watching. Both arrive here, and both go through `createRadarItem`, which
 * carries the creation gate. Not two paths with two rules: the second path is
 * where the first path's protections go missing, and this codebase has now
 * produced that failure often enough to stop building it on purpose.
 *
 * WHY THIS LAYER EXISTS AT ALL, given the gate is already in createRadarItem:
 * the gate THROWS. That is right for a programming error and wrong for a chat
 * message. If Istvan writes "figyeld a HOFF Banks-t" and the request is
 * incomplete, an exception reaches a log and he sees nothing happen — which is
 * the same silence this whole card exists to remove, arriving through the door
 * we just built. So intake returns a RESULT: either the item, or the reason,
 * in words meant for him.
 *
 * WHAT THIS LAYER DOES NOT DO: guess. There is no field on `personal_cases`
 * holding a target price or a search term — measured, not assumed (the table
 * has title, description, case_type, status, dates, references, and nothing
 * about prices). A model may read a case and PROPOSE "HOFF Banks, 35 000 Ft";
 * that proposal arrives here as explicit input and is checked like any other.
 * What must not happen is a number inferred from prose being written down as if
 * it were stated: a made-up target either never fires or fires falsely every
 * day, and Istvan is the only one who knows the real one.
 */
import type Database from 'better-sqlite3'
import {
  createRadarItem, radarCreationRefusal, getRadarItem,
  type NewRadarItem, type RadarItemRow,
} from './radar.js'
import { getCase } from './case-store.js'

export interface RadarIntakeRequest {
  radarId: string
  kind: string
  label: string
  targetPrice?: number
  /** PRODUCT: the search terms. Absent is a refusal, never a fallback to label. */
  terms?: string
  /** RENTAL: the structured pickup/dropoff descriptor. */
  search?: unknown
  currency?: string
  checkIntervalSec?: number
  caseId?: string
  mustMatch?: string[]
  excludeTerms?: string[]
  maxResults?: number
}

export type RadarIntakeResult =
  | { ok: true; item: RadarItemRow }
  | { ok: false; code: 'REFUSED' | 'DUPLICATE' | 'NO_CASE' | 'CASE_ARCHIVED'; reason: string }

/** The query shape each kind needs, assembled from the request's flat fields. */
function queryFor(req: RadarIntakeRequest): unknown {
  if (req.kind === 'PRODUCT') {
    return {
      terms: req.terms,
      ...(req.mustMatch ? { mustMatch: req.mustMatch } : {}),
      ...(req.excludeTerms ? { excludeTerms: req.excludeTerms } : {}),
      ...(req.maxResults ? { maxResults: req.maxResults } : {}),
    }
  }
  if (req.kind === 'RENTAL') return { search: req.search }
  return {}
}

function toNewItem(req: RadarIntakeRequest): NewRadarItem {
  return {
    radarId: req.radarId, caseId: req.caseId, kind: req.kind, label: req.label,
    targetPrice: req.targetPrice, currency: req.currency ?? 'HUF',
    checkIntervalSec: req.checkIntervalSec, query: queryFor(req),
  }
}

/**
 * Create one radar item from an explicit request. Refusals come back as data.
 *
 * The refusal reason is `radarCreationRefusal`'s own — the SAME predicate the
 * gate enforces, asked before the attempt rather than restated here. Two
 * wordings of one rule drift, and then the intake says yes while the writer
 * says no.
 */
export function addRadarItem(
  db: Database.Database, req: RadarIntakeRequest, now: number,
): RadarIntakeResult {
  const item = toNewItem(req)
  const refusal = radarCreationRefusal(item)
  if (refusal) return { ok: false, code: 'REFUSED', reason: refusal }
  // An id collision is not a gate failure and must not read like one: silently
  // overwriting a watched item would lose its notification history, which is
  // what stops the radar repeating itself.
  if (getRadarItem(db, req.radarId)) {
    return { ok: false, code: 'DUPLICATE', reason: `mar letezik radar-tetel ezzel az azonositoval: ${req.radarId}` }
  }
  return { ok: true, item: createRadarItem(db, item, now) }
}

/**
 * The CoS-case entry point: the same creation, anchored to a case.
 *
 * The case supplies CONTEXT (it exists, it is open, it is the thing being
 * watched); it does not supply the target price, because nothing in the table
 * holds one. So this is not "derive an item from a case" — it is "attach an
 * explicitly stated watch to a case", and a request that omits the price or the
 * terms is refused exactly as it would be from Telegram.
 */
export function addRadarItemForCase(
  db: Database.Database, caseId: string, req: Omit<RadarIntakeRequest, 'caseId'>, now: number,
): RadarIntakeResult {
  const c = getCase(db, caseId)
  if (!c) return { ok: false, code: 'NO_CASE', reason: `nincs ilyen ugy: ${caseId}` }
  if (c.archived_at != null) {
    return { ok: false, code: 'CASE_ARCHIVED', reason: `az ugy archivalva van (${caseId}) -- lezart ugyre nem inditunk figyelest` }
  }
  return addRadarItem(db, { ...req, caseId }, now)
}
