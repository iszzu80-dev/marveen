// CostOps Phase 2 / P2-C -- subscription / capacity visibility.
//
// WHAT THIS REPLACES. GET /api/costs/subscriptions returned
// `{"subscriptions":[],"config_present":false}` -- structurally correct and
// informationally empty. There was no way to answer, without hand-written SQL,
// "what plan is active, how much of it are we using, how much is going unused, are
// we overflowing, is work getting blocked, is work being pushed to metered API".
//
// THE RULE THAT SHAPES EVERY FIELD. Every figure here is a CapacityFigure carrying
// its own value, confidence and freshness. A number with no provenance is worse
// than a gap, because a gap prompts a question and a bare number ends one. So:
//
//   * a figure we cannot compute is `{ value: null, confidence: 'unknown' }` with
//     a `blocker` string saying precisely why -- never 0, which would read as
//     "measured, and it is zero";
//   * derived figures INHERIT the weakest confidence of their inputs. Unused
//     capacity computed from a manual usage reading is 'manual', not 'measured' --
//     arithmetic does not upgrade evidence;
//   * freshness is the age of the underlying observation, not of this HTTP
//     response. A 9-day-old manual reading says so.
//
// PHASE SCOPE (hard): Phase 2 is VISIBILITY ONLY. No upgrade/downgrade/plan-change
// recommendation may be emitted -- that is Phase 4. This is not left to discipline:
// assertNoRecommendationLanguage() runs over the built payload before it is
// returned, and a test drives it red.
//
// Deployment-local values (real plan names, prices, accounts) live only in
// gitignored store/costops-subscriptions.json; the committed example is
// config-examples/costops-subscriptions.example.json.
//
// Deterministic: SQLite + local config. No LLM, no network, no secret.

import type Database from 'better-sqlite3'
import type { SubscriptionLifecycle, SubscriptionBillingPeriod } from './subscriptions.js'
import { latestRateLimitSnapshot, type UsageConfidence } from './capacity-snapshots.js'
import { countSaturationEvents } from './saturation-events.js'

/** How stale an observation may be before the UI should stop trusting it. */
export const CAPACITY_STALE_AFTER_SECONDS = 26 * 60 * 60

export interface Freshness {
  /** Epoch sec of the underlying OBSERVATION (not of this response). */
  as_of: number | null
  age_seconds: number | null
  stale: boolean
}

export interface CapacityFigure {
  value: number | null
  confidence: UsageConfidence
  freshness: Freshness
  /** Where the figure came from, or 'none' when there is no figure. */
  source: string
  /** Precise reason the value is null. Null when there IS a value. */
  blocker: string | null
  /** Unit of `value` -- never assumed by the renderer. */
  unit: string | null
  /**
   * Provider-stated reset time (epoch sec) of the window the figure belongs
   * to, when the underlying snapshot carried one (OPT-M1, review 2026-08-12:
   * the codex collector persists resets_at, and before this field the column
   * was write-only -- no reader ever surfaced it, so the routing layer could
   * not distinguish "over limit right now" from "over limit in a window that
   * has since reset"). Optional: only figures backed by a capacity snapshot
   * carry it; counters and derived figures leave it absent. Never fabricated
   * from a reset LABEL -- absent unless the provider gave a real timestamp.
   */
  resets_at?: number | null
}

const CONFIDENCE_RANK: Record<UsageConfidence, number> = { measured: 3, manual: 2, inferred: 1, unknown: 0 }

/** The WEAKEST of the given confidences: a derivation never outranks its inputs. */
export function weakestConfidence(...cs: UsageConfidence[]): UsageConfidence {
  let out: UsageConfidence = 'measured'
  for (const c of cs) if (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[out]) out = c
  return out
}

export function freshnessOf(asOf: number | null, now: number): Freshness {
  if (asOf === null) return { as_of: null, age_seconds: null, stale: true }
  const age = Math.max(0, now - asOf)
  return { as_of: asOf, age_seconds: age, stale: age > CAPACITY_STALE_AFTER_SECONDS }
}

export function unknownFigure(blocker: string, unit: string | null = null): CapacityFigure {
  return { value: null, confidence: 'unknown', freshness: freshnessOf(null, 0), source: 'none', blocker, unit }
}

export interface BillingCycle {
  period: SubscriptionBillingPeriod
  next_renewal: string | null
  paid_until: string | null
  days_until_next_date: number | null
  past_due: boolean
}

export interface SubscriptionCapacityView {
  id: string
  name: string
  provider: string
  status: string
  billing_cycle: BillingCycle
  /** Fraction of the plan's window CONSUMED (0..1). */
  usage: CapacityFigure
  /** Fraction of the plan's window paid for and NOT consumed (0..1). */
  unused_capacity: CapacityFigure
  /** Fraction consumed BEYOND the window (0 when inside it). */
  overflow: CapacityFigure
  /** Dispatches stopped by the capacity/saturation gate in the window. */
  blocked_work: CapacityFigure
  /** Dispatches that ran on metered API billing rather than this subscription. */
  work_pushed_to_api: CapacityFigure
}

export interface CapacityReport {
  generated_at: number
  /** Window the work-side counters (blocked / pushed-to-api) were counted over. */
  window: { start: number; end: number }
  subscriptions: SubscriptionCapacityView[]
  /** Phase marker: Phase 2 is visibility only, by contract. */
  phase: 'phase2_visibility_only'
  /** Non-secret notes about structural gaps, so an empty figure is explainable. */
  notes: string[]
}

// ---- forbidden Phase-4 language --------------------------------------------

/**
 * Any recommendation/plan-change verb. Phase 2 must not emit these, so the guard
 * runs over the built payload rather than trusting that nobody added a helpful
 * "consider upgrading" label later.
 *
 * Scoped deliberately to what THIS module generates: operator free text (`notes`
 * on a subscription entry) is NOT copied into the payload, so an operator writing
 * "upgrade later" in their local config cannot trip the guard and 500 the route.
 */
// Matched as STEMS (`upgrad\w*`), not whole words: `_` is a word character, so a
// `\bupgrade\b` pattern would sail straight past a key named `upgrade_path`.
export const RECOMMENDATION_FORBIDDEN_PATTERN =
  /\b(?:upgrad\w*|downgrad\w*|recommend\w*|right[-_ ]?siz\w*)|\bshould switch\b|\bswitch to\b|\bconsider\s+(?:a\s+)?plan\b/i

function walkStrings(value: unknown, visit: (s: string, path: string) => void, path = '$'): void {
  if (typeof value === 'string') { visit(value, path); return }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`)); return }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k, `${path}.${k}`)
      walkStrings(v, visit, `${path}.${k}`)
    }
  }
}

/**
 * Throw if a Phase-4 recommendation leaked into a Phase-2 payload. Checks keys AND
 * string values, at any depth.
 */
export function assertNoRecommendationLanguage(payload: unknown): void {
  const hits: string[] = []
  walkStrings(payload, (s, path) => {
    if (RECOMMENDATION_FORBIDDEN_PATTERN.test(s)) hits.push(`${path}: ${s.slice(0, 80)}`)
  })
  if (hits.length) {
    throw new Error(
      `Phase 2 is visibility only and must emit no upgrade/downgrade recommendation (that is Phase 4). Found: ${hits.join('; ')}`,
    )
  }
}

// ---- figure builders -------------------------------------------------------

/**
 * Usage for one subscription, from the newest capacity snapshot for its provider
 * (and, when the subscription entry names one, its specific auth profile --
 * card 3ce58384).
 *
 * `sub.authProfile` set -> EXACT match only: a provider-wide (unlabelled)
 * snapshot does NOT answer for a specific profile, so an old/undifferentiated
 * reading can never be silently presented as this profile's own figure.
 * `sub.authProfile` unset -> provider-wide query, byte-identical to
 * pre-3ce58384 behaviour (no forced migration).
 *
 * Confidence comes from the SNAPSHOT ROW, not from this function's opinion: codex's
 * provider metadata read is 'measured', a Claude usage-screen reading is 'manual'.
 * No snapshot => unknown with the reason, never 0.
 *
 * The snapshot's provider-stated resets_at travels with the figure (OPT-M1) so
 * a routing-side reader can tell an over-limit reading whose window has since
 * reset apart from a live one -- see the CapacityFigure.resets_at doc above.
 */
export function usageFigure(db: Database.Database, sub: SubscriptionLifecycle, now: number): CapacityFigure {
  const snap = latestRateLimitSnapshot(db, sub.provider, sub.authProfile)
  if (!snap) {
    return unknownFigure(
      sub.authProfile
        ? `no capacity snapshot for provider '${sub.provider}' auth profile '${sub.authProfile}' -- nothing has been observed or supplied yet for this specific profile`
        : `no capacity snapshot for provider '${sub.provider}' -- nothing has been observed or supplied yet`,
      'fraction',
    )
  }
  // A stored row with no confidence marker (pre-P2-C history) is NOT promoted.
  const confidence: UsageConfidence = (snap.usage_confidence ?? 'unknown') as UsageConfidence
  if (confidence === 'unknown') {
    return {
      value: null, confidence: 'unknown', freshness: freshnessOf(snap.captured_at, now),
      source: snap.snapshot_source ?? 'unmarked_snapshot',
      blocker: 'the stored snapshot carries no confidence marker, so its number cannot be presented as a usage figure',
      unit: 'fraction',
      // The reset time is provenance-free metadata about the window, not the
      // figure itself, so it is surfaced even when the number is withheld.
      resets_at: snap.resets_at ?? null,
    }
  }
  return {
    value: Math.round((snap.used_percent / 100) * 10000) / 10000,
    confidence,
    freshness: freshnessOf(snap.captured_at, now),
    source: snap.snapshot_source ?? 'unknown_source',
    blocker: null,
    unit: 'fraction',
    resets_at: snap.resets_at ?? null,
  }
}

/** Unused = 1 - usage, clamped at 0. Inherits usage's confidence and freshness. */
export function unusedCapacityFigure(usage: CapacityFigure): CapacityFigure {
  if (usage.value === null) {
    return { ...usage, blocker: `unused capacity cannot be derived: ${usage.blocker ?? 'usage is unknown'}` }
  }
  return { ...usage, value: Math.max(0, Math.round((1 - usage.value) * 10000) / 10000) }
}

/** Overflow = usage - 1, clamped at 0. Inherits usage's confidence and freshness. */
export function overflowFigure(usage: CapacityFigure): CapacityFigure {
  if (usage.value === null) {
    return { ...usage, blocker: `overflow cannot be derived: ${usage.blocker ?? 'usage is unknown'}` }
  }
  return { ...usage, value: Math.max(0, Math.round((usage.value - 1) * 10000) / 10000) }
}

/**
 * Work stopped by the capacity gate in the window.
 *
 * `observations === 0` means the gate never made a MEASURED observation, which is
 * unknown -- not "no work was blocked". Distinguishing those two is the whole
 * point: a dead gate and a healthy fleet both produce zero events.
 */
export function blockedWorkFigure(db: Database.Database, from: number, to: number, now: number): CapacityFigure {
  let counts: { observations: number; events: number; refusals: number }
  try {
    counts = countSaturationEvents(db, { from, to })
  } catch {
    // A DB migrated before P2-C has no such table: that is an honest unknown, not 0.
    return unknownFigure('the saturation-event table is not available on this database', 'dispatches')
  }
  if (counts.observations === 0) {
    return unknownFigure(
      'the capacity gate recorded no MEASURED observation in this window, so blocked work is unknown '
      + '(zero events and a gate that never observed anything are not the same thing)',
      'dispatches',
    )
  }
  return {
    value: counts.refusals,
    confidence: 'measured',
    freshness: freshnessOf(to, now),
    source: 'dispatch_saturation_events',
    blocker: null,
    unit: 'dispatches',
  }
}

/**
 * Dispatches in the window that ran on metered API billing rather than on this
 * subscription. Derived from dispatches.billing_mode, which is stamped from the
 * deployment-local billing map -- an UNMAPPED pair resolves to 'unknown', never to
 * a flattering 'subscription_included', so this counter cannot silently under-report.
 *
 * No dispatch rows at all => unknown, not 0.
 */
export function workPushedToApiFigure(
  db: Database.Database, provider: string, from: number, to: number, now: number,
): CapacityFigure {
  let row: { total: number; payg: number; unknown_mode: number } | undefined
  try {
    row = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN billing_mode = 'api_payg' THEN 1 ELSE 0 END) AS payg,
             SUM(CASE WHEN billing_mode IS NULL OR billing_mode = 'unknown' THEN 1 ELSE 0 END) AS unknown_mode
      FROM dispatches
      -- Upper bound INCLUSIVE, same reason as countSaturationEvents: the end of the
      -- window is "now", and a dispatch created this second is part of the question.
      WHERE provider = ? AND created_at >= ? AND created_at <= ?
    `).get(provider, from, to) as { total: number; payg: number; unknown_mode: number }
  } catch {
    return unknownFigure('the dispatches table is not available on this database', 'dispatches')
  }
  const total = row?.total ?? 0
  if (total === 0) {
    return unknownFigure(
      `no dispatch was attributed to provider '${provider}' in this window, so API-pushed work is unknown`,
      'dispatches',
    )
  }
  const unknownMode = row?.unknown_mode ?? 0
  return {
    value: row?.payg ?? 0,
    // Every dispatch whose billing_mode is unmapped is a dispatch this count
    // cannot see, so the figure is inferred rather than measured while any exist.
    confidence: unknownMode > 0 ? 'inferred' : 'measured',
    freshness: freshnessOf(to, now),
    source: 'dispatches.billing_mode',
    blocker: unknownMode > 0
      ? `${unknownMode} of ${total} dispatches have no mapped billing_mode, so this count is a lower bound`
      : null,
    unit: 'dispatches',
  }
}

// ---- report ----------------------------------------------------------------

/**
 * Build the full subscription/capacity picture. Pure read: no provider call, no
 * write, no LLM. `window` bounds the work-side counters (defaults to the trailing
 * 30 days, which is the period a capacity question is actually asked over).
 */
export function buildCapacityReport(
  db: Database.Database,
  subscriptions: SubscriptionLifecycle[],
  now: number,
  opts: { windowStart?: number; windowEnd?: number } = {},
): CapacityReport {
  const end = opts.windowEnd ?? now
  const start = opts.windowStart ?? (end - 30 * 24 * 60 * 60)
  const notes: string[] = []
  const views: SubscriptionCapacityView[] = subscriptions.map(sub => {
    const usage = usageFigure(db, sub, now)
    return {
      id: sub.id,
      name: sub.name,
      provider: sub.provider,
      status: sub.status,
      billing_cycle: {
        period: sub.billing_period ?? 'unknown',
        next_renewal: sub.next_renewal ?? null,
        paid_until: sub.paid_until ?? null,
        days_until_next_date: sub.days_until_next_date,
        past_due: sub.past_due,
      },
      usage,
      unused_capacity: unusedCapacityFigure(usage),
      overflow: overflowFigure(usage),
      blocked_work: blockedWorkFigure(db, start, end, now),
      work_pushed_to_api: workPushedToApiFigure(db, sub.provider, start, end, now),
    }
  })

  if (subscriptions.length === 0) {
    notes.push('no subscription is configured in store/costops-subscriptions.json, so there is no plan to report capacity for')
  }
  if (views.some(v => v.usage.confidence === 'manual')) {
    notes.push('a usage figure marked "manual" is an operator reading, not a live measurement: Anthropic publishes no quota API')
  }
  if (views.some(v => v.usage.confidence === 'unknown')) {
    notes.push('a usage figure marked "unknown" has no observation behind it; it is deliberately not shown as 0')
  }

  const report: CapacityReport = {
    generated_at: now,
    window: { start, end },
    subscriptions: views,
    phase: 'phase2_visibility_only',
    notes,
  }
  // Structural, not aspirational: a Phase-4 verb anywhere in this payload is a bug.
  assertNoRecommendationLanguage(report)
  return report
}
