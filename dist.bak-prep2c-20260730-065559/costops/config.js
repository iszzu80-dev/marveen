// CostOps v0.1 -- local cost config loader.
//
// The operator's fixed/manual monthly costs (Claude Max, ChatGPT, hosting,
// domain, SaaS, ...) and budgets live in store/costops-config.json. That path
// is under the gitignored store/ tree, so real amounts / account references
// NEVER enter a tracked file. A safe placeholder skeleton is generated as
// store/costops-config.json.example on first load if no config exists.
//
// This module is pure I/O + validation. No secrets, no network, no LLM.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
export const COSTOPS_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-config.json');
export const COSTOPS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-config.json.example');
const EMPTY_CONFIG = {
    version: 1,
    currency: 'HUF',
    fixed_costs: [],
    budgets: [],
};
// Safe skeleton with placeholder (zero) values -- contains no real amounts,
// account IDs or secrets, so it is safe to keep as a tracked example too.
const EXAMPLE_CONFIG = {
    version: 1,
    currency: 'HUF',
    _doc: 'CostOps v0.1 local config. Copy to store/costops-config.json and fill in real values. Amounts are per month. No secrets/API keys here -- put those in the Vault.',
    fixed_costs: [
        { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 0, period: 'monthly', charge_category: 'subscription', confidence: 'manual' },
        { source_id: 'openai-chatgpt', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 0, period: 'monthly', confidence: 'manual' },
        { source_id: 'github', name: 'GitHub', provider: 'github', source_type: 'saas', amount: 0, period: 'monthly', confidence: 'manual' },
        { source_id: 'hosting', name: 'Hosting', provider: 'other', source_type: 'hosting', amount: 0, period: 'monthly', confidence: 'manual' },
        { source_id: 'domain', name: 'Domain', provider: 'other', source_type: 'domain', amount: 0, period: 'monthly', confidence: 'manual' },
    ],
    budgets: [
        { id: 'global-monthly', name: 'Global monthly', scope: 'global', amount: 0, warning_threshold: 0.8, hard_threshold: 1.0 },
    ],
};
/**
 * Load and validate the local CostOps config. Never throws: a missing or
 * malformed config yields an empty (but valid) config plus a list of errors,
 * so the read-only summary endpoint degrades gracefully instead of 500ing.
 * On a missing config, writes the placeholder example alongside for guidance.
 */
export function loadCostopsConfig() {
    if (!existsSync(COSTOPS_CONFIG_PATH)) {
        ensureExampleConfig();
        return { config: { ...EMPTY_CONFIG }, exists: false, errors: [] };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(COSTOPS_CONFIG_PATH, 'utf-8'));
    }
    catch (err) {
        logger.warn({ err }, 'costops-config.json is not valid JSON');
        return { config: { ...EMPTY_CONFIG }, exists: true, errors: ['config is not valid JSON'] };
    }
    return validateConfig(raw);
}
export function ensureExampleConfig() {
    try {
        if (!existsSync(COSTOPS_EXAMPLE_PATH)) {
            writeFileSync(COSTOPS_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8');
        }
    }
    catch (err) {
        logger.warn({ err }, 'Failed to write costops-config example');
    }
}
/**
 * Persist the config back to store/costops-config.json. Phase 3 (GAP-11):
 * the only write path today is budgets.ts's upsertBudget/deleteBudget --
 * fixed_costs remain manual-edit-only (no API mutates them). Whole-file
 * rewrite, not a partial patch -- config.ts's own load path already
 * round-trips the full object, so this stays consistent with it.
 */
export function saveCostopsConfig(config) {
    writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
/**
 * Pure validation of a parsed config object. Exported for unit tests.
 * Drops invalid entries (with an error note) rather than failing the whole load.
 */
export function validateConfig(raw) {
    const errors = [];
    const obj = (raw && typeof raw === 'object') ? raw : {};
    const currency = typeof obj.currency === 'string' ? obj.currency : 'HUF';
    const fixed_costs = [];
    const rawFixed = Array.isArray(obj.fixed_costs) ? obj.fixed_costs : [];
    for (const [i, e] of rawFixed.entries()) {
        const c = e;
        if (typeof c?.source_id !== 'string' || !c.source_id) {
            errors.push(`fixed_costs[${i}]: missing source_id`);
            continue;
        }
        if (typeof c?.amount !== 'number' || !isFinite(c.amount) || c.amount < 0) {
            errors.push(`fixed_costs[${i}] (${c.source_id}): amount must be a non-negative number`);
            continue;
        }
        if (c.period !== undefined && c.period !== 'monthly') {
            errors.push(`fixed_costs[${i}] (${c.source_id}): only period 'monthly' is supported in v0.1`);
            continue;
        }
        fixed_costs.push({
            source_id: c.source_id,
            name: typeof c.name === 'string' ? c.name : c.source_id,
            provider: typeof c.provider === 'string' ? c.provider : 'other',
            source_type: typeof c.source_type === 'string' ? c.source_type : 'manual',
            amount: c.amount,
            period: 'monthly',
            charge_category: (typeof c.charge_category === 'string' ? c.charge_category : 'subscription'),
            confidence: (typeof c.confidence === 'string' ? c.confidence : 'manual'),
            currency: typeof c.currency === 'string' ? c.currency : currency,
            notes: typeof c.notes === 'string' ? c.notes : undefined,
            owner: typeof c.owner === 'string' ? c.owner : undefined,
            lifecycle_override: (c.lifecycle_override === 'unsupported' || c.lifecycle_override === 'deprecated') ? c.lifecycle_override : undefined,
        });
    }
    const budgets = [];
    const rawBudgets = Array.isArray(obj.budgets) ? obj.budgets : [];
    for (const [i, e] of rawBudgets.entries()) {
        const b = e;
        if (typeof b?.id !== 'string' || !b.id) {
            errors.push(`budgets[${i}]: missing id`);
            continue;
        }
        if (typeof b?.amount !== 'number' || !isFinite(b.amount) || b.amount < 0) {
            errors.push(`budgets[${i}] (${b.id}): amount must be a non-negative number`);
            continue;
        }
        budgets.push({
            id: b.id,
            name: typeof b.name === 'string' ? b.name : b.id,
            scope: (typeof b.scope === 'string' ? b.scope : 'global'),
            scope_ref: typeof b.scope_ref === 'string' ? b.scope_ref : undefined,
            amount: b.amount,
            currency: typeof b.currency === 'string' ? b.currency : currency,
            warning_threshold: typeof b.warning_threshold === 'number' ? b.warning_threshold : 0.8,
            hard_threshold: typeof b.hard_threshold === 'number' ? b.hard_threshold : 1.0,
            owner: typeof b.owner === 'string' ? b.owner : undefined,
            notes: typeof b.notes === 'string' ? b.notes : undefined,
        });
    }
    return {
        config: { version: typeof obj.version === 'number' ? obj.version : 1, currency, fixed_costs, budgets },
        exists: true,
        errors,
    };
}
