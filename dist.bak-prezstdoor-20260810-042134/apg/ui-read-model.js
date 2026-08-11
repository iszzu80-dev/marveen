import { statSync } from 'node:fs';
import { buildApgUiSummary, resolveApgKernelDbPath, } from './ui-projection.js';
const CACHE_TTL_MS = 10_000;
let summaryCache = null;
function readDbMtimeMs() {
    try {
        return statSync(resolveApgKernelDbPath()).mtimeMs;
    }
    catch {
        return null;
    }
}
export function getCachedApgSummary(mode) {
    const nowMs = Date.now();
    if (summaryCache
        && summaryCache.mode === mode
        && nowMs - summaryCache.builtAtMs < CACHE_TTL_MS) {
        // A missing sidecar is cached for the TTL instead of causing a failed stat
        // loop on every dashboard request.
        if (summaryCache.dbMtimeMs === null)
            return summaryCache.value;
        const currentMtimeMs = readDbMtimeMs();
        if (currentMtimeMs === summaryCache.dbMtimeMs)
            return summaryCache.value;
    }
    const nowIso = new Date(nowMs).toISOString();
    const dbMtimeMs = readDbMtimeMs();
    const value = buildApgUiSummary(nowIso, mode);
    summaryCache = {
        mode,
        value,
        builtAtMs: nowMs,
        dbMtimeMs,
    };
    return value;
}
export function invalidateApgCache() {
    summaryCache = null;
}
export { buildApgWorkItemSummaries, buildApgWorkItemDetail, buildApgEvents, } from './ui-projection.js';
