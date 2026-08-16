import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { runShadowReplay } from '../cos/replay/shadow-replay.js'
import type { ReplayCorpus } from '../cos/replay/types.js'

const T = Math.floor(Date.UTC(2026, 7, 16, 0, 0, 0) / 1000)
const corpus: ReplayCorpus = {
  generatedAt: T,
  anchorStart: T - 60 * 86400,
  anchorEnd: T + 86400,
  messages: [
    { sourceAccountId: 'private', messageId: 'm1', threadId: 't1', direction: 'INBOUND', occurredAt: T - 100, subject: 'One', bodyText: 'Do this' },
    { sourceAccountId: 'zst', messageId: 'm2', threadId: 't2', direction: 'INBOUND', occurredAt: T - 50, subject: 'Two', bodyText: 'Invoice due 2026-08-30' },
  ],
}

describe('Clean Replay multi-run history', () => {
  it('can replay the same immutable corpus twice without overwriting prior run evidence', () => {
    const db = new Database(':memory:')
    const first = runShadowReplay(db, corpus, 'r1')
    const second = runShadowReplay(db, corpus, 'r2')
    expect(first.projectedCases).toBe(2)
    expect(second.projectedCases).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS n FROM replay_runs').get() as { n: number }).n).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS n FROM replay_cases').get() as { n: number }).n).toBe(4)
    expect((db.prepare('SELECT COUNT(*) AS n FROM replay_messages').get() as { n: number }).n).toBe(4)
    db.close()
  })
})
