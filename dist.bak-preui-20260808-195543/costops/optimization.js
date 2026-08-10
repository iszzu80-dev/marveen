// CostOps -- Phase 4 aggregate cost optimization advisor (GAP-17 /
// core-functional-scope-v1.0.1.md §17).
//
// Same two-layer shape as alerts.ts (Anvil, Phase 3):
// 1. DETECTORS -- one pure function per recommendation type, each over a
//    narrow SIGNAL interface (never a concrete module type like
//    SubscriptionLifecycle/LimitStatus), so this file stays independent of
//    subscriptions.ts/limits.ts/ledger.ts -- a future orchestration layer
//    (optimization-capture.ts, mirroring alerts-capture.ts) adapts real data
//    into these signals, the same split alerts.ts/alerts-capture.ts used.
// 2. LIFECYCLE -- `reconcileRecommendations` turns "candidates detected this
//    round" + "what's already stored" into insert/touch/resolve/expire
//    instructions: a human's accepted/dismissed decision is never silently
//    overwritten by re-detection, an unaddressed recommendation expires
//    after a while (visibility hygiene, not an automatic action), and a
//    recommendation whose condition disappears on its own auto-resolves.
//
// NO db.ts/web.ts/schema.ts edits: `initOptimizationSchema` is a schema
// DEFINER only, not mounted anywhere -- the seam-refactor's
// `initCostOpsSchema(db)` aggregator calls it, per
// docs/fork-upstream-policy.md §2a.
//
// AGGREGATE COST SCOPE ONLY (GAP-17's explicit "Tilos" list): every
// recommendation here is subscription/provider/hosting/SaaS/domain-level.
// There is no agent-level, task-level, product-level, or model-routing
// recommendation type in this file, and none will ever be added to it --
// that is a different, explicitly out-of-scope project per both spec docs.
// Nothing here EXECUTES anything: every detector only produces a
// recommendation record; cancelling/downgrading/switching a real
// subscription or service is always a human action taken outside this
// codebase. No LLM anywhere -- every number is traceable to the ledger/
// subscription/utilisation data the caller supplies.
import { serializeEvidence, deserializeEvidence } from './alerts.js';
function round2(n) { return Math.round(n * 100) / 100; }
export function detectUnderusedSubscriptionRecommendation(s) {
    if (s.usage_pct > s.under_threshold_pct)
        return null;
    if (s.cancel_or_downgrade_option == null)
        return null; // no known real option -- never fabricate a recommendation
    const target = s.cancel_or_downgrade_option === 'downgrade' && s.downgrade_monthly_cost != null ? s.downgrade_monthly_cost : 0;
    const monthlySaving = round2(s.monthly_cost - target);
    if (monthlySaving <= 0)
        return null;
    return {
        type: 'underused_subscription_downgrade',
        dedup_key: `underused_subscription_downgrade|${s.subscription_id}`,
        evidence: { subscription_id: s.subscription_id, provider: s.provider, usage_pct: s.usage_pct, under_threshold_pct: s.under_threshold_pct },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: monthlySaving,
        estimated_annual_saving: round2(monthlySaving * 12),
        switching_cost: 0,
        risk: s.cancel_or_downgrade_option === 'cancel' ? 'medium' : 'low',
        confidence: s.downgrade_monthly_cost != null || s.cancel_or_downgrade_option === 'cancel' ? 'high' : 'medium',
        human_decision_required: s.cancel_or_downgrade_option === 'cancel'
            ? `Confirm cancelling ${s.subscription_id} (usage ${Math.round(s.usage_pct * 100)}%)`
            : `Confirm downgrading ${s.subscription_id} to a cheaper tier`,
        rollback_note: 'Re-subscribing/upgrading later reverses this -- no data loss, but re-onboarding or promotional pricing may not carry over.',
    };
}
/** Multi-output: one recommendation per product-group with 2+ ACTIVE subscriptions. */
export function detectDuplicateSubscriptionRecommendations(subs) {
    const active = subs.filter(s => s.status === 'active');
    const byProduct = new Map();
    for (const s of active) {
        const a = byProduct.get(s.product);
        if (a)
            a.push(s);
        else
            byProduct.set(s.product, [s]);
    }
    const out = [];
    for (const [product, group] of byProduct) {
        if (group.length < 2)
            continue;
        const sorted = [...group].sort((a, b) => b.monthly_cost - a.monthly_cost);
        const [keep, ...redundant] = sorted;
        const monthlySaving = round2(redundant.reduce((s, r) => s + r.monthly_cost, 0));
        if (monthlySaving <= 0)
            continue;
        out.push({
            type: 'duplicate_subscription',
            dedup_key: `duplicate_subscription|${product}`,
            evidence: { product, subscription_ids: group.map(g => g.subscription_id), suggested_keep: keep.subscription_id, suggested_cancel: redundant.map(r => r.subscription_id) },
            current_monthly_cost: round2(group.reduce((s, g) => s + g.monthly_cost, 0)),
            estimated_monthly_saving: monthlySaving,
            estimated_annual_saving: round2(monthlySaving * 12),
            switching_cost: 0,
            risk: 'medium',
            confidence: 'medium',
            human_decision_required: `Confirm which of [${group.map(g => g.subscription_id).join(', ')}] to keep and cancel the rest`,
            rollback_note: 'Cancelled subscriptions can typically be re-activated, but may lose promotional pricing or onboarding state.',
        });
    }
    return out;
}
/** Multi-output: one recommendation per service_key-group with 2+ sources -- deliberately LOW confidence, since grouping is a caller-supplied heuristic, not a verified duplicate. */
export function detectDuplicateHostingSaasRecommendations(sources) {
    const byKey = new Map();
    for (const s of sources) {
        const a = byKey.get(s.service_key);
        if (a)
            a.push(s);
        else
            byKey.set(s.service_key, [s]);
    }
    const out = [];
    for (const [key, group] of byKey) {
        if (group.length < 2)
            continue;
        const total = round2(group.reduce((s, g) => s + g.monthly_cost, 0));
        const max = Math.max(...group.map(g => g.monthly_cost));
        const monthlySaving = round2(total - max); // assumes at least one must be kept -- a lower bound, not "cancel everything"
        if (monthlySaving <= 0)
            continue;
        out.push({
            type: 'duplicate_hosting_saas',
            dedup_key: `duplicate_hosting_saas|${key}`,
            evidence: { service_key: key, source_ids: group.map(g => g.source_id), providers: group.map(g => g.provider) },
            current_monthly_cost: total,
            estimated_monthly_saving: monthlySaving,
            estimated_annual_saving: round2(monthlySaving * 12),
            switching_cost: 0,
            risk: 'medium',
            confidence: 'low',
            human_decision_required: `Confirm whether [${group.map(g => g.source_id).join(', ')}] are genuinely redundant hosting/SaaS`,
            rollback_note: 'Cancelling a redundant hosting/SaaS account can usually be re-provisioned, but may lose data/config unless backed up first.',
        });
    }
    return out;
}
export function detectAnnualBillingRecommendation(s) {
    if (s.annual_plan_monthly_equivalent == null)
        return null;
    const monthlySaving = round2(s.monthly_cost - s.annual_plan_monthly_equivalent);
    if (monthlySaving <= 0)
        return null;
    return {
        type: 'switch_to_annual_billing',
        dedup_key: `switch_to_annual_billing|${s.subscription_id}`,
        evidence: { subscription_id: s.subscription_id, provider: s.provider, monthly_billing_cost: s.monthly_cost, annual_equivalent_monthly_cost: s.annual_plan_monthly_equivalent },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: monthlySaving,
        estimated_annual_saving: round2(monthlySaving * 12),
        // The annual up-front commitment IS a real cash outlay, not a free switch -- surfaced as
        // switching_cost so a human sees the liquidity impact, not just the eventual saving.
        switching_cost: round2(s.annual_plan_monthly_equivalent * 12),
        risk: 'low',
        confidence: 'high',
        human_decision_required: `Confirm committing to annual billing for ${s.subscription_id} (locks in for 12 months)`,
        rollback_note: 'Annual commitments are typically NOT refundable mid-term -- switching back to monthly means waiting out the paid year.',
    };
}
export function detectUnusedDomainOrStorageRecommendation(s) {
    if (!s.confirmed_unused)
        return null;
    return {
        type: 'unused_domain_or_storage',
        dedup_key: `unused_domain_or_storage|${s.source_id}`,
        evidence: { source_id: s.source_id, provider: s.provider, source_type: s.source_type },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: s.monthly_cost,
        estimated_annual_saving: round2(s.monthly_cost * 12),
        switching_cost: 0,
        risk: 'low',
        confidence: 'medium',
        human_decision_required: `Confirm ${s.source_id} (${s.source_type}) is safe to release/cancel`,
        rollback_note: s.source_type === 'domain'
            ? 'A released domain can be re-registered later, but may be claimed by someone else first.'
            : 'Deleted storage cannot be recovered unless backed up first.',
    };
}
export function detectForgottenServiceRecommendation(s) {
    if (s.months_since_last_meaningful_activity == null)
        return null;
    if (s.months_since_last_meaningful_activity < s.threshold_months)
        return null;
    return {
        type: 'forgotten_service',
        dedup_key: `forgotten_service|${s.source_id}`,
        evidence: { source_id: s.source_id, provider: s.provider, months_inactive: s.months_since_last_meaningful_activity },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: s.monthly_cost,
        estimated_annual_saving: round2(s.monthly_cost * 12),
        switching_cost: 0,
        risk: 'medium',
        confidence: 'medium',
        human_decision_required: `Confirm ${s.source_id} is genuinely forgotten/unneeded before cancelling (${s.months_since_last_meaningful_activity} months inactive)`,
        rollback_note: 'Re-subscribing later is usually possible but may lose historical account state or pricing.',
    };
}
export function detectOversizedFixedPackageRecommendation(s) {
    if (s.smaller_tier_monthly_cost == null || s.smaller_tier_capacity_pct_of_current == null)
        return null;
    if (s.actual_usage_pct_of_current_tier > s.smaller_tier_capacity_pct_of_current)
        return null; // wouldn't actually fit
    const monthlySaving = round2(s.current_tier_monthly_cost - s.smaller_tier_monthly_cost);
    if (monthlySaving <= 0)
        return null;
    return {
        type: 'oversized_fixed_package',
        dedup_key: `oversized_fixed_package|${s.subscription_id}`,
        evidence: { subscription_id: s.subscription_id, provider: s.provider, usage_pct: s.actual_usage_pct_of_current_tier, smaller_tier_capacity_pct: s.smaller_tier_capacity_pct_of_current },
        current_monthly_cost: s.current_tier_monthly_cost,
        estimated_monthly_saving: monthlySaving,
        estimated_annual_saving: round2(monthlySaving * 12),
        switching_cost: 0,
        risk: 'medium',
        confidence: 'medium',
        human_decision_required: `Confirm downgrading ${s.subscription_id} to the smaller tier still covers real usage`,
        rollback_note: 'Upgrading back later is usually available on-demand, often for a prorated fee.',
    };
}
/**
 * This recommendation's value is DATA QUALITY (less error-prone manual entry,
 * less operator labor), not a direct cost reduction -- estimated_monthly_saving
 * is honestly 0 rather than fabricating a dollar figure nothing backs.
 * switching_cost is also 0: building/enabling a collector is engineering time,
 * which this ledger has no unit to price.
 */
export function detectAutomateLongManualSourceRecommendation(s) {
    if (s.consecutive_manual_only_months < s.threshold_months)
        return null;
    return {
        type: 'automate_long_manual_source',
        dedup_key: `automate_long_manual_source|${s.source_id}`,
        evidence: { source_id: s.source_id, provider: s.provider, consecutive_manual_only_months: s.consecutive_manual_only_months },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: 0,
        estimated_annual_saving: 0,
        switching_cost: 0,
        risk: 'low',
        confidence: 'medium',
        human_decision_required: `Consider building/enabling a provider collector for ${s.source_id} (${s.consecutive_manual_only_months} consecutive manual-only months)`,
        rollback_note: 'A new automated collector can always be disabled, reverting to manual entry.',
    };
}
export function detectProviderCreditOrDiscountRecommendation(s) {
    if (s.known_available_credit_or_discount_monthly == null || s.known_available_credit_or_discount_monthly <= 0)
        return null;
    return {
        type: 'provider_credit_or_discount',
        dedup_key: `provider_credit_or_discount|${s.provider}`,
        evidence: { provider: s.provider, discount_description: s.discount_description },
        current_monthly_cost: s.monthly_cost,
        estimated_monthly_saving: s.known_available_credit_or_discount_monthly,
        estimated_annual_saving: round2(s.known_available_credit_or_discount_monthly * 12),
        switching_cost: 0,
        risk: 'low',
        confidence: 'high',
        human_decision_required: `Apply the known ${s.provider} discount/credit${s.discount_description ? ` (${s.discount_description})` : ''}`,
        rollback_note: 'Applying a discount/credit is not typically reversible-needed -- no rollback risk.',
    };
}
// ---- lifecycle engine -----------------------------------------------------------------------
// Flagged placeholder (same convention as inventory.ts's freshness thresholds / alerts.ts's
// cooldown) -- an unaddressed recommendation stops nagging after ~90 days if no human ever
// accepted/dismissed it. This is visibility hygiene only, never an automatic action.
const DEFAULT_EXPIRY_SECONDS = 90 * 24 * 3600;
/**
 * The lifecycle core, mirroring alerts.ts's reconcileAlerts shape:
 *
 * - Candidate with no existing row, OR matching a row that's already
 *   'expired' -> brand new recommendation, status 'open' (an expired one
 *   resurfacing gets a fresh record, not a silent un-expire).
 * - Candidate matching an 'open' existing row -> touch: refresh cost/saving/
 *   risk/confidence/evidence numbers (the underlying data may have moved)
 *   without touching status.
 * - Candidate matching an 'accepted'/'dismissed'/'resolved' existing row ->
 *   FROZEN. A human's decision (or a prior auto-resolve) is never silently
 *   overwritten by re-detection; see acceptRecommendation/
 *   dismissRecommendation for the only way status changes on those.
 * - Existing 'open' row with NO matching candidate this round -> the
 *   underlying condition is gone -> `toResolve` (takes priority over expiry
 *   -- "resolved on its own" is more informative than "timed out").
 * - Existing 'open' row that DOES still have a matching candidate but is
 *   past `expires_at` -> `toExpire` (a human never acted on it in time).
 */
export function reconcileRecommendations(existing, candidates, now, expirySeconds = DEFAULT_EXPIRY_SECONDS) {
    const existingByKey = new Map(existing.map(e => [e.dedup_key, e]));
    const candidateKeys = new Set(candidates.map(c => c.dedup_key));
    const toInsert = [];
    const toTouch = [];
    for (const c of candidates) {
        const ex = existingByKey.get(c.dedup_key);
        if (!ex || ex.status === 'expired') {
            toInsert.push({
                ...c, first_seen: now, last_seen: now, status: 'open',
                status_changed_at: null, status_changed_by: null, expires_at: now + expirySeconds,
            });
            continue;
        }
        if (ex.status === 'open') {
            toTouch.push({
                dedup_key: c.dedup_key,
                patch: {
                    last_seen: now, evidence: c.evidence, current_monthly_cost: c.current_monthly_cost,
                    estimated_monthly_saving: c.estimated_monthly_saving, estimated_annual_saving: c.estimated_annual_saving,
                    switching_cost: c.switching_cost, risk: c.risk, confidence: c.confidence,
                },
            });
            continue;
        }
        // accepted / dismissed / resolved -> frozen, intentionally no-op here.
    }
    const toResolve = existing
        .filter(e => e.status === 'open' && !candidateKeys.has(e.dedup_key))
        .map(e => ({ dedup_key: e.dedup_key }));
    const resolvedKeys = new Set(toResolve.map(r => r.dedup_key));
    const toExpire = existing
        .filter(e => e.status === 'open' && !resolvedKeys.has(e.dedup_key) && e.expires_at != null && now > e.expires_at)
        .map(e => ({ dedup_key: e.dedup_key }));
    return { toInsert, toTouch, toResolve, toExpire };
}
/** Manual human decision: accept a recommendation (the human intends to act on it, outside this codebase -- this function never executes anything itself). */
export function acceptRecommendation(r, actor, now) {
    return { ...r, status: 'accepted', status_changed_at: now, status_changed_by: actor };
}
/** Manual human decision: dismiss a recommendation (the human decided against it). */
export function dismissRecommendation(r, actor, now) {
    return { ...r, status: 'dismissed', status_changed_at: now, status_changed_by: actor };
}
export { serializeEvidence, deserializeEvidence };
// ---- schema (DEFINER ONLY -- not mounted; see file header) ------------------------------------
/**
 * Schema DEFINER only. NOT called from db.ts or src/costops/schema.ts -- per
 * fork-upstream-policy.md §2a, the seam mount (`initCostOpsSchema(db)`
 * calling this among the module's other schema definers) is the
 * seam-refactor's job. Safe to call more than once (`IF NOT EXISTS`).
 */
export function initOptimizationSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS costops_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      current_monthly_cost REAL NOT NULL,
      estimated_monthly_saving REAL NOT NULL,
      estimated_annual_saving REAL NOT NULL,
      switching_cost REAL NOT NULL,
      risk TEXT NOT NULL,
      confidence TEXT NOT NULL,
      human_decision_required TEXT NOT NULL,
      rollback_note TEXT NOT NULL,
      status TEXT NOT NULL,
      status_changed_at INTEGER,
      status_changed_by TEXT,
      expires_at INTEGER,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_costops_recommendations_type ON costops_recommendations(type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_costops_recommendations_status ON costops_recommendations(status)`);
}
