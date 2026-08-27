// Progression heartbeat — periodic runner for the progression scheduler.
// Card 52250c7f, thin vertical slice (GATE 0-2).
//
// This is the ONE function that a cron/scheduled-task should call. It:
//   1. Finds all due cases (next_progression_at <= now) across both domains
//   2. For each, atomically claims it (tryClaimProgression)
//   3. Runs one progression cycle
//   4. Releases the claim
//
// All mutations are domain-scoped and internal only (no external side effects).
// At GATE 2, nothing here can send email, dispatch, or reach outside the DB.
//
// Usage from a cron / scheduled task:
//   import { getDb } from '../db.js'
//   import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'
//   const db = getDb()
//   const result = runProgressionHeartbeat(db)
//   // result: { personal: N, zst: N, errors: [...] }

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  findDuePage,
  type DueMetrics,
  tryClaimProgression,
  releaseProgressionClaim,
  deferProgression,
} from './progression-scheduler.js'
import { runProgressionCycle, type PipelineOptions } from './progression-pipeline.js'
import { projectCase } from './case-projection.js'
import { acquireClaim, releaseClaim } from './case-store.js'
import { decideTrigger, recordProgressionState, dueDeadline } from './progression-trigger.js'
import { killSwitchRefusal } from './kill-switch.js'
import { evaluateCaseTemporalConsistency } from './temporal-consistency-gate.js'

/** How far out the next check is pushed after a case ran. Matches the sweep
 *  cadence: the case is examined again on the next sweep, not sooner. */
export const POST_RUN_RECHECK_SEC = 300

/** How far out the next check is pushed for a case that was due but had NOTHING
 *  to reason about (§10.8 said no trigger).
 *
 *  This is the brake the old comment claimed and did not have. It said "Push the
 *  next check out anyway", and then called releaseProgressionClaim, which pushes
 *  nothing — nothing in the system ever advanced next_progression_at after a
 *  run, so every enabled case stayed permanently due and every five-minute sweep
 *  claimed and released all of them. Three times the sweep interval is a
 *  compromise: long enough that an idle case costs a fraction of the writes,
 *  short enough that a case nobody touched is still looked at four times an
 *  hour. Anything that genuinely changes the case (an owner answer, a new
 *  deadline) pulls it back in — recordOwnerAnswer re-arms the check on the spot,
 *  precisely so this backoff cannot delay an answer. */
export const NO_TRIGGER_BACKOFF_SEC = 900

export interface HeartbeatResult {
  personal: number
  zst: number
  errors: string[]
  /** Cases that were claimed by another runner and skipped. */
  skippedClaimed: number
  /** §10.8: due, but nothing about the case changed and no clock came round. */
  skippedNoTrigger: number
  /** Cases whose trigger was real but TSCG refused to let policy reason from an
   *  unverified/missing/conflicted/past-due semantic time fact. */
  temporalBlocked: number
  /** Bounded evidence for the operator; the count above is authoritative. */
  temporalBlockReasons: string[]
  /** Cases that threw during the cycle. */
  cycleErrors: number
  /** §11 C-invariant: due cases the per-domain bound left for the next sweep.
   *
   *  Zero is the normal state and the one this field exists to distinguish from.
   *  Without it, "personal: 50" reads identically whether fifty cases were due
   *  or four hundred were — and the second is a backlog the sweep interval will
   *  not drain on its own, because every sweep takes the same fifty from the
   *  front of the same queue. A bound that never says it was reached turns a
   *  growing queue into a steady-looking report. */
  remainingDue: { personal: number; zst: number }
  /** True when either domain left work behind. */
  truncated: boolean
  /** §10.4 closure C (owner, 2026-08-27): backlog, oldest due age, per-band
   *  selection, and the starvation counter -- per domain, measured at selection
   *  time. `null` for a domain whose page was never read. */
  selection: { personal: DueMetrics | null; zst: DueMetrics | null }
  /** Set when the §22 master switch stopped the sweep before it started. */
  killSwitchEngaged?: string
}

/** Run one heartbeat sweep across both domains.
 *
 *  Processes up to 50 cases per domain per sweep (configurable).
 *  Each case is claimed atomically — if two runners overlap, only one
 *  processes a given case.
 *
 *  The heartbeat is SAFE to call from a cron running every few minutes.
 *  Idempotent claim + lease means no case is double-processed. */
/**
 * Defer a case's next check AND project the result.
 *
 * WHY THE TWO ARE ONE FUNCTION, measured on the first two pinned cycles after
 * the P1 cutover. `deferProgression` moves `next_progression_at`, which the
 * projection reads and the revision trigger watches. This loop calls it in
 * THREE places -- no trigger, temporally blocked, and after a run -- and the
 * first two do not run the pipeline at all, so nothing projected on those paths.
 *
 * Cycle one reported `projected: 92` right after a fully reconciled board.
 * Cycle two, with only the post-run path fixed, still reported 89 while running
 * ZERO progressions: every one of those was this loop deferring a case it had
 * decided not to reason about.
 *
 * Nothing was broken either time -- the sweep repaired them seconds later and
 * drift ended at zero. What was broken was the SIGNAL. A `projected` counter
 * dominated by the poller's own five-minute re-check cannot also tell anyone
 * that canonical state moved somewhere unexpected, which is the only reason to
 * read it. Binding the two together is what makes a non-zero count mean
 * something.
 */
function deferAndProject(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  nextProgressionAt: number,
  now: number,
): void {
  deferProgression(db, domain, caseId, nextProgressionAt, now)
  // A projection failure must never cost the deferral: without the deferral the
  // case is due again immediately and the loop spins. The sweep reconciles.
  try { projectCase(db, domain, caseId, now) } catch { /* reconcileProjections */ }
}

export function runProgressionHeartbeat(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
  maxPerDomain: number = 50,
): HeartbeatResult {
  const result: HeartbeatResult = {
    personal: 0,
    zst: 0,
    errors: [],
    skippedClaimed: 0,
    skippedNoTrigger: 0,
    temporalBlocked: 0,
    temporalBlockReasons: [],
    cycleErrors: 0,
    remainingDue: { personal: 0, zst: 0 },
    truncated: false,
    selection: { personal: null, zst: null },
  }

  // §22 MASTER SWITCH, CHECKED BEFORE THE FIRST CASE IS TOUCHED.
  //
  // The switch reached executor-core and the permits() path and stopped there.
  // The progression engine — which consumes owner answers and transitions cases
  // between READY, BLOCKED and COMPLETED — never asked. So "stop everything,
  // now" stopped sending and left the thing that decides what to send running.
  // Checked here as well as inside runProgressionCycle: here so an engaged
  // switch costs one read for the whole sweep instead of one refusal row per
  // case, there so no caller can route around it.
  let refusal: string | null = null
  try {
    refusal = killSwitchRefusal(db)
  } catch {
    // cos_autonomy_global belongs to ensureLadderSchema; a store that never ran
    // it has no switch installed, which is not the same as an engaged one.
    refusal = null
  }
  if (refusal) {
    result.killSwitchEngaged = refusal
    result.errors.push(`progression heartbeat refused: ${refusal}`)
    return result
  }

  for (const domain of ['personal', 'zst'] as const) {
    const page = findDuePage(db, domain, now, maxPerDomain)
    // Recorded BEFORE the loop: this is what the bound left behind, which is a
    // property of the read, not of how the sweep then went.
    result.remainingDue[domain] = page.remaining
    if (page.hasMore) result.truncated = true
    // §10.4 closure C: the six numbers the owner asked for, per domain, taken at
    // SELECTION time. A metric gathered after the loop cannot see what the page
    // did not choose, and what it did not choose is the whole question.
    result.selection[domain] = page.metrics

    for (const dc of page.cases) {
      // Skip cases already claimed by another runner
      if (dc.claimed_by_other) {
        result.skippedClaimed++
        continue
      }

      const runId = randomUUID()
      const claimed = tryClaimProgression(db, domain, dc.case_id, runId, 300, now)
      if (claimed) {
        // Mirror the claim into case_claims, WITH a fence (§6.6 / A.2).
        try {
          acquireClaim(db, {
            claimKey: `progression:${domain}:${dc.case_id}`, ownerRunId: runId, ttlSeconds: 300,
          }, now)
        } catch { /* the progression lease already provides exclusion; the fence is the extra */ }
      }

      if (!claimed) {
        // Lost the race to another runner — skip
        result.skippedClaimed++
        continue
      }

      // §10.8 trigger contract. Being DUE is not a reason; the clock coming
      // round again says nothing about the case.
      const trig = decideTrigger(db, domain, dc.case_id, now)
      if (!trig.shouldRun) {
        result.skippedNoTrigger++
        deferAndProject(db, domain, dc.case_id, now + NO_TRIGGER_BACKOFF_SEC, now)
        releaseProgressionClaim(db, domain, dc.case_id, runId, now)
        continue
      }

      // A run whose trigger is missing must not be labelled 'SCHEDULED'.
      if (!trig.trigger) {
        result.cycleErrors++
        result.errors.push(`${domain}/${dc.case_id}: shouldRun with no trigger named (§10.8 defect)`)
        releaseProgressionClaim(db, domain, dc.case_id, runId, now)
        continue
      }

      try {
        // ACP v1.4.5 TSCG — BEFORE the policy decision. A real trigger is not
        // permission to reason from a date whose semantic meaning is absent or
        // unresolved. This is intentionally inside the already-held claim, so
        // the facts cannot be changed concurrently between the gate and cycle.
        const temporal = evaluateCaseTemporalConsistency(db, domain, dc.case_id, now)
        if (!temporal.allowProgression) {
          result.temporalBlocked++
          if (result.temporalBlockReasons.length < 20) {
            result.temporalBlockReasons.push(
              `${domain}/${dc.case_id}: ${temporal.status}: ${temporal.reasons.join('; ')}`,
            )
          }
          // Do not record the state hash: resolving/verifying the temporal fact
          // must make this case eligible again even if no legacy case column
          // changed. A short defer prevents a tight retry loop meanwhile.
          deferAndProject(db, domain, dc.case_id, now + POST_RUN_RECHECK_SEC, now)
          continue
        }

        const opts: PipelineOptions = {
          triggerType: trig.trigger,
          triggerReference: trig.triggerReference ?? `heartbeat-${runId.slice(0, 8)}`,
          // This sweep already holds the claim for this case; the cycle must not
          // take a second one and refuse itself.
          claimedBy: runId,
        }
        runProgressionCycle(db, domain, dc.case_id, now, opts)
        // And schedule the next check. A case that ran is not due again until
        // the next sweep — the COMPLETE path clears next_progression_at, and
        // deferProgression deliberately cannot undo that.
        deferAndProject(db, domain, dc.case_id, now + POST_RUN_RECHECK_SEC, now)
        // Recorded AFTER the run, and RE-DERIVED after it — not the hash from
        // before. The cycle mutates the case (version, goal version, wait), so
        // the pre-run hash never matches the post-run state, and recording it
        // meant every case looked changed on the next pass and ran again for
        // ever. Measured: 30 cases still running every cycle with the pre-run
        // hash recorded.
        recordProgressionState(db, domain, dc.case_id,
          decideTrigger(db, domain, dc.case_id, now).effectiveStateHash, now,
          dueDeadline(db, domain, dc.case_id, now))

        if (domain === 'personal') result.personal++
        else result.zst++
      } catch (err) {
        result.cycleErrors++
        result.errors.push(
          `${domain}/${dc.case_id}: ${(err as Error).message}`,
        )
      } finally {
        releaseProgressionClaim(db, domain, dc.case_id, runId, now)
        // A tukrozott claim elengedese: egy ott felejtett sor a kovetkezo
        // egyeztetesben "lejart foglalas"-kent jelenne meg, ami zaj, es a zaj
        // megtanitja az embert atugrani a jelentest.
        try {
          const key = `progression:${domain}:${dc.case_id}`
          const held = db.prepare(`SELECT claim_fence FROM case_claims WHERE claim_key=? AND owner_run_id=?`)
            .get(key, runId) as { claim_fence: number } | undefined
          if (held) releaseClaim(db, { claimKey: key, ownerRunId: runId, fence: held.claim_fence })
        } catch { /* a lease lejarata amugy is felszabaditja */ }
      }
    }
  }

  return result
}
