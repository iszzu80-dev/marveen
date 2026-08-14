// APG 1.9 §12.1-a (WP4) -- the packet BODY reaches the agent.
//
// The 1.8 conformance audit's WP4 row is one sentence: "a packet valódi, de a
// törzse sosem jut el az ügynökhöz -- csak metaadat tárolódik". That was
// literally true: kanban.ts built a ContextPacket, called derivePacketMetadata()
// on it, stored the metadata, and then sent the agent a hand-assembled string
// while the rendered packet was garbage-collected. validateContextPacket() --
// the format's own fail-closed edge -- had no production caller at all.
//
// This file drives the REAL route (tryHandleKanban, unmocked, against an
// in-memory DB, the same harness apg-dispatch-role-origins.test.ts uses) and
// asserts what the agent's queued message actually contains. It is written so
// that reverting kanban.ts to the hand-built string turns it RED.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  sendPromptToSession: vi.fn(async () => undefined),
  isAgentRunning: () => true,
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentModel: () => 'claude-sonnet-5',
  readAgentModelProfile: () => null,
  readAgentClaudePlan: () => null,
  readAgentClaudeConfigDir: () => null,
  resolveAgentModelDetailed: () => ({ model: 'claude-sonnet-5', source: 'explicit_model' }),
  listAgentNames: () => ['orin', 'dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/transcript-sources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/transcript-sources.js')>()),
  resolveCurrentSessionId: () => 'sess-wp4',
}))

const { initDatabase, getDb, createKanbanCard, getKanbanComments } = await import('../db.js')
const { tryHandleKanban, kanbanMoveInstructions, buildKanbanProducerPacket } =
  await import('../web/routes/kanban.js')
const { renderContextPacket, hashPacket, packetIdentity } = await import('../context-packet.js')
const { readPacketMetadata } = await import('../costops/packet-metadata.js')
const { MAIN_AGENT_ID } = await import('../config.js')

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

const messages = () =>
  getDb().prepare('SELECT to_agent, content, dispatch_id FROM agent_messages ORDER BY id')
    .all() as { to_agent: string; content: string; dispatch_id: string | null }[]

const dispatchCount = () =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n

describe('§12.1-a: the kanban dispatch sends the RENDERED packet', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks() })

  it('the agent receives the packet body, not a hand-built string', async () => {
    createKanbanCard({
      id: 'a1b2c3d4', title: 'Fix the token page', description: 'Group by model, not just agent.',
      assignee: MAIN_AGENT_ID, status: 'planned', priority: 'high', project: 'costops',
    } as any)
    expect(await tryHandleKanban(moveCtx('a1b2c3d4', 'in_progress'))).toBe(true)

    const [msg] = messages()
    expect(msg.to_agent).toBe(MAIN_AGENT_ID)

    // It IS the packet: the five-section shape, byte-for-byte at the front.
    const expected = renderContextPacket(
      buildKanbanProducerPacket(
        { title: 'Fix the token page', description: 'Group by model, not just agent.', priority: 'high', project: 'costops' },
        'a1b2c3d4', [], 'normal',
      ),
    )
    expect(msg.content.startsWith(expected)).toBe(true)
    for (const heading of ['## Goal', '## Canonical references', '## Relevant constraints', '## Data sensitivity', '## Done when']) {
      expect(msg.content).toContain(heading)
    }
    // §12.1-e: the receiving agent can read the role it was dispatched in.
    expect(msg.content).toContain('executionRole: producer')

    // The OLD hand-built prefix is gone -- this is the assertion that goes RED
    // if kanban.ts reverts to `[Kanban feladat #id]: title\n\n<instructions>`.
    expect(msg.content.startsWith('[Kanban feladat #a1b2c3d4]')).toBe(false)
  })

  it('preserves everything the old message conveyed', async () => {
    createKanbanCard({
      id: 'b2c3d4e5', title: 'Fix the token page', description: 'Group by model, not just agent.',
      assignee: MAIN_AGENT_ID, status: 'planned', priority: 'high', project: 'costops',
    } as any)
    await tryHandleKanban(moveCtx('b2c3d4e5', 'in_progress'))
    const [msg] = messages()

    // card id, title and description -- previously the whole of the header line
    expect(msg.content).toContain('[Kanban feladat #b2c3d4e5]: Fix the token page')
    expect(msg.content).toContain('Group by model, not just agent.')
    // ...and the done/escalation protocol, byte-identical to what it was.
    expect(msg.content).toContain(kanbanMoveInstructions('b2c3d4e5', MAIN_AGENT_ID))
    // Facts the agent used to have to go and look up are now stated.
    expect(msg.content).toContain('Prioritás: high')
    expect(msg.content).toContain('Projekt: costops')
  })

  it('stores the identity of the packet it actually sent', async () => {
    createKanbanCard({ id: 'c3d4e5f6', title: 'Small thing', assignee: MAIN_AGENT_ID, status: 'planned' } as any)
    await tryHandleKanban(moveCtx('c3d4e5f6', 'in_progress'))

    const [msg] = messages()
    const row = readPacketMetadata(getDb(), msg.dispatch_id!)!
    const sent = buildKanbanProducerPacket({ title: 'Small thing', description: null, priority: 'normal', project: null },
      'c3d4e5f6', [], 'normal')
    expect(row.packetHash).toBe(hashPacket(sent))
    expect(row.packetId).toBe(packetIdentity(sent).packetId)
    expect(row.executionRole).toBe('producer')
    // generated_at is stamped at the ORIGIN (the packet layer has no clock).
    expect(row.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // ...and the hash is the hash of the bytes the agent got.
    expect(msg.content.startsWith(renderContextPacket(sent))).toBe(true)
  })

  it('a long description is truncated with a pointer, never silently dropped and never a refusal', async () => {
    const long = 'x'.repeat(5000)
    createKanbanCard({ id: 'd4e5f6a7', title: 'Big card', description: long, assignee: MAIN_AGENT_ID, status: 'planned' } as any)
    await tryHandleKanban(moveCtx('d4e5f6a7', 'in_progress'))

    const [msg] = messages()
    expect(msg).toBeTruthy()
    expect(msg.content).toContain('...')
    expect(msg.content).toContain('A teljes szöveg a #d4e5f6a7 kártyán van')
    expect(msg.content).not.toContain(long)
  })
})

describe('§12.1: validation runs BEFORE the send, and a failing packet is not dispatched', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks() })

  it('refuses a packet that carries something credential-shaped', async () => {
    // The one error class an origin can realistically hit: a token pasted into
    // a card description. Before WP4 this went straight to the agent, because
    // nothing validated anything on this path.
    createKanbanCard({
      id: 'e5f6a7b8', title: 'Deploy it',
      description: 'use sk-abcdefghijklmnopqrstuvwxyz012345 for the API',
      assignee: MAIN_AGENT_ID, status: 'planned',
    } as any)
    expect(await tryHandleKanban(moveCtx('e5f6a7b8', 'in_progress'))).toBe(true)

    // Nothing was sent, and nothing was minted for a send that never happened.
    expect(messages()).toHaveLength(0)
    expect(dispatchCount()).toBe(0)
    // Not marked dispatched: the work is deferred, so a fixed card re-fires.
    const card = getDb().prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?')
      .get('e5f6a7b8') as { dispatched_at: number | null }
    expect(card.dispatched_at).toBeNull()

    // And the refusal is never silent -- but it does not echo the secret back.
    const comments = getKanbanComments('e5f6a7b8')
    expect(comments).toHaveLength(1)
    expect(comments[0].content).toContain('possible_secret')
    expect(comments[0].content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('a valid card is unaffected -- the gate is fail-CLOSED, not fail-often', async () => {
    createKanbanCard({ id: 'f6a7b8c9', title: 'Ordinary work', assignee: MAIN_AGENT_ID, status: 'planned' } as any)
    await tryHandleKanban(moveCtx('f6a7b8c9', 'in_progress'))
    expect(messages()).toHaveLength(1)
    expect(dispatchCount()).toBe(1)
    expect(getKanbanComments('f6a7b8c9')).toHaveLength(0)
  })
})
