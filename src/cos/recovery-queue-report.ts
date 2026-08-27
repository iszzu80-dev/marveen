/**
 * The recovery step's REPORTING ADAPTER: domain result in, cycle payload out.
 *
 * Two things live here rather than in scripts/cos-recovery-queue.ts, for the
 * same reason the CPP normaliser moved to cycle-cpp.ts on the same day: an
 * entry point is unreachable from a test, and a guard nothing can reach is a
 * guard nobody has seen go red.
 *
 * 1. CPP vocabulary. `reconcileRecoveryQueue` speaks domain (`enqueued`,
 *    `resolved`, `inRecovery`); the cycle's normaliser speaks CPP (`examined`,
 *    `matched`, `acted`). Mapping here keeps CPP names out of the domain module
 *    AND keeps the normaliser free of a per-step table -- the thing its own
 *    comment warns against, because the step nobody remembers to add to that
 *    table reports UNKNOWN while looking exactly like a step that genuinely
 *    cannot say what it did. This step WAS that step, from the 2026-08-24
 *    pinned cutover until 2026-08-27.
 *
 * 2. The zero that must fail. On the live store nothing is parked, so every row
 *    counter is 0 on every healthy cycle -- byte-identical to a reconcile that
 *    never queried. `surfacesScanned` counts QUERIES rather than rows, so it
 *    survives an empty input set, and zero of them is reported as a FAILURE.
 *    Without that, this fix would have replaced an honest UNKNOWN with a
 *    confident permanent zero and called it progress.
 */
import type { ReconcileResult } from './recovery-queue.js'

export function recoveryStepPayload(
  res: ReconcileResult, needsHumanRows: unknown[],
): Record<string, unknown> {
  if (res.surfacesScanned === 0) {
    return {
      ...res, failed: true,
      error: 'recovery reconcile scanned ZERO source surfaces -- it did not run. '
        + 'examined:0 here means "never looked", not "nothing parked".',
    }
  }
  return {
    ...res,
    matched: res.inRecovery,
    // enqueued + resolved: both are WRITES this reconcile made. A status count
    // (needsHuman, pendingRetry) is state, not action, and putting state in
    // `acted` would claim work on every quiet cycle with a single parked row.
    acted: res.enqueued + res.resolved,
    needsHumanRows,
  }
}
