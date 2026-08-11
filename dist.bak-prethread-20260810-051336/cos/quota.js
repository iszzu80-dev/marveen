// Personal Chief of Staff (COS) — atomic send quota (P0.4).
//
// A rolling-window rate limit per quota key. reserveQuota() is the whole point:
// it checks-and-increments in ONE transaction, so two concurrent workers can
// never both reserve the last slot (the spec's "kvóta atomikus lefoglalása egy
// tranzakcióban"). The dispatch/executor reserves a slot before an outbound
// action; if the reservation fails, the action is not sent. The window resets
// lazily on the first reservation after it expires. Pure DB logic.
/**
 * Atomically reserve one slot from `quotaKey`'s window (max `maxCount` per
 * `windowSec`). Returns reserved=false without incrementing if the window is
 * full. The whole read-reset-check-increment runs in a single transaction, so
 * concurrent callers are serialized and the limit is never exceeded.
 */
export function reserveQuota(db, quotaKey, maxCount, windowSec, now) {
    const tx = db.transaction(() => {
        const row = db.prepare(`SELECT window_start, window_sec, max_count, used_count FROM send_quotas WHERE quota_key = ?`).get(quotaKey);
        // No row, or the window has rolled over → start a fresh window at count 1.
        if (!row || now >= row.window_start + row.window_sec) {
            if (maxCount < 1)
                return { reserved: false, remaining: 0, windowStart: now };
            db.prepare(`INSERT INTO send_quotas (quota_key, window_start, window_sec, max_count, used_count, updated_at)
         VALUES (@key, @now, @windowSec, @max, 1, @now)
         ON CONFLICT(quota_key) DO UPDATE SET window_start=@now, window_sec=@windowSec, max_count=@max, used_count=1, updated_at=@now`).run({ key: quotaKey, now, windowSec, max: maxCount });
            return { reserved: true, remaining: maxCount - 1, windowStart: now };
        }
        // Within the current window.
        if (row.used_count >= row.max_count) {
            return { reserved: false, remaining: 0, windowStart: row.window_start };
        }
        db.prepare(`UPDATE send_quotas SET used_count = used_count + 1, updated_at = @now WHERE quota_key = @key`).run({ key: quotaKey, now });
        return { reserved: true, remaining: row.max_count - row.used_count - 1, windowStart: row.window_start };
    });
    return tx();
}
/** Refund one slot (e.g. a reserved send that then proved a no-op). Never goes
 *  below zero and only within the same window. */
export function releaseQuota(db, quotaKey, now) {
    const row = db.prepare(`SELECT window_start, window_sec, used_count FROM send_quotas WHERE quota_key = ?`).get(quotaKey);
    if (!row || now >= row.window_start + row.window_sec || row.used_count <= 0)
        return;
    db.prepare(`UPDATE send_quotas SET used_count = used_count - 1, updated_at = @now WHERE quota_key = @key`).run({ key: quotaKey, now });
}
export function quotaUsage(db, quotaKey) {
    const row = db.prepare(`SELECT used_count, max_count FROM send_quotas WHERE quota_key = ?`).get(quotaKey);
    return row ? { used: row.used_count, max: row.max_count } : undefined;
}
