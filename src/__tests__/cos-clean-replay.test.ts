import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { expandTouchedThreads, runShadowReplay, readReplayProjections } from '../cos/replay/shadow-replay.js'
import { reconcileReplay, replayReadyForStability } from '../cos/replay/reconcile.js'
import { buildZstMigrationBatches, buildZstMigrationCandidates } from '../cos/replay/zst-migration-plan.js'
import type { ReplayCorpus } from '../cos/replay/types.js'

const DAY = 86400
const T = Math.floor(Date.UTC(2026, 7, 16) / 1000)

function corpus(): ReplayCorpus {
  return {
    generatedAt: T, anchorStart: T - 60 * DAY, anchorEnd: T + DAY,
    messages: [
      // thread A begins outside the 60-day window but has a recent reply: the
      // old opener MUST be replayed too.
      { sourceAccountId: 'private', messageId: 'a-old', threadId: 'A', direction: 'INBOUND', occurredAt: T - 90 * DAY, subject: 'Autóbérlés', bodyText: 'Foglalás indítása' },
      { sourceAccountId: 'private', messageId: 'a-new', threadId: 'A', direction: 'INBOUND', occurredAt: T - DAY, subject: 'Autóbérlés', bodyText: 'DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt' },
      // untouched old thread must stay out.
      { sourceAccountId: 'private', messageId: 'b-old', threadId: 'B', direction: 'INBOUND', occurredAt: T - 100 * DAY, subject: 'Old', bodyText: 'old' },
      // explicit ZST connector stays ZST.
      { sourceAccountId: 'zst', messageId: 'z1', threadId: 'Z', direction: 'SENT', occurredAt: T - 2 * DAY, subject: 'Invoice', bodyText: 'invoice follow-up', to: ['vendor@example.com'] },
    ],
  }
}

describe('Clean Replay & Reconciliation Gate v1.0', () => {
  it('expands the complete history of every touched thread', () => {
    const m = expandTouchedThreads(corpus())
    expect(m.map(x => x.messageId)).toEqual(['a-old', 'z1', 'a-new'])
    expect(m.some(x => x.threadId === 'B')).toBe(false)
  })

  it('writes only a separate shadow schema and produces classifiable projections', () => {
    const db = new Database(':memory:')
    const r = runShadowReplay(db, corpus(), 'run-1')
    expect(r.touchedThreads).toBe(2)
    expect(r.replayedMessages).toBe(3)
    expect(r.projectedCases).toBe(2)
    expect(r.orphanCases).toBe(0)
    const stores = db.prepare('SELECT domain, thread_id FROM replay_cases ORDER BY thread_id').all() as Array<{ domain: string; thread_id: string }>
    expect(stores).toEqual([{ domain: 'personal', thread_id: 'A' }, { domain: 'zst', thread_id: 'Z' }])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_cases'").get()).toBeUndefined()
    db.close()
  })

  it('all reconciliation findings are explicitly non-auto-applicable', () => {
    const db = new Database(':memory:')
    const r = runShadowReplay(db, corpus(), 'run-2')
    const projections = readReplayProjections(db, r.runId)
    const m = reconcileReplay('run-2', projections, [{
      caseId: 'prod-A', domain: 'personal', threadIds: ['A'], title: 'Different title', status: 'READY',
      nextAction: null, nextActionOwner: null, hasHumanAuthorityEvent: false, hasExternalReceipt: false,
    }])
    expect(m.autoApplyAllowed).toBe(false)
    expect(m.findings.length).toBeGreaterThan(0)
    expect(m.findings.every(f => f.autoApplyAllowed === false)).toBe(true)
    expect(replayReadyForStability(m)).toBe(false)
    db.close()
  })

  it('builds exact ZST rollout batches without proposing closure or execution', () => {
    const legacy = Array.from({ length: 22 }, (_, i) => ({ caseId: `z${String(i).padStart(2, '0')}`, status: 'NEW', caseType: 'ADMIN' }))
    const candidates = buildZstMigrationCandidates(legacy)
    const batches = buildZstMigrationBatches(candidates)
    expect(batches.map(b => [b.phase, b.caseIds.length])).toEqual([
      ['DRY_RUN', 22], ['CANARY_2', 2], ['CANARY_5', 5], ['CANARY_10', 10], ['REMAINDER', 5],
    ])
    expect(candidates.every(c => c.requiresHumanReview)).toBe(true)
  })
})
