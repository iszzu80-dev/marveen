import { CronExpressionParser } from 'cron-parser';
import { APP_TZ } from '../config.js';
export function resolveCronTz(env = process.env) {
    if (env.SCHEDULER_TZ)
        return { tz: env.SCHEDULER_TZ, source: 'SCHEDULER_TZ' };
    if (env.TZ)
        return { tz: env.TZ, source: 'TZ' };
    return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, source: 'system-default' };
}
// The effective zone is config.APP_TZ (SCHEDULER_TZ via config-overrides.json >
// .env > host zone), so a dashboard-set zone is honored and cron/display never
// diverge; resolveCronTz() above stays as the startup source-reporter (see
// startScheduleRunner) so the operator sees which layer won.
const CRON_TZ = APP_TZ;
export function computeNextRun(cronExpression, tz = CRON_TZ) {
    const expr = CronExpressionParser.parse(cronExpression, { tz });
    return Math.floor(expr.next().getTime() / 1000);
}
// Accept 5-field (standard) and 6-field (with seconds) cron expressions;
// cron-parser supports both. Anything else -- oversized strings, random
// punctuation, empty fields -- gets rejected at the API boundary instead
// of reaching the parser deep inside the scheduler loop.
export const CRON_SHAPE_RX = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/;
export function isValidCronShape(cron) {
    if (typeof cron !== 'string')
        return false;
    const trimmed = cron.trim();
    if (!trimmed || trimmed.length > 100)
        return false;
    if (!CRON_SHAPE_RX.test(trimmed))
        return false;
    try {
        const expr = CronExpressionParser.parse(trimmed, { tz: CRON_TZ });
        expr.next();
        return true;
    }
    catch {
        return false;
    }
}
// True if a scheduled occurrence of `cron` falls in the half-open window
// (fromMs, toMs]. Driven by the ACTUAL elapsed time between scheduler ticks
// rather than a fixed 60s window: Node timers only ever fire late (never
// early), so a fixed-width window equal to the nominal tick interval drifts
// until a sparse cron's single occurrence lands in a gap no tick's window
// covers -- silently missed for the day, while a "*/15" cron with 96 daily
// occurrences survives (the 2026-07-13..15 outage). Feeding the real
// (previous-tick, now] interval makes the windows contiguous and
// non-overlapping: every occurrence is covered by exactly one tick, so even a
// multi-minute tick gap cannot swallow a daily task. prev() returns only the
// most recent occurrence, so a long outage yields at most one catch-up fire,
// never a burst.
export function cronDueBetween(cron, fromMs, toMs, tz = CRON_TZ) {
    try {
        // `toMs + 1`: cron-parser's prev() returns the last occurrence STRICTLY
        // before currentDate, so an occurrence landing exactly on the tick boundary
        // (O === toMs) would be excluded here AND excluded next tick (O === fromMs,
        // the `> fromMs` is strict) -- a rare "silently lost" occurrence. Nudging
        // currentDate one ms past toMs makes the window a true half-open (fromMs,
        // toMs], so a boundary occurrence fires exactly once, never twice.
        const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) });
        return expr.prev().getTime() > fromMs;
    }
    catch {
        return false;
    }
}
// Back-compat shim faithful to the old fixed-window semantics -- "did an
// occurrence happen in the last catchUpMs". Kept for callers/tests that ask
// the question that way; the scheduler loop itself uses cronDueBetween with
// the real inter-tick interval.
export function cronMatchesNow(cron, catchUpMs = 60000, tz = CRON_TZ) {
    const now = Date.now();
    return cronDueBetween(cron, now - catchUpMs, now, tz);
}
