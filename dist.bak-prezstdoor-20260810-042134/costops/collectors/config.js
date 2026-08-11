// CostOps v0.3 -- local collectors config loader.
//
// store/costops-collectors.json is gitignored/local. It holds ONLY non-secret
// wiring: enable flags, a `secret_ref` pointing at a Vault id (NOT the value),
// an optional account_ref_hash (never a raw account id), and the FX rate.
// NO API key, account id, or invoice ref ever lives here or is logged.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../config.js';
import { logger } from '../../logger.js';
export const COLLECTORS_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-collectors.json');
const EMPTY = { version: 1, fx_usd_huf: 0, collectors: [] };
export function loadCollectorsConfig() {
    if (!existsSync(COLLECTORS_CONFIG_PATH)) {
        return { config: { ...EMPTY }, exists: false, errors: [] };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(COLLECTORS_CONFIG_PATH, 'utf-8'));
    }
    catch (err) {
        logger.warn({ err }, 'costops-collectors.json is not valid JSON');
        return { config: { ...EMPTY }, exists: true, errors: ['collectors config is not valid JSON'] };
    }
    return validateCollectorsConfig(raw);
}
export function validateCollectorsConfig(raw) {
    const errors = [];
    const obj = (raw && typeof raw === 'object') ? raw : {};
    const fx = typeof obj.fx_usd_huf === 'number' && isFinite(obj.fx_usd_huf) && obj.fx_usd_huf >= 0 ? obj.fx_usd_huf : 0;
    const collectors = [];
    for (const [i, e] of (Array.isArray(obj.collectors) ? obj.collectors : []).entries()) {
        const c = e;
        if (typeof c?.provider !== 'string' || !c.provider) {
            errors.push(`collectors[${i}]: missing provider`);
            continue;
        }
        // A raw key would look like 'sk-...'; a secret_ref must be a 'vault:' reference.
        const ref = typeof c.secret_ref === 'string' ? c.secret_ref : '';
        if (ref && !ref.startsWith('vault:')) {
            errors.push(`collectors[${i}] (${c.provider}): secret_ref must be a 'vault:<id>' reference, not a raw value`);
            continue;
        }
        collectors.push({
            provider: c.provider,
            enabled: c.enabled === true,
            secret_ref: ref,
            account_ref_hash: typeof c.account_ref_hash === 'string' ? c.account_ref_hash : null,
        });
    }
    return { config: { version: typeof obj.version === 'number' ? obj.version : 1, fx_usd_huf: fx, collectors }, exists: true, errors };
}
