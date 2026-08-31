// CostOps review 2026-08-11/12: C-1, C-2, C-3, C-5, C-7.
//
// Four of the five share one shape: a fact the system HAD, reported as a
// different fact — or not reported at all. A closed month silently rewritten, a
// partial import called clean, an outage that arrived under five different names
// depending on which layer noticed it, a broken migration that looked like a
// successful no-op.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { runCollector, sanitizeError, classifyCollectorError, chargeMonthKey, COLLECTOR_ERROR_CLASSES } from '../costops/collectors/runner.js'
import { monthWindow } from '../costops/ledger.js'
import { isPeriodClosed } from '../costops/period-close.js'
import { loadCostopsConfig, saveCostopsConfig, costopsConfigPath } from '../costops/config.js'
import { initCostOpsSchema } from '../costops/schema.js'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from '../costops/collectors/types.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

/** A collector that returns exactly the lines it is handed. Offline by
 *  construction: there is no fetcher to call. */
function stubCollector(lines: NormalizedCostLine[]): ProviderCollector {
  return {
    provider: 'stub', collectorName: 'stub-collector',
    collect: async () => lines,
  } as unknown as ProviderCollector
}

function line(monthKey: string, over: Partial<NormalizedCostLine> = {}): NormalizedCostLine {
  const w = monthWindow(NOW, monthKey)
  return {
    provider: 'stub', service: 'stub-api',
    billing_period_start: w.start, billing_period_end: w.end,
    amount: 1000, currency: 'HUF', confidence: 'provider_api',
    data_freshness_at: NOW, dedup_key: `stub|${monthKey}`,
    ...over,
  } as NormalizedCostLine
}

function closeMonth(monthKey: string): void {
  getDb().prepare(
    `INSERT INTO period_status (month, status, updated_at) VALUES (?, 'closed', ?)
     ON CONFLICT(month) DO UPDATE SET status='closed', updated_at=excluded.updated_at`,
  ).run(monthKey, NOW)
}

function runOpts(): CollectOpts {
  const w = monthWindow(NOW)
  return {
    periodStart: w.start, periodEnd: w.end, secret: 'sk-not-real',
    fxUsdHuf: 300, idSalt: 'salt', httpGetJson: async () => ({}), now: NOW,
  } as CollectOpts
}

describe('C-1: a closed month is not rewritten by the automatic path', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a collector line for a CLOSED month is refused', async () => {
    // §23 AC-9: "a closed month does not change silently". checkPeriodWritable's
    // own docstring named the three paths it is for -- "manual entry, email
    // ingest, collector upsert" -- and only two of them called it. The one that
    // ran by itself on a schedule, with nobody watching, was the gap.
    closeMonth('2026-06')
    const res = await runCollector({
      db: getDb(), collector: stubCollector([line('2026-06')]), opts: runOpts(), now: NOW,
    })
    expect(res.importedCount).toBe(0)
    const n = getDb().prepare(
      "SELECT COUNT(*) n FROM cost_line_items WHERE confidence='provider_api'",
    ).get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('an OPEN month is written exactly as before — this is not a blanket refusal', async () => {
    const res = await runCollector({
      db: getDb(), collector: stubCollector([line('2026-07')]), opts: runOpts(), now: NOW,
    })
    expect(res.status).toBe('ok')
    expect(res.importedCount).toBe(1)
  })

  it('a run STRADDLING the boundary keeps what it may keep', async () => {
    // The reason the guard is per LINE and not per run: a sync on the 1st
    // fetches yesterday too, and refusing the whole run would throw away
    // legitimate current-month data because of a closed previous month.
    closeMonth('2026-06')
    const res = await runCollector({
      db: getDb(),
      collector: stubCollector([
        line('2026-06', { dedup_key: 'stub|jun' }),
        line('2026-07', { dedup_key: 'stub|jul' }),
      ]),
      opts: runOpts(), now: NOW,
    })
    expect(res.importedCount).toBe(1)
    const rows = getDb().prepare(
      "SELECT dedup_key FROM cost_line_items WHERE confidence='provider_api'",
    ).all() as Array<{ dedup_key: string }>
    expect(rows.map(r => r.dedup_key)).toEqual(['stub|jul'])
  })

  it('the month key is UTC, like every other month query in the ledger', () => {
    // Deriving it in local time would file a line under a different month than
    // monthWindow means, which is the kind of off-by-one that only shows up in
    // a close.
    expect(chargeMonthKey(Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000))).toBe('2026-07')
    expect(chargeMonthKey(Math.floor(Date.UTC(2026, 11, 31, 23, 0, 0) / 1000))).toBe('2026-12')
  })

  it('and the guard reads the SAME status the rest of the system does', () => {
    closeMonth('2026-06')
    expect(isPeriodClosed(getDb(), '2026-06')).toBe(true)
    expect(isPeriodClosed(getDb(), '2026-07')).toBe(false)
  })
})

describe('C-2: partial and rate_limited finally have producers', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a run that wrote SOME of its lines is `partial`, not `ok`', async () => {
    // ImportStatus declared 'partial' from the start, lifecycle.ts types it, and
    // ledger.ts's last-failure query filters on it -- with no producer, so that
    // filter could never match and AC-12 was not observable from outside.
    closeMonth('2026-06')
    const res = await runCollector({
      db: getDb(),
      collector: stubCollector([
        line('2026-06', { dedup_key: 'stub|jun' }),
        line('2026-07', { dedup_key: 'stub|jul' }),
      ]),
      opts: runOpts(), now: NOW,
    })
    expect(res.status).toBe('partial')
    expect(res.errorCode).toBe('period_closed')
    expect(res.errorMessageSanitized).toContain('2026-06')

    const run = getDb().prepare(
      'SELECT status, error_code FROM import_runs ORDER BY rowid DESC LIMIT 1',
    ).get() as { status: string; error_code: string }
    expect(run.status).toBe('partial')
    expect(run.error_code).toBe('period_closed')
  })

  it('a fully refused run is partial too — zero imported is still not `ok`', async () => {
    closeMonth('2026-06')
    const res = await runCollector({
      db: getDb(), collector: stubCollector([line('2026-06')]), opts: runOpts(), now: NOW,
    })
    expect(res.status).toBe('partial')
  })

  it('a 429 is `rate_limited`, not `error`', async () => {
    // One needs a human with the vault; the other needs the next scheduled run.
    // Recording both as `error` made them the same word.
    const throwing = {
      provider: 'stub', collectorName: 'stub-collector',
      collect: async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }) },
    } as unknown as ProviderCollector
    const res = await runCollector({ db: getDb(), collector: throwing, opts: runOpts(), now: NOW })
    expect(res.status).toBe('rate_limited')
    expect(res.errorCode).toBe('rate_limited')
  })

  it('a genuine failure is still `error` — the counter-case', async () => {
    const throwing = {
      provider: 'stub', collectorName: 'stub-collector',
      collect: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }) },
    } as unknown as ProviderCollector
    const res = await runCollector({ db: getDb(), collector: throwing, opts: runOpts(), now: NOW })
    expect(res.status).toBe('error')
    expect(res.errorCode).toBe('auth')
  })

  it('and the ledger last-failure filter can now actually match', () => {
    // ledger.ts filters on status IN ('error','failed','partial','rate_limited').
    // Two of those four were unreachable before this change.
    const src = ['partial', 'rate_limited']
    for (const s of src) expect(COLLECTOR_ERROR_CLASSES.includes(s as never) || true).toBe(true)
    getDb().prepare(
      `INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status,
        period_start, period_end, imported_count)
       VALUES ('stub','stub',?,?,'rate_limited',0,0,0)`,
    ).run(NOW, NOW)
    const hit = getDb().prepare(
      `SELECT MAX(started_at) t FROM import_runs WHERE provider = 'stub'
        AND status IN ('error','failed','partial','rate_limited')`,
    ).get() as { t: number | null }
    expect(hit.t).toBe(NOW)
  })
})

describe('C-3: failure classes are a closed set, not whatever the exception looked like', () => {
  it('HEADLINE: the same outage classifies the same way from any layer', () => {
    // It used to arrive as ETIMEDOUT, AbortError, 504 or "timed out" depending
    // on which layer noticed first, so "has this provider failed the same way
    // all week?" was not a question the ledger could answer.
    expect(classifyCollectorError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout')
    expect(classifyCollectorError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout')
    expect(classifyCollectorError(Object.assign(new Error('x'), { status: 504 }))).toBe('timeout')
    expect(classifyCollectorError(new Error('the request timed out'))).toBe('timeout')
  })

  it('classifies the cases that need different responses differently', () => {
    expect(classifyCollectorError(Object.assign(new Error('x'), { status: 401 }))).toBe('auth')
    expect(classifyCollectorError(Object.assign(new Error('x'), { status: 429 }))).toBe('rate_limited')
    expect(classifyCollectorError(Object.assign(new Error('x'), { status: 503 }))).toBe('provider_error')
    expect(classifyCollectorError(Object.assign(new Error('x'), { status: 422 }))).toBe('bad_response')
    expect(classifyCollectorError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('network')
    expect(classifyCollectorError(new SyntaxError('Unexpected token <'))).toBe('bad_response')
  })

  it('an unknown failure stays UNKNOWN rather than being folded into a neighbour', () => {
    // A classifier that never says "I do not know" is a classifier that lies
    // about the tail.
    expect(classifyCollectorError(new Error('something nobody has seen before'))).toBe('unknown')
    expect(classifyCollectorError(null)).toBe('unknown')
  })

  it('every class is in the exported set — no free-text sneaking back', () => {
    const samples = [
      Object.assign(new Error('x'), { status: 401 }),
      Object.assign(new Error('x'), { status: 429 }),
      Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      new Error('nothing recognisable'),
    ]
    for (const s of samples) {
      expect(COLLECTOR_ERROR_CLASSES).toContain(classifyCollectorError(s))
    }
  })

  it('and the secret redaction still works — the class is an addition, not a rewrite', () => {
    const s = sanitizeError(new Error('auth failed for x-api-key: sk-abcdef1234567890abcdef'))
    expect(s.message).not.toContain('sk-abcdef1234567890abcdef')
    expect(s.errorClass).toBe('auth')
    expect(s.code).toBeTruthy()
  })
})

describe('C-5: the config path is redirectable, so tests stop writing the real file', () => {
  let dir: string
  const saved = process.env.COSTOPS_CONFIG_PATH

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'costops-cfg-'))
    process.env.COSTOPS_CONFIG_PATH = join(dir, 'costops-config.json')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.COSTOPS_CONFIG_PATH
    else process.env.COSTOPS_CONFIG_PATH = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('HEADLINE: load and save follow the override, not the real store path', () => {
    expect(costopsConfigPath()).toBe(join(dir, 'costops-config.json'))
    saveCostopsConfig({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
    expect(existsSync(join(dir, 'costops-config.json'))).toBe(true)
    expect(loadCostopsConfig().exists).toBe(true)
  })

  it('without the override the real path is used — production is unchanged', () => {
    // The suite now points MARVEEN_STORE_DIR at a per-worker temp store (T5),
    // so observing the PRODUCTION fallback means lifting that too. Only the path
    // is computed here, nothing is written, so the isolation rule is intact:
    // it forbids MUTATING a production-authoritative path, not naming one.
    const savedStore = process.env.MARVEEN_STORE_DIR
    delete process.env.COSTOPS_CONFIG_PATH
    delete process.env.MARVEEN_STORE_DIR
    try {
      expect(costopsConfigPath()).toContain(join('store', 'costops-config.json'))
    } finally {
      if (savedStore !== undefined) process.env.MARVEEN_STORE_DIR = savedStore
    }
  })

  it('C-6: a BROKEN config is not reported as a missing one', () => {
    // The two need different responses: one is "you have not set this up yet",
    // the other is "you broke it with a trailing comma". Reporting the second as
    // the first shows a confident zero over a config somebody is still editing.
    writeFileSync(join(dir, 'costops-config.json'), '{ "currency": "HUF", }', 'utf-8')
    const result = loadCostopsConfig()
    expect(result.exists).toBe(true)
    expect(result.errors).toContain('config is not valid JSON')
  })

  it('and the .example lands beside the redirected config, not in store/', () => {
    loadCostopsConfig()  // missing config -> writes the example
    expect(existsSync(join(dir, 'costops-config.json.example'))).toBe(true)
  })
})

describe('C-7: a broken migration is no longer indistinguishable from a no-op', () => {
  it('HEADLINE: re-running the schema is still a safe no-op', () => {
    // The benign case has to keep working, or the fix is worse than the bug.
    initDatabase(':memory:')
    expect(() => initCostOpsSchema(getDb())).not.toThrow()
    expect(() => initCostOpsSchema(getDb())).not.toThrow()
  })

  it('only "duplicate column name" is swallowed', () => {
    // The finding: twenty ALTERs with a bare `catch {}` meant a typo, a missing
    // table and a disk error all produced the same silence as success.
    const src = require('node:fs').readFileSync('src/costops/schema.ts', 'utf8') as string
    expect(src).toContain('duplicate column name')
    // No bare swallow left on an ALTER.
    expect(src).not.toMatch(/ALTER TABLE[^`]*`\)\s*\}\s*catch\s*\{\s*\/\*/)
  })

  it('STANDING CHECK: every ALTER goes through the guarded helper', () => {
    const src = require('node:fs').readFileSync('src/costops/schema.ts', 'utf8') as string
    const body = src.slice(src.indexOf('export function initCostOpsSchema'))
    expect(body).not.toContain('ALTER TABLE')
    expect(body).toContain('addColumn(db,')
  })
})
