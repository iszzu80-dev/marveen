// CostOps Phase 4 -- monthly portfolio review.
//
// Reads CostOps only -- never a parallel ledger. This module issues no SQL of
// its own (see the structural test for the exact forbidden call pattern); the
// ONLY way it learns anything about actual spend is by calling ledger.ts's
// own getCostSummary(), the same function every other CostOps surface reads.
//
// THE AGREEMENT GUARANTEE (card dec9ae64's pattern, reapplied): period_total_huf
// below is a direct pass-through of summary.current_spend -- not an
// independently recomputed sum -- so this module cannot introduce its own
// disagreement with CostOps' own headline number. checkSourceTotalsAgreement()
// re-sums summary.all_sources (a field CostOps already produced) and compares
// it to that same current_spend; a failure there can only mean CostOps'
// surfaces disagree with each other, which is exactly the bug class dec9ae64
// found, not that this review drifted from CostOps.
//
// package_recommendations (from portfolio-recommendation.ts, package-inventory
// driven) and source_totals (from CostOps, cost_line_items driven) are
// reported SIDE BY SIDE, not merged one-to-one -- package-inventory.ts has no
// cost_source_id cross-reference today, and inventing one here would be a
// fabricated correspondence, not a structural fact.

import type Database from 'better-sqlite3'
import { getCostSummary, monthWindow, type CostSummary } from './ledger.js'
import type { CostOpsConfig } from './config.js'
import type { PackageInventoryEntry } from './package-inventory.js'
import { buildPortfolioReport, type PackageRecommendation, type FxEvidenceContext } from './portfolio-recommendation.js'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface SourceTotalsAgreement {
  ok: boolean
  summed_source_totals: number
  period_total_huf: number
  discrepancy: number
}

/**
 * The agreement assertion: sum of per-source spend must equal the headline
 * period total, both read off the SAME CostSummary. See module header.
 */
export function checkSourceTotalsAgreement(summary: Pick<CostSummary, 'all_sources' | 'current_spend'>): SourceTotalsAgreement {
  const summed = round2(summary.all_sources.reduce((s, r) => s + (r.spend ?? 0), 0))
  const period_total_huf = round2(summary.current_spend)
  const discrepancy = round2(summed - period_total_huf)
  return { ok: discrepancy === 0, summed_source_totals: summed, period_total_huf, discrepancy }
}

export interface MonthlyPortfolioReview {
  month: string
  currency: string
  /** Direct pass-through of CostSummary.current_spend -- never recomputed. */
  period_total_huf: number
  source_totals: Array<{ source_id: string; provider: string; spend: number | null; confidence: string }>
  package_recommendations: PackageRecommendation[]
  agreement: SourceTotalsAgreement
  generated_at: number
}

/**
 * Builds the monthly review: CostOps' own period total + per-source actuals
 * (via getCostSummary -- the only measurement stack) alongside the
 * package-inventory-driven recommendation set (via buildPortfolioReport,
 * increment 1). `now` and `opts.monthKey` are caller-supplied, never read
 * from the clock in here, so this stays a pure function of its inputs given a
 * fixed db state.
 */
export function buildMonthlyPortfolioReview(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  packages: PackageInventoryEntry[],
  fxCtx: FxEvidenceContext,
  opts: { monthKey?: string } = {},
): MonthlyPortfolioReview {
  const summary = getCostSummary(db, config, now, { monthKey: opts.monthKey })
  const win = monthWindow(now, opts.monthKey)
  const package_recommendations = buildPortfolioReport(packages, { from: win.start, to: win.end }, fxCtx)
  const source_totals = summary.all_sources.map(s => ({
    source_id: s.source_id, provider: s.provider, spend: s.spend, confidence: s.confidence,
  }))

  return {
    month: summary.month,
    currency: summary.currency,
    period_total_huf: summary.current_spend,
    source_totals,
    package_recommendations,
    agreement: checkSourceTotalsAgreement(summary),
    generated_at: now,
  }
}