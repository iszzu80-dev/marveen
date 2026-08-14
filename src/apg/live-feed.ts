// APG 1.9 §35 -- the scheduled live feed. THE STAGE 1 PRECONDITION.
//
// THE DEFECT THIS CLOSES, in the 1.8 audit's own summary of the whole APG
// deployment: "ami ma valós Marveen-munka ellen fut, az egy kézzel indított
// szkript hét átmásolt kártyán". The kernel's `a1_pilot.poll_and_ingest` is
// real and tested and had NO PRODUCTION CALLER -- its own docstring says a
// "future scheduled heartbeat" would call it, and none ever did. So observe mode
// measured nothing, and an empty attention list meant "not watching anything"
// rather than "all clear".
//
// §35's v1.9 subsection makes that a status, not an inconvenience: an unfed
// observe mode reports `rollout_stage = NOT_STARTED, reason = OBSERVE_NOT_FED`,
// and Stage 1 has not begun. It names three requirements; this module is the
// first of them (an AUTOMATIC, SCHEDULED ingest against the real work-item
// source) and the kernel's `live_ingest.py` is the other two (its own liveness
// signal, and a countable eligible work item).
//
// WHY THE SCHEDULER IS HERE AND THE WORK IS THERE. The kernel is a Python
// sidecar with its own database and its own append-only discipline; it
// deliberately owns no timer, for the same reason `poll_and_ingest` owns no
// loop -- a sidecar that scheduled itself would be a daemon. Marveen already has
// the machinery: `costops/collectors/scheduled-sync.ts` established the pattern
// (declare a cadence, derive due-ness from stored history, tick often, never
// throw), and `startCostOpsBackgroundTasks` established the mount. This reuses
// both rather than inventing a third scheduler.
//
// THE DEADLOCK LESSON, WHICH THIS MODULE IS SHAPED BY. `ops/scheduled-tasks/
// costops-alert-monitor/check.py` carries the incident in its own header: the
// schedule-runner invokes command tasks with `spawnSync`, which BLOCKS the
// dashboard's Node event loop until the child exits -- and that child called the
// dashboard's OWN HTTP API, which cannot be served while the loop is blocked.
// Every scheduled run timed out while manual runs succeeded. The APG feed reads
// `/api/kanban` from this very dashboard, so it is the same shape exactly. Two
// consequences, both load-bearing:
//
//   1. THE CHILD IS SPAWNED ASYNCHRONOUSLY. `execFile`, never `execFileSync`,
//      never `spawnSync`. `apg-live-feed.test.ts` asserts the absence of the
//      synchronous forms at the source level, because the failure they cause is
//      invisible in a unit test and catastrophic in production.
//   2. THE TICK RETURNS IMMEDIATELY. It kicks the child and resolves; the
//      child's own exit is logged when it happens. Nothing awaits it on the
//      request path.
//
// HONESTLY INERT, NEVER FAKE-GREEN. On a host with no kernel checkout there is
// nothing to run, and this module says so with a NAMED reason
// (`KERNEL_NOT_PRESENT`) rather than reporting a quiet success. When the kernel
// IS present but its sources are not reachable, the kernel writes its own
// `NO_SOURCE` run row and the liveness signal goes STALLED -- which is the
// state §35 wants visible, and is why the feed's health is read back from the
// kernel's store rather than from whether this function threw.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { isTestRun } from '../test-run-marker.js'
// The SAME reader the UI summary uses. Deliberately not a second connection
// helper: "where is the kernel database" must have one answer, or the tick
// could pace itself off a store the dashboard is not reading.
import { openApgKernelReadonly } from './ui-projection.js'

/**
 * How often the tick wakes up. Matches `COLLECTOR_TICK_MS`'s spirit rather than
 * its number: the kernel's own cadence expectation is hourly
 * (`live_ingest.DEFAULT_CADENCE_SECONDS`) and it stalls after three missed
 * hours, so a 15-minute tick would spend three quarters of its wakeups doing
 * nothing. The due-check below is what actually paces it, so this only bounds
 * how quickly the feed recovers after a restart.
 */
export const APG_FEED_TICK_MS = 15 * 60 * 1000

/** The kernel's own expected cadence, in seconds. Mirrors `live_ingest`. */
export const APG_FEED_CADENCE_SECONDS = 60 * 60

/** The one-cycle timeout. A cycle that has not finished in five minutes is
 *  wedged, and a wedged child that is never killed accumulates one process per
 *  tick until the host runs out. */
export const APG_FEED_TIMEOUT_MS = 5 * 60 * 1000

export type ApgFeedTickState =
  | 'ran' | 'not_due' | 'kernel_absent' | 'disabled_in_test' | 'already_running'

export interface ApgFeedTickResult {
  state: ApgFeedTickState
  /** A named reason whenever the feed did NOT run. Never null on a non-'ran'. */
  reason: string | null
  kernelRoot: string | null
}

/**
 * Where the kernel checkout lives. `APG_KERNEL_ROOT` overrides; the default is
 * the parent of the path `ui-projection.resolveApgKernelDbPath` already
 * defaults to, so the two resolvers cannot point at different installs.
 */
export function resolveApgKernelRoot(): string {
  const configured = process.env.APG_KERNEL_ROOT
  if (configured) return configured
  return join(homedir(), 'marveen-local', 'apg-kernel')
}

/** The entrypoint script. Absent => the kernel is not installed here. */
export function resolveApgFeedScript(kernelRoot: string = resolveApgKernelRoot()): string {
  return join(kernelRoot, 'apg_feed.py')
}

export interface ApgFeedDeps {
  /** Injected for tests: returns the epoch SECONDS of the last successful (or
   *  any) feed run, or null. Production reads the kernel's own ingest_runs. */
  lastRunAt?: () => number | null
  /** Injected for tests: kicks the child. Production spawns apg_feed.py. */
  spawnCycle?: (kernelRoot: string) => void
  now?: () => number
  force?: boolean
}

/**
 * Is the feed due? True when it has never run, or when the cadence has elapsed.
 *
 * DERIVED FROM STORED HISTORY, not from an in-memory timer -- the same property
 * `isCollectorDue` has and for the same three reasons: restarting the dashboard
 * does not re-hammer the source, a manually run cycle correctly delays the next
 * scheduled one, and the pacing survives a crash. The history it reads is the
 * KERNEL's `ingest_runs` table, which is also the liveness signal, so "when did
 * it last run" has exactly one answer.
 */
export function isApgFeedDue(lastRunAt: number | null, now: number, cadenceSeconds = APG_FEED_CADENCE_SECONDS): boolean {
  if (lastRunAt === null) return true
  return now - lastRunAt >= cadenceSeconds
}

/**
 * Read the last feed run out of the kernel's store. Null when there is no
 * kernel, no database, or no run yet -- all three of which mean "due".
 *
 * Read-only, and it opens the kernel database directly rather than shelling out
 * to `apg_feed.py --status-only`: spawning a process to answer a due-check
 * every 15 minutes would cost more than the check saves, and this read is the
 * same one `ui-projection.ts` already makes for the summary.
 */
export function lastApgFeedRunAt(): number | null {
  try {
    const db = openApgKernelReadonly()
    if (!db) return null
    try {
      const row = db.prepare('SELECT MAX(started_at) AS last FROM ingest_runs').get() as
        { last: number | null } | undefined
      return row?.last ?? null
    } finally {
      try { db.close() } catch { /* a failed reader must not escape */ }
    }
  } catch {
    // No table, no database, no driver: all "we have no record of a run", which
    // is exactly what null means here.
    return null
  }
}

/** True while a cycle this process started is still running. */
let cycleInFlight = false

function spawnFeedCycle(kernelRoot: string): void {
  cycleInFlight = true
  const started = Date.now()
  // execFile, NOT execFileSync and NOT spawnSync. See the header: the child
  // calls this dashboard's own HTTP API, and a synchronous spawn blocks the
  // event loop that would have to serve it -- the exact deadlock recorded in
  // ops/scheduled-tasks/costops-alert-monitor/check.py.
  execFile(
    'python3',
    [resolveApgFeedScript(kernelRoot)],
    { cwd: kernelRoot, timeout: APG_FEED_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      cycleInFlight = false
      const elapsedMs = Date.now() - started
      if (err) {
        // Exit 2 is the kernel's "the cycle left NO liveness row" -- the one
        // outcome that must not be confused with an honest NO_SOURCE run, which
        // exits 0 after recording itself.
        logger.warn(
          { err, elapsedMs, stderr: String(stderr).slice(0, 500) },
          'APG live feed cycle failed; the kernel may have recorded no liveness row for it',
        )
        return
      }
      let summary: unknown = null
      try { summary = JSON.parse(String(stdout).trim().split('\n').pop() ?? '') } catch { /* not JSON */ }
      logger.info({ elapsedMs, summary }, 'APG live feed cycle completed')
    },
  )
}

/**
 * One tick. NEVER throws: a measurement sweep may not take the background loop
 * down, the same contract `runScheduledCollectorSyncSafe` keeps.
 */
export function apgFeedTickSafely(deps: ApgFeedDeps = {}): ApgFeedTickResult {
  const kernelRoot = resolveApgKernelRoot()
  try {
    // ORDER MATTERS, and it is the opposite of the obvious one. The
    // kernel-absent check runs FIRST because it is a filesystem read with no
    // side effect, and because it is the answer §35 actually wants: a host with
    // no kernel is not measuring, whether or not a test happens to be running.
    // Putting the test guard first would make the honest-inert path untestable
    // -- the only way to reach it would be to not be in a test.
    const script = resolveApgFeedScript(kernelRoot)
    if (!deps.spawnCycle && !existsSync(script)) {
      // HONESTLY INERT, with a NAME. Not a silent no-op and not a success:
      // there is no kernel on this host, the feed cannot run, and §35's status
      // is reported by whatever reads the (absent) liveness signal.
      return { state: 'kernel_absent', reason: `KERNEL_NOT_PRESENT:${script}`, kernelRoot }
    }
    // Same guard, same reason, as collectorSyncTickSafely: a unit test must
    // never spawn a real subprocess against a real dashboard (the 2026-07-27
    // incident). It sits after the filesystem check and before the only line
    // that starts a process. The WIRING is still proven -- at the source level
    // and by startApgLiveFeed returning its interval -- and the tick's own
    // logic is tested offline through the injected seams below.
    if (isTestRun() && !deps.spawnCycle) {
      return { state: 'disabled_in_test', reason: 'IS_TEST_RUN', kernelRoot }
    }
    if (cycleInFlight && !deps.force) {
      // A cycle that outlives its cadence must not be joined by a second one:
      // the kernel's store is append-only and would survive it, but two
      // concurrent passes would write two run rows for one measurement.
      return { state: 'already_running', reason: 'CYCLE_IN_FLIGHT', kernelRoot }
    }
    const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))()
    const lastRun = (deps.lastRunAt ?? lastApgFeedRunAt)()
    if (!deps.force && !isApgFeedDue(lastRun, now)) {
      return { state: 'not_due', reason: `NOT_DUE_UNTIL:${lastRun! + APG_FEED_CADENCE_SECONDS}`, kernelRoot }
    }
    ;(deps.spawnCycle ?? spawnFeedCycle)(kernelRoot)
    return { state: 'ran', reason: null, kernelRoot }
  } catch (err) {
    logger.warn({ err }, 'APG live feed tick failed')
    return { state: 'kernel_absent', reason: 'TICK_THREW', kernelRoot }
  }
}

/**
 * Boot-time seam: start the APG live feed. Runs one tick immediately, then on
 * the cadence. Returns the interval handles so the caller can clear them on
 * shutdown, matching every other start*Runner() in this codebase.
 *
 * THIS FUNCTION IS THE DELIVERABLE. Everything else in this module is
 * mechanism; without a call to this from web.ts the kernel has no caller again,
 * which is the entire 1.8 finding. `apg-live-feed.test.ts` asserts the call
 * site at the source level for exactly that reason -- a test that only exercised
 * the tick would pass just as happily with the mount deleted.
 */
export function startApgLiveFeed(): NodeJS.Timeout[] {
  const first = apgFeedTickSafely()
  if (first.state === 'kernel_absent') {
    logger.info(
      { reason: first.reason },
      'APG live feed not started: no kernel on this host (§35 rollout_stage stays NOT_STARTED / OBSERVE_NOT_FED)',
    )
  }
  return [setInterval(() => { apgFeedTickSafely() }, APG_FEED_TICK_MS)]
}
