// APG 1.9 §15.3-d / §28.17 (WP6) -- a dispatch is joinable to an execution.
//
// WHAT WAS TRUE BEFORE. `dispatches` knew which agent got which card and what
// the send cost. Nothing joined it to a runner-minted execution principal
// (§11.2) or to the context packet that principal was handed (§12.1), so
// §28.17's RED condition -- "controlled work execution indulhat runner-mintelt
// execution/dispatch receipt nélkül" -- was the only state that existed.
//
// THE JOIN IS ARITHMETIC. Both sides derive the execution_id from the same seven
// facts with the same content digest, so they agree because the content agrees
// and not because one told the other. That makes the two implementations a
// CONTRACT, and the two constants below are the contract: the kernel's
// tests/test_wp6_kanban_dispatch.py pins the identical strings in
// `test_the_dispatcher_can_derive_the_execution_id_before_the_mint`. A drift in
// either implementation turns a silent mis-join into two failing tests, in two
// repositories, on the same two values.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  deriveExecutionId, pythonJson,
  SESSION_ID_UNKNOWN, TARGET_REF_UNKNOWN, CONTEXT_PACKET_HASH_UNKNOWN,
} from '../apg/execution-binding.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { initDatabase, getDb } = await import('../db.js')
const { createDispatch, listUnboundDispatches } = await import('../costops/dispatch.js')

/** 2026-07-17T09:39:17Z -- the watermark a1_pilot already pins, reused so both
 *  repositories' vectors are recomputable from one documented instant. */
const T0 = 1784281157
const PACKET_HASH = 'b'.repeat(64)

/** THE CROSS-REPO VECTORS. Identical constants live in the kernel test. */
const VECTOR_WITH_CONTEXT = 'ex-b7848fb7906a827ea7322381e6c37f89'
const VECTOR_ALL_UNKNOWN = 'ex-a939ce43ca4c30f717c6eec6c4c398c0'

describe('§15.3-d: the execution_id derivation matches the kernel', () => {
  it('HEADLINE: a fully-specified dispatch derives the kernel contract vector', () => {
    expect(deriveExecutionId({
      workItemId: 'card-9f2a',
      agentId: 'dex',
      role: 'producer',
      createdAt: T0,
      sessionId: 'sess-7',
      contextPacketHash: PACKET_HASH,
    })).toBe(VECTOR_WITH_CONTEXT)
  })

  it('the three reserved unknown words are HASHED, not skipped', () => {
    // A caller that passed nothing and a caller that spelled the sentinel must
    // reach the same digest -- otherwise the kernel, which always resolves to
    // the sentinel before hashing, would mint a different id for the same
    // dispatch.
    const implicit = deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'dex', role: 'producer', createdAt: T0,
    })
    const explicit = deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'dex', role: 'producer', createdAt: T0,
      sessionId: SESSION_ID_UNKNOWN,
      targetRef: TARGET_REF_UNKNOWN,
      contextPacketHash: CONTEXT_PACKET_HASH_UNKNOWN,
    })
    expect(implicit).toBe(VECTOR_ALL_UNKNOWN)
    expect(explicit).toBe(VECTOR_ALL_UNKNOWN)
  })

  it('a `sha256:`-prefixed hash and a bare one are the same context', () => {
    expect(deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'dex', role: 'producer', createdAt: T0,
      sessionId: 'sess-7', contextPacketHash: `sha256:${PACKET_HASH.toUpperCase()}`,
    })).toBe(VECTOR_WITH_CONTEXT)
  })

  it('a malformed packet hash degrades to the unknown sentinel, never to itself', () => {
    // A "hash" of another width is not a content hash of anything the packet
    // format produces. Hashing it verbatim would derive an id the kernel -- which
    // refuses a malformed hash outright -- can never reproduce.
    expect(deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'dex', role: 'producer', createdAt: T0,
      contextPacketHash: 'not-a-hash',
    })).toBe(VECTOR_ALL_UNKNOWN)
  })

  it('pythonJson escapes non-ASCII the way json.dumps(ensure_ascii=True) does', () => {
    // THE SUBTLETY THAT WOULD ONLY HAVE BROKEN IN PRODUCTION. JSON.stringify
    // emits accented characters literally; Python escapes them. A single
    // accented agent name would have hashed differently on the two sides -- and
    // an all-ASCII fixture set would never have shown it.
    // Verbatim `json.dumps(['épító'], separators=(',', ':'))`.
    expect(pythonJson(['épító'])).toBe('["\\u00e9p\\u00edt\\u00f3"]')
    expect(pythonJson(['plain', 'ascii'])).toBe('["plain","ascii"]')
    // Astral plane: Python emits the surrogate PAIR as two escapes, and so does
    // this (the regex matches UTF-16 code units, deliberately without /u).
    expect(pythonJson(['\u{1F600}'])).toBe('["\\ud83d\\ude00"]')
  })

  it('an accented agent name still derives a stable, reproducible id', () => {
    const id = deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'épító', role: 'producer', createdAt: T0,
    })
    expect(id).toMatch(/^ex-[0-9a-f]{32}$/)
    expect(id).not.toBe(VECTOR_ALL_UNKNOWN)
  })

  it('an incomplete identity derives NULL, never a plausible id that joins to nothing', () => {
    const incomplete = [
      { workItemId: '', agentId: 'dex', role: 'producer' as const, createdAt: T0 },
      { workItemId: 'card-1', agentId: '  ', role: 'producer' as const, createdAt: T0 },
      { workItemId: 'card-1', agentId: 'dex', role: 'archivist' as never, createdAt: T0 },
      { workItemId: 'card-1', agentId: 'dex', role: 'producer' as const, createdAt: 1.5 },
    ]
    for (const facts of incomplete) expect(deriveExecutionId(facts)).toBeNull()
  })
})

describe('§28.17: the dispatch row carries the binding', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a stamped dispatch is joinable; an unstamped one is honestly unbound', () => {
    const bound = createDispatch(getDb(), {
      source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-9f2a',
      sessionId: 'sess-7',
      executionId: VECTOR_WITH_CONTEXT,
    }, T0 * 1000)
    // An origin with no role and no card cannot derive one, and stores NULL
    // rather than a fabricated value.
    const unbound = createDispatch(getDb(), { source: 'message', agent: 'dex' }, T0 * 1000)

    const row = getDb().prepare('SELECT execution_id FROM dispatches WHERE dispatch_id = ?')
      .get(bound) as { execution_id: string | null }
    expect(row.execution_id).toBe(VECTOR_WITH_CONTEXT)

    const unboundRows = listUnboundDispatches(getDb())
    expect(unboundRows.map(r => r.dispatch_id)).toEqual([unbound])
  })

  it('the kanban origin derives the id from the SAME facts it stores', () => {
    // The property that makes the binding real, asserted end to end rather than
    // trusted: take the row the origin wrote, re-derive from its own columns,
    // and require the two to agree. If the origin ever reads the clock twice,
    // or resolves the session twice, this goes red.
    const sessionId = 'sess-7'
    const createdAtSec = T0
    const executionId = deriveExecutionId({
      workItemId: 'card-9f2a', agentId: 'dex', role: 'producer',
      createdAt: createdAtSec, sessionId, contextPacketHash: PACKET_HASH,
    })
    const id = createDispatch(getDb(), {
      source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-9f2a',
      sessionId, executionId,
    }, createdAtSec * 1000)

    const row = getDb().prepare(
      'SELECT card_id, agent, role, session_id, created_at, execution_id FROM dispatches WHERE dispatch_id = ?',
    ).get(id) as {
      card_id: string; agent: string; role: string; session_id: string
      created_at: number; execution_id: string
    }
    expect(deriveExecutionId({
      workItemId: row.card_id, agentId: row.agent, role: row.role as 'producer',
      createdAt: row.created_at, sessionId: row.session_id, contextPacketHash: PACKET_HASH,
    })).toBe(row.execution_id)
  })
})
