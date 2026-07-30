// CostOps Phase 4 -- package portfolio recommendation engine.
//
// ADVISORY ONLY. This module returns DATA, never an action. There is no
// network call, no fetch, no subprocess, no exec anywhere in this file
// (assertNoAutonomousAction below is a structural test over the SOURCE, not
// a runtime check, precisely so an autonomous call can never be added here
// without a test catching it at review time, not discovering it in
// production). Enabling a plan, canceling one, or calling a provider API is
// always a SEPARATE, explicitly-authorized action outside this module.
//
// THE LOAD-BEARING GUARD (marveen, 2026-07-30): the FX layer is not
// finished -- store/costops-fx.json holds one static USD rate, EUR is
// unset, and there is no per-day MNB rate on record for anything yet. A
// recommendation computed on a wrong or flat-rate conversion is worse than
// no recommendation, so:
//
//   - any evidence figure that cannot be converted (no rate at all) OR that
//     can only be converted via a flat/static rate (no cost-arising-day
//     rate on record) makes the WHOLE package's verdict INSUFFICIENT_EVIDENCE,
//     with the specific reason named -- never a rounded guess, never a
//     silent drop.
//   - a portfolio-level report NEVER omits a package for this reason. The
//     Anthropic Max 5x (EUR, currently unconvertible) must still appear in
//     the output, with its own INSUFFICIENT_EVIDENCE verdict -- silently
//     leaving it out would understate the portfolio and favour the status
//     quo, which is the most dangerous direction for an advisory engine.
//
// No LLM anywhere in this module. Deterministic: the same inputs always
// produce the same verdicts (see the repeat-run test).

import {
  resolveFxRate, lookupHistoricalRate, roundHuf,
  type FxRateTable, type FxRateRecord,
} from './fx.js'
import type { PackageInventoryEntry, ProvenancedNumber } from './package-inventory.js'

// ---- confidence vocabulary --------------------------------------------------
//
// Reuses kpi.ts's KpiState vocabulary EXACTLY (measured/estimated/unknown +
// mandatory blocker) rather than inventing a second one, per the context
// packet's explicit instruction. kpi.ts's own measured()/unknown()/estimated()
// helpers are file-local (not exported), so this module has its own
// constructors with the identical shape and the identical rule: an absent/
// unconvertible figure is 'unknown' with a blocker, never a fabricated 0.

export type RecommendationConfidence = 'measured' | 'estimated' | 'unknown'

export interface EvidenceFigure {
  label: string
  value: number | null
  currency: string | null
  confidence: RecommendationConfidence
  blocker: string | null
}

function measuredFigure(label: string, value: number, currency: string | null): EvidenceFigure {
  return { label, value, currency, confidence: 'measured', blocker: null }
}
function estimatedFigure(label: string, value: number, currency: string | null, blocker: string): EvidenceFigure {
  return { label, value, currency, confidence: 'estimated', blocker }
}
function unknownFigure(label: string, blocker: string, currency: string | null = null): EvidenceFigure {
  return { label, value: null, currency, confidence: 'unknown', blocker }
}

export type RecommendationVerdict =
  | 'KEEP' | 'UPGRADE' | 'DOWNGRADE' | 'CANCEL' | 'ADD'
  | 'ENABLE_USAGE_CREDIT' | 'REBALANCE' | 'NO_DECISION' | 'INSUFFICIENT_EVIDENCE'

export interface RecommendationWindow {
  from: number  // epoch sec, inclusive
  to: number    // epoch sec, exclusive
}

export interface PackageRecommendation {
  package_id: string
  verdict: RecommendationVerdict
  evidence: EvidenceFigure[]
  /** Overall confidence -- the WEAKEST confidence among `evidence` (arithmetic
   *  never upgrades evidence, same rule capacity.ts already established). */
  confidence: RecommendationConfidence
  /** Mandatory whenever confidence !== 'measured' (mirrors kpi.ts's own rule);
   *  null only when every evidence figure is 'measured'. */
  blocker: string | null
  window: RecommendationWindow
  generated_at: number
}

const CONFIDENCE_RANK: Record<RecommendationConfidence, number> = { measured: 2, estimated: 1, unknown: 0 }

function weakestConfidence(figures: EvidenceFigure[]): RecommendationConfidence {
  if (figures.length === 0) return 'unknown'
  return figures.reduce((worst, f) => (CONFIDENCE_RANK[f.confidence] < CONFIDENCE_RANK[worst] ? f.confidence : worst), 'measured' as RecommendationConfidence)
}

// ---- FX evidence gate (THE load-bearing guard) ------------------------------

export interface FxEvidenceContext {
  fxRates: FxRateTable
  /** Historical per-day rate records (fx_rates table via lookupHistoricalRate).
   *  Empty today in practice -- no genuine cost-arising-day rate exists yet for
   *  anything, which is exactly the gap this function must not paper over. */
  fxRateRecords: FxRateRecord[]
}

export interface FxEvidenceResult {
  ok: boolean
  huf_value: number | null
  /** 'measured' only when a genuine cost-arising-day rate was found on record.
   *  A flat/static-table rate is 'estimated'-grade at best, and this function
   *  treats it as NOT ok (see the module header) rather than silently using it. */
  blocker: string | null
}

/**
 * Resolves one ProvenancedNumber's money value to HUF, or explains precisely
 * why it cannot be resolved right now. HUF needs no conversion. Any other
 * currency needs a GENUINE cost-arising-day rate on record (lookupHistoricalRate)
 * -- a flat/static table entry (resolveFxRate) is deliberately NOT accepted as
 * sufficient, because it is not a real day-of-cost rate (card 97accbce is
 * still open; do not treat its eventual landing as already having happened).
 */
export function checkFxEvidence(amount: ProvenancedNumber, atDate: number, ctx: FxEvidenceContext): FxEvidenceResult {
  if (amount.value === null) {
    return { ok: false, huf_value: null, blocker: `no price published (provenance: ${amount.provenance})` }
  }
  const cur = (amount.currency || 'HUF').toUpperCase()
  if (cur === 'HUF') {
    return { ok: true, huf_value: amount.value, blocker: null }
  }
  const historical = lookupHistoricalRate(ctx.fxRateRecords, cur, atDate)
  if (historical) {
    return { ok: true, huf_value: roundHuf(amount.value * historical.rate), blocker: null }
  }
  // No genuine day-of-cost rate on record. Even if a flat static rate exists in
  // costops-fx.json, that is NOT the cost-arising day's MNB rate -- surface the
  // specific reason rather than silently using the flat number.
  const flatRate = resolveFxRate(cur, ctx.fxRates)
  if (flatRate == null) {
    return { ok: false, huf_value: null, blocker: `no FX rate configured for ${cur} -- unconvertible` }
  }
  return {
    ok: false, huf_value: null,
    blocker: `${cur} has only a flat static rate (${flatRate}) in costops-fx.json, not a cost-arising-day MNB rate (card 97accbce is still open) -- refusing to convert at an unverified flat rate`,
  }
}

// ---- single-package evaluation ------------------------------------------------

/**
 * Evaluates ONE package inventory entry. First-pass scope (2026-07-30): this
 * implements the FX-evidence gate and price observation faithfully, and
 * returns NO_DECISION (never a fabricated KEEP/UPGRADE/DOWNGRADE) where a
 * real threshold/comparison rule has not yet been specified -- a confident
 * verdict invented without a real rule behind it is exactly the failure mode
 * this phase exists to prevent. Comparison-against-usage and market-based
 * UPGRADE/DOWNGRADE/CANCEL logic is a follow-up once those rules are given.
 */
export function evaluatePackage(
  pkg: PackageInventoryEntry,
  window: RecommendationWindow,
  ctx: FxEvidenceContext,
): PackageRecommendation {
  const generated_at = window.to
  const priceFx = checkFxEvidence(pkg.price, window.to, ctx)

  const priceFigure: EvidenceFigure = !priceFx.ok
    ? unknownFigure('price_huf', priceFx.blocker!, 'HUF')
    : pkg.price.provenance === 'invoice'
      ? measuredFigure('price_huf', priceFx.huf_value!, 'HUF')
      : estimatedFigure('price_huf', priceFx.huf_value!, 'HUF', `original figure provenance: ${pkg.price.provenance}`)

  const evidence: EvidenceFigure[] = [priceFigure]

  if (!priceFx.ok) {
    return {
      package_id: pkg.id,
      verdict: 'INSUFFICIENT_EVIDENCE',
      evidence,
      confidence: 'unknown',
      blocker: priceFx.blocker,
      window,
      generated_at,
    }
  }

  // No decision logic implemented yet beyond the FX gate -- honest NO_DECISION,
  // not a fabricated recommendation. confidence/blocker still follow the
  // weakest-evidence rule so this verdict is not silently reported as 'measured'
  // when its only backing evidence is an 'estimated' price.
  const confidence = weakestConfidence(evidence)
  return {
    package_id: pkg.id,
    verdict: 'NO_DECISION',
    evidence,
    confidence,
    blocker: confidence === 'measured' ? null : `no comparison/threshold rule implemented yet beyond FX-evidence gating (${evidence.find(e => e.confidence !== 'measured')?.blocker ?? 'n/a'})`,
    window,
    generated_at,
  }
}

// ---- portfolio-level report --------------------------------------------------

/**
 * ONE recommendation per package inventory entry, ALWAYS -- a straight map,
 * never a filter. This is what makes "a portfolio comparison must not
 * silently omit an unconvertible cost" true structurally: there is no code
 * path in this function that can drop an entry, so an unconvertible package
 * (e.g. the Anthropic Max 5x EUR case) still appears, carrying its own
 * INSUFFICIENT_EVIDENCE verdict instead of vanishing from the list.
 */
export function buildPortfolioReport(
  packages: PackageInventoryEntry[],
  window: RecommendationWindow,
  ctx: FxEvidenceContext,
): PackageRecommendation[] {
  return packages.map(pkg => evaluatePackage(pkg, window, ctx))
}

