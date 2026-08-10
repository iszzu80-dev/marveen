// CostOps v0.1 -- deterministic cost ledger core.
//
// Pure SQL + arithmetic. NO LLM, no network, no secrets. `db` and `now` are
// passed in so every function is deterministic and unit-testable against an
// in-memory database. FOCUS-inspired: cost_sources (ProviderName/BillingAccount),
// cost_line_items (ChargeRow: ChargePeriod, ChargeCategory, BilledCost,
// ConsumedQuantity/Unit, confidence), budgets (display-only).
import { createHash } from 'node:crypto';
import { getTokenCostEstimate } from './pricing.js';
export function monthWindow(now, monthKey) {
    let year, month; // month 0-based
    if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
        year = parseInt(monthKey.slice(0, 4));
        month = parseInt(monthKey.slice(5, 7)) - 1;
    }
    else {
        const d = new Date(now * 1000);
        year = d.getUTCFullYear();
        month = d.getUTCMonth();
    }
    const start = Math.floor(Date.UTC(year, month, 1) / 1000);
    const end = Math.floor(Date.UTC(year, month + 1, 1) / 1000);
    const daysInMonth = Math.round((end - start) / 86400);
    const elapsed = Math.min(Math.max(now - start, 1), end - start);
    const fractionElapsed = elapsed / (end - start);
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    return { key, start, end, daysInMonth, fractionElapsed };
}
// ---- hashing (no raw account IDs / invoice refs ever stored) ----------------
/** Deterministic, non-reversible ref for account/resource/invoice identifiers. */
export function hashRef(salt, raw) {
    return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32);
}
// ---- confidence -> breakdown bucket ----------------------------------------
// Higher = more authoritative. Used to resolve a source to one headline line
// (v0.3) so a provider_api actual supersedes a manual estimate without double count.
export const CONF_PRIORITY = {
    actual_invoice: 6, provider_api: 5, billing_export: 4, local_usage: 3, estimate: 2, manual: 1,
    // provider_plan_estimate is ADVISORY only: it is excluded from the headline
    // current_spend entirely (see getCostSummary), so its priority never applies
    // to a headline resolution. Kept here for completeness / bucketing.
    provider_plan_estimate: 0,
};
// provider_plan_estimate lines never enter the headline spend; they surface in a
// dedicated render_plan block (manual vs plan vs variance).
export const ADVISORY_CONF = new Set(['provider_plan_estimate']);
// v0.7: pending_permission lines (a tracked provider whose cost can't be read,
// e.g. AWS) are excluded the same way, but kept SEPARATE from ADVISORY_CONF so
// they never leak into the Render-specific render_plan block. They surface only
// via a dedicated warnings.ts billing_access_needed warning.
export const PENDING_CONF = new Set(['pending_permission']);
// Costs a plan-based Render estimate structurally CANNOT see -> the estimate is a
// lower bound. Surfaced verbatim so the number is never mistaken for an invoice.
export const RENDER_NOT_COVERED = [
    'bandwidth overage (web + static site)',
    'database storage / backup overage above the plan',
    'logs / metrics / observability add-ons',
    'team / workspace seats',
    'tax / VAT',
    'credits / discounts',
    'invoice adjustments',
    'one-off charges',
    'cron per-run compute above the flat approximation',
    'preview environments (excluded)',
];
// v0.4: operational spend preference. The MAIN KPI prefers provider data over the
// manual fallback, per source's provider: provider_api_actual > provider_plan_estimate
// > local_usage > manual/estimate. A provider that HAS a provider-derived line drops
// its manual/estimate lines from operational (they become fallback/comparison only),
// so manual + provider are never double-counted (e.g. a provider-plan estimate wins over a manual entry for the same source).
export const OPERATIONAL_TIER = {
    actual_invoice: 4, provider_api: 4, billing_export: 4,
    provider_plan_estimate: 3,
    local_usage: 2,
    estimate: 1, manual: 1,
};
const PROVIDER_DERIVED_MIN = 3; // provider_plan_estimate or higher = "provider-derived"
const REAL_ACTUAL_MIN = 4; // actual_invoice / provider_api / billing_export = a REAL measured cost
/**
 * Resolve the provider-preferred OPERATIONAL spend for a set of month lines.
 * Per source -> best line by OPERATIONAL_TIER. Per provider -> if it has any
 * provider-derived source, its manual/estimate sources are excluded from operational
 * (fallback only). No double counting. `win` is used for the forecast run-rate.
 */
export function resolveOperational(lines, win) {
    const bySource = new Map();
    for (const l of lines) {
        const a = bySource.get(l.source_id);
        if (a)
            a.push(l);
        else
            bySource.set(l.source_id, [l]);
    }
    const sourceBest = new Map();
    for (const [sid, ls] of bySource) {
        // Tier first; on an EQUAL tier the fresher row wins (card 097d8355, Istvan's
        // ruling 2026-07-20). actual_invoice / provider_api / billing_export all sit at
        // tier 4, so a newly ingested invoice used to tie with an older provider_api row
        // and lose -- strict `>` keeps the incumbent -- meaning the invoice was stored but
        // never reached operational_spend. `data_freshness` is an ingest timestamp
        // (`= @now`, ordered DESC elsewhere), so higher = newer.
        sourceBest.set(sid, ls.reduce((a, b) => {
            const ta = OPERATIONAL_TIER[a.confidence] || 0;
            const tb = OPERATIONAL_TIER[b.confidence] || 0;
            if (tb !== ta)
                return tb > ta ? b : a;
            return b.data_freshness > a.data_freshness ? b : a;
        }));
    }
    // which providers have a provider-derived (tier>=3) source, and which have a REAL
    // measured actual (tier>=4). A real invoice/api actual SUPERSEDES the whole-provider
    // provider_plan_estimate proxy for that provider -- otherwise the plan estimate and
    // the real invoice both count and the provider is double-counted (e.g. Render).
    const providerHasDerived = new Map();
    const providerHasRealActual = new Map();
    for (const best of sourceBest.values()) {
        const t = OPERATIONAL_TIER[best.confidence] || 0;
        if (t >= PROVIDER_DERIVED_MIN)
            providerHasDerived.set(best.provider, true);
        if (t >= REAL_ACTUAL_MIN)
            providerHasRealActual.set(best.provider, true);
    }
    let operational = 0, manual = 0, providerDerived = 0, forecast = 0, manualForDerivedProviders = 0;
    let fresh = null;
    const providerAgg = new Map();
    const confBreakdown = {};
    for (const [, best] of sourceBest) {
        const tier = OPERATIONAL_TIER[best.confidence] || 0;
        const p = best.provider;
        if (fresh === null || best.data_freshness > fresh)
            fresh = best.data_freshness;
        if (tier <= 2)
            manual += best.billed_cost; // fallback view: all manual/estimate, pre-exclusion
        // plan estimate is a proxy for the provider's total -> drop it once a real invoice/api actual exists
        const planSuperseded = best.confidence === 'provider_plan_estimate' && providerHasRealActual.get(p) === true;
        const isFallbackExcluded = (providerHasDerived.get(p) === true && tier < PROVIDER_DERIVED_MIN) || planSuperseded;
        if (isFallbackExcluded) {
            manualForDerivedProviders += best.billed_cost;
            continue;
        }
        if (tier >= PROVIDER_DERIVED_MIN)
            providerDerived += best.billed_cost;
        operational += best.billed_cost;
        confBreakdown[best.confidence] = round2((confBreakdown[best.confidence] || 0) + best.billed_cost);
        const agg = providerAgg.get(p) || { spend: 0, conf: best.confidence, tier: -1 };
        agg.spend += best.billed_cost;
        if (tier > agg.tier) {
            agg.tier = tier;
            agg.conf = best.confidence;
        }
        providerAgg.set(p, agg);
        // forecast policy: provider_api_actual usage MTD -> run-rate; plan/manual -> full monthly
        forecast += (tier >= 4 && best.charge_category === 'usage') ? best.billed_cost / win.fractionElapsed : best.billed_cost;
    }
    return {
        operational_spend: round2(operational),
        manual_spend: round2(manual),
        provider_derived_spend: round2(providerDerived),
        operational_forecast_month_end: round2(forecast),
        provider_breakdown: [...providerAgg.entries()].map(([provider, v]) => ({ provider, spend: round2(v.spend), confidence: v.conf })).sort((a, b) => b.spend - a.spend),
        confidence_breakdown: confBreakdown,
        manual_vs_provider_variance: round2(providerDerived - manualForDerivedProviders),
        data_freshness: fresh,
    };
}
export function confidenceBucket(c) {
    switch (c) {
        case 'actual_invoice':
        case 'provider_api':
        case 'billing_export':
            return 'provider';
        case 'estimate':
        case 'local_usage':
        case 'provider_plan_estimate':
            return 'estimate';
        case 'manual':
        default:
            return 'fixed_manual';
    }
}
// ---- write path: reflect config fixed costs into the ledger (idempotent) -----
/**
 * Upsert the config's fixed/manual monthly costs as cost_line_items for the
 * target month, and upsert their cost_sources. Idempotent via a stable
 * dedup_key (`fixed|<source_id>|<YYYY-MM>`) so re-running never duplicates.
 * Returns the number of line items written/updated.
 */
export function syncFixedCostsToLedger(db, config, now, monthKey) {
    const win = monthWindow(now, monthKey);
    const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, @currency, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, provider=excluded.provider, source_type=excluded.source_type,
      currency=excluded.currency, active=1, updated_at=excluded.updated_at
  `);
    const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at, actual_source)
    VALUES
      (@source_id, @start, @end, @charge_category, @service_name,
       NULL, 1, 'month', @billed_cost, NULL, @currency,
       @confidence, @now, NULL, @dedup_key, @now, 'manual_entry')
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, charge_category=excluded.charge_category,
      service_name=excluded.service_name, currency=excluded.currency,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness,
      actual_source=excluded.actual_source
  `);
    const tx = db.transaction((entries) => {
        let count = 0;
        for (const e of entries) {
            upsertSource.run({
                id: e.source_id, name: e.name, provider: e.provider,
                source_type: e.source_type, currency: e.currency ?? config.currency, now,
            });
            upsertLine.run({
                source_id: e.source_id, start: win.start, end: win.end,
                charge_category: e.charge_category ?? 'subscription', service_name: e.name,
                billed_cost: e.amount, currency: e.currency ?? config.currency,
                confidence: e.confidence ?? 'manual', now,
                dedup_key: `fixed|${e.source_id}|${win.key}`,
            });
            count++;
        }
        return count;
    });
    return tx(config.fixed_costs);
}
export function getCostSummary(db, config, now, opts = {}) {
    const win = monthWindow(now, opts.monthKey);
    const lines = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence, data_freshness,
      actual_source, original_amount, original_currency, fx_rate, fx_date
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start AND voided_at IS NULL
  `).all({ start: win.start, end: win.end });
    let current_spend = 0;
    let forecast_month_end = 0;
    const confidence_breakdown = {};
    const breakdown = { fixed_manual: 0, provider: 0, estimate: 0 };
    const perSource = new Map();
    const perSourceConfidence = new Map();
    // v0.8 (card 6f4d1332 §2/§3): captured in the SAME per-source loop below, no second query --
    // the run-rate/fixed/manual forecast formula already existed but was only summed into the
    // aggregate forecast_month_end and discarded per-source; original-currency fields already
    // existed on the row (v0.7) but were never threaded through to all_sources.
    const perSourceForecast = new Map();
    const perSourceForecastBasis = new Map();
    const perSourceActualSource = new Map();
    const perSourceOriginal = new Map();
    let latestFreshness = null;
    // Group lines per source. The HEADLINE spend resolves each source to its
    // single highest-confidence line (v0.3: a provider_api actual supersedes the
    // manual/estimate WITHOUT double-counting), while all lines are kept for the
    // estimate-vs-actual reconcile view.
    // provider_plan_estimate lines are ADVISORY -- excluded from the headline
    // current_spend and from all_sources; they surface only in the render_plan block.
    const headlineLines = lines.filter(l => !ADVISORY_CONF.has(l.confidence) && !PENDING_CONF.has(l.confidence));
    const planLines = lines.filter(l => ADVISORY_CONF.has(l.confidence));
    const pendingLines = lines.filter(l => PENDING_CONF.has(l.confidence));
    const advisorySourceIds = new Set([...planLines, ...pendingLines].map(l => l.source_id));
    // v0.8 §1 bugfix: all_sources' OWN filter (below) must exclude only plan-estimate sources, not
    // pending ones too -- see the all_sources construction for the full explanation.
    const planOnlySourceIds = new Set(planLines.map(l => l.source_id));
    const pendingSourceIds = new Set(pendingLines.map(l => l.source_id));
    const bySource = new Map();
    for (const l of headlineLines) {
        const arr = bySource.get(l.source_id);
        if (arr)
            arr.push(l);
        else
            bySource.set(l.source_id, [l]);
    }
    for (const l of lines) {
        if (latestFreshness === null || l.data_freshness > latestFreshness)
            latestFreshness = l.data_freshness;
    }
    const EST_CONF = ['manual', 'estimate', 'local_usage'];
    const ACT_CONF = ['provider_api', 'billing_export', 'actual_invoice'];
    const reconcile = [];
    for (const [sid, ls] of bySource) {
        const resolved = ls.reduce((a, b) => (CONF_PRIORITY[b.confidence] || 0) > (CONF_PRIORITY[a.confidence] || 0) ? b : a);
        current_spend += resolved.billed_cost;
        const sourceForecast = resolved.charge_category === 'usage'
            ? resolved.billed_cost / win.fractionElapsed
            : resolved.billed_cost;
        forecast_month_end += sourceForecast;
        confidence_breakdown[resolved.confidence] = (confidence_breakdown[resolved.confidence] || 0) + resolved.billed_cost;
        breakdown[confidenceBucket(resolved.confidence)] += resolved.billed_cost;
        perSource.set(sid, resolved.billed_cost);
        perSourceConfidence.set(sid, resolved.confidence);
        perSourceForecast.set(sid, round2(sourceForecast));
        const actualSource = resolved.actual_source || 'no_data';
        perSourceActualSource.set(sid, actualSource);
        perSourceOriginal.set(sid, {
            amount: resolved.original_amount, currency: resolved.original_currency,
            fx_rate: resolved.fx_rate, fx_date: resolved.fx_date,
        });
        const basis = resolved.charge_category === 'usage' ? 'run_rate'
            : (actualSource === 'provider_api' || actualSource === 'email_invoice') ? 'fixed_subscription'
                : (resolved.confidence === 'manual' || resolved.confidence === 'estimate') ? 'manual_forecast'
                    : 'no_forecast';
        perSourceForecastBasis.set(sid, basis);
        const estAmt = ls.filter(l => EST_CONF.includes(l.confidence)).reduce((s, l) => s + l.billed_cost, 0);
        const actAmt = ls.filter(l => ACT_CONF.includes(l.confidence)).reduce((s, l) => s + l.billed_cost, 0);
        if (actAmt > 0)
            reconcile.push({ source_id: sid, estimate: round2(estAmt), actual: round2(actAmt), variance: round2(actAmt - estAmt), resolved_confidence: resolved.confidence });
    }
    current_spend = round2(current_spend);
    forecast_month_end = round2(forecast_month_end);
    // resolve source metadata (name/provider/source_type) for every active source
    const srcRows = db.prepare(`SELECT id, name, provider, source_type FROM cost_sources WHERE active = 1`).all();
    const nameMap = new Map(srcRows.map(r => [r.id, r.name]));
    const top_sources = [...perSource.entries()]
        .map(([source_id, spend]) => ({ source_id, name: nameMap.get(source_id) || source_id, spend: round2(spend) }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5);
    // Full list: every configured/active source with spend (0 if none this month), extended per
    // v0.8 §1-3 with actual_source/forecast/original-currency.
    //
    // v0.8 §1 bugfix (found reading the code, not in the original requirements): this filter used
    // to exclude BOTH plan-estimate AND pending_permission sources via the combined
    // advisorySourceIds set. Line 67-68's own comment says pending sources are kept "SEPARATE from
    // ADVISORY_CONF" deliberately -- but this filter re-merged them, so a pending_permission source
    // (the spec's own example: "AWS - Jogosultsag kell - nincs osszeg") could never appear in
    // all_sources at all. Fixed: exclude only plan-estimate sources (still correctly advisory-only,
    // surfaced via render_plan instead); INCLUDE pending sources with spend:null (never a fabricated
    // 0 -- guardrail requires the JSON field itself to express "unknown", not just render blank
    // client-side) and actual_source:'pending_permission'.
    const all_sources = srcRows
        .filter(r => !planOnlySourceIds.has(r.id))
        .map(r => {
        const isPending = pendingSourceIds.has(r.id) && !bySource.has(r.id);
        const original = perSourceOriginal.get(r.id);
        return {
            source_id: r.id, name: r.name, provider: r.provider, source_type: r.source_type,
            spend: isPending ? null : round2(perSource.get(r.id) || 0),
            confidence: isPending ? 'pending_permission' : (perSourceConfidence.get(r.id) || 'manual'),
            actual_source: isPending ? 'pending_permission' : (perSourceActualSource.get(r.id) || 'no_data'),
            forecast_month_end: isPending ? null : (perSourceForecast.get(r.id) ?? null),
            forecast_basis: isPending ? 'no_forecast' : (perSourceForecastBasis.get(r.id) || 'no_forecast'),
            forecast_confidence: isPending ? null : (perSourceConfidence.get(r.id) ?? null),
            original_amount: original?.amount ?? null,
            original_currency: original?.currency ?? null,
            fx_rate: original?.fx_rate ?? null,
            fx_date: original?.fx_date ?? null,
            fx_estimated: (original?.fx_rate ?? null) != null ? true : null,
        };
    })
        .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || a.name.localeCompare(b.name));
    // v0.3 Render plan-based estimate (ADVISORY): manual render estimate vs plan-based
    // estimate vs variance. NEVER folded into current_spend. Empty until a Render import.
    const plan_estimate_total = round2(planLines.reduce((s, l) => s + l.billed_cost, 0));
    const manual_render_estimate = round2(srcRows.filter(r => r.provider === 'render' && !advisorySourceIds.has(r.id))
        .reduce((s, r) => s + (perSource.get(r.id) || 0), 0));
    const planFreshness = planLines.reduce((m, l) => Math.max(m, l.data_freshness), 0) || null;
    // v0.5: latest successful Render sync -> sanitized breakdown (service_count, plan
    // breakdown, undercount) + last_sync for the dashboard Render detail.
    const renderRun = db.prepare(`SELECT detail_json, started_at FROM import_runs WHERE provider='render' AND status='ok' ORDER BY started_at DESC LIMIT 1`).get();
    let renderDetail = null;
    if (renderRun?.detail_json) {
        try {
            renderDetail = JSON.parse(renderRun.detail_json);
        }
        catch {
            renderDetail = null;
        }
    }
    const render_plan = planLines.length > 0 ? {
        currency: config.currency,
        plan_estimate_total,
        manual_estimate: manual_render_estimate,
        variance: round2(plan_estimate_total - manual_render_estimate),
        confidence: 'provider_plan_estimate',
        data_freshness_at: planFreshness,
        not_covered: RENDER_NOT_COVERED,
        detail: renderDetail,
        last_sync: renderRun?.started_at ?? null,
    } : null;
    // v0.4: provider-preferred OPERATIONAL spend (new main KPI). Uses ALL lines
    // (manual + plan + provider actual), mapped to their provider, resolved so a
    // provider's manual is dropped once it has provider-derived data (no double count).
    const providerBySource = new Map(srcRows.map(r => [r.id, r.provider]));
    const opLines = lines.filter(l => !PENDING_CONF.has(l.confidence)).map(l => ({
        source_id: l.source_id, provider: providerBySource.get(l.source_id) || 'other',
        billed_cost: l.billed_cost, charge_category: l.charge_category, confidence: l.confidence, data_freshness: l.data_freshness,
    }));
    const op = resolveOperational(opLines, win);
    // previous month: aggregate from cost_line_items; NEVER fabricated. null if no data.
    const prevWin = monthWindow(win.start - 86400);
    const prevRows = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence, data_freshness
    FROM cost_line_items WHERE charge_period_start < @end AND charge_period_end > @start AND voided_at IS NULL
  `).all({ start: prevWin.start, end: prevWin.end });
    let previous_month = null;
    if (prevRows.length > 0) {
        const prevOp = resolveOperational(prevRows.filter(l => !PENDING_CONF.has(l.confidence)).map(l => ({
            source_id: l.source_id, provider: providerBySource.get(l.source_id) || 'other',
            billed_cost: l.billed_cost, charge_category: l.charge_category, confidence: l.confidence, data_freshness: l.data_freshness,
        })), prevWin);
        previous_month = { month: prevWin.key, operational_spend: prevOp.operational_spend, by_provider: prevOp.provider_breakdown };
    }
    const month_over_month_delta = previous_month ? round2(op.operational_spend - previous_month.operational_spend) : null;
    // budget (first budget, or the 'global-monthly' one if present)
    const budgetDef = config.budgets.find(b => b.id === 'global-monthly') || config.budgets[0] || null;
    let budget = null;
    if (budgetDef && budgetDef.amount > 0) {
        const warning = budgetDef.warning_threshold ?? 0.8;
        const hard = budgetDef.hard_threshold ?? 1.0;
        const used_pct = current_spend / budgetDef.amount;
        const forecast_pct = forecast_month_end / budgetDef.amount;
        // v0.4: budget usage against the OPERATIONAL spend (the main KPI).
        const op_used_pct = op.operational_spend / budgetDef.amount;
        const op_forecast_pct = op.operational_forecast_month_end / budgetDef.amount;
        // Status is display-only. No action is ever taken here. Driven by operational.
        const status = op_used_pct >= hard ? 'hard' : op_used_pct >= warning ? 'warning' : 'ok';
        budget = {
            id: budgetDef.id, amount: budgetDef.amount,
            used_pct: round4(used_pct), forecast_pct: round4(forecast_pct),
            operational_used_pct: round4(op_used_pct), operational_forecast_pct: round4(op_forecast_pct),
            status, warning_threshold: warning, hard_threshold: hard,
        };
    }
    // token_usage: VOLUME/ACTIVITY only -- NOT priced in v0.1 (no model column).
    const tu = db.prepare(`
    SELECT COUNT(*) as calls, COUNT(DISTINCT agent) as agents,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens
    FROM token_usage WHERE timestamp >= @start AND timestamp < @end
  `).get({ start: win.start, end: win.end });
    // v0.2 token-cost estimate (deterministic; unknown model / no rate -> unpriced).
    const pricing = opts.pricing ?? { version: 1, currency: config.currency, models: {} };
    const token_cost_estimate = getTokenCostEstimate(db, pricing, opts.pricingExists ?? false, win.start, win.end);
    const estimated_total_with_token_cost = round2(current_spend + token_cost_estimate.total_estimated_huf);
    // v0.3/v0.5 provider sync status: the latest run per provider + last ok/failed +
    // derived status (ok / stale / failed / no_data) + data age + period coverage.
    const STALE_SECS = 3 * 24 * 3600;
    const latestRows = db.prepare(`
    SELECT provider, collector_name, status, imported_count, data_freshness_at, started_at, error_code
    FROM import_runs r
    WHERE started_at = (SELECT MAX(started_at) FROM import_runs WHERE provider = r.provider)
    GROUP BY provider
  `).all();
    const lastOkStmt = db.prepare(`SELECT MAX(started_at) t FROM import_runs WHERE provider = ? AND status = 'ok'`);
    const lastFailStmt = db.prepare(`SELECT MAX(started_at) t FROM import_runs WHERE provider = ? AND status IN ('error','failed','partial','rate_limited')`);
    const prevProviders = new Set(prevRows.map(l => providerBySource.get(l.source_id) || 'other'));
    const provider_sync = latestRows.map(r => {
        const lastOk = lastOkStmt.get(r.provider).t || null;
        const lastFailed = lastFailStmt.get(r.provider).t || null;
        // "stale" means we have not SYNCED recently (not about the billing-period age).
        const syncAge = now - r.started_at;
        const stale = syncAge > STALE_SECS;
        const status = r.status !== 'ok' ? 'failed' : (stale ? 'stale' : 'ok');
        return {
            provider: r.provider, collector_name: r.collector_name, status,
            imported_count: r.imported_count, data_freshness_at: r.data_freshness_at,
            last_sync: r.started_at, last_success: lastOk, last_failed: lastFailed,
            data_age_secs: syncAge,
            current_period: win.key, previous_period_coverage: prevProviders.has(r.provider),
            stale, error_code: r.error_code,
        };
    });
    return {
        month: win.key,
        currency: config.currency,
        current_spend,
        forecast_month_end,
        operational_spend: op.operational_spend,
        operational_forecast_month_end: op.operational_forecast_month_end,
        operational: op,
        previous_month,
        month_over_month_delta,
        top_sources,
        all_sources,
        confidence_breakdown: roundValues(confidence_breakdown),
        breakdown: { fixed_manual: round2(breakdown.fixed_manual), provider: round2(breakdown.provider), estimate: round2(breakdown.estimate) },
        budget,
        token_usage: {
            note: 'volume/activity only -- not priced in v0.1 (token_usage has no model column; token->cost mapping lands in v0.2 after model/session enrichment)',
            calls: tu.calls, agents: tu.agents,
            input_tokens: tu.input_tokens, output_tokens: tu.output_tokens,
            cache_read_tokens: tu.cache_read_tokens, cache_creation_tokens: tu.cache_creation_tokens,
        },
        token_cost_estimate,
        estimated_total_with_token_cost,
        reconcile,
        provider_sync,
        render_plan,
        data_freshness: latestFreshness,
        config_present: opts.configExists ?? true,
        config_errors: opts.configErrors ?? [],
        generated_at: now,
    };
}
export function getCostSources(db) {
    return db.prepare(`SELECT id, name, provider, source_type, currency, active, updated_at FROM cost_sources WHERE active = 1 ORDER BY name`).all();
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function roundValues(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj))
        out[k] = round2(v);
    return out;
}
