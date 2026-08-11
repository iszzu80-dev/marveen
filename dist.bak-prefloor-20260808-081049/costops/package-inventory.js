// CostOps Phase 4 -- package inventory.
//
// The recommendation engine's INPUT: one entry per priced package/plan/subscription
// the fleet actually holds or is comparing against. Loaded from
// store/costops-package-inventory.json (gitignored, same convention as
// costops-subscriptions.json -- real accounts/prices/quotas never enter a tracked
// file). This module is pure I/O + validation. No Gmail access, no secrets, no
// network, no LLM.
//
// THE RULE THAT SHAPES EVERY FIELD, same rule Phase 2 established for capacity
// figures and this phase must not weaken: every priced/quantified fact is a
// ProvenancedNumber carrying its own value, currency, provenance and as_of date.
// A number with no provenance is worse than a gap -- a gap prompts a question,
// a bare number ends one. `value: null` (never 0-fabricated) with a provenance
// is how "not published" and "not yet entered" both read honestly.
//
// external_market_reference entries (comparison-only) are structurally distinct
// from held entries: `enabled_for_routing` is ALWAYS false for them by
// construction (see validateEntry) -- a Phase 4 recommendation may NAME a
// cheaper external provider, but this schema cannot represent "enabled" for one
// without a separate, explicit owner GO landing in a different config.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
export const PACKAGE_INVENTORY_PATH = join(PROJECT_ROOT, 'store', 'costops-package-inventory.json');
export const PACKAGE_INVENTORY_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-package-inventory.json.example');
const EMPTY = { version: 1, packages: [] };
const EXAMPLE_CONFIG = {
    version: 1,
    _doc: 'CostOps Phase 4 package inventory. Copy to store/costops-package-inventory.json. Every priced/quantified fact is a ProvenancedNumber -- value is null (never 0) when not published/not entered, and provenance+as_of travel with it. kind:held is a package the fleet actually pays for; kind:external_market_reference is comparison-only and enabled_for_routing is structurally always false for it. subscription_id cross-references costops-subscriptions.json for a held package that also has a lifecycle fact there (renewal/cancellation).',
    packages: [
        {
            id: 'anthropic-max-5x', kind: 'held', provider: 'anthropic', name: 'Claude Max 5x',
            subscription_id: 'anthropic-max',
            price: { value: 90.00, currency: 'EUR', provenance: 'invoice', as_of: '2026-07-01', source_note: 'company mailbox invoice' },
            contract_granularity: 'monthly', renewal_date: '2026-08-01',
            quota_shape: 'session_and_weekly_pct', quota_limit: null,
            overage_available: false, overage_rate: null, usage_credit_available: false,
            enabled_for_routing: true,
        },
        {
            id: 'openai-chatgpt-plus', kind: 'held', provider: 'openai', name: 'ChatGPT Plus',
            subscription_id: 'openai-chatgpt',
            price: { value: null, currency: null, provenance: 'not_published', as_of: null, source_note: 'no invoice located yet' },
            contract_granularity: 'monthly', renewal_date: null,
            quota_shape: 'unknown', quota_limit: null,
            overage_available: null, overage_rate: null, usage_credit_available: null,
            enabled_for_routing: true,
        },
        {
            id: 'gemini-advanced-market-ref', kind: 'external_market_reference', provider: 'google', name: 'Gemini Advanced',
            price: { value: 21.99, currency: 'USD', provenance: 'aggregator', as_of: '2026-07-30', source_note: 'aggregator-derived, see phase4-market-snapshot-2026-07-30.md -- not vendor-confirmed' },
            contract_granularity: 'monthly', renewal_date: null,
            quota_shape: 'unknown', quota_limit: null,
            overage_available: null, overage_rate: null, usage_credit_available: null,
            enabled_for_routing: false,
        },
    ],
};
export function loadPackageInventoryConfig() {
    if (!existsSync(PACKAGE_INVENTORY_PATH)) {
        ensureExamplePackageInventory();
        return { config: { ...EMPTY }, exists: false, errors: [] };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(PACKAGE_INVENTORY_PATH, 'utf-8'));
    }
    catch (err) {
        logger.warn({ err }, 'costops-package-inventory.json is not valid JSON');
        return { config: { ...EMPTY }, exists: true, errors: ['config is not valid JSON'] };
    }
    return validatePackageInventoryConfig(raw);
}
export function ensureExamplePackageInventory() {
    try {
        if (!existsSync(PACKAGE_INVENTORY_EXAMPLE_PATH)) {
            writeFileSync(PACKAGE_INVENTORY_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8');
        }
    }
    catch (err) {
        logger.warn({ err }, 'Failed to write costops-package-inventory example');
    }
}
const VALID_KIND = new Set(['held', 'external_market_reference']);
const VALID_PROVENANCE = new Set(['invoice', 'manual', 'aggregator', 'not_published']);
const VALID_GRANULARITY = new Set(['monthly', 'annual', 'usage_based', 'one_time', 'unknown']);
const VALID_QUOTA_SHAPE = new Set(['unlimited', 'session_and_weekly_pct', 'token_ceiling', 'seat_count', 'usage_metered', 'unknown']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `currencyRequired`: true for money amounts (price, overage_rate); false for
 *  dimensionless counts (quota_limit -- a token ceiling or seat count has no
 *  currency, per the schema's own doc comment on ProvenancedNumber). Getting
 *  this wrong in either direction is a real bug: requiring currency on a
 *  token count would reject every legitimate quota_limit; not requiring it
 *  on a price would let a bare unitless number pass as money. */
function validateProvenancedNumber(raw, path, errors, currencyRequired) {
    if (raw === null || raw === undefined)
        return null;
    const p = raw;
    const provenance = VALID_PROVENANCE.has(p?.provenance) ? p.provenance : 'not_published';
    let value = null;
    if (p.value !== null && p.value !== undefined) {
        if (typeof p.value !== 'number' || !isFinite(p.value) || p.value < 0) {
            errors.push(`${path}: value must be a non-negative number or null`);
        }
        else {
            value = p.value;
        }
    }
    if (currencyRequired && value !== null && (typeof p.currency !== 'string' || !p.currency)) {
        errors.push(`${path}: currency is required when value is present`);
    }
    if (p.as_of !== null && p.as_of !== undefined && !ISO_DATE.test(p.as_of)) {
        errors.push(`${path}: as_of must be YYYY-MM-DD or null`);
    }
    return {
        value,
        currency: (value !== null && typeof p.currency === 'string' && p.currency) ? p.currency : null,
        provenance,
        as_of: (typeof p.as_of === 'string' && ISO_DATE.test(p.as_of)) ? p.as_of : null,
        source_note: typeof p.source_note === 'string' ? p.source_note : null,
    };
}
/** Every entry passes through here -- this is the ONE place enabled_for_routing
 *  is decided, so an external_market_reference can never accidentally be
 *  entered as enabled: true (structural, not a review checklist). */
function validateEntry(raw, i, errors) {
    if (typeof raw?.id !== 'string' || !raw.id) {
        errors.push(`packages[${i}]: missing id`);
        return null;
    }
    if (typeof raw?.name !== 'string' || !raw.name) {
        errors.push(`packages[${i}] (${raw.id}): missing name`);
        return null;
    }
    if (typeof raw?.provider !== 'string' || !raw.provider) {
        errors.push(`packages[${i}] (${raw.id}): missing provider`);
        return null;
    }
    const kind = VALID_KIND.has(raw.kind) ? raw.kind : 'held';
    if (raw.renewal_date !== null && raw.renewal_date !== undefined && !ISO_DATE.test(raw.renewal_date)) {
        errors.push(`packages[${i}] (${raw.id}): renewal_date must be YYYY-MM-DD or null`);
        return null;
    }
    // price is REQUIRED: malformed-but-present is worse than absent (same convention
    // as subscriptions.ts's `amount` -- a bad value rejects the whole entry rather
    // than silently nulling just the price and keeping a package whose price field
    // looked fine but wasn't).
    const priceErrorsBefore = errors.length;
    const price = validateProvenancedNumber(raw.price, `packages[${i}] (${raw.id}).price`, errors, true);
    if (!price) {
        errors.push(`packages[${i}] (${raw.id}): missing price`);
        return null;
    }
    if (errors.length > priceErrorsBefore)
        return null;
    // quota_limit is dimensionless (token ceiling / seat count) -- no currency required.
    const quota_limit = validateProvenancedNumber(raw.quota_limit ?? null, `packages[${i}] (${raw.id}).quota_limit`, errors, false);
    const overage_rate = validateProvenancedNumber(raw.overage_rate ?? null, `packages[${i}] (${raw.id}).overage_rate`, errors, true);
    return {
        id: raw.id, kind, provider: raw.provider, name: raw.name,
        subscription_id: typeof raw.subscription_id === 'string' ? raw.subscription_id : undefined,
        price,
        contract_granularity: VALID_GRANULARITY.has(raw.contract_granularity) ? raw.contract_granularity : 'unknown',
        renewal_date: (typeof raw.renewal_date === 'string' && ISO_DATE.test(raw.renewal_date)) ? raw.renewal_date : null,
        quota_shape: VALID_QUOTA_SHAPE.has(raw.quota_shape) ? raw.quota_shape : 'unknown',
        quota_limit,
        overage_available: typeof raw.overage_available === 'boolean' ? raw.overage_available : null,
        overage_rate,
        usage_credit_available: typeof raw.usage_credit_available === 'boolean' ? raw.usage_credit_available : null,
        // STRUCTURAL: kind==='external_market_reference' forces false regardless of what the
        // config file says. This is the one line that makes "a market comparison cannot imply
        // enabling a new provider" true by construction, not by convention.
        enabled_for_routing: kind === 'external_market_reference' ? false : (raw.enabled_for_routing === true),
        notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    };
}
export function validatePackageInventoryConfig(raw) {
    const errors = [];
    const obj = (raw && typeof raw === 'object') ? raw : {};
    const rawPackages = Array.isArray(obj.packages) ? obj.packages : [];
    const packages = [];
    for (const [i, e] of rawPackages.entries()) {
        const entry = validateEntry(e, i, errors);
        if (entry)
            packages.push(entry);
    }
    return { config: { version: 1, packages }, exists: true, errors };
}
