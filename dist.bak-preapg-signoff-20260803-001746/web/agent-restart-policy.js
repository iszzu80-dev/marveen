// Pure decision logic for the channel-plugin watchdog's agent auto-restart.
//
// Extracted from channel-monitor.ts so the restart guards are unit-testable
// without spawning processes or mocking the OS. The watchdog walks each
// agent's process tree to check whether the channel plugin (a `bun server.ts`
// grandchild) is alive; when it is not, it used to restart the agent
// immediately. That killed freshly-started agents whose plugin had simply not
// finished spawning yet -- a large-context model launched with --continue can
// take well over the 30s first-probe window to bring the plugin up, so the
// watchdog saw "down", restarted, and looped forever. The startup grace below
// gives a young process time to finish coming up before any restart.
// The restart grace after applying exponential back-off for repeated failed
// restarts. Each consecutive failure doubles the base grace, capped (when a cap
// is given) so retries continue at a bounded floor frequency. Exported for unit
// tests and so the caller can log the effective interval.
export function effectiveRestartGraceMs(restartGraceMs, consecutiveFailures, maxRestartGraceMs) {
    const failures = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
        ? Math.floor(consecutiveFailures)
        : 0;
    // Cap the exponent well below the point where 2^n overflows Number range.
    const exp = Math.min(failures, 30);
    let grace = restartGraceMs * 2 ** exp;
    if (maxRestartGraceMs != null && Number.isFinite(maxRestartGraceMs)) {
        grace = Math.min(grace, maxRestartGraceMs);
    }
    return grace;
}
// Returns true only when a down-reporting agent should actually be restarted.
export function shouldAutoRestartDownAgent(input) {
    const { processAgeMs, msSinceLastRestart, startupGraceMs, restartGraceMs } = input;
    // Unknown process age: the age probe failed. Be conservative and do not
    // restart -- a false "down" must never kill a healthy agent.
    if (!Number.isFinite(processAgeMs) || processAgeMs < 0)
        return false;
    // Freshly started: the channel plugin may still be spawning.
    if (processAgeMs < startupGraceMs)
        return false;
    // Recently restarted by the watchdog: give the new process time to come up,
    // backed off exponentially for repeated failed restarts so a plugin that can
    // never come up is not restarted on a fixed short cadence forever.
    const grace = effectiveRestartGraceMs(restartGraceMs, input.consecutiveFailures ?? 0, input.maxRestartGraceMs);
    if (msSinceLastRestart !== null && msSinceLastRestart < grace)
        return false;
    return true;
}
// Hard cap on consecutive watchdog restarts that never bring the plugin back
// up. The exponential back-off above only SLOWS the churn; on its own a plugin
// that no restart can fix -- e.g. the claude-side channel MCP wedged after a
// respawn-pane, or an auth/token fault the watchdog cannot repair -- is
// hard-restarted forever. Every sub-agent restart is a FRESH session, so the
// agent loses all of its working context on each cycle (observed: a sub-agent
// hard-restarted ~10x/hour, re-running /name every time). After this many
// consecutive failed attempts the watchdog stops restarting and alerts the
// operator instead, turning a silent infinite loop into one actionable ping.
export const AGENT_MAX_RESTART_ATTEMPTS = 5;
// Decide what to do about a sub-agent whose channel plugin is observed down.
// Wraps shouldAutoRestartDownAgent with a consecutive-failure cap so the
// watchdog escalates to a human instead of churning the session indefinitely:
//   'restart' -> under the cap and the back-off has elapsed: hard-restart
//   'alert'   -> the cap was just reached: surface to the operator (once)
//   'skip'    -> within back-off, or already alerted past the cap
//
// The caller must tick consecutiveFailures past maxRestartAttempts when it
// acts on 'alert', so subsequent ticks fall through to 'skip' and the alert
// fires exactly once per down-spell (the counter is reset when the plugin
// recovers, re-arming the alert for any future spell).
// 'alert-busy' is the same escalation for a different cause: the plugin stayed
// down past the busy-deferral cap while the agent kept working, so the watchdog
// refuses to choose between killing live work and leaving the agent deaf, and
// asks the operator instead.
export function decideDownAgentAction(input, maxRestartAttempts) {
    const failures = Number.isFinite(input.consecutiveFailures) && (input.consecutiveFailures ?? 0) > 0
        ? Math.floor(input.consecutiveFailures)
        : 0;
    if (maxRestartAttempts > 0 && failures >= maxRestartAttempts) {
        return failures === maxRestartAttempts ? 'alert' : 'skip';
    }
    // Confirmation window: one down sample is a suspicion, not a verdict.
    const msDown = Number.isFinite(input.msDown) ? input.msDown : 0;
    const downConfirmMs = Number.isFinite(input.downConfirmMs) ? input.downConfirmMs : 0;
    if (msDown < downConfirmMs)
        return 'skip';
    if (!shouldAutoRestartDownAgent(input))
        return 'skip';
    // Busy-guard: the restart is a FRESH session, so it destroys whatever the
    // agent is generating right now. Wait for idle; escalate if that never comes.
    if (input.agentBusy) {
        const cap = input.busyDeferMaxMs;
        if (cap != null && Number.isFinite(cap) && msDown >= cap)
            return 'alert-busy';
        return 'skip';
    }
    return 'restart';
}
// Parse the elapsed-time string from `ps -o etime=` into seconds.
// Format is `[[dd-]hh:]mm:ss` on both BSD (macOS) and procps (Linux):
//   "05:23"        -> 323
//   "01:05:23"     -> 3923
//   "2-03:04:05"   -> 183845
// Returns -1 for anything it cannot parse.
export function parseEtimeToSeconds(etime) {
    // Match exactly the documented shapes and nothing else, so malformed input
    // (empty segments, a leading '-', stray colons) falls through to -1 instead
    // of coercing through Number('') === 0 into a bogus duration.
    // The day count only appears together with an hours field, so days and hours
    // share one optional group: this matches MM:SS, HH:MM:SS and DD-HH:MM:SS but
    // rejects shapes ps never emits (e.g. DD-MM:SS).
    const m = etime.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
    if (!m)
        return -1;
    const days = m[1] ? Number(m[1]) : 0;
    const hours = m[2] ? Number(m[2]) : 0;
    const minutes = Number(m[3]);
    const seconds = Number(m[4]);
    if (minutes > 59 || seconds > 59)
        return -1;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}
