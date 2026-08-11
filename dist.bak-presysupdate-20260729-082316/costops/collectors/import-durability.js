// CostOps Phase 1 (GAP-07) -- collector durability primitives shared by every
// provider collector via the common runner.ts entry point (runCollector),
// so a single change here benefits openai/github/deepseek/render at once
// instead of retrofitting each collector individually.
//
// Two independent concerns:
// 1. Per-provider import lock: prevents two concurrent syncs of the SAME
//    provider from racing each other's upserts (e.g. a manual "sync now"
//    click while the scheduled sync is already running). A stale lock (the
//    holder crashed mid-run and never released it) is reclaimed after
//    `staleAfterSecs` -- otherwise a crash would permanently wedge that
//    provider's sync. `now`/`locked_at` are epoch SECONDS, matching every
//    other `now` in this codebase (Math.floor(Date.now()/1000)) -- NOT ms.
// 2. Retry/backoff for a transient error (network blip, rate limit) --
//    generic, injectable sleep so it's unit-testable without real delays.
export function buildDbImportLockContext(db) {
    return {
        tryAcquireLock(provider, token, now, staleAfterSecs) {
            const existing = db.prepare(`SELECT locked_at, lock_token FROM import_locks WHERE provider = ?`).get(provider);
            if (!existing) {
                db.prepare(`INSERT INTO import_locks (provider, locked_at, lock_token) VALUES (?, ?, ?)`).run(provider, now, token);
                return 'acquired';
            }
            const isStale = now - existing.locked_at > staleAfterSecs;
            if (!isStale)
                return 'held';
            // Reclaim: only if it still matches what we just read (guards a race
            // between two reclaimers -- whichever UPDATE actually matches wins).
            const res = db.prepare(`UPDATE import_locks SET locked_at = ?, lock_token = ? WHERE provider = ? AND lock_token = ?`)
                .run(now, token, provider, existing.lock_token);
            return res.changes > 0 ? 'acquired' : 'held';
        },
        releaseLock(provider, token) {
            db.prepare(`DELETE FROM import_locks WHERE provider = ? AND lock_token = ?`).run(provider, token);
        },
    };
}
/**
 * Run `fn` only if the per-provider lock is acquired; otherwise returns
 * `{ ok: false, reason: 'locked' }` without calling `fn` at all -- the caller
 * (runCollector) records this as an ImportStatus of 'locked', touching no
 * data. Always releases the lock afterward, success or failure, via
 * try/finally.
 */
export async function withImportLock(ctx, provider, now, fn, opts = {}) {
    const staleAfterSecs = opts.staleAfterSecs ?? 10 * 60;
    const token = `${now}-${Math.random().toString(36).slice(2)}`;
    if (ctx.tryAcquireLock(provider, token, now, staleAfterSecs) === 'held') {
        return { ok: false, reason: 'locked' };
    }
    try {
        const result = await fn();
        return { ok: true, result };
    }
    finally {
        ctx.releaseLock(provider, token);
    }
}
const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Retry `fn` with exponential backoff (baseDelayMs * 2^attempt) up to
 * maxAttempts total tries. Re-throws the LAST error if every attempt fails
 * and it was retryable; re-throws IMMEDIATELY (no further attempts) the
 * moment `isRetryable` says an error is permanent.
 */
export async function withRetry(fn, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    const sleep = opts.sleep ?? defaultSleep;
    const isRetryable = opts.isRetryable ?? (() => true);
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === maxAttempts - 1)
                throw err;
            await sleep(baseDelayMs * Math.pow(2, attempt));
        }
    }
    throw lastErr;
}
