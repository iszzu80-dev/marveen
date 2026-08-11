// Preflight check for the in-dashboard "Update now" button.
//
// The previous flow was:
//   1. user clicks "Frissítés most"
//   2. backend spawns update.sh (detached, stdio ignored)
//   3. frontend receives { ok: true }, shows "Frissítés elindult..."
//   4. after 30s the page reloads and shows the same pending commits
//
// The silent failure mode is update.sh hitting `git pull --ff-only origin
// <branch>` while the local checkout is detached, or has local
// modifications that would make a fast-forward impossible. set -e in
// update.sh makes it exit before the stop.sh / start.sh step, but the
// frontend has no way to know because it only watched spawn() success.
//
// The update is branch-agnostic: update.sh derives the branch from the
// current checkout and pulls origin/<that-branch>, so an install that
// tracks any release branch (main, develop, …) self-updates. The only
// branch state this preflight rejects is a detached HEAD, which has no
// branch to pull.
//
// Running the preflight checks server-side means the apply endpoint can
// refuse with a 409 and a readable reason, the user sees an actionable
// toast, and the dashboard never enters the "reload in 30s" lie for a
// run that was guaranteed to fail.
//
// The module takes its git calls through a GitRunner interface so the
// decision logic is pure and synchronously testable without shelling
// out in tests.
// Max age before a live-looking pidfile is treated as stale anyway.
// This guards against PID recycling after SIGKILL / power loss: if a
// pidfile survives a kernel kill and the OS later recycles its PID to
// an unrelated process, kill(pid, 0) would report "alive" forever. A
// typical update is well under five minutes; one hour is twelve times
// the upper end of the normal distribution and still short enough
// that an operator waiting on a genuinely runaway update will notice
// and intervene.
export const MAX_PIDFILE_AGE_MS = 60 * 60 * 1000;
export function classifyLockWriteError(code) {
    return code === 'EEXIST' ? 'race' : 'other';
}
export function checkNoConcurrentUpdate(pf) {
    const raw = pf.readPidfile();
    if (raw === null)
        return { ok: true };
    const trimmed = raw.trim();
    if (!trimmed)
        return { ok: true };
    // Accept pidfile formats:
    //   "<pid>"                       (legacy, echo $$ only)
    //   "<pid>\n<start-epoch-ms>\n"   (dashboard-written, preferred)
    //   "<pid> garbage..."            (pid parsed from leading digits)
    const match = trimmed.match(/^(\d+)(?:[\s\r\n]+(\d+))?/);
    if (!match)
        return { ok: true };
    const pid = Number.parseInt(match[1], 10);
    // PID 0 and 1 are reserved / init; treating them as alive would
    // permanently lock the button if a stale pidfile ever contained one.
    if (!Number.isFinite(pid) || pid <= 1)
        return { ok: true };
    // If the optional second line is present and older than the max
    // age, treat as stale regardless of kill(pid, 0). Missing second
    // line means a legacy pidfile with no age info: fall through to
    // the alive probe alone.
    if (match[2]) {
        const startEpoch = Number.parseInt(match[2], 10);
        if (Number.isFinite(startEpoch) && startEpoch > 0) {
            const age = pf.now() - startEpoch;
            if (age > MAX_PIDFILE_AGE_MS)
                return { ok: true };
        }
    }
    if (!pf.isProcessAlive(pid))
        return { ok: true };
    return {
        ok: false,
        reason: 'already-running',
        pid,
        message: `Update already running (pid ${pid}). Wait for it to finish, then retry.`,
    };
}
export function checkUpdatePreflight(git) {
    const branch = git.currentBranch().trim();
    // `git rev-parse --abbrev-ref HEAD` prints "HEAD" on a detached
    // checkout. A detached HEAD has no branch to pull from, so it is the
    // one branch state the update cannot proceed from. Any named branch
    // is fine: update.sh pulls origin/<that-branch>.
    if (!branch || branch === 'HEAD') {
        return {
            ok: false,
            reason: 'detached-head',
            message: 'Repository is in a detached-HEAD state. ' +
                'Check out a release branch before updating, e.g.: git checkout main',
        };
    }
    // HEARTBEAT.md is self-modifying (rewritten by the agent every heartbeat).
    // Treating it as a blocker means the update button is almost always
    // refused in practice. Skip it from the dirty check; the file is
    // gitignore'd as "tracked-but-mutable" by convention. Any other dirty
    // file still blocks (see update.sh which stashes HEARTBEAT.md before
    // git pull and pops it after).
    const dirty = git.porcelainStatus()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .filter((l) => !/\sHEARTBEAT\.md$/.test(l));
    if (dirty.length > 0) {
        return {
            ok: false,
            reason: 'dirty-tree',
            message: 'Working tree has uncommitted changes (staged or unstaged). ' +
                'Commit or stash them before updating: git stash',
        };
    }
    // Local commits ahead of upstream = a diverged history. `git pull --ff-only`
    // refuses this, and because update.sh runs detached the abort is invisible
    // (the update looks "started" then reloads to the same commit list). Catch it
    // here with an actionable message instead of that silent death. A running
    // agent committing to its own tracked CLAUDE.md/SOUL.md/task-config is the
    // usual cause. The tree is clean (changes are committed), so the dirty-tree
    // stash cannot help; reconciliation is a separate, explicit step.
    const ahead = git.aheadCount();
    if (ahead > 0) {
        return {
            ok: false,
            reason: 'local-commits',
            ahead,
            message: `The local checkout has ${ahead} commit(s) not on the upstream, so a ` +
                'fast-forward update is not possible. This is usually a local edit that ' +
                'was committed. Review with: git log @{u}..HEAD',
        };
    }
    return { ok: true };
}
