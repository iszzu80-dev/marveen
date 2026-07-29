// P2-A gate closure: correlateTokenUsageToDispatches() is INVOKED in production.
//
// The rule itself was correct and unit-tested (costops-dispatch.test.ts), but it
// had ZERO non-test call sites -- so in production `token_usage.dispatch_id`
// stayed NULL forever and cost_per_accepted_task had no marginal input. Storage
// restored is not invocation restored. This file proves the invocation:
//
//   1. source level -- the call is chained inside collectTokenUsage(), the ONE
//      function every collection path goes through, and each enumerated path
//      (hourly interval, startup pass, POST /api/token-usage/collect) reaches it;
//   2. runtime -- a real collection over a fixture transcript actually attributes
//      the rows it just wrote to a real dispatch;
//   3. fault isolation -- a REAL correlation fault (missing P2-A table) does not
//      break the collection that already wrote token rows;
//   4. idempotency -- collecting twice does not double-attribute.
//
// Tests 2-4 fail if the correlation call is removed from collectTokenUsage, and
// test 3 fails if the fault-isolation wrapper is removed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8')

// ---------------------------------------------------------------------------
// 1. Source-level wiring
// ---------------------------------------------------------------------------

describe('P2-A: the correlation is wired into every collection path (source)', () => {
  const COLLECTOR = read('../web/token-usage.ts')
  const WEB = read('../web.ts')
  const ROUTE = read('../web/routes/token-usage.ts')
  const DISPATCH = read('../costops/dispatch.ts')

  it('collectTokenUsage() calls the correlation, fault-isolated, and returns the count', () => {
    const idx = COLLECTOR.indexOf('export async function collectTokenUsage(')
    expect(idx).toBeGreaterThan(0)
    const body = COLLECTOR.slice(idx)
    // The _Safe variant specifically: the raw function would throw into the
    // collection path (see the fault-isolation test below).
    expect(body).toMatch(/const dispatchAttributed = correlateTokenUsageToDispatchesSafe\(db\)/)
    expect(body).toMatch(/return \{ inserted: totalInserted, files: totalFiles, dispatchAttributed \}/)
    expect(COLLECTOR).toMatch(/import \{ correlateTokenUsageToDispatchesSafe \} from '\.\.\/costops\/dispatch\.js'/)
    // The unwrapped function must NOT be the one called from the hot path.
    expect(body).not.toMatch(/[^e]correlateTokenUsageToDispatches\(db\)/)
  })

  it('the _Safe wrapper swallows and logs, never rethrows', () => {
    const idx = DISPATCH.indexOf('export function correlateTokenUsageToDispatchesSafe(')
    expect(idx).toBeGreaterThan(0)
    const body = DISPATCH.slice(idx, DISPATCH.indexOf('\n}', idx))
    expect(body).toMatch(/try \{\s*\n\s*return correlateTokenUsageToDispatches\(db, opts\)/)
    expect(body).toMatch(/\} catch \(err\) \{/)
    expect(body).toMatch(/logger\.warn\(/)
    expect(body).toMatch(/return 0/)
    expect(body).not.toMatch(/throw/)
  })

  it('both web.ts collection paths (hourly interval + startup) go through collectTokenUsage', () => {
    // Chaining inside collectTokenUsage is what makes these two inherit the
    // correlation; assert they really are collectTokenUsage callers.
    expect(WEB).toMatch(/setInterval\(\(\) => \{\s*\n\s*collectTokenUsage\(\)\.catch\(err => logger\.warn\(\{ err \}, 'Periodic token usage collection failed'\)\)/)
    expect(WEB).toMatch(/collectTokenUsage\(\)\.catch\(err => logger\.warn\(\{ err \}, 'Startup token usage collection failed'\)\)/)
  })

  it('POST /api/token-usage/collect reports dispatchAttributed in its response', () => {
    expect(ROUTE).toMatch(/const \{ inserted, files, dispatchAttributed \} = await collectTokenUsage\(\)/)
    expect(ROUTE).toMatch(/json\(res, \{ ok: true, inserted, files, dispatchAttributed \}\)/)
  })
})

// ---------------------------------------------------------------------------
// 2-4. Runtime behaviour
// ---------------------------------------------------------------------------

// Fixture transcript dir, swapped in for the caller's real ~/.claude/projects.
let FIXTURE_DIR = ''
const FIXTURE_AGENT = 'corr-agent'
const FIXTURE_SESSION = 'sess-corr-1'

vi.mock('../web/transcript-sources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/transcript-sources.js')>()),
  discoverAgentSources: () => (FIXTURE_DIR ? [{ agent: FIXTURE_AGENT, projectDir: FIXTURE_DIR }] : []),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { initDatabase, getDb } = await import('../db.js')
const { collectTokenUsage } = await import('../web/token-usage.js')
const { createDispatch } = await import('../costops/dispatch.js')

// Deterministic epoch (seconds); token rows land 10s and 20s after the dispatch,
// far inside the default 6h attribution cap.
const T0_SEC = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const isoAt = (offsetSec: number) => new Date((T0_SEC + offsetSec) * 1000).toISOString()

function assistantLine(offsetSec: number, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: FIXTURE_SESSION,
    timestamp: isoAt(offsetSec),
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: inputTokens,
        output_tokens: 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'fixture output' }],
    },
  })
}

function writeFixtureTranscript(): void {
  writeFileSync(
    join(FIXTURE_DIR, `${FIXTURE_SESSION}.jsonl`),
    [assistantLine(10, 1000), assistantLine(20, 1100)].join('\n'),
  )
}

describe('P2-A: the correlation actually RUNS after a collection (runtime)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'p2a-corr-'))
    writeFixtureTranscript()
  })

  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
    FIXTURE_DIR = ''
  })

  it('collect -> the freshly-written token rows are attributed to the dispatch', async () => {
    const db = getDb()
    const dispatchId = createDispatch(
      db,
      { source: 'scheduler', agent: FIXTURE_AGENT, sessionId: FIXTURE_SESSION },
      T0_SEC * 1000,
    )

    const result = await collectTokenUsage()

    expect(result.inserted).toBe(2)
    // The number is reported, not just applied -- this is what the manual route
    // surfaces so the wiring is observable rather than invisible.
    expect(result.dispatchAttributed).toBe(2)

    const rows = db
      .prepare('SELECT timestamp, dispatch_id FROM token_usage ORDER BY timestamp')
      .all() as { timestamp: number; dispatch_id: string | null }[]
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.dispatch_id)).toEqual([dispatchId, dispatchId])
  })

  it('rows outside any dispatch window stay unattributed (no invented bucket)', async () => {
    const db = getDb()
    // Dispatch starts AFTER both token rows -> forward-only rule 1 excludes them.
    createDispatch(
      db,
      { source: 'scheduler', agent: FIXTURE_AGENT, sessionId: FIXTURE_SESSION },
      (T0_SEC + 3600) * 1000,
    )

    const result = await collectTokenUsage()

    expect(result.inserted).toBe(2)
    expect(result.dispatchAttributed).toBe(0)
    const nulls = db
      .prepare('SELECT COUNT(*) c FROM token_usage WHERE dispatch_id IS NULL')
      .get() as { c: number }
    expect(nulls.c).toBe(2)
  })

  it('collecting twice does not double-attribute or re-link rows (idempotent)', async () => {
    const db = getDb()
    const dispatchId = createDispatch(
      db,
      { source: 'scheduler', agent: FIXTURE_AGENT, sessionId: FIXTURE_SESSION },
      T0_SEC * 1000,
    )

    const first = await collectTokenUsage()
    expect(first.dispatchAttributed).toBe(2)

    // Second pass: touch the file so the size cursor does not short-circuit the
    // re-read, i.e. the collection genuinely runs again over the same rows.
    writeFixtureTranscript()
    writeFileSync(
      join(FIXTURE_DIR, `${FIXTURE_SESSION}.jsonl`),
      [assistantLine(10, 1000), assistantLine(20, 1100), ''].join('\n'),
    )
    const second = await collectTokenUsage()

    // Nothing left with dispatch_id IS NULL to attribute -> 0 newly linked.
    expect(second.dispatchAttributed).toBe(0)
    const rows = db
      .prepare('SELECT dispatch_id FROM token_usage')
      .all() as { dispatch_id: string | null }[]
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.dispatch_id === dispatchId)).toBe(true)
    // And no duplicate outcome/dispatch rows appeared.
    const dispatches = db.prepare('SELECT COUNT(*) c FROM dispatches').get() as { c: number }
    expect(dispatches.c).toBe(1)
  })

  it('a REAL correlation fault does not break the collection (fault isolation)', async () => {
    const db = getDb()
    createDispatch(
      db,
      { source: 'scheduler', agent: FIXTURE_AGENT, sessionId: FIXTURE_SESSION },
      T0_SEC * 1000,
    )
    // Not a mocked throw: remove the table the correlation reads, so
    // correlateTokenUsageToDispatches() raises a genuine SQLite error inside the
    // collection path. Without the _Safe wrapper this rejects the whole promise
    // and the real token rows are reported as a failed collection.
    db.exec('DROP TABLE dispatches')

    const result = await collectTokenUsage()

    expect(result.inserted).toBe(2)      // the real work still landed
    expect(result.files).toBe(1)
    expect(result.dispatchAttributed).toBe(0) // measurement degraded, visibly
    const stored = db.prepare('SELECT COUNT(*) c FROM token_usage').get() as { c: number }
    expect(stored.c).toBe(2)
  })
})
