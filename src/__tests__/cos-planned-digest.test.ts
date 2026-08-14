import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { planAction } from '../cos/executor.js'
import {
  buildPlannedDigest, reportPlannedOutbound, plannedDigestPostedToday,
  PLANNED_DIGEST_HEADER,
} from '../cos/outbound-alert.js'

// A drafted letter waits in outbound_ledger as PLANNED. Nothing used to push
// that queue at the owner, so one real letter sat there two days unnoticed.
// These tests measure the EFFECT (something was posted, naming the row), not the
// existence of the function.

const NOW = 1_800_000_000
const DAY = 86400

function seedPlanned(seq: number, opts: { subject?: string; to?: string; createdAt?: number } = {}) {
  const db = getDb()
  const p = planAction(db, {
    caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: seq,
    payload: { to: opts.to ?? 'them@example.com', subject: opts.subject ?? 'Re: ugy', body: 'TITKOS LEVELTORZS' },
    recipient: opts.to ?? 'them@example.com',
  }, opts.createdAt ?? NOW)
  return p.ledgerId
}

describe('PLANNED outbound daily digest', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Csomag visszakuldes', caseType: 'CLAIM' }, NOW)
  })

  // THE point of the whole thing: silence on zero is what made the gap invisible
  // in the first place, so the empty queue has to produce text too.
  it('speaks in the zero case instead of going quiet', () => {
    const d = buildPlannedDigest(getDb(), NOW)
    expect(d.count).toBe(0)
    expect(d.oldestAgeDays).toBeNull()
    expect(d.text).toContain('0 sor')
    expect(d.text).toContain(PLANNED_DIGEST_HEADER)
  })

  it('names the row, its age, subject and recipient', () => {
    const id = seedPlanned(1, { subject: 'Re: hol tart az ugy', to: 'r.mark@example.com', createdAt: NOW - 2 * DAY })
    const d = buildPlannedDigest(getDb(), NOW)
    expect(d.count).toBe(1)
    expect(d.oldestAgeDays).toBe(2)
    expect(d.text).toContain(id)
    expect(d.text).toContain('2 napja')
    expect(d.text).toContain('Re: hol tart az ugy')
    expect(d.text).toContain('r.mark@example.com')
    expect(d.text).toContain('Csomag visszakuldes')
  })

  // The digest is a wide surface (bus + daily log). The letter body is personal
  // correspondence and must not ride along.
  it('never carries the letter body', () => {
    seedPlanned(1)
    expect(buildPlannedDigest(getDb(), NOW).text).not.toContain('TITKOS LEVELTORZS')
  })

  it('reports the oldest age from the oldest row, not the newest', () => {
    seedPlanned(1, { createdAt: NOW - 5 * DAY })
    seedPlanned(2, { createdAt: NOW - 1 * DAY })
    expect(buildPlannedDigest(getDb(), NOW).oldestAgeDays).toBe(5)
  })

  it('says so when the listing is capped instead of reading as the whole queue', () => {
    for (let i = 1; i <= 4; i++) seedPlanned(i, { createdAt: NOW - i * DAY })
    const d = buildPlannedDigest(getDb(), NOW, 2)
    expect(d.count).toBe(4)
    expect(d.text).toContain('+2 tovabbi')
  })

  it('ignores rows that already left PLANNED', () => {
    const id = seedPlanned(1)
    getDb().prepare(`UPDATE outbound_ledger SET status='VERIFIED' WHERE ledger_id=?`).run(id)
    expect(buildPlannedDigest(getDb(), NOW).count).toBe(0)
  })

  it('posts to the bus AND leaves a daily-log receipt', () => {
    seedPlanned(1, { subject: 'Re: hol tart az ugy' })
    const r = reportPlannedOutbound(getDb(), NOW)
    expect(r.posted).toBe(true)
    expect(r.count).toBe(1)
    const msg = getDb().prepare(
      `SELECT content FROM agent_messages WHERE from_agent='cos-outbound' ORDER BY id DESC LIMIT 1`
    ).get() as { content: string } | undefined
    expect(msg?.content).toContain('Re: hol tart az ugy')
    expect(plannedDigestPostedToday(getDb())).toBe(true)
  })

  it('posts the zero case as well, so a quiet day still leaves a receipt', () => {
    const r = reportPlannedOutbound(getDb(), NOW)
    expect(r.posted).toBe(true)
    expect(r.count).toBe(0)
    const msg = getDb().prepare(
      `SELECT content FROM agent_messages WHERE from_agent='cos-outbound' ORDER BY id DESC LIMIT 1`
    ).get() as { content: string } | undefined
    expect(msg?.content).toContain('0 sor')
  })

  // It rides the ten-minute cycle, so it must not post six times an hour.
  it('posts once a day: the second call in the same day is a no-op', () => {
    seedPlanned(1)
    expect(reportPlannedOutbound(getDb(), NOW).posted).toBe(true)
    const second = reportPlannedOutbound(getDb(), NOW)
    expect(second.posted).toBe(false)
    expect(second.alreadyToday).toBe(true)
    const n = getDb().prepare(
      `SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent='cos-outbound'`
    ).get() as { n: number }
    expect(n.n).toBe(1)
  })

  // The guard reads its own receipt. If the receipt is gone the digest must fire
  // again, rather than trust a separate "already done" flag that can drift.
  it('fires again when its own receipt is missing', () => {
    seedPlanned(1)
    reportPlannedOutbound(getDb(), NOW)
    getDb().prepare(`DELETE FROM daily_logs WHERE content LIKE ?`).run(`${PLANNED_DIGEST_HEADER}%`)
    expect(plannedDigestPostedToday(getDb())).toBe(false)
    expect(reportPlannedOutbound(getDb(), NOW).posted).toBe(true)
  })

  // Someone else's daily-log line must not be mistaken for this digest's receipt.
  it('does not accept an unrelated daily-log entry as its receipt', () => {
    const db = getDb()
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Budapest' })
    db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?,?,?,?)')
      .run('marveen', today, '## Valami mas tortent ma', NOW)
    expect(plannedDigestPostedToday(db)).toBe(false)
  })
})
