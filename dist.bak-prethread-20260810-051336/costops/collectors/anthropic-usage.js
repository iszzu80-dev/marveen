// CostOps Phase 2 / P2-C -- Claude (Anthropic) usage-capacity collector.
//
// THE HONEST GAP, STATED ONCE: Anthropic exposes NO quota/usage API. The Admin
// API returns COST (see anthropic.ts), not remaining capacity, and the Claude
// usage screen shows a PERCENT of an undisclosed ceiling. Re-verified 2026-07-30.
// Therefore this collector NEVER makes a network call and NEVER produces a
// measured figure. It promotes what the operator already recorded in
// store/costops-subscriptions.json (`usage_snapshot`: session_pct / weekly_pct /
// a verbatim reset label) into the same snapshot table the codex collector writes
// to, so one dashboard/KPI read path can show Claude capacity next to Codex
// capacity WITHOUT the two looking equally authoritative:
//
//   codex   -> snapshot_source 'provider_metadata_api',    confidence 'measured'
//   claude  -> snapshot_source 'operator_manual_snapshot', confidence 'manual'
//
// The 'measured' label is not merely unused here -- capacity-snapshots.ts refuses
// it for this source, so it is unreachable.
//
// No usage_snapshot in local config => nothing is written and the run is recorded
// as 'skipped' with a precise reason. limits.ts / the capacity view then report
// 'unknown'. A fabricated percentage is never an option.
//
// Deterministic: local file read + SQLite. No LLM, no network, no secret.
import { loadSubscriptionsConfig } from '../subscriptions.js';
import { writeRateLimitSnapshot } from '../capacity-snapshots.js';
export const ANTHROPIC_USAGE_COLLECTOR = 'anthropic-usage-snapshot';
/**
 * Promote every anthropic subscription's manual usage_snapshot into
 * provider_ratelimit_snapshots, stamped 'manual'.
 *
 * Idempotent by construction: the dedup_key includes the snapshot's own `as_of`,
 * so re-running on every scheduled tick does not turn one manual reading into N
 * observations. A NEW reading (new as_of) does land as a new row.
 *
 * `resets_at` is deliberately left NULL: the config carries a verbatim label like
 * 'Tue 08:59' whose timezone and cadence are not confirmed, so it is stored as
 * reset_label and never parsed into a specific calendar timestamp.
 */
export function syncAnthropicUsageSnapshot(db, now, deps = {}) {
    const config = deps.config ?? loadSubscriptionsConfig().config;
    const candidates = config.subscriptions.filter(s => s.provider === 'anthropic');
    if (candidates.length === 0) {
        return {
            ok: false, provider: 'anthropic', status: 'skipped', imported_count: 0,
            blocker: 'no anthropic subscription in store/costops-subscriptions.json',
            subscription_ids: [],
        };
    }
    const withSnapshot = candidates.filter(s => s.usage_snapshot);
    if (withSnapshot.length === 0) {
        return {
            ok: false, provider: 'anthropic', status: 'skipped', imported_count: 0,
            blocker: 'no usage_snapshot on any anthropic subscription (Anthropic exposes no quota API; '
                + 'a snapshot must be supplied manually) -- capacity stays unknown, never inferred',
            subscription_ids: [],
        };
    }
    let imported = 0;
    const ids = [];
    for (const s of withSnapshot) {
        const snap = s.usage_snapshot;
        const landed = writeRateLimitSnapshot(db, {
            provider: 'anthropic',
            // Card 3ce58384: threads the subscription entry's own authProfile (if
            // the operator configured per-profile entries) so this snapshot can be
            // matched exactly by usageFigure(), instead of landing as a
            // provider-wide row every profile's query would otherwise share.
            authProfile: s.authProfile ?? null,
            limitId: `${s.id}|weekly`,
            usedPercent: snap.weekly_pct,
            windowDurationMins: null,
            // No real epoch reset exists -- only the operator's verbatim label.
            resetsAt: null,
            resetLabel: snap.weekly_reset_label,
            planType: s.name,
            source: 'operator_manual_snapshot',
            confidence: 'manual',
            dedupKey: `anthropic|${s.id}|weekly|${snap.as_of}`,
            capturedAt: now,
        });
        if (landed)
            imported++;
        ids.push(s.id);
    }
    return {
        ok: true, provider: 'anthropic', status: 'ok', imported_count: imported,
        blocker: null, subscription_ids: ids,
    };
}
