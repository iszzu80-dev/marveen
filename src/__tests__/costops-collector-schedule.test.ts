// P2-C: the scheduled collector sweep -- cadence, due-check, fault isolation.
//
// Every collector runner is INJECTED here, so this suite touches no network, no
// Vault and never spawns `codex app-server`. What it proves is the scheduler's own
// behaviour, which is what was missing entirely before P2-C: nothing in this
// process ever ran a collector, so the codex rate-limit collector had produced
// exactly zero snapshots on the live install while looking finished.
//
// RED-ABILITY:
//  * drop a collector from buildCollectorPlan            -> test 1 goes red
//  * make isCollectorDue always return true              -> tests 3, 4 go red
//  * remove the per-collector try/catch in the sweep     -> test 5 goes red
//  * stop recording a run row for a bail-out collector   -> test 6 goes red
//    (and the due-check would then retry it every tick forever)
//  * let `force` be ignored                              -> test 7 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  buildCollectorPlan,
  isCollectorDue,
  lastCollectorRunAt,
  runScheduledCollectorSync,
  HOURLY,
  DAILY,
  COLLECTOR_TICK_MS,
  type CollectorRunner,
} from '../costops/collectors/scheduled-sync.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

/** A runner that records what it was asked and reports a clean import. */
function okRunner(provider: string, collector: string, calls: string[]): CollectorRunner {
  return async () => {
    calls.push(collector)
    return { provider, collector, status: 'ok', imported_count: 1, blocker: null }
  }
}

function stubAll(calls: string[]): Record<string, CollectorRunner> {
  const out: Record<string, CollectorRunner> = {}
  for (const e of buildCollectorPlan()) out[e.collectorName] = okRunner(e.provider, e.collectorName, calls)
  return out
}

describe('P2-C collector plan', () => {
  it('1. covers every required Phase 2 signal, with capacity on a faster cadence than cost', () => {
    const plan = buildCollectorPlan()
    const byName = new Map(plan.map(e => [e.collectorName, e]))

    // The required signals: codex rate-limit + reset, Claude usage snapshot,
    // prepaid API balance, provider cost.
    expect(byName.has('codex-ratelimit')).toBe(true)
    expect(byName.has('anthropic-usage-snapshot')).toBe(true)
    expect(byName.has('deepseek-balance')).toBe(true)
    expect(byName.has('openai-costs')).toBe(true)
    expect(byName.has('github-billing-usage')).toBe(true)
    expect(byName.has('render-plan-report')).toBe(true)
    // The anthropic COST collector shipped with no call site at all before P2-C.
    expect(byName.has('anthropic-cost-report')).toBe(true)

    // A capacity figure is worthless a day stale; a month-to-date cost is not.
    expect(byName.get('codex-ratelimit')!.cadenceSeconds).toBe(HOURLY)
    expect(byName.get('deepseek-balance')!.cadenceSeconds).toBe(HOURLY)
    expect(byName.get('anthropic-usage-snapshot')!.cadenceSeconds).toBe(HOURLY)
    expect(byName.get('openai-costs')!.cadenceSeconds).toBe(DAILY)
    expect(byName.get('render-plan-report')!.cadenceSeconds).toBe(DAILY)

    for (const e of plan) expect(['capacity', 'cost']).toContain(e.kind)
    // The tick must be finer than the finest cadence, or an "hourly" collector is not hourly.
    expect(COLLECTOR_TICK_MS / 1000).toBeLessThan(HOURLY)
  })
})

describe('P2-C due-check (restart-safe, derived from import_runs)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function recordRun(collector: string, at: number, status = 'ok'): void {
    getDb().prepare(`
      INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count)
      VALUES ('p', ?, ?, ?, ?, 1)
    `).run(collector, at, at, status)
  }

  it('2. a collector that has never run is due, and its last-run is null', () => {
    expect(lastCollectorRunAt(getDb(), 'codex-ratelimit')).toBeNull()
    expect(isCollectorDue(getDb(), 'codex-ratelimit', HOURLY, NOW)).toBe(true)
  })

  it('3. within the cadence it is NOT due -- a restart does not re-hammer the provider', () => {
    recordRun('codex-ratelimit', NOW - 600)
    expect(isCollectorDue(getDb(), 'codex-ratelimit', HOURLY, NOW)).toBe(false)
    expect(isCollectorDue(getDb(), 'codex-ratelimit', HOURLY, NOW + HOURLY)).toBe(true)
  })

  it('4. an EXTERNAL sync counts too, so the in-process runner does not double-run it', () => {
    // This is the pre-existing out-of-repo cron's row: same collector_name.
    recordRun('render-plan-report', NOW - 2 * 3600)
    expect(isCollectorDue(getDb(), 'render-plan-report', DAILY, NOW)).toBe(false)
  })

  it('4b. a FAILED run still paces the collector (no 15-minute retry storm on a dead credential)', () => {
    recordRun('github-billing-usage', NOW - 3600, 'error')
    expect(isCollectorDue(getDb(), 'github-billing-usage', DAILY, NOW)).toBe(false)
  })
})

describe('P2-C sweep', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('runs every due collector once and reports each outcome', async () => {
    const calls: string[] = []
    const report = await runScheduledCollectorSync(getDb(), NOW, { runners: stubAll(calls) })
    expect(report.outcomes).toHaveLength(buildCollectorPlan().length)
    expect(calls).toHaveLength(buildCollectorPlan().length)
    expect(report.skipped_not_due).toEqual([])
    expect(report.outcomes.every(o => o.status === 'ok')).toBe(true)
  })

  it('5. one collector THROWING does not stop the others (real throw, not a mocked status)', async () => {
    const calls: string[] = []
    const runners = stubAll(calls)
    runners['codex-ratelimit'] = async () => { throw new Error('codex app-server timeout') }
    const report = await runScheduledCollectorSync(getDb(), NOW, { runners })

    const codex = report.outcomes.find(o => o.collector === 'codex-ratelimit')!
    expect(codex.status).toBe('error')
    expect(codex.imported_count).toBe(0)
    expect(codex.blocker).toContain('timeout')
    // Everything else still ran.
    expect(report.outcomes.filter(o => o.status === 'ok')).toHaveLength(buildCollectorPlan().length - 1)
  })

  it('5b. a thrown secret-shaped string is sanitized before it reaches the report or the DB', async () => {
    const runners = stubAll([])
    runners['openai-costs'] = async () => { throw new Error('openai api 401 for sk-abcdefghijklmnopqrstuvwx') }
    const report = await runScheduledCollectorSync(getDb(), NOW, { runners })
    const oa = report.outcomes.find(o => o.collector === 'openai-costs')!
    expect(oa.blocker).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    const row = getDb().prepare(
      "SELECT error_message_sanitized m FROM import_runs WHERE collector_name='openai-costs' ORDER BY id DESC LIMIT 1",
    ).get() as { m: string | null } | undefined
    if (row?.m) expect(row.m).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  it('6. a collector that bails without recording gets a run row anyway, so it stays paced', async () => {
    const runners = stubAll([])
    // Mirrors the real no-credential path: returns early, writes nothing itself.
    runners['github-billing-usage'] = async () => ({
      provider: 'github', collector: 'github-billing-usage', status: 'skipped' as const,
      imported_count: 0, blocker: 'no GitHub token in vault (github_plan)',
    })
    await runScheduledCollectorSync(getDb(), NOW, { runners })

    const row = getDb().prepare(`
      SELECT status, imported_count, error_message_sanitized m
      FROM import_runs WHERE collector_name = 'github-billing-usage' ORDER BY id DESC LIMIT 1
    `).get() as { status: string; imported_count: number; m: string | null }
    expect(row.status).toBe('skipped')      // not 'ok', not 'error'
    expect(row.imported_count).toBe(0)
    expect(row.m).toContain('github_plan')
    // And that row is what stops a retry every 15 minutes.
    expect(isCollectorDue(getDb(), 'github-billing-usage', DAILY, NOW)).toBe(false)
  })

  it('6b. a collector that records its OWN run row is not double-recorded', async () => {
    const runners = stubAll([])
    runners['deepseek-balance'] = async (db, now) => {
      db.prepare(`
        INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count)
        VALUES ('deepseek','deepseek-balance', ?, ?, 'ok', 1)
      `).run(now, now)
      return { provider: 'deepseek', collector: 'deepseek-balance', status: 'ok' as const, imported_count: 1, blocker: null }
    }
    await runScheduledCollectorSync(getDb(), NOW, { runners })
    const n = getDb().prepare("SELECT COUNT(*) c FROM import_runs WHERE collector_name='deepseek-balance'").get() as { c: number }
    expect(n.c).toBe(1)
  })

  it('skips a collector that is not due, and names it', async () => {
    const calls: string[] = []
    const runners = stubAll(calls)
    await runScheduledCollectorSync(getDb(), NOW, { runners })
    calls.length = 0

    // 30 minutes later: only nothing is due (finest cadence is hourly).
    const second = await runScheduledCollectorSync(getDb(), NOW + 1800, { runners })
    expect(calls).toEqual([])
    expect(second.outcomes).toEqual([])
    expect(second.skipped_not_due.length).toBe(buildCollectorPlan().length)

    // An hour later the capacity collectors come due, the daily cost ones do not.
    const third = await runScheduledCollectorSync(getDb(), NOW + HOURLY, { runners })
    expect(third.outcomes.map(o => o.collector).sort()).toEqual(
      ['anthropic-usage-snapshot', 'codex-ratelimit', 'deepseek-balance'],
    )
  })

  it('7. force ignores the cadence (what POST /api/costs/sync?provider=all uses)', async () => {
    const calls: string[] = []
    const runners = stubAll(calls)
    await runScheduledCollectorSync(getDb(), NOW, { runners })
    calls.length = 0
    const forced = await runScheduledCollectorSync(getDb(), NOW + 60, { runners, force: true })
    expect(calls).toHaveLength(buildCollectorPlan().length)
    expect(forced.skipped_not_due).toEqual([])
  })
})
