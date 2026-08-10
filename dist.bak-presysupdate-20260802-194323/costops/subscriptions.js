// CostOps v0.7 -- subscription lifecycle.
//
// Per-subscription active/canceled/paid_until/next_renewal facts, loaded from
// store/costops-subscriptions.json (gitignored, same convention as
// costops-config.json -- real dates/amounts never enter a tracked file). This
// module is pure I/O + derived-field computation. No Gmail access, no secrets,
// no raw email/PII -- the facts here are already-extracted structured data.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
export const SUBSCRIPTIONS_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json');
export const SUBSCRIPTIONS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json.example');
const EMPTY = { version: 1, subscriptions: [] };
const EXAMPLE_CONFIG = {
    version: 1,
    _doc: 'CostOps v0.7 subscription lifecycle facts. Copy to store/costops-subscriptions.json. paid_until/next_renewal are ISO dates (YYYY-MM-DD). amount is omitted (not 0) when genuinely unknown -- set amount_source accordingly. usage_snapshot (card 2ed90db1) is an OPTIONAL manual reading off a Claude usage screen -- percent + a raw reset label only, never a derived token count; weekly_pct is what feeds the 80% alert. authProfile (card 3ce58384) is OPTIONAL -- set it to configure per-auth-profile capacity (e.g. two Anthropic logins with independent quotas) instead of one shared reading for the whole provider.',
    subscriptions: [
        { id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', source: 'google_play', status: 'canceled', paid_until: '2026-07-16', amount_source: 'invoice', notes: 'cancellation notice received; active until paid_until, then ends' },
        {
            id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', authProfile: 'host_default', source: 'anthropic', status: 'active', next_renewal: '2026-07-20', amount_source: 'manual_fallback', notes: 'no invoice amount available yet',
            usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59', fable_pct: 0 },
        },
        { id: 'openai-chatgpt', name: 'ChatGPT Plus', provider: 'openai', source: 'openai', status: 'active', amount_source: 'no_invoice_found' },
    ],
};
export function loadSubscriptionsConfig() {
    if (!existsSync(SUBSCRIPTIONS_PATH)) {
        ensureExampleSubscriptions();
        return { config: { ...EMPTY }, exists: false, errors: [] };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'));
    }
    catch (err) {
        logger.warn({ err }, 'costops-subscriptions.json is not valid JSON');
        return { config: { ...EMPTY }, exists: true, errors: ['config is not valid JSON'] };
    }
    return validateSubscriptionsConfig(raw);
}
export function ensureExampleSubscriptions() {
    try {
        if (!existsSync(SUBSCRIPTIONS_EXAMPLE_PATH)) {
            writeFileSync(SUBSCRIPTIONS_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8');
        }
    }
    catch (err) {
        logger.warn({ err }, 'Failed to write costops-subscriptions example');
    }
}
const VALID_STATUS = new Set(['active', 'canceled', 'expired', 'unknown']);
const VALID_AMOUNT_SOURCE = new Set(['invoice', 'manual_fallback', 'no_invoice_found', 'pending_permission']);
const VALID_BILLING_PERIOD = new Set(['monthly', 'annual', 'weekly', 'unknown']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function validateSubscriptionsConfig(raw) {
    const errors = [];
    const obj = (raw && typeof raw === 'object') ? raw : {};
    const rawSubs = Array.isArray(obj.subscriptions) ? obj.subscriptions : [];
    const subscriptions = [];
    for (const [i, e] of rawSubs.entries()) {
        const s = e;
        if (typeof s?.id !== 'string' || !s.id) {
            errors.push(`subscriptions[${i}]: missing id`);
            continue;
        }
        if (typeof s?.name !== 'string' || !s.name) {
            errors.push(`subscriptions[${i}] (${s.id}): missing name`);
            continue;
        }
        const status = VALID_STATUS.has(s.status) ? s.status : 'unknown';
        const amount_source = VALID_AMOUNT_SOURCE.has(s.amount_source) ? s.amount_source : 'no_invoice_found';
        if (s.paid_until !== undefined && !ISO_DATE.test(s.paid_until)) {
            errors.push(`subscriptions[${i}] (${s.id}): paid_until must be YYYY-MM-DD`);
            continue;
        }
        if (s.next_renewal !== undefined && !ISO_DATE.test(s.next_renewal)) {
            errors.push(`subscriptions[${i}] (${s.id}): next_renewal must be YYYY-MM-DD`);
            continue;
        }
        if (s.amount !== undefined && (typeof s.amount !== 'number' || !isFinite(s.amount) || s.amount < 0)) {
            errors.push(`subscriptions[${i}] (${s.id}): amount must be a non-negative number when present`);
            continue;
        }
        if (s.weekly_limit_tokens !== undefined && (typeof s.weekly_limit_tokens !== 'number' || !isFinite(s.weekly_limit_tokens) || s.weekly_limit_tokens < 0)) {
            errors.push(`subscriptions[${i}] (${s.id}): weekly_limit_tokens must be a non-negative number when present`);
            continue;
        }
        if (s.five_hour_limit_tokens !== undefined && (typeof s.five_hour_limit_tokens !== 'number' || !isFinite(s.five_hour_limit_tokens) || s.five_hour_limit_tokens < 0)) {
            errors.push(`subscriptions[${i}] (${s.id}): five_hour_limit_tokens must be a non-negative number when present`);
            continue;
        }
        // Malformed usage_snapshot is dropped (not fatal to the whole subscription entry) -- a typo
        // in a manually-pasted snapshot shouldn't lose the subscription's active/canceled status.
        const usage_snapshot = parseUsageSnapshot(s.usage_snapshot);
        subscriptions.push({
            id: s.id, name: s.name,
            provider: typeof s.provider === 'string' ? s.provider : 'other',
            // Blank/non-string -> undefined, never coerced to '' (a '' authProfile
            // must not accidentally exact-match a stray '' elsewhere).
            authProfile: (typeof s.authProfile === 'string' && s.authProfile.trim()) ? s.authProfile.trim() : undefined,
            source: typeof s.source === 'string' ? s.source : 'unknown',
            status,
            paid_until: typeof s.paid_until === 'string' ? s.paid_until : undefined,
            next_renewal: typeof s.next_renewal === 'string' ? s.next_renewal : undefined,
            amount: typeof s.amount === 'number' ? s.amount : undefined,
            currency: typeof s.currency === 'string' ? s.currency : undefined,
            amount_source,
            // An unrecognised value is NOT silently coerced to 'monthly' -- it becomes
            // 'unknown', which the capacity view then reports as unknown.
            billing_period: VALID_BILLING_PERIOD.has(s.billing_period)
                ? s.billing_period
                : 'unknown',
            notes: typeof s.notes === 'string' ? s.notes : undefined,
            weekly_limit_tokens: typeof s.weekly_limit_tokens === 'number' ? s.weekly_limit_tokens : undefined,
            five_hour_limit_tokens: typeof s.five_hour_limit_tokens === 'number' ? s.five_hour_limit_tokens : undefined,
            usage_snapshot,
        });
    }
    return { config: { version: typeof obj.version === 'number' ? obj.version : 1, subscriptions }, exists: true, errors };
}
function isPct(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100;
}
function parseUsageSnapshot(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const u = raw;
    if (typeof u.as_of !== 'string' || isNaN(Date.parse(u.as_of)))
        return undefined;
    if (!isPct(u.session_pct) || !isPct(u.weekly_pct))
        return undefined;
    if (typeof u.weekly_reset_label !== 'string' || !u.weekly_reset_label)
        return undefined;
    return {
        as_of: u.as_of,
        session_pct: u.session_pct,
        weekly_pct: u.weekly_pct,
        weekly_reset_label: u.weekly_reset_label,
        fable_pct: isPct(u.fable_pct) ? u.fable_pct : undefined,
    };
}
/**
 * Derive lifecycle display fields (days remaining, past-due flag) from the
 * static config facts + `now`. Pure function -- no I/O, no DB.
 */
export function deriveLifecycle(config, now) {
    const nowDay = Math.floor(now / 86400);
    return config.subscriptions.map(s => {
        const targetDate = s.status === 'canceled' ? s.paid_until : s.next_renewal;
        let days_until_next_date = null;
        let past_due = false;
        if (targetDate && ISO_DATE.test(targetDate)) {
            const targetDay = Math.floor(Date.parse(`${targetDate}T00:00:00Z`) / 1000 / 86400);
            days_until_next_date = targetDay - nowDay;
            past_due = s.status === 'active' && days_until_next_date < 0;
        }
        return { ...s, days_until_next_date, past_due };
    });
}
