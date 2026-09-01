// PHASE 2 -- ATTENTION, and OPPORTUNITIES ranked beneath it.
//
// THE PRIORITY IS DETERMINISTIC, in the owner's order:
//
//     risk > urgency > due/staleness > blockedness > unresolved contradiction
//
// Deterministic means two things, and the second is the one that usually gets
// lost: the same inputs always give the same order, AND the comparison is a
// documented lexicographic walk rather than a weighted sum. A weighted sum with
// hand-tuned coefficients looks principled and cannot be argued with -- nobody
// can say which factor decided a given item. Here, `explain()` names the field
// that broke the tie.
//
// NOT EVERY CHANGE IS AN INTERRUPTION.
//
//     "anti-spam / dedupe -- ne minden változás legyen interruption"
//
// Two mechanisms, and they are different. DEDUPE collapses items that are the
// same thing (stable element id). ANTI-SPAM decides whether an item that IS
// different is different ENOUGH to interrupt: a case whose priority band has not
// changed since it was last surfaced does not get to speak again.
//
// The interaction record is the ONLY durable thing this layer writes, and it
// stores the fact of the interaction -- id, band, when -- never the item's
// content. So the item is always recomputed from the canonical store and can
// never drift from the case it describes.
//
// OPPORTUNITIES CANNOT CROWD ANYTHING OUT.
//
//     "mindig alacsonyabb prioritású, mint obligation / safety / blocking
//      decision. Ne szoríthasson ki commitments/attention/questions elemeket."
//
// Enforced structurally, not by a number: opportunities are ranked in their own
// list and merged only after the obligation list has taken every slot it wants.
// A scoring scheme could let a very attractive opportunity outrank a dull
// obligation; separate lists cannot.
import type { IntelligenceElement } from './element.js'
import type { Commitment } from './commitments.js'
import type { Decision } from './decisions.js'

export type AttentionBand = 'SAFETY' | 'OBLIGATION' | 'BLOCKING' | 'INFORMATIONAL' | 'OPPORTUNITY'

export interface AttentionItem {
  element: IntelligenceElement
  band: AttentionBand
  /** The five factors, each 0..1, in the owner's order. Kept as named fields
   *  rather than a score so `explain` can say which one decided. */
  factors: {
    risk: number
    urgency: number
    staleness: number
    blockedness: number
    unresolvedContradiction: number
  }
  /** Why this is being surfaced, in one line. */
  why: string
}

const BAND_RANK: Record<AttentionBand, number> = {
  SAFETY: 0, OBLIGATION: 1, BLOCKING: 2, INFORMATIONAL: 3, OPPORTUNITY: 4,
}

const FACTOR_ORDER = ['risk', 'urgency', 'staleness', 'blockedness', 'unresolvedContradiction'] as const
export type FactorName = typeof FACTOR_ORDER[number]

/**
 * The comparison. Band first -- an opportunity can never outrank an obligation
 * whatever its factors -- then the five factors in order, then the element id so
 * the sort is total and a redeploy cannot reshuffle equal items.
 */
export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const band = BAND_RANK[a.band] - BAND_RANK[b.band]
  if (band !== 0) return band
  for (const f of FACTOR_ORDER) {
    const d = b.factors[f] - a.factors[f]   // higher factor first
    if (Math.abs(d) > 1e-9) return d
  }
  return a.element.id < b.element.id ? -1 : a.element.id > b.element.id ? 1 : 0
}

/** Which field decided, for a reader who disagrees with the order. */
export function explainOrder(a: AttentionItem, b: AttentionItem): string {
  if (BAND_RANK[a.band] !== BAND_RANK[b.band]) {
    return `band: ${a.band} outranks ${b.band}`
  }
  for (const f of FACTOR_ORDER) {
    if (Math.abs(a.factors[f] - b.factors[f]) > 1e-9) {
      return `${f}: ${a.factors[f].toFixed(3)} vs ${b.factors[f].toFixed(3)}`
    }
  }
  return 'identical on every factor; ordered by id so the sort is stable'
}

const DAY = 86_400

export function commitmentToAttention(c: Commitment, now: number): AttentionItem {
  const overdue = c.dueAt != null && c.dueAt < now
  const urgency = c.dueAt == null ? 0
    : overdue ? 1
    : Math.max(0, Math.min(1, 1 - (c.dueAt - now) / (7 * DAY)))
  // An UNKNOWN fulfilment is a DATA-QUALITY finding, not a safety alarm.
  //
  // It used to be one. Measured on the live store 2026-09-01: every one of the
  // three personal interruptions was a COMPLETED case whose only defect was a
  // thin closure record, and all three held a SAFETY slot ahead of genuinely
  // overdue obligations. A closed case cannot be an emergency because its
  // paperwork is thin -- and treating it as one is exactly the generic
  // "UNKNOWN therefore unsafe" alarm the owner ruled out.
  //
  // The risk factor still ORDERS these above ordinary items inside their band,
  // graded by how much closure evidence exists, so the gap with no evidence at
  // all still sorts first. What changed is that it no longer INTERRUPTS.
  //
  // AN EXPIRED COMMITMENT CARRIES RISK, and it used not to. That was harmless
  // while commitments were the only route into attention; once case-level
  // attention arrived carrying risk of its own, a risk of ZERO put every broken
  // promise below every open question, because risk is the first factor. A
  // stated promise whose date has passed with nothing showing it done is the
  // clearest harm this surface can observe, so it ranks above "somebody must
  // choose" and below "an authority sent something nobody has read".
  const risk = c.status === 'UNKNOWN'
    ? (c.closureEvidence === 'CLOSURE_REASON' ? 0.3
      : c.closureEvidence === 'COMPLETED_AT_ONLY' ? 0.5
      : 0.8)
    : c.status === 'REOPENED' ? 0.6
    : c.status === 'EXPIRED' ? 0.6
    : 0
  return {
    element: c,
    band: c.status === 'UNKNOWN' ? 'INFORMATIONAL' : 'OBLIGATION',
    factors: {
      risk,
      urgency,
      staleness: Math.min(1, c.recencySeconds / (14 * DAY)),
      blockedness: 0,
      unresolvedContradiction: c.contradiction.state === 'UNRESOLVED' ? 1 : 0,
    },
    why: c.status === 'UNKNOWN'
      ? `completion unverified: the record says done and no event evidences it ` +
        `(closure evidence: ${c.closureEvidence ?? 'NONE'})`
      : overdue ? 'past its date with nothing evidencing fulfilment' : c.fulfillment.why,
  }
}

export function decisionToAttention(d: Decision, now: number): AttentionItem {
  const blocking = d.axis === 'ENGINE_EXECUTION_PERMISSION' || d.axis === 'HUMAN_DEPENDENCY'
  return {
    element: d,
    band: blocking ? 'BLOCKING' : 'INFORMATIONAL',
    factors: {
      risk: d.axis === 'EXTERNAL_SIDE_EFFECT' ? 0.9 : 0,
      urgency: 0,
      staleness: Math.min(1, d.recencySeconds / (14 * DAY)),
      blockedness: blocking ? 1 : 0,
      unresolvedContradiction: d.contradiction.state === 'UNRESOLVED' ? 1 : 0,
    },
    why: d.question,
  }
}

// ── anti-spam: an item speaks again only when its BAND changes ───────────────

export interface SurfacedRecord {
  /** element id -- the content is deliberately NOT stored. */
  id: string
  band: AttentionBand
  at: number
}

export interface InterruptionPolicy {
  /** How many items may interrupt in one pass. */
  maxInterruptions: number
  /** An item in the same band may not speak again inside this window. */
  quietSeconds: number
}

export const DEFAULT_INTERRUPTION_POLICY: InterruptionPolicy = {
  maxInterruptions: 3,
  quietSeconds: 6 * 3600,
}

export interface SelectionResult {
  interrupt: AttentionItem[]
  /** Ranked and available, but not interrupting: the surface a person can look
   *  at when they choose to, which is different from being spoken to. */
  quiet: AttentionItem[]
  suppressed: Array<{ item: AttentionItem; reason: string }>
}

/**
 * Rank, dedupe, and decide who gets to interrupt.
 *
 * Opportunities are passed separately and appended AFTER the obligation list has
 * taken what it wants, so they cannot displace anything -- see the header.
 */
export function selectAttention(
  obligations: readonly AttentionItem[],
  opportunities: readonly AttentionItem[],
  seen: readonly SurfacedRecord[],
  now: number,
  policy: InterruptionPolicy = DEFAULT_INTERRUPTION_POLICY,
): SelectionResult {
  const lastSeen = new Map<string, SurfacedRecord>()
  for (const s of seen) {
    const prev = lastSeen.get(s.id)
    if (!prev || s.at > prev.at) lastSeen.set(s.id, s)
  }

  // DEDUPE first: the same element id twice is one item. The id is stable across
  // evidence changes, so this collapses refreshes rather than variants.
  const dedupe = (items: readonly AttentionItem[]): AttentionItem[] => {
    const byId = new Map<string, AttentionItem>()
    for (const it of items) {
      const prev = byId.get(it.element.id)
      if (!prev || compareAttention(it, prev) < 0) byId.set(it.element.id, it)
    }
    return [...byId.values()].sort(compareAttention)
  }

  const ranked = dedupe(obligations)
  const rankedOpps = dedupe(opportunities).map((o) => ({ ...o, band: 'OPPORTUNITY' as const }))

  const interrupt: AttentionItem[] = []
  const quiet: AttentionItem[] = []
  const suppressed: SelectionResult['suppressed'] = []

  for (const item of ranked) {
    const prev = lastSeen.get(item.element.id)
    if (prev && prev.band === item.band && now - prev.at < policy.quietSeconds) {
      suppressed.push({
        item,
        reason: `same band (${item.band}) as when it was last surfaced ${now - prev.at}s ago; ` +
          `a change that does not change the band is not an interruption`,
      })
      continue
    }
    if (interrupt.length < policy.maxInterruptions) interrupt.push(item)
    else quiet.push(item)
  }

  // Opportunities NEVER interrupt. Not "rarely" -- never. They are available to
  // look at, which is a different act from being spoken to.
  quiet.push(...rankedOpps)

  return { interrupt, quiet, suppressed }
}
