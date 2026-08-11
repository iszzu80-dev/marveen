// CostOps -- OpenAI cost collector (LIVE, read-only).
//
// Uses the OpenAI Costs API (GET /v1/organization/costs) which returns daily
// USD cost buckets and REQUIRES an admin key. The mapper is a PURE function
// tested offline against a fixture; collect() calls the INJECTED httpGetJson so
// no network happens unless a real fetcher is passed. The admin key arrives via
// opts.secret (from the Vault) and is NEVER logged or persisted. No provider-
// side write ever happens (pure GET).
import { createHash } from 'node:crypto';
const OPENAI_COSTS_URL = 'https://api.openai.com/v1/organization/costs';
// All OpenAI API usage reconciles against this source id (matches the manual
// 'openai-api' / 'openai-chatgpt' line family so estimate and actual share it).
const OPENAI_API_SOURCE = 'openai-api';
function hashRef(salt, raw) {
    return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32);
}
/**
 * PURE mapper: OpenAI /organization/costs page -> a single aggregated
 * provider_api line for the openai-api source for the requested period. Daily
 * USD amounts are summed and converted to HUF via fxUsdHuf. Deterministic; no
 * I/O. Returns [] if the page carries no cost results (so an all-zero month can
 * still be reported by the caller as an explicit 0-with-freshness line).
 */
export function mapOpenAiCosts(raw, opts) {
    const page = (raw && typeof raw === 'object') ? raw : {};
    const buckets = Array.isArray(page.data) ? page.data : [];
    let usdTotal = 0;
    let any = false;
    for (const b of buckets) {
        for (const r of (Array.isArray(b.results) ? b.results : [])) {
            const rawAmt = r.amount?.value;
            const amt = typeof rawAmt === 'number' ? rawAmt : parseFloat(String(rawAmt ?? ''));
            if (!isFinite(amt))
                continue;
            // OpenAI costs are USD. Non-USD is not expected; if seen, still sum the
            // numeric value and let the live-verify step flag the currency mismatch.
            usdTotal += amt;
            any = true;
        }
    }
    if (!any)
        return [];
    // Card 23912ca4: a zero/unconfigured fxUsdHuf must never fabricate a 0 HUF
    // line -- that would read as "OpenAI cost this month: nothing", which is
    // false; the real cost is unknown-in-HUF, not zero. No line at all until a
    // real rate exists (idempotent dedup_key means a later re-run with a real
    // rate fills this in). Guarded here too, not only in the caller, so a
    // future direct caller of this pure mapper cannot bypass the check.
    if (!(opts.fxUsdHuf > 0))
        return [];
    const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7);
    const amountHuf = Math.round(usdTotal * opts.fxUsdHuf * 100) / 100;
    return [{
            provider: 'openai',
            service: OPENAI_API_SOURCE,
            billing_period_start: opts.periodStart,
            billing_period_end: opts.periodEnd,
            amount: amountHuf,
            currency: 'HUF',
            confidence: 'provider_api',
            usage_type: 'api_usage',
            quantity: null,
            unit: null,
            data_freshness_at: opts.now,
            raw_ref_hash: hashRef(opts.idSalt, `openai-costs|${monthKey}`),
            dedup_key: `provider|openai|${OPENAI_API_SOURCE}|${monthKey}|provider_api`,
        }];
}
export const openaiCollector = {
    provider: 'openai',
    collectorName: 'openai-costs',
    async collectRaw(opts) {
        // OpenAI Costs API takes unix start_time; daily buckets; limit covers a month.
        const url = `${OPENAI_COSTS_URL}?start_time=${opts.periodStart}&end_time=${opts.periodEnd}&bucket_width=1d&limit=31`;
        // secret used ONLY as the auth header; never logged.
        const headers = {
            'authorization': `Bearer ${opts.secret}`,
            'content-type': 'application/json',
        };
        const raw = await opts.httpGetJson(url, headers);
        const lines = mapOpenAiCosts(raw, {
            periodStart: opts.periodStart, periodEnd: opts.periodEnd,
            fxUsdHuf: opts.fxUsdHuf, idSalt: opts.idSalt, now: opts.now,
        });
        return { raw, lines };
    },
    async collect(opts) {
        return (await this.collectRaw(opts)).lines;
    },
};
/** Vault secret id for the OpenAI admin (read-only) key. */
export const OPENAI_VAULT_SECRET_ID = 'open_api_adminkey_readonly';
/**
 * LIVE read-only sync: pulls the admin key from the Vault (never logged), calls
 * the Costs API for the current month, and records a provider_api line + an
 * import_runs row. No provider-side write. Injected deps let tests stub both the
 * key and the fetcher.
 */
export async function syncOpenAiCollector(db, now, deps = {}) {
    const { runCollector } = await import('./runner.js');
    const { monthWindow } = await import('../ledger.js');
    let apiKey = deps.apiKey;
    if (apiKey === undefined) {
        try {
            const { getSecret } = await import('../../web/vault.js');
            apiKey = getSecret(OPENAI_VAULT_SECRET_ID);
        }
        catch {
            apiKey = null;
        }
    }
    if (!apiKey) {
        return { ok: false, provider: 'openai', status: 'error', imported_count: 0, error: `no OpenAI key in vault (${OPENAI_VAULT_SECRET_ID})` };
    }
    let fxUsdHuf = deps.fxUsdHuf;
    if (fxUsdHuf === undefined) {
        try {
            const { loadFxRates } = await import('../fx-config.js');
            fxUsdHuf = loadFxRates().rates.USD ?? 0;
        }
        catch {
            fxUsdHuf = 0;
        }
    }
    // Card 23912ca4: fail fast with an explicit blocker instead of silently
    // storing a fabricated 0 HUF line (the mapper also guards this on its own,
    // but the point of failing HERE is the actionable error message).
    if (!(fxUsdHuf > 0)) {
        return {
            ok: false, provider: 'openai', status: 'error', imported_count: 0,
            error: 'USD->HUF rate is not configured (store/costops-fx.json) -- costs were NOT converted or stored; set the rate and re-run',
        };
    }
    const httpGetJson = deps.httpGetJson || (async (url, headers) => {
        const r = await fetch(url, { method: 'GET', headers });
        if (!r.ok)
            throw new Error(`openai api ${r.status}`);
        return r.json();
    });
    const w = monthWindow(now);
    const opts = { periodStart: w.start, periodEnd: w.end, secret: apiKey, fxUsdHuf, idSalt: 'openai-salt', httpGetJson, now };
    const res = await runCollector({ db, collector: openaiCollector, opts, now });
    return {
        ok: res.status === 'ok', provider: 'openai', status: res.status,
        imported_count: res.importedCount, error: res.errorMessageSanitized || undefined, period: w.key,
    };
}
