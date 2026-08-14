// APG 1.9 §12.1 (WP4) -- the context packet has an IDENTITY, and it is stored.
//
// The gap this closes is narrow and load-bearing: the packet had no packet_id,
// no packet_hash and no generated_at, so the kernel's execution identity stored
// CONTEXT_PACKET_HASH_UNKNOWN for every execution it minted -- permanently,
// with the recorded reason "no packet body is hashed". These tests prove the
// body IS hashed, that the hash means what a content hash has to mean, and that
// the identity survives into the row the dispatch already writes.
//
// The three properties that matter, and each is written so that deleting the
// rule turns it RED:
//   1. identical content -> identical hash (otherwise it is a nonce, not an id);
//   2. changed content   -> changed hash  (otherwise it is a constant);
//   3. the CLOCK is not in it (otherwise the join key is per-dispatch noise and
//      "these two runs saw the same context" becomes unanswerable).

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildContextPacket,
  renderContextPacket,
  derivePacketMetadata,
  hashPacket,
  packetIdentity,
  PACKET_ID_PREFIX,
  type ContextPacketInput,
} from '../context-packet.js'
import { EXECUTION_ROLES, asExecutionRole } from '../execution-role.js'
import { DISPATCH_ROLES } from '../costops/dispatch.js'

function packet(over: Partial<ContextPacketInput> = {}) {
  return buildContextPacket({
    goal: 'Ship the thing',
    dataSensitivity: 'internal',
    doneWhen: ['tests green'],
    ...over,
  })
}

describe('§12.1 packet identity: the hash is a content hash', () => {
  it('is stable for identical content, across independently built packets', () => {
    expect(hashPacket(packet())).toBe(hashPacket(packet()))
    expect(packetIdentity(packet()).packetId).toBe(packetIdentity(packet()).packetId)
  })

  it('changes when ANY rendered part of the content changes', () => {
    const base = hashPacket(packet())
    const changed = [
      packet({ goal: 'Ship a different thing' }),
      packet({ doneWhen: ['tests green', 'and the docs'] }),
      packet({ constraints: ['no schema change'] }),
      packet({ dataSensitivity: 'restricted' }),
      packet({ executionRole: 'verifier' }),
      packet({ taskSize: 'large' }),
    ].map(hashPacket)
    for (const h of changed) expect(h).not.toBe(base)
    // ...and they are all distinct from each other, i.e. the hash is not just
    // "changed by any edit" but actually a function of the whole body.
    expect(new Set(changed).size).toBe(changed.length)
  })

  it('is sha256 of the RENDERED packet -- the bytes the agent actually receives', () => {
    const p = packet({ constraints: ['one'] })
    const rendered = renderContextPacket(p)
    expect(hashPacket(p)).toBe(
      // Independently computed here, so the test does not just re-call the
      // implementation and agree with itself.
      createHash('sha256').update(rendered, 'utf-8').digest('hex'),
    )
  })

  it('does NOT stir the clock into the identity', () => {
    // Two dispatches of byte-identical context are the same context. If
    // generatedAt were hashed, packet_hash could never answer the one question
    // it exists for -- "did these two executions run against the same packet?"
    const early = packetIdentity(packet(), '2026-01-01T00:00:00.000Z')
    const late = packetIdentity(packet(), '2026-08-13T23:59:59.000Z')
    expect(early.packetHash).toBe(late.packetHash)
    expect(early.packetId).toBe(late.packetId)
    expect(early.generatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(late.generatedAt).toBe('2026-08-13T23:59:59.000Z')
  })

  it('records no generation time rather than inventing one', () => {
    // context-packet.ts has no clock, by the same rule the whole module keeps.
    expect(packetIdentity(packet()).generatedAt).toBeNull()
    expect(packetIdentity(packet(), '').generatedAt).toBeNull()
  })

  it('derives the id from the hash, with no parameter to choose one', () => {
    const id = packetIdentity(packet())
    expect(id.packetId.startsWith(PACKET_ID_PREFIX)).toBe(true)
    expect(id.packetId.slice(PACKET_ID_PREFIX.length)).toBe(id.packetHash.slice(0, 32))
  })
})

describe('§12.1-e execution_role on the packet', () => {
  it('uses WP3\'s vocabulary -- one definition, not a second copy', () => {
    // DISPATCH_ROLES (the §11.2 column) and EXECUTION_ROLES (the §12.1-e packet
    // field) must be the SAME array, not two arrays that happen to agree today.
    expect(DISPATCH_ROLES).toBe(EXECUTION_ROLES)
    expect([...EXECUTION_ROLES]).toEqual(['producer', 'verifier', 'executor', 'owner'])
  })

  it('renders into the packet head, so the receiving agent can read its own role', () => {
    expect(renderContextPacket(packet({ executionRole: 'verifier' })))
      .toContain('executionRole: verifier')
  })

  it('an unrecognised role becomes null, never a guessed producer', () => {
    expect(packet({ executionRole: 'admin' as never }).executionRole).toBeNull()
    expect(asExecutionRole('Producer')).toBeNull()
    expect(renderContextPacket(packet({ executionRole: 'admin' as never })))
      .not.toContain('executionRole')
  })

  it('a packet with no role declares none rather than defaulting', () => {
    expect(packet().executionRole).toBeNull()
  })
})

describe('§12.1 packet identity: it reaches the row the dispatch already writes', () => {
  let db: import('better-sqlite3').Database

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default
    db = new Database(':memory:')
    const { initPacketMetadataSchema } = await import('../costops/packet-metadata.js')
    initPacketMetadataSchema(db)
  })

  it('stores packet_id, packet_hash, generated_at and execution_role', async () => {
    const { recordPacketMetadata, readPacketMetadata } = await import('../costops/packet-metadata.js')
    const p = packet({ executionRole: 'producer', cardId: 'a1b2c3d4' })
    const generatedAt = '2026-08-13T10:00:00.000Z'
    recordPacketMetadata(db, 'disp-1', derivePacketMetadata(p, generatedAt))

    const row = readPacketMetadata(db, 'disp-1')!
    expect(row.packetHash).toBe(hashPacket(p))
    expect(row.packetId).toBe(packetIdentity(p).packetId)
    expect(row.generatedAt).toBe(generatedAt)
    expect(row.executionRole).toBe('producer')
  })

  it('a recorder with no packet in hand stores NULL, not a hash of nothing', async () => {
    const { recordPacketMetadata, readPacketMetadata } = await import('../costops/packet-metadata.js')
    recordPacketMetadata(db, 'disp-2', {
      packetVersion: 'p2b-1',
      referencedArtifacts: [], contentHashes: [],
      estimatedFreshTokens: 100, estimateConfidence: 'estimated', estimateMethod: 'x',
      taskSize: null, contextBudgetClass: null,
    })
    const row = readPacketMetadata(db, 'disp-2')!
    expect(row.packetId).toBeNull()
    expect(row.packetHash).toBeNull()
    expect(row.generatedAt).toBeNull()
    expect(row.executionRole).toBeNull()
  })

  it('two dispatches of the same context share a packet_hash -- the join key works', async () => {
    const { recordPacketMetadata } = await import('../costops/packet-metadata.js')
    const p = packet({ cardId: 'a1b2c3d4', executionRole: 'producer' })
    recordPacketMetadata(db, 'disp-a', derivePacketMetadata(p, '2026-08-13T10:00:00.000Z'))
    recordPacketMetadata(db, 'disp-b', derivePacketMetadata(p, '2026-08-14T11:00:00.000Z'))
    const rows = db.prepare('SELECT dispatch_id FROM dispatch_packets WHERE packet_hash = ?')
      .all(hashPacket(p)) as { dispatch_id: string }[]
    expect(rows.map(r => r.dispatch_id).sort()).toEqual(['disp-a', 'disp-b'])
  })

  it('there is still no column that could hold the packet BODY', () => {
    const cols = (db.prepare('PRAGMA table_info(dispatch_packets)').all() as { name: string }[])
      .map(c => c.name)
    // A hash of the body is not the body -- that asymmetry is why storing the
    // hash is safe, and it stops being true the day a body column appears.
    for (const forbidden of ['packet_body', 'body', 'prompt', 'content', 'goal', 'excerpt']) {
      expect(cols).not.toContain(forbidden)
    }
    expect(cols).toContain('packet_hash')
  })
})
