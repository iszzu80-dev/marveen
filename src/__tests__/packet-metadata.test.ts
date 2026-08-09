// P2-B: packet-metadata persistence on/next to the P2-A dispatch row.
//
// Includes the fault-isolation guard: if this layer throws, the DISPATCH still
// goes out. Mirrors P2-A's createDispatchSafe test, and is red-able (remove the
// try/catch in recordPacketMetadataSafe -> the fault-isolation test goes red).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { initDispatchSchema, createDispatch, createDispatchSafe } from '../costops/dispatch.js'
import {
  initPacketMetadataSchema,
  recordPacketMetadata,
  recordPacketMetadataSafe,
  readPacketMetadata,
} from '../costops/packet-metadata.js'
import { buildContextPacket, derivePacketMetadata, artifactRefFromContent, type PacketMetadata } from '../context-packet.js'
import { EXAMPLE_PACKET } from '../context-packet-example.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const T0 = Date.UTC(2026, 6, 20, 9, 0, 0)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p2b-packet-'))
  initDatabase(join(dir, 'test.db'))
  initDispatchSchema(getDb())
  initPacketMetadataSchema(getDb())
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function newDispatch(): string {
  return createDispatch(getDb(), { source: 'kanban', agent: 'dev1', cardId: 'card-1', sessionId: 's1' }, T0)
}

describe('P2-B packet metadata: schema rides the CostOps seam, idempotently', () => {
  it('re-running the DDL is a no-op (idempotent boot DDL)', () => {
    expect(() => { initPacketMetadataSchema(getDb()); initPacketMetadataSchema(getDb()) }).not.toThrow()
  })

  it('is installed via initCostOpsSchema, not a second parallel seam', () => {
    const schema = readFileSync(join(REPO_ROOT, 'src', 'costops', 'schema.ts'), 'utf-8')
    expect(schema).toMatch(/initPacketMetadataSchema\(db\)/)
    // db.ts must NOT grow a second init call for this feature.
    const dbSrc = readFileSync(join(REPO_ROOT, 'src', 'db.ts'), 'utf-8')
    expect(dbSrc).not.toMatch(/initPacketMetadataSchema/)
  })

  it('carries NO column that could hold prompt text or a packet body', () => {
    const cols = getDb().prepare("SELECT name FROM pragma_table_info('dispatch_packets')").all() as { name: string }[]
    // Compare on name SEGMENTS so 'context_budget_class' is not read as carrying
    // 'text'; the point is that no column is a prompt/body/content field.
    const segments = new Set(cols.flatMap(c => c.name.split('_')))
    for (const forbidden of ['prompt', 'body', 'content', 'text', 'excerpt', 'secret', 'credential']) {
      expect(segments.has(forbidden), `column segment "${forbidden}"`).toBe(false)
    }
    // The only 'tokens' column is a numeric COUNT, not a token/credential value.
    const tokenCols = getDb().prepare("SELECT name, type FROM pragma_table_info('dispatch_packets')").all() as { name: string; type: string }[]
    for (const c of tokenCols.filter(c => c.name.includes('token'))) {
      expect(c.name).toBe('estimated_fresh_tokens')
      expect(c.type).toBe('INTEGER')
    }
    const names = cols.map(c => c.name)
    expect(names).toContain('estimate_confidence')
  })

  it('estimate_confidence is NOT NULL, so a stored estimate can never lose its marker', () => {
    const cols = getDb().prepare("SELECT name, [notnull] FROM pragma_table_info('dispatch_packets')").all() as { name: string; notnull: number }[]
    expect(cols.find(c => c.name === 'estimate_confidence')?.notnull).toBe(1)
  })
})

describe('P2-B packet metadata: persistence', () => {
  it('round-trips every required field including the confidence marker', () => {
    const id = newDispatch()
    const meta = derivePacketMetadata(EXAMPLE_PACKET)
    recordPacketMetadata(getDb(), id, { ...meta, taskSizeSource: 'workflow_policy' }, T0)
    const row = readPacketMetadata(getDb(), id)!
    expect(row.dispatchId).toBe(id)
    expect(row.packetVersion).toBe('p2b-1')
    expect(row.taskSize).toBe('normal')
    expect(row.taskSizeSource).toBe('workflow_policy')
    expect(row.contextBudgetClass).toBe('standard')
    expect(row.estimatedFreshTokens).toBe(meta.estimatedFreshTokens)
    expect(row.estimateConfidence).toBe('estimated')
    expect(row.estimateMethod).toMatch(/heuristic/)
    expect(row.referencedArtifacts).toEqual(meta.referencedArtifacts)
    expect(row.contentHashes).toEqual(meta.contentHashes)
    expect(row.createdAt).toBe(Math.floor(T0 / 1000))
  })

  it('keeps referencedArtifacts and contentHashes index-aligned and ordered', () => {
    const id = newDispatch()
    const p = buildContextPacket({
      goal: 'g', dataSensitivity: 'internal', doneWhen: ['d'],
      references: [
        artifactRefFromContent('a/one.md', 'c1', 'one'),
        artifactRefFromContent('b/two.md', 'c2', 'two'),
        artifactRefFromContent('c/three.md', 'c3', 'three'),
      ],
    })
    recordPacketMetadata(getDb(), id, derivePacketMetadata(p), T0)
    const row = readPacketMetadata(getDb(), id)!
    expect(row.referencedArtifacts).toEqual(['a/one.md@c1', 'b/two.md@c2', 'c/three.md@c3'])
    expect(row.contentHashes).toEqual(derivePacketMetadata(p).contentHashes)
  })

  it('is idempotent per dispatch: re-recording replaces, never duplicates', () => {
    const id = newDispatch()
    const p = buildContextPacket({ goal: 'g', dataSensitivity: 'internal', doneWhen: ['d'], references: [artifactRefFromContent('a.md', 'c1', 'x')] })
    recordPacketMetadata(getDb(), id, derivePacketMetadata(p), T0)
    recordPacketMetadata(getDb(), id, { ...derivePacketMetadata(p), taskSize: 'large' }, T0)
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM dispatch_packets WHERE dispatch_id = ?').get(id) as { n: number }
    const a = getDb().prepare('SELECT COUNT(*) AS n FROM dispatch_packet_artifacts WHERE dispatch_id = ?').get(id) as { n: number }
    expect(n.n).toBe(1)
    expect(a.n).toBe(1)
    expect(readPacketMetadata(getDb(), id)!.taskSize).toBe('large')
  })

  it('a dispatch with no packet metadata reads back as null, never a guessed row', () => {
    expect(readPacketMetadata(getDb(), newDispatch())).toBeNull()
    expect(readPacketMetadata(getDb(), 'no-such-dispatch')).toBeNull()
  })

  it('REFUSES to store a token count with no confidence marker', () => {
    const id = newDispatch()
    const bad = { ...derivePacketMetadata(EXAMPLE_PACKET), estimateConfidence: '' as unknown as PacketMetadata['estimateConfidence'] }
    expect(() => recordPacketMetadata(getDb(), id, bad, T0)).toThrow(/confidence marker/)
    expect(readPacketMetadata(getDb(), id)).toBeNull()
  })

  it('REFUSES an artifact reference that looks like a credential', () => {
    const id = newDispatch()
    const bad = { ...derivePacketMetadata(EXAMPLE_PACKET), referencedArtifacts: ['sk-abcdefghijklmnopqrstuvwxyz012345@c1'], contentHashes: ['a'.repeat(64)] }
    expect(() => recordPacketMetadata(getDb(), id, bad, T0)).toThrow(/credential/)
    expect(readPacketMetadata(getDb(), id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FAULT ISOLATION. Red-able: delete the try/catch in recordPacketMetadataSafe.
// ---------------------------------------------------------------------------
describe('P2-B packet metadata: fault isolation -- the dispatch still goes out', () => {
  it('recordPacketMetadataSafe swallows a throwing metadata layer and returns false', () => {
    const id = newDispatch()
    // Force a real failure: drop the table out from under the writer.
    getDb().exec('DROP TABLE dispatch_packets')
    expect(() => recordPacketMetadataSafe(getDb(), id, derivePacketMetadata(EXAMPLE_PACKET), T0)).not.toThrow()
    expect(recordPacketMetadataSafe(getDb(), id, derivePacketMetadata(EXAMPLE_PACKET), T0)).toBe(false)
  })

  it('a rejected estimate (no confidence marker) does not propagate through the safe wrapper', () => {
    const id = newDispatch()
    const bad = { ...derivePacketMetadata(EXAMPLE_PACKET), estimateConfidence: undefined as unknown as PacketMetadata['estimateConfidence'] }
    expect(recordPacketMetadataSafe(getDb(), id, bad, T0)).toBe(false)
  })

  it('THE guard: a broken metadata layer costs the metadata, never the dispatch', () => {
    // Simulate the origin sequence with the metadata layer already broken.
    getDb().exec('DROP TABLE dispatch_packets')
    let sent: string | null = null
    const dispatchAndSend = () => {
      const id = createDispatchSafe(getDb(), { source: 'kanban', agent: 'dev1', cardId: 'card-9' }, T0)
      recordPacketMetadataSafe(getDb(), id, derivePacketMetadata(EXAMPLE_PACKET), T0)
      sent = `prompt-for-${id}` // stands in for sendPromptToSession
      return id
    }
    const id = dispatchAndSend()
    expect(id).toBeTruthy()
    expect(sent).toBe(`prompt-for-${id}`)
    // The P2-A dispatch row itself landed, untouched by the P2-B failure.
    const row = getDb().prepare('SELECT dispatch_id FROM dispatches WHERE dispatch_id = ?').get(id!)
    expect(row).toBeTruthy()
  })

  it('a null dispatchId (P2-A itself failed) is a quiet false, not a throw', () => {
    expect(recordPacketMetadataSafe(getDb(), null, derivePacketMetadata(EXAMPLE_PACKET), T0)).toBe(false)
    expect(recordPacketMetadataSafe(getDb(), undefined, derivePacketMetadata(EXAMPLE_PACKET), T0)).toBe(false)
  })
})

describe('P2-B packet metadata: rollback is inert', () => {
  it('ignoring the new tables leaves the P2-A dispatch path fully working', () => {
    // Fresh DB with ONLY the P2-A schema -- as if P2-B were never installed.
    const dir2 = mkdtempSync(join(tmpdir(), 'p2b-rollback-'))
    try {
      initDatabase(join(dir2, 'test.db'))
      initDispatchSchema(getDb())
      // Simulate the rollback: the P2-B tables are gone / were never created.
      getDb().exec('DROP TABLE IF EXISTS dispatch_packets')
      getDb().exec('DROP TABLE IF EXISTS dispatch_packet_artifacts')
      const id = createDispatch(getDb(), { source: 'message', agent: 'dev2' }, T0)
      expect(id).toBeTruthy()
      // P2-B tables absent; the safe writer degrades quietly, the dispatch stands.
      expect(recordPacketMetadataSafe(getDb(), id, derivePacketMetadata(EXAMPLE_PACKET), T0)).toBe(false)
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM dispatches').get()).toEqual({ n: 1 })
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('the P2-A dispatches table gained no columns (linked-table choice, not nullable columns)', () => {
    const cols = (getDb().prepare("SELECT name FROM pragma_table_info('dispatches')").all() as { name: string }[]).map(c => c.name)
    for (const n of ['packet_version', 'estimated_fresh_tokens', 'task_size', 'context_budget_class', 'content_hashes']) {
      expect(cols, n).not.toContain(n)
    }
  })
})
