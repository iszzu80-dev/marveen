// APG 1.9 §11.2 -- the execution ROLE reaches the store, from real origins.
//
// The column and the type would be a decoration if no origin wrote them, which
// is exactly the failure mode P2-C had to come back and fix for the model
// columns ("P2-A created them but no origin populated them"). So this file
// proves the write at RUNTIME, against a real in-memory DB, from two
// independent origins -- kanban and the inter-agent router -- rather than
// asserting the source text and hoping.
//
// The kanban case runs unmocked (the route is drivable end to end). The router
// case reuses dispatch-outcome-writers.test.ts's harness: real DB, real
// runMessageRouterTick, tmux and config doubled out. The two tmux-driven
// origins (scheduler, worker) keep the source-level standard the rest of the
// P2-A origin wiring uses -- see dispatch-threading.test.ts for why.
//
// What the roles MEAN, and why they are not all 'producer': a scheduled tick
// and a worker call are executions of something already declared, while a card
// dispatch and a bare inter-agent request ask an agent to author something.
// §26's first invariant ("an agent may not accept its own final output") only
// becomes checkable if that distinction is in the data.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8')

const mockSendPrompt = vi.fn(async (..._a: unknown[]) => undefined)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
  isAgentRunning: () => true,
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  resolveAgentModelDetailed: () => ({ model: 'claude-sonnet-5', source: 'explicit_model' }),
  readAgentModelProfile: () => null,
  readAgentClaudePlan: () => null,
  readAgentClaudeConfigDir: () => null,
  expandAndValidateConfigDir: () => null,
  listAgentNames: () => ['orin', 'dex'],
  readAgentDisplayName: (n: string) => n,
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
  resolveCurrentSessionId: () => 'sess-role-1',
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: () => ({ enabled: false, peers: [] }),
  abandonWindowMsForPeer: () => 60 * 60 * 1000,
}))

vi.mock('../web/federation/bridge.js', () => ({
  sendFederatedMessage: async () => ({ ok: false, error: 'disabled' }),
}))

const { initDatabase, getDb, createKanbanCard } = await import('../db.js')
const { runMessageRouterTick } = await import('../web/message-router.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { resolveCardRoleAgents, DISPATCH_ROLES, createDispatch } =
  await import('../costops/dispatch.js')
const { MAIN_AGENT_ID } = await import('../config.js')

interface DispatchRow { source: string; role: string | null; agent: string; card_id: string | null }

const dispatchRows = (): DispatchRow[] =>
  getDb().prepare('SELECT source, role, agent, card_id FROM dispatches ORDER BY rowid')
    .all() as DispatchRow[]

function moveCtx(cardId: string, status: string): any {
  const res: any = { writeHead() { return res }, end() { /* discarded */ } }
  const url = new URL(`http://localhost:3420/api/kanban/${cardId}/move`)
  const req: any = {
    on(event: string, cb: (...a: any[]) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ status })))
      if (event === 'end') cb()
      return req
    },
  }
  return { req, res, path: url.pathname, method: 'POST', url }
}

describe('§11.2: role reaches the store from the KANBAN origin', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks() })

  it('a card dispatch stamps role=producer, decided by the server from the resolved target', async () => {
    createKanbanCard({ id: 'a1b2c3d4', title: 'work', assignee: MAIN_AGENT_ID, status: 'planned' } as any)
    expect(await tryHandleKanban(moveCtx('a1b2c3d4', 'in_progress'))).toBe(true)

    const rows = dispatchRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('kanban')
    expect(rows[0].role).toBe('producer')
    // The agent named is the DISPATCH TARGET, not anything the agent said about
    // itself -- the property §11.1 says `from_agent` does not have.
    expect(rows[0].agent).toBe(MAIN_AGENT_ID)

    // ...and the role is readable back as the §11.2 role set, which is what the
    // projection and the §24.0.5 producer check both consume.
    const roles = resolveCardRoleAgents(getDb(), 'a1b2c3d4')
    expect(roles.producer).toBe(MAIN_AGENT_ID)
    // No verification or owner dispatch exists yet. This null is RESOLVED, not
    // hardcoded -- the distinction ui-projection.ts now depends on.
    expect(roles.verifier).toBeNull()
    expect(roles.owner).toBeNull()
  })
})

describe('§11.2: role reaches the store from the ROUTER origin', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks(); mockSendPrompt.mockImplementation(async () => undefined) })

  it('a bare inter-agent message mints a message-source dispatch with role=producer', async () => {
    getDb().prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, dispatch_id)
       VALUES (9001, 'orin', 'dex', 'make me a thing', 'pending', ?, NULL)`,
    ).run(Math.floor(Date.now() / 1000))

    await runMessageRouterTick()

    const rows = dispatchRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('message')
    // §11.3: the delegate still AUTHORED the output -- delegation withholds
    // authority, not authorship -- so the receiver is the producer.
    expect(rows[0].role).toBe('producer')
    expect(rows[0].agent).toBe('dex')
  })
})

describe('§11.2: the role column is an enum in intent, not a free-text field', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('declares exactly the four §11.2 roles', () => {
    expect([...DISPATCH_ROLES]).toEqual(['producer', 'verifier', 'executor', 'owner'])
  })

  it('an unrecognised role is stored as NULL, not passed through', () => {
    // "We do not know what this agent was acting as" must have ONE spelling.
    // A typo'd value reaching the column would read downstream as a fifth role.
    createDispatch(getDb(), { source: 'manual', agent: 'dex', role: 'admin' as never })
    expect(dispatchRows()[0].role).toBeNull()
  })

  it('an origin that says nothing stores NULL rather than a guessed producer', () => {
    createDispatch(getDb(), { source: 'manual', agent: 'dex' })
    expect(dispatchRows()[0].role).toBeNull()
  })
})

describe('§11.2: the two tmux-driven origins carry a role too', () => {
  // Same standard as dispatch-threading.test.ts: these paths cannot be driven
  // in a unit test, so the wiring is asserted at the source. Both are RED-able
  // -- deleting the role from either origin fails the matching assertion.
  it('the scheduler stamps executor, not producer', () => {
    const src = read('../web/schedule-runner.ts')
    expect(src).toMatch(/source: 'scheduler', agent: agentName, taskType: task\.type, role: 'executor'/)
    expect(src).not.toMatch(/source: 'scheduler'[^}]*role: 'producer'/)
  })

  it('the worker stamps executor, so the MAIN agent never looks like the author of its worker runs', () => {
    const src = read('../web/agent-worker.ts')
    expect(src).toMatch(/source: 'worker', agent: MAIN_AGENT_ID, taskType: 'worker', role: 'executor'/)
    expect(src).not.toMatch(/source: 'worker'[^}]*role: 'producer'/)
  })
})
