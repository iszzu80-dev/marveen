// CostOps Phase 2 / P2-C -- the scheduled collector runner.
//
// THE DEFECT THIS CLOSES. Before P2-C nothing INSIDE this process ever ran a
// provider collector. `POST /api/costs/sync?provider=X` was the only call site, so
// every collector depended on someone (a human, or an out-of-repo file-based
// scheduled task under ~/.claude/scheduled-tasks/) remembering to poke it. The
// observable consequences on the live install, 2026-07-30:
//
//   * the codex rate-limit collector had NEVER run -- provider_ratelimit_snapshots
//     was completely empty, so the one capacity signal we can actually measure was
//     absent, while the code that measures it sat there looking finished;
//   * the anthropic cost collector had no call site at all, in or out of repo;
//   * the out-of-repo cron covered 4 providers and nothing in this repository could
//     detect its removal, because no test can see a file in ~/.claude.
//
// A collector with no caller is dead code, and dead measurement code reads as a
// working feature. So: an in-process runner, on the CostOps background seam, with
// a repo test that goes red if the invocation is removed.
//
// CADENCE + DUE-CHECK. Each collector declares its own cadence and the runner
// ticks often (COLLECTOR_TICK_MS), asking import_runs "when did this collector
// last run?". Consequences worth stating:
//   * restart-safe: the cadence is derived from stored history, not from an
//     in-memory timer, so restarting the dashboard does not re-hammer providers;
//   * it does NOT double-run against the pre-existing out-of-repo cron -- if that
//     cron synced render at 06:00, render is simply not due again for 24h;
//   * every DUE attempt leaves an import_runs row even when the collector itself
//     returns early (no credential), otherwise the due-check would retry it on
//     every single tick forever.
//
// DETERMINISTIC: no LLM anywhere in this path. Secrets are read by the individual
// collectors from the Vault and are never logged, returned, or persisted here --
// this module only ever sees a sanitized status string.

import type Database from 'better-sqlite3'
import { logger } from '../../logger.js'
import type { ImportStatus } from './types.js'

/** How often the runner wakes up and asks what is due. */
export const COLLECTOR_TICK_MS = 15 * 60 * 1000

export const HOURLY = 60 * 60
export const DAILY = 24 * 60 * 60

export interface CollectorSyncOutcome {
  provider: string
  collector: string
  status: ImportStatus
  imported_count: number
  /** Sanitized reason when nothing landed. NEVER a secret or a raw provider body. */
  blocker: string | null
}

export interface ScheduledCollectorDeps {
  /** Injected per-collector runners; tests pass stubs so no network/CLI is touched. */
  runners?: Partial<Record<string, CollectorRunner>>
}

export type CollectorRunner = (db: Database.Database, now: number) => Promise<CollectorSyncOutcome>

export interface CollectorPlanEntry {
  provider: string
  collectorName: string
  cadenceSeconds: number
  /** What the signal is FOR -- 'capacity' figures drive the limit ladder, 'cost' the ledger. */
  kind: 'capacity' | 'cost'
  run: CollectorRunner
}

function outcome(
  provider: string, collector: string, status: ImportStatus, imported: number, blocker: string | null,
): CollectorSyncOutcome {
  return { provider, collector, status, imported_count: imported, blocker }
}

/**
 * The collector plan. Capacity signals (rate-limit %, prepaid balance, the manual
 * Claude reading) run hourly because they are the numbers a capacity decision
 * would be made on; monthly-cost collectors run daily because a month-to-date
 * figure does not get 24x truer for 24x the provider calls.
 */
export function buildCollectorPlan(deps: ScheduledCollectorDeps = {}): CollectorPlanEntry[] {
  const plan: CollectorPlanEntry[] = [
    {
      provider: 'codex', collectorName: 'codex-ratelimit', cadenceSeconds: HOURLY, kind: 'capacity',
      run: async (db, now) => {
        const { syncCodexRateLimit } = await import('./codex.js')
        const r = await syncCodexRateLimit(db, now)
        // COS-OPS-M4: the sync itself now runs under the per-provider import lock and
        // can legitimately report 'locked' (benign no-op) -- pass its real status
        // through instead of flattening every non-ok into 'error'.
        return outcome('codex', 'codex-ratelimit', r.status as ImportStatus, r.imported_count, r.ok ? null : (r.error ?? 'codex rate-limit read failed'))
      },
    },
    {
      provider: 'deepseek', collectorName: 'deepseek-balance', cadenceSeconds: HOURLY, kind: 'capacity',
      run: async (db, now) => {
        const { syncDeepSeekBalance } = await import('./deepseek.js')
        const r = await syncDeepSeekBalance(db, now)
        // COS-OPS-M4: same as codex -- 'locked' is a benign concurrent-run no-op, not an error.
        return outcome('deepseek', 'deepseek-balance', r.status as ImportStatus, r.imported_count, r.ok ? null : (r.error ?? 'deepseek balance read failed'))
      },
    },
    {
      provider: 'anthropic', collectorName: 'anthropic-usage-snapshot', cadenceSeconds: HOURLY, kind: 'capacity',
      run: async (db, now) => {
        const { syncAnthropicUsageSnapshot } = await import('./anthropic-usage.js')
        const r = syncAnthropicUsageSnapshot(db, now)
        return outcome('anthropic', 'anthropic-usage-snapshot', r.status, r.imported_count, r.blocker)
      },
    },
    {
      provider: 'openai', collectorName: 'openai-costs', cadenceSeconds: DAILY, kind: 'cost',
      run: async (db, now) => {
        const { syncOpenAiCollector } = await import('./openai.js')
        const r = await syncOpenAiCollector(db, now)
        return outcome('openai', 'openai-costs', r.ok ? 'ok' : 'error', r.imported_count, r.ok ? null : (r.error ?? 'openai costs read failed'))
      },
    },
    {
      provider: 'github', collectorName: 'github-billing-usage', cadenceSeconds: DAILY, kind: 'cost',
      run: async (db, now) => {
        const { syncGitHubCollector } = await import('./github.js')
        const r = await syncGitHubCollector(db, now)
        return outcome('github', 'github-billing-usage', r.ok ? 'ok' : 'error', r.imported_count, r.ok ? null : (r.error ?? 'github billing read failed'))
      },
    },
    {
      provider: 'render', collectorName: 'render-plan-report', cadenceSeconds: DAILY, kind: 'cost',
      run: async (db, now) => {
        const { syncRenderCollector } = await import('./render.js')
        const r = await syncRenderCollector(db, now)
        return outcome('render', 'render-plan-report', r.ok ? 'ok' : 'error', r.imported_count, r.ok ? null : (r.error ?? 'render plan read failed'))
      },
    },
    {
      provider: 'anthropic', collectorName: 'anthropic-cost-report', cadenceSeconds: DAILY, kind: 'cost',
      run: async (db, now) => {
        const { syncAnthropicCostReport } = await import('./anthropic.js')
        const r = await syncAnthropicCostReport(db, now)
        return outcome('anthropic', 'anthropic-cost-report', r.ok ? 'ok' : 'error', r.imported_count, r.ok ? null : (r.error ?? 'anthropic cost report read failed'))
      },
    },
  ]
  if (!deps.runners) return plan
  return plan.map(e => (deps.runners![e.collectorName] ? { ...e, run: deps.runners![e.collectorName]! } : e))
}

/** Most recent import_runs.started_at for a collector, or null if it never ran. */
export function lastCollectorRunAt(db: Database.Database, collectorName: string): number | null {
  const row = db.prepare(
    'SELECT MAX(started_at) AS last FROM import_runs WHERE collector_name = ?',
  ).get(collectorName) as { last: number | null } | undefined
  return row?.last ?? null
}

/**
 * Is this collector due? True when it has never run, or when its cadence has
 * elapsed since its last run -- of ANY status, deliberately: a collector whose
 * credential is missing must not be retried every 15 minutes forever, and its
 * 'skipped' row is what paces it.
 */
export function isCollectorDue(
  db: Database.Database, collectorName: string, cadenceSeconds: number, now: number,
): boolean {
  const last = lastCollectorRunAt(db, collectorName)
  if (last === null) return true
  return now - last >= cadenceSeconds
}

/** Record a run row for a DUE attempt whose collector left no trace of its own. */
function recordScheduledRun(
  db: Database.Database, entry: CollectorPlanEntry, res: CollectorSyncOutcome, now: number,
): void {
  db.prepare(`
    INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status,
      imported_count, error_code, error_message_sanitized, data_freshness_at)
    VALUES (@provider, @collector, @now, @now, @status, @count, @ecode, @emsg, @fresh)
  `).run({
    provider: entry.provider, collector: entry.collectorName, now,
    status: res.status, count: res.imported_count,
    ecode: res.status === 'ok' ? null : res.status,
    emsg: res.blocker,
    fresh: res.status === 'ok' ? now : null,
  })
}

export interface ScheduledSyncReport {
  ran_at: number
  /** Only the collectors that were actually due (or all, when forced). */
  outcomes: CollectorSyncOutcome[]
  skipped_not_due: string[]
}

/**
 * Run every DUE collector once. Never throws: each collector is independently
 * fault-isolated, so one provider's outage/credential problem cannot stop the
 * others (the exact property the out-of-repo cron script also had, kept).
 *
 * `force: true` ignores the cadence -- that is what POST /api/costs/sync?provider=all
 * uses so an operator can demand a sweep now.
 */
export async function runScheduledCollectorSync(
  db: Database.Database,
  now: number,
  deps: ScheduledCollectorDeps & { force?: boolean } = {},
): Promise<ScheduledSyncReport> {
  const plan = buildCollectorPlan(deps)
  const outcomes: CollectorSyncOutcome[] = []
  const skipped: string[] = []
  for (const entry of plan) {
    if (!deps.force && !isCollectorDue(db, entry.collectorName, entry.cadenceSeconds, now)) {
      skipped.push(entry.collectorName)
      continue
    }
    const before = lastCollectorRunAt(db, entry.collectorName)
    let res: CollectorSyncOutcome
    try {
      res = await entry.run(db, now)
    } catch (err) {
      const { sanitizeError } = await import('./runner.js')
      const s = sanitizeError(err)
      res = outcome(entry.provider, entry.collectorName, 'error', 0, `${s.code}: ${s.message}`)
    }
    // Collectors that bail before recording (missing credential) would otherwise
    // never advance their own due-clock, so the scheduler records the attempt.
    try {
      if (lastCollectorRunAt(db, entry.collectorName) === before) recordScheduledRun(db, entry, res, now)
    } catch (err) {
      logger.warn({ err, collector: entry.collectorName }, 'CostOps scheduled sync: run-row insert failed')
    }
    outcomes.push(res)
  }
  return { ran_at: now, outcomes, skipped_not_due: skipped }
}

/**
 * Fault-isolated tick used by the background seam. NEVER throws and NEVER
 * rejects: a measurement sweep may not take the dashboard's background loop down.
 */
export async function runScheduledCollectorSyncSafe(db: Database.Database, now: number): Promise<ScheduledSyncReport | null> {
  try {
    const report = await runScheduledCollectorSync(db, now)
    const landed = report.outcomes.filter(o => o.status === 'ok').length
    if (report.outcomes.length > 0) {
      logger.info(
        { ran: report.outcomes.length, ok: landed, blocked: report.outcomes.filter(o => o.status !== 'ok').map(o => o.collector) },
        'CostOps scheduled collector sync completed',
      )
    }
    return report
  } catch (err) {
    logger.warn({ err }, 'CostOps scheduled collector sync failed')
    return null
  }
}
