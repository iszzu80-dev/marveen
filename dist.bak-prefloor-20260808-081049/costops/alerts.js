// CostOps -- Phase 3 alerts lifecycle (GAP-12 / core-functional-scope-v1.0.1.md §12).
//
// Pure, deterministic (NEVER LLM-based) alert engine. Two layers:
// 1. DETECTORS -- one pure function per alert type, each taking a narrow
//    SIGNAL interface (never a concrete module type like CostSummary/
//    OperationalResult) so this file stays independent of ledger.ts/
//    forecast.ts/fx.ts/collectors -- the aggregator adapts real data into
//    these signals.
// 2. LIFECYCLE -- `reconcileAlerts` turns "candidates detected this round"
//    + "what's already stored" into insert/touch/resolve instructions:
//    dedup (never a duplicate row for an already-active problem), cooldown
//    (a resolved alert recurring immediately after resolution is reopened
//    quietly, not counted as a fresh noisy recurrence), acknowledgement,
//    and resolution.
//
// NO db.ts/web.ts/schema.ts edits: `initAlertsSchema` is a schema DEFINER
// only, not mounted anywhere -- the seam-refactor's `initCostOpsSchema(db)`
// aggregator (Mason, accounting-core seam, src/costops/schema.ts) calls it,
// per docs/fork-upstream-policy.md §2a. Same pattern as forecast.ts/fx.ts.
//
// GAP-12 acceptance reminder baked into every detector below: "stale data
// alone must not produce a strong or incorrect business claim" -- a stale/failed sync
// alert is capped at 'warning', never 'critical', and detectors that need a
// COMPARISON (variance, growth) refuse to fire without a real baseline
// (never comparing against a fabricated 0).
export function detectBudgetThresholdAlert(s) {
    if (s.used_pct >= s.hard_threshold) {
        return { type: 'budget_threshold', severity: 'critical', dedup_key: `budget_threshold|${s.budget_id}`, evidence: { budget_id: s.budget_id, scope: s.scope, used_pct: s.used_pct, threshold: s.hard_threshold, level: 'hard' } };
    }
    if (s.used_pct >= s.warning_threshold) {
        return { type: 'budget_threshold', severity: 'warning', dedup_key: `budget_threshold|${s.budget_id}`, evidence: { budget_id: s.budget_id, scope: s.scope, used_pct: s.used_pct, threshold: s.warning_threshold, level: 'warning' } };
    }
    return null;
}
/**
 * Distinct from `detectBudgetThresholdAlert`: fires when the FORECAST crosses
 * the hard threshold even though CURRENT spend has not yet -- an early
 * warning before the breach actually happens. Once used_pct itself crosses
 * hard, the plain budget_threshold alert takes over (no double-alerting).
 */
export function detectForecastBudgetBreachAlert(s) {
    if (s.forecast_pct >= s.hard_threshold && s.used_pct < s.hard_threshold) {
        return { type: 'forecast_budget_breach', severity: 'warning', dedup_key: `forecast_budget_breach|${s.budget_id}`, evidence: { budget_id: s.budget_id, scope: s.scope, forecast_pct: s.forecast_pct, used_pct: s.used_pct, threshold: s.hard_threshold } };
    }
    return null;
}
export function detectBalanceExhaustionAlert(s, now) {
    if (s.forecast_exhaustion_at == null)
        return null;
    const daysAhead = (s.forecast_exhaustion_at - now) / 86400;
    const warnDays = s.warning_days_ahead ?? 7;
    if (daysAhead <= 0) {
        return { type: 'balance_exhaustion', severity: 'critical', dedup_key: `balance_exhaustion|${s.provider}`, evidence: { provider: s.provider, remaining: s.remaining, currency: s.currency, forecast_exhaustion_at: s.forecast_exhaustion_at, days_ahead: daysAhead } };
    }
    if (daysAhead <= warnDays) {
        return { type: 'balance_exhaustion', severity: 'warning', dedup_key: `balance_exhaustion|${s.provider}`, evidence: { provider: s.provider, remaining: s.remaining, currency: s.currency, forecast_exhaustion_at: s.forecast_exhaustion_at, days_ahead: daysAhead } };
    }
    return null;
}
/** Stale data is capped at 'warning' -- never 'critical' (GAP-12 acceptance: stale data alone must not produce a strong/incorrect business claim). */
export function detectStaleCollectorAlert(s) {
    if (s.status !== 'stale')
        return null;
    return { type: 'stale_collector', severity: 'warning', dedup_key: `stale_collector|${s.provider}`, evidence: { provider: s.provider, data_age_secs: s.data_age_secs, last_success: s.last_success } };
}
export function detectFailedSyncAlert(s) {
    if (s.status !== 'failed')
        return null;
    const isCredentialIssue = s.error_code === 'credential_error' || s.error_code === 'permission_error';
    return { type: 'failed_sync', severity: isCredentialIssue ? 'critical' : 'warning', dedup_key: `failed_sync|${s.provider}`, evidence: { provider: s.provider, error_code: s.error_code, last_success: s.last_success } };
}
/** Caller already knows this is a real credential/permission problem (no null case -- unlike the other detectors, there's no "maybe" here). */
export function detectCredentialPermissionAlert(s) {
    return { type: 'credential_permission_error', severity: 'critical', dedup_key: `credential_permission_error|${s.source_id}`, evidence: { source_id: s.source_id, provider: s.provider, issue: s.issue } };
}
export function detectMissingInvoiceAlert(s, now) {
    if (s.received || now < s.expected_by)
        return null;
    return { type: 'missing_invoice', severity: 'warning', dedup_key: `missing_invoice|${s.source_id}`, evidence: { source_id: s.source_id, expected_by: s.expected_by, overdue_days: Math.floor((now - s.expected_by) / 86400) } };
}
/** Refuses to fire against a fabricated baseline: actual === 0 means there's nothing real to compare against, so no alert (never a divide-by-zero-flavored false positive). */
export function detectReconciliationMismatchAlert(s) {
    if (s.actual === 0)
        return null;
    const pct = Math.abs(s.variance) / Math.abs(s.actual);
    if (pct < s.variance_threshold_pct)
        return null;
    return { type: 'reconciliation_mismatch', severity: pct >= s.variance_threshold_pct * 2 ? 'critical' : 'warning', dedup_key: `reconciliation_mismatch|${s.source_id}`, evidence: { source_id: s.source_id, estimate: s.estimate, actual: s.actual, variance: s.variance, variance_pct: pct } };
}
export function detectManualProviderVarianceAlert(s) {
    if (s.provider_derived_spend === 0)
        return null;
    const variance = s.provider_derived_spend - s.manual_spend;
    const pct = Math.abs(variance) / Math.abs(s.provider_derived_spend);
    if (pct < s.variance_threshold_pct)
        return null;
    return { type: 'manual_provider_variance', severity: 'warning', dedup_key: `manual_provider_variance|${s.provider}`, evidence: { provider: s.provider, manual_spend: s.manual_spend, provider_derived_spend: s.provider_derived_spend, variance, variance_pct: pct } };
}
/** No baseline (<= 0) means growth cannot be measured -- never fabricated as "infinite growth." */
export function detectUnusualSpendGrowthAlert(s) {
    if (s.baseline_amount <= 0)
        return null;
    const growthPct = (s.current_amount - s.baseline_amount) / s.baseline_amount;
    if (growthPct < s.growth_threshold_pct)
        return null;
    return { type: 'unusual_spend_growth', severity: growthPct >= s.growth_threshold_pct * 2 ? 'critical' : 'warning', dedup_key: `unusual_spend_growth|${s.key}`, evidence: { key: s.key, current_amount: s.current_amount, baseline_amount: s.baseline_amount, growth_pct: growthPct } };
}
export function detectNewUnknownSourceAlert(s) {
    if (!s.is_first_appearance)
        return null;
    return { type: 'new_unknown_source', severity: 'info', dedup_key: `new_unknown_source|${s.source_id}`, evidence: { source_id: s.source_id, first_seen_month: s.first_seen_month } };
}
export function detectLongEstimateOnlySourceAlert(s) {
    if (s.consecutive_estimate_only_months < s.threshold_months)
        return null;
    return { type: 'long_estimate_only_source', severity: 'info', dedup_key: `long_estimate_only_source|${s.source_id}`, evidence: { source_id: s.source_id, consecutive_estimate_only_months: s.consecutive_estimate_only_months, threshold_months: s.threshold_months } };
}
export function detectSubscriptionUtilizationAlert(s) {
    if (s.usage_pct <= s.under_threshold_pct) {
        return { type: 'subscription_utilization', severity: 'info', dedup_key: `subscription_utilization|${s.subscription_id}`, evidence: { subscription_id: s.subscription_id, usage_pct: s.usage_pct, direction: 'under', threshold: s.under_threshold_pct } };
    }
    if (s.usage_pct >= s.over_threshold_pct) {
        return { type: 'subscription_utilization', severity: 'warning', dedup_key: `subscription_utilization|${s.subscription_id}`, evidence: { subscription_id: s.subscription_id, usage_pct: s.usage_pct, direction: 'over', threshold: s.over_threshold_pct } };
    }
    return null;
}
// ---- lifecycle engine ---------------------------------------------------------------
const DEFAULT_COOLDOWN_SECONDS = 3600;
/**
 * The lifecycle core. Given everything currently stored (`existing`, keyed by
 * dedup_key) and this round's freshly detected candidates, decides what
 * changes:
 *
 * - Candidate with NO existing row -> brand new alert (`toInsert`).
 * - Candidate matching an ACTIVE (unresolved) existing row -> dedup: no new
 *   row, just refresh `last_seen`/`severity`/`evidence` (`toTouch`).
 * - Candidate matching a RESOLVED existing row -> the problem came back.
 *   - Within `cooldownSeconds` of the row's own `cooldown_until` -> reopen
 *     quietly (`resolved_at: null`) WITHOUT bumping `recurrence_count` --
 *     this is flapping, not a genuine new incident, so it must not inflate
 *     the recurrence counter noise-wise.
 *   - After cooldown has elapsed -> genuine recurrence: reopen AND bump
 *     `recurrence_count`, and set a fresh `cooldown_until`.
 * - Existing UNRESOLVED row whose dedup_key has NO candidate this round -> the
 *   underlying condition is gone -> `toResolve`.
 *
 * Acknowledgement state is untouched by this function on purpose --
 * dedup/resolve/recur never clears an operator's ack; see `acknowledgeAlert`.
 */
export function reconcileAlerts(existing, candidates, now, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS) {
    const existingByKey = new Map(existing.map(e => [e.dedup_key, e]));
    const candidateKeys = new Set(candidates.map(c => c.dedup_key));
    const toInsert = [];
    const toTouch = [];
    for (const c of candidates) {
        const ex = existingByKey.get(c.dedup_key);
        if (!ex) {
            toInsert.push({
                dedup_key: c.dedup_key, type: c.type, severity: c.severity, evidence: c.evidence,
                first_seen: now, last_seen: now, acknowledged_at: null, acknowledged_by: null,
                resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: now + cooldownSeconds,
            });
            continue;
        }
        if (ex.resolved_at == null) {
            toTouch.push({ dedup_key: c.dedup_key, patch: { last_seen: now, severity: c.severity, evidence: c.evidence, resolved_at: null, recurrence_count: ex.recurrence_count, cooldown_until: ex.cooldown_until } });
            continue;
        }
        const withinCooldown = ex.cooldown_until != null && now < ex.cooldown_until;
        if (withinCooldown) {
            toTouch.push({ dedup_key: c.dedup_key, patch: { last_seen: now, severity: c.severity, evidence: c.evidence, resolved_at: null, recurrence_count: ex.recurrence_count, cooldown_until: ex.cooldown_until } });
        }
        else {
            toTouch.push({ dedup_key: c.dedup_key, patch: { last_seen: now, severity: c.severity, evidence: c.evidence, resolved_at: null, recurrence_count: ex.recurrence_count + 1, cooldown_until: now + cooldownSeconds } });
        }
    }
    const toResolve = existing
        .filter(e => e.resolved_at == null && !candidateKeys.has(e.dedup_key))
        .map(e => ({ dedup_key: e.dedup_key, resolved_at: now }));
    return { toInsert, toTouch, toResolve };
}
/** Manual acknowledgement -- never clears resolution/recurrence state, only records who/when. */
export function acknowledgeAlert(alert, actor, now) {
    return { ...alert, acknowledged_at: now, acknowledged_by: actor };
}
/** Manual/explicit resolve (distinct from the automatic toResolve from reconcileAlerts, e.g. an operator dismissing an alert early). */
export function resolveAlert(alert, now) {
    return { ...alert, resolved_at: now };
}
// ---- evidence (de)serialization -----------------------------------------------------
export function serializeEvidence(evidence) { return JSON.stringify(evidence); }
export function deserializeEvidence(json) {
    try {
        return JSON.parse(json);
    }
    catch {
        return {};
    }
}
// ---- schema (DEFINER ONLY -- not mounted; see file header) --------------------------
/**
 * Schema DEFINER only. NOT called from db.ts or src/costops/schema.ts -- per
 * fork-upstream-policy.md §2a, the ONE seam mount (`initCostOpsSchema(db)` in
 * schema.ts calling this among the module's other schema definers) is the
 * seam-refactor's job. Safe to call more than once (`IF NOT EXISTS`).
 * `evidence_json` stores the `AlertCandidate.evidence` object via
 * `serializeEvidence`; the aggregator round-trips it with
 * `deserializeEvidence`. Named `costops_alerts` (not the generic `alerts`)
 * to stay distinct from any unrelated alerting table elsewhere in the app.
 */
export function initAlertsSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS costops_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      acknowledged_at INTEGER,
      acknowledged_by TEXT,
      resolved_at INTEGER,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      cooldown_until INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_costops_alerts_type ON costops_alerts(type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_costops_alerts_unresolved ON costops_alerts(resolved_at)`);
}
