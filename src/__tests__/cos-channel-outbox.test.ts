// The channel outbox: what a producer with no state of its own does when it has
// something to tell the owner.
//
// The radar is the first such producer, and it is the reason the queue exists
// rather than a direct send. `alertRadarHit` runs inside the radar tick —
// synchronous, no awaiting — so a Telegram call there would put an HTTPS round
// trip inside a loop that must not block, and a hit lost to a transient failure
// would be lost for good. A price falls below its target once.
//
// Tonight (2026-08-11) the same class of failure hit the question path for real:
// a send failed, and only the fact that queueing and sending are separate steps
// kept the question alive to be retried.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  enqueueOutbox, pendingOutbox, markOutboxSent, markOutboxFailed,
} from '../cos/channel-outbox.js'

const T0 = 1_700_000_000
const entry = (over: Partial<Parameters<typeof enqueueOutbox>[1]> = {}) => ({
  channel: 'telegram:cos', kind: 'radar', dedupeKey: 'radar:r1:1000', text: '🎯 HIT', ...over,
})

describe('cos_channel_outbox', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('queues a message and hands it back as pending', () => {
    expect(enqueueOutbox(getDb(), entry(), T0)).toBe(true)
    const q = pendingOutbox(getDb(), 'telegram:cos')
    expect(q).toHaveLength(1)
    expect(q[0].text).toBe('🎯 HIT')
    expect(q[0].attempts).toBe(0)
  })

  it('the SAME news is not queued twice', () => {
    // Two radar ticks over one observation are the same news. Telling the owner
    // the same price fell twice is how a channel earns being muted.
    expect(enqueueOutbox(getDb(), entry(), T0)).toBe(true)
    expect(enqueueOutbox(getDb(), entry(), T0 + 60)).toBe(false)
    expect(pendingOutbox(getDb(), 'telegram:cos')).toHaveLength(1)
  })

  it('a NEW observation IS new news', () => {
    // The counter-case: dedupe must key on the thing announced, not on the item,
    // or a second genuine price drop would be silently swallowed.
    enqueueOutbox(getDb(), entry({ dedupeKey: 'radar:r1:1000' }), T0)
    enqueueOutbox(getDb(), entry({ dedupeKey: 'radar:r1:2000' }), T0 + 3600)
    expect(pendingOutbox(getDb(), 'telegram:cos')).toHaveLength(2)
  })

  it('a delivered message leaves the queue and records where it went', () => {
    enqueueOutbox(getDb(), entry(), T0)
    const [q] = pendingOutbox(getDb(), 'telegram:cos')
    markOutboxSent(getDb(), q.outbox_id, '8942301795:42', T0 + 5)
    expect(pendingOutbox(getDb(), 'telegram:cos')).toHaveLength(0)
    const row = getDb().prepare(
      `SELECT sent_at, channel_target FROM cos_channel_outbox WHERE outbox_id = ?`,
    ).get(q.outbox_id) as { sent_at: number; channel_target: string }
    expect(row.sent_at).toBe(T0 + 5)
    expect(row.channel_target).toBe('8942301795:42')
  })

  it('a FAILED send keeps the message queued for the next drain', () => {
    // The whole reason for the queue. The row stays unsent, the error is kept
    // for whoever reads the report, and the attempt is counted so a permanently
    // failing message is visible as such rather than as silence.
    enqueueOutbox(getDb(), entry(), T0)
    const [q] = pendingOutbox(getDb(), 'telegram:cos')
    markOutboxFailed(getDb(), q.outbox_id, 'telegram sendMessage failed: fetch failed')
    const again = pendingOutbox(getDb(), 'telegram:cos')
    expect(again).toHaveLength(1)
    expect(again[0].attempts).toBe(1)
    expect((getDb().prepare(
      `SELECT last_error AS e FROM cos_channel_outbox WHERE outbox_id = ?`,
    ).get(q.outbox_id) as { e: string }).e).toMatch(/fetch failed/)
  })

  it('a drain for one channel does not pick up another channel’s messages', () => {
    // The split exists so the two channels stay distinguishable; a drain that
    // ignored the address would undo it at the last step.
    enqueueOutbox(getDb(), entry({ channel: 'telegram:cos', dedupeKey: 'a' }), T0)
    enqueueOutbox(getDb(), entry({ channel: 'telegram:dev', dedupeKey: 'b' }), T0)
    expect(pendingOutbox(getDb(), 'telegram:cos')).toHaveLength(1)
    expect(pendingOutbox(getDb(), 'telegram:cos')[0].dedupe_key).toBe('a')
  })

  it('oldest first', () => {
    enqueueOutbox(getDb(), entry({ dedupeKey: 'newer' }), T0 + 100)
    enqueueOutbox(getDb(), entry({ dedupeKey: 'older' }), T0)
    expect(pendingOutbox(getDb(), 'telegram:cos').map(r => r.dedupe_key)).toEqual(['older', 'newer'])
  })
})
