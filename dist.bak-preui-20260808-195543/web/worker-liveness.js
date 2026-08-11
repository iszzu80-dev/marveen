import { logger } from '../logger.js';
import { capturePane } from './agent-process.js';
import { workerContexts, isWorkerSessionAlive } from './agent-worker.js';
export const NO_WORKER_LIVENESS_STATE = {
    firstSeenAtMs: null,
    lastSeenAliveAtMs: null,
    lastPane: null,
    firstSeenOnFirstSweep: false,
};
/** Keep the death log bounded: the tail is where a crash message would be. */
export const DEATH_PANE_LINES = 15;
export function tailLines(pane, n = DEATH_PANE_LINES) {
    if (pane == null)
        return null;
    const lines = pane.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0)
        return null;
    return lines.slice(-n).join('\n');
}
/**
 * Pure liveness decision. Logs a death exactly once, on the transition from
 * "seen alive" to "absent", and then resets -- so a worker that stays gone does
 * not re-log on every poll, and a later restart starts a fresh lifetime.
 *
 * A session we have NEVER seen alive is not a death: that is the WEB_ONLY case,
 * a poll that raced the boot pre-start, or a host where the worker never
 * started at all. Reporting those as deaths would make the signal useless.
 */
export function decideWorkerLiveness(obs, prev) {
    if (obs.alive) {
        const isNewSighting = prev.firstSeenAtMs == null;
        return {
            logDeath: false,
            lifetimeMs: null,
            lastPane: null,
            lifetimeTruncated: false,
            next: {
                firstSeenAtMs: prev.firstSeenAtMs ?? obs.nowMs,
                lastSeenAliveAtMs: obs.nowMs,
                firstSeenOnFirstSweep: isNewSighting ? obs.isFirstSweep : prev.firstSeenOnFirstSweep,
                // Keep the previous snapshot when this capture failed, so a transient
                // capture error does not blank the only evidence we will have.
                lastPane: obs.pane ?? prev.lastPane,
            },
        };
    }
    // Absent, and we never saw it alive: nothing happened worth reporting.
    if (prev.lastSeenAliveAtMs == null) {
        return { logDeath: false, lifetimeMs: null, lastPane: null, lifetimeTruncated: false, next: NO_WORKER_LIVENESS_STATE };
    }
    // Absent after having been alive: the one transition worth a log line.
    const lifetimeMs = prev.firstSeenAtMs != null ? prev.lastSeenAliveAtMs - prev.firstSeenAtMs : null;
    return {
        logDeath: true,
        lifetimeMs,
        lastPane: tailLines(prev.lastPane),
        lifetimeTruncated: prev.firstSeenOnFirstSweep,
        next: NO_WORKER_LIVENESS_STATE,
    };
}
export function sweepWorkerLiveness(deps, states, isFirstSweep = false) {
    for (const { session } of deps.sessions()) {
        const alive = deps.isAlive(session);
        const decision = decideWorkerLiveness({ alive, pane: alive ? deps.capture(session) : null, nowMs: deps.now(), isFirstSweep }, states.get(session) ?? NO_WORKER_LIVENESS_STATE);
        states.set(session, decision.next);
        if (decision.logDeath) {
            deps.onDeath({
                session,
                lifetimeMs: decision.lifetimeMs,
                lastPane: decision.lastPane,
                lifetimeTruncated: decision.lifetimeTruncated,
            });
        }
    }
}
/** Poll cadence: fine enough to bracket a death, cheap enough to ignore. */
export const LIVENESS_POLL_MS = 60_000;
/**
 * Wire the sweep to tmux and the logger. Returns the interval handle so the
 * caller can clear it, matching the other monitors in this codebase.
 */
export function startWorkerLivenessMonitor() {
    const states = new Map();
    const deps = {
        sessions: () => workerContexts().map((c) => ({ session: c.session })),
        isAlive: (session) => isWorkerSessionAlive(session),
        capture: (session) => capturePane(session),
        now: () => Date.now(),
        onDeath: ({ session, lifetimeMs, lastPane, lifetimeTruncated }) => {
            logger.warn({
                session,
                lifetimeMs,
                lifetimeMin: lifetimeMs == null ? null : Math.round(lifetimeMs / 60_000),
                // The session predated this monitor process, so the figure above is a
                // LOWER BOUND. Said out loud rather than estimated: a truncated
                // lifetime reads like a fast death and would point at the launch line.
                lifetimeTruncated,
                lastPane,
            }, lifetimeTruncated
                ? 'worker-liveness: worker session disappeared (lifetime is a LOWER BOUND: the session predated this monitor, e.g. a dashboard restart)'
                : 'worker-liveness: worker session disappeared (it was started, then died -- nothing restarts it until the next request)');
        },
    };
    let first = true;
    const tick = () => {
        try {
            sweepWorkerLiveness(deps, states, first);
        }
        catch (err) {
            logger.warn({ err }, 'worker-liveness: sweep failed (continuing)');
        }
        finally {
            first = false;
        }
    };
    return setInterval(tick, LIVENESS_POLL_MS);
}
