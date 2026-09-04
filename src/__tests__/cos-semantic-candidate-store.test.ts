// A PROPOSAL THAT CANNOT BE MISTAKEN FOR A RELATION.
//
// The owner's constraint is that a semantic candidate produces no canonical
// link, no parent assignment, no case merge and no namespace migration. Most of
// that is enforced by WHERE the row lives: a CANDIDATE state inside
// `case_sources` is one careless `WHERE case_id = ?` away from being read as a
// relation, and the promise here is that it cannot be acted on by accident.
// These tests assert the separation itself, not merely the intention.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { getCaseDossier } from '../cos/case-sources.js'
import {
  recordCandidates, candidatesForCase, candidatesByFingerprint, describeCandidate,
} from '../cos/semantic/candidate-store.js'
import type { RelationCandidate } from '../cos/semantic/relation-candidates.js'

const NOW = 1_700_000_000

const candidate = (over: Partial<RelationCandidate> = {}): RelationCandidate => ({
  relationType: 'CASE_PARENT_CANDIDATE',
  namespace: 'personal',
  sourceRef: 'case-child',
  targetCaseId: 'PRI-TRIP-2026-001',
  confidence: 0.85,
  features: [{ family: 'IDENTIFIER', name: 'SIBLING_IDENTIFIER_BRIDGE', weight: 0.55,
    reason: 'it shares the reference D014745393 with case-centauro, which already belongs to this case' }],
  negatives: [],
  reasons: ['it shares the reference D014745393 with case-centauro, which already belongs to this case'],
  algorithmFingerprint: 'local-lexical-v1:abc123',
  ...over,
})

describe('a candidate is stored apart from the relation graph', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'PRI-TRIP-2026-001', title: 'trip', caseType: 'TRAVEL', status: 'READY' } as never, NOW)
    createCase(getDb(), { caseId: 'case-child', title: 'child', caseType: 'TRAVEL', status: 'READY' } as never, NOW)
  })

  it('HEADLINE: recording a candidate writes NOTHING to case_sources or the case row', () => {
    recordCandidates(getDb(), [candidate()], { sourceKind: 'CASE', provenance: 'test' }, NOW)

    expect(getCaseDossier(getDb(), 'personal', 'PRI-TRIP-2026-001').canonical).toEqual([])
    expect(getCaseDossier(getDb(), 'personal', 'PRI-TRIP-2026-001').candidates).toEqual([])
    const row = getDb().prepare('SELECT parent_case_id FROM personal_cases WHERE case_id=?')
      .get('case-child') as { parent_case_id: string | null }
    expect(row.parent_case_id, 'no parent was assigned').toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) n FROM case_sources').get()).toEqual({ n: 0 })
  })

  it('and the proposal IS retrievable, or the test above proves only that nothing happened', () => {
    recordCandidates(getDb(), [candidate()], { sourceKind: 'CASE', provenance: 'test' }, NOW)
    const found = candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      relationType: 'CASE_PARENT_CANDIDATE', sourceRef: 'case-child', confidence: 0.85,
    })
  })

  it('the module itself never names a graph table', () => {
    // A structural check, because the behavioural one above can only see the
    // paths a test happens to exercise.
    const src = readFileSync(join(process.cwd(), 'src/cos/semantic/candidate-store.ts'), 'utf8')
      .replace(/\/\/.*$/gm, '')
    for (const table of ['case_sources', 'personal_cases', 'zst_cases']) {
      expect(src, `candidate-store must not write to ${table}`).not.toContain(table)
    }
  })
})

describe('what every candidate carries', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: every field the owner asked for survives a round trip', () => {
    const c = candidate({
      crossMailbox: { sourceMailbox: 'zst', targetMailbox: 'private' },
      negatives: [{ name: 'TEMPORAL_DISJOINT', reason: 'dates fall outside', disqualifying: false }],
    })
    recordCandidates(getDb(), [c], { sourceKind: 'GMAIL_THREAD', provenance: 'source-replay 2026-09-04' }, NOW)
    const [got] = candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')

    expect(got.relationType).toBe('CASE_PARENT_CANDIDATE')
    expect(got.sourceRef).toBe('case-child')
    expect(got.targetCaseId).toBe('PRI-TRIP-2026-001')
    expect(got.namespace).toBe('personal')
    expect(got.confidence).toBe(0.85)
    expect(got.features[0].name).toBe('SIBLING_IDENTIFIER_BRIDGE')
    expect(got.reasons[0]).toContain('D014745393')
    expect(got.negatives[0].name).toBe('TEMPORAL_DISJOINT')
    expect(got.sourceKind).toBe('GMAIL_THREAD')
    expect(got.provenance).toBe('source-replay 2026-09-04')
    expect(got.algorithmFingerprint).toBe('local-lexical-v1:abc123')
    expect(got.crossMailbox).toEqual({ sourceMailbox: 'zst', targetMailbox: 'private' })
    expect(got.createdAt).toBe(NOW)
  })

  it('the projection is prose, not a bare score', () => {
    // "Ne csak egy similarity score legyen." A number invites a threshold
    // somebody sets once and never revisits.
    recordCandidates(getDb(), [candidate()], { sourceKind: 'CASE', provenance: 'test' }, NOW)
    const [got] = candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')
    const text = describeCandidate(got)
    expect(text).toContain('Possible parent')
    expect(text).toContain('D014745393')
    expect(text).toContain('case-centauro')
  })

  it('a cross-mailbox proposal says so in the projection', () => {
    recordCandidates(getDb(), [candidate({ crossMailbox: { sourceMailbox: 'zst' } })],
      { sourceKind: 'GMAIL_THREAD', provenance: 'test' }, NOW)
    const [got] = candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')
    expect(describeCandidate(got)).toContain('arrived on zst')
  })
})

describe('re-running the engine', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: the same algorithm updates in place instead of piling up', () => {
    recordCandidates(getDb(), [candidate()], { sourceKind: 'CASE', provenance: 'run1' }, NOW)
    recordCandidates(getDb(), [candidate({ confidence: 0.62 })], { sourceKind: 'CASE', provenance: 'run2' }, NOW + 60)
    const rows = candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].confidence).toBe(0.62)
    expect(rows[0].updatedAt).toBe(NOW + 60)
  })

  it('a DIFFERENT algorithm version writes a new row, so the two can be compared', () => {
    // Overwriting would erase the comparison, which is the only way to tell
    // whether a change to the rules made the proposals better or worse.
    recordCandidates(getDb(), [candidate()], { sourceKind: 'CASE', provenance: 'v1' }, NOW)
    recordCandidates(getDb(), [candidate({ algorithmFingerprint: 'local-lexical-v2:def456', confidence: 0.4 })],
      { sourceKind: 'CASE', provenance: 'v2' }, NOW)
    expect(candidatesForCase(getDb(), 'personal', 'PRI-TRIP-2026-001')).toHaveLength(2)
    expect(candidatesByFingerprint(getDb(), 'local-lexical-v1:abc123')).toHaveLength(1)
    expect(candidatesByFingerprint(getDb(), 'local-lexical-v2:def456')).toHaveLength(1)
  })

  it('a confidence outside 0..1 is refused by the store, not silently clamped', () => {
    expect(() => recordCandidates(getDb(), [candidate({ confidence: 1.4 })],
      { sourceKind: 'CASE', provenance: 'test' }, NOW)).toThrow()
  })

  it('an unknown relation type is refused', () => {
    expect(() => recordCandidates(getDb(),
      [candidate({ relationType: 'CANONICAL_PARENT' as never })],
      { sourceKind: 'CASE', provenance: 'test' }, NOW)).toThrow()
  })
})
