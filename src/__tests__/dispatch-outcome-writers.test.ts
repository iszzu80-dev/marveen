// P2-A gate closure: the `failed` / `retry` outcome states now have LIVE writers.
//
// Before this, `accepted` (kanban status->done) was the ONLY outcome anything
// ever wrote, so `failed`/`cancelled`/`retry` were dead enum values in practice
// and every non-accepted dispatch relied purely on the 6h window cap.
//
// The writers added here fire ONLY on mechanisms that already produced a
// deterministic terminal decision in production code -- a terminal
// markMessageFailed() in the message router, and the worker's timeout /
// session-death branches. Nothing is inferred: a delivered-but-unjudged dispatch
// stays `unknown`, which is the specified behaviour (spec 7.2). History is never
// backfilled.
//
// The router writers are proven at RUNTIME here (real in-memory DB, real
// getPendingMessages/markMessageFailed, a real dispatch row). The worker writers
// are tmux-driven and asserted at the source level, the same standard the rest
// of the P2-A origin wiring uses (dispatch-threading.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8')

// ---------------------------------------------------------------------------
// Runtime harness: the real DB + the real router, tmux and config stubbed out.
// ---------------------------------------------------------------------------

const mockSendPrompt = vi.fn(async (..._a: unknown[]) => undefined)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // Keep the sub-agent Telegram wake watcher inert so this file stays scoped to
  // outcome writing.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  // P2-C: the router now stamps the dispatch identity columns, which reads the
  // agent's model + login binding through these. Doubled explicitly so the tick
  // exercises the REAL stamping path rather than silently falling into
  // resolveDispatchIdentitySafe's fault branch.
  resolveAgentModelDetailed: () => ({ model: 'claude-sonnet-5', source: 'explicit_model' }),
  readAgentModelProfile: () => null,
  readAgentClaudePlan: () => null,
  readAgentClaudeConfigDir: () => null,
  expandAndValidateConfigDir: () => null,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'body' }),
}))

vi.mock('../web/data-sensitivity-gate-runner.js', () => ({
  checkDispatchGate: () => ({ shouldBlock: false, result: { reason: null }, auditEntry: null }),
  checkGateLiveness: () => undefined,
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: () => undefined,
}))

vi.mock('../web/transcript-sources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/transcript-sources.js')>()),
  resolveCurrentSessionId: () => 'sess-router-1',
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: () => ({ enabled: false, peers: [] }),
  abandonWindowMsForPeer: () => 60 * 60 * 1000,
}))

vi.mock('../web/federation/bridge.js', () => ({
  sendFederatedMessage: async () => ({ ok: false, error: 'disabled' }),
}))

const { initDatabase, getDb } = await import('../db.js')
const { runMessageRouterTick } = await import('../web/message-router.js')
const { resolveOutcome, createDispatch } = await import('../costops/dispatch.js')

interface OutcomeRow {
  dispatch_id: string
  outcome: string
  evidence: string | null
  retry_of: string | null
}

const outcomesFor = (dispatchId: string): OutcomeRow[] =>
  getDb()
    .prepare('SELECT dispatch_id, outcome, evidence, retry_of FROM dispatch_outcomes WHERE dispatch_id = ? ORDER BY rowid')
    .all(dispatchId) as OutcomeRow[]

// Explicit, monotonically increasing message ids ACROSS tests. The router keeps
// per-message retry state in module-level maps keyed by msg.id, while each test
// starts a fresh :memory: DB whose AUTOINCREMENT restarts at 1 -- reusing id 1
// would leak one test's retry state into the next. Production ids never repeat,
// so this models reality rather than papering over a bug.
let nextMsgId = 1000

/** Queue one pending inter-agent message carrying an upstream dispatch_id. */
function enqueueWithDispatch(dispatchId: string | null): number {
  const id = nextMsgId++
  getDb()
    .prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, dispatch_id)
       VALUES (?, 'orin', 'dex', 'ping', 'pending', ?, ?)`,
    )
    .run(id, Math.floor(Date.now() / 1000), dispatchId)
  return id
}

// MAX_INJECT_FAILURES is 3 in message-router.ts: attempts 1 and 2 are `retry`,
// attempt 3 gives up and is `failed`.
const MAX_ATTEMPTS = 3

describe('P2-A live writer: `failed` on the message-router give-up path', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    vi.clearAllMocks()
    mockSendPrompt.mockImplementation(async () => undefined)
  })

  it('writes `failed` with mechanism evidence once the inject retries are exhausted', async () => {
    const db = getDb()
    const dispatchId = createDispatch(db, { source: 'kanban', agent: 'dex', cardId: 'card-1', sessionId: 'sess-router-1' })
    const msgId = enqueueWithDispatch(dispatchId)

    // Every inject throws -> the router retries across ticks, then gives up.
    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux send-keys failed') })
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runMessageRouterTick()

    expect(resolveOutcome(db, dispatchId)).toBe('failed')
    const rows = outcomesFor(dispatchId)
    const failed = rows.filter(r => r.outcome === 'failed')
    expect(failed).toHaveLength(1)
    // Evidence names the MECHANISM, not a verdict.
    expect(failed[0].evidence).toBe('message-router:inject-giveup-after-3-attempts:markMessageFailed')
    // ...and the message really was marked failed by the same branch.
    const msg = db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(msgId) as { status: string }
    expect(msg.status).toBe('failed')
  })

  it('writes `retry` (non-terminal) on each attempt before the give-up, with retry_of when the prior dispatch differs', async () => {
    const db = getDb()
    const dispatchId = createDispatch(db, { source: 'scheduler', agent: 'dex', sessionId: 'sess-router-1' })
    enqueueWithDispatch(dispatchId)

    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux send-keys failed') })
    await runMessageRouterTick()

    const rows = outcomesFor(dispatchId)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('retry')
    expect(rows[0].evidence).toBe('message-router:inject-threw-attempt-1-of-3-will-retry')
    // The SAME upstream dispatch id is reused across attempts here, so there is
    // no distinct prior dispatch -- retry_of stays NULL instead of pointing at
    // itself. (A bare inter-agent message mints a fresh dispatch per attempt;
    // that is the case where retry_of is genuinely knowable.)
    expect(rows[0].retry_of).toBeNull()
    // 'retry' must not be terminal: it may not close the attribution window.
    const { TERMINAL_OUTCOMES } = await import('../costops/dispatch.js')
    expect(TERMINAL_OUTCOMES).not.toContain('retry')
  })

  it('links attempt N to attempt N-1 via retry_of when each attempt mints its own dispatch', async () => {
    const db = getDb()
    // No upstream dispatch_id on the message -> the router mints a fresh
    // 'message'-source dispatch on every attempt, so the prior attempt's
    // dispatch is a real, distinct id.
    enqueueWithDispatch(null)

    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux send-keys failed') })
    await runMessageRouterTick()
    await runMessageRouterTick()

    const minted = db
      .prepare("SELECT dispatch_id FROM dispatches WHERE source = 'message' ORDER BY rowid")
      .all() as { dispatch_id: string }[]
    expect(minted).toHaveLength(2)
    const [first, second] = minted.map(r => r.dispatch_id)

    const firstRows = outcomesFor(first)
    expect(firstRows.map(r => r.outcome)).toEqual(['retry'])
    expect(firstRows[0].retry_of).toBeNull() // no prior attempt existed

    const secondRows = outcomesFor(second)
    expect(secondRows.map(r => r.outcome)).toEqual(['retry'])
    expect(secondRows[0].retry_of).toBe(first) // chained to the previous attempt
  })

  it('a SUCCESSFUL delivery writes no outcome at all -- delivered is not accepted, and not failed', async () => {
    const db = getDb()
    const dispatchId = createDispatch(db, { source: 'kanban', agent: 'dex', cardId: 'card-ok', sessionId: 'sess-router-1' })
    const msgId = enqueueWithDispatch(dispatchId)

    await runMessageRouterTick()

    expect(mockSendPrompt).toHaveBeenCalled()
    const msg = db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(msgId) as { status: string }
    expect(msg.status).toBe('delivered')
    // No row -> resolveOutcome() reports the honest 'unknown'.
    expect(outcomesFor(dispatchId)).toHaveLength(0)
    expect(resolveOutcome(db, dispatchId)).toBe('unknown')
  })

  it('an un-instrumented message (no dispatch anywhere) produces no outcome row on give-up', async () => {
    const db = getDb()
    // channel-inbound would be the real un-instrumented case; here we simply
    // assert the writers never invent a dispatch to attach an outcome to.
    enqueueWithDispatch(null)
    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux send-keys failed') })
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runMessageRouterTick()

    const minted = db.prepare("SELECT dispatch_id FROM dispatches WHERE source = 'message'").all() as { dispatch_id: string }[]
    // Only the dispatches the router itself minted have outcomes; no orphan rows.
    const orphans = db
      .prepare('SELECT COUNT(*) c FROM dispatch_outcomes WHERE dispatch_id NOT IN (SELECT dispatch_id FROM dispatches)')
      .get() as { c: number }
    expect(orphans.c).toBe(0)
    expect(minted.length).toBeGreaterThan(0)
  })

  it('re-running ticks after the give-up does not append more outcomes (idempotent, no flipping)', async () => {
    const db = getDb()
    const dispatchId = createDispatch(db, { source: 'kanban', agent: 'dex', cardId: 'card-2', sessionId: 'sess-router-1' })
    enqueueWithDispatch(dispatchId)

    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux send-keys failed') })
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runMessageRouterTick()
    const afterGiveUp = outcomesFor(dispatchId)

    // The message is 'failed' now, so it is no longer pending: further ticks are
    // no-ops and cannot re-judge the dispatch.
    await runMessageRouterTick()
    await runMessageRouterTick()

    expect(outcomesFor(dispatchId)).toEqual(afterGiveUp)
    expect(resolveOutcome(db, dispatchId)).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Source-level assertions for the branches that are not unit-runnable, plus the
// "no invented outcome" guarantees.
// ---------------------------------------------------------------------------

describe('P2-A outcome writers: source-level guarantees', () => {
  const ROUTER = read('../web/message-router.ts')
  const WORKER = read('../web/agent-worker.ts')
  const DISPATCH = read('../costops/dispatch.ts')

  it('recordOutcomeSafe swallows and logs, never rethrows into a delivery path', () => {
    const idx = DISPATCH.indexOf('export function recordOutcomeSafe(')
    expect(idx).toBeGreaterThan(0)
    const body = DISPATCH.slice(idx, DISPATCH.indexOf('\n}', idx))
    expect(body).toMatch(/try \{\s*\n\s*return recordOutcome\(db, input, now\)/)
    expect(body).toMatch(/\} catch \(err\) \{/)
    expect(body).toMatch(/logger\.warn\(/)
    expect(body).toMatch(/return null/)
    expect(body).not.toMatch(/throw/)
  })

  it('every router outcome write goes through the fault-isolated helper', () => {
    // The router must never call the raw recordOutcome (it would throw into the
    // branch that is already handling a delivery failure).
    expect(ROUTER).not.toMatch(/[^e]recordOutcome\(/)
    expect(ROUTER).toMatch(/recordOutcomeSafe\(getDb\(\), \{ dispatchId, outcome, evidence, retryOf \}\)/)
    // At most one outcome row per message per tick (the outer catch also fires
    // for throws raised inside the inner catch).
    expect(ROUTER).toMatch(/if \(!dispatchId \|\| dispatchOutcomeWrittenThisTick\) return/)
  })

  it('the router writes `failed` on all three terminal markMessageFailed branches', () => {
    for (const evidence of [
      'message-router:abandoned-session-absent-full-window:markMessageFailed',
      'message-router:inject-giveup-after-${failCount}-attempts:markMessageFailed',
      'message-router:delivery-error:markMessageFailed',
    ]) {
      expect(ROUTER).toContain(evidence)
    }
  })

  it('the worker writes `failed` only on its two deterministic dead-end signals', () => {
    expect(WORKER).toMatch(/import \{ createDispatchSafe, recordOutcomeSafe \} from '\.\.\/costops\/dispatch\.js'/)
    expect(WORKER).toMatch(/if \(dispatchId\) recordOutcomeSafe\(getDb\(\), \{ dispatchId, outcome: 'failed', evidence: 'agent-worker:request-timeout' \}\)/)
    expect(WORKER).toMatch(/if \(dispatchId\) recordOutcomeSafe\(getDb\(\), \{ dispatchId, outcome: 'failed', evidence: 'agent-worker:session-died-mid-request' \}\)/)
    // The auth-failure branch is a re-seed + retry-once + SDK-fallback path with
    // no single deterministic verdict, so it deliberately writes NOTHING.
    expect(WORKER).not.toMatch(/evidence: 'agent-worker:auth/)
  })

  it('NO writer invents `cancelled` -- there is no cancellation signal in the codebase', () => {
    // A `cancelled` writer would have to be manufactured; spec 7.2 says the
    // honest state for a path with no reliable evidence is `unknown`.
    for (const src of [ROUTER, WORKER]) {
      expect(src).not.toMatch(/outcome: 'cancelled'/)
    }
  })

  it('no writer backfills history: every write targets a dispatch minted in the same flow', () => {
    // The writers only ever pass the in-scope `dispatchId`; no query selects old
    // dispatches to judge them retroactively.
    expect(ROUTER).not.toMatch(/FROM dispatches/)
    expect(WORKER).not.toMatch(/FROM dispatches/)
  })
})
