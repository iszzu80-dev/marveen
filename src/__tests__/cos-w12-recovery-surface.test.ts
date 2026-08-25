import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, markRecoveryRequired } from '../cos/email-ingest.js'
import { reconcileRecoveryQueue, recordRecoveryAttempt } from '../cos/recovery-queue.js'
import { listMonitoring } from '../web/routes/cos.js'

// W12 / §6.7 — the escalated record reaches the SURFACE Istvan chose for it.
//
// His constraint (2026-08-25): the existing internal UI/brief surfaces the
// queue, and W12 opens NO new automatic email/push/outbound channel. So the
// proof obligation is not "the row exists" — the audit could already say that
// about RECOVERY_REQUIRED — it is that the row travels the whole way: source
// table → queue → API → rendered HTML. Every one of those hops has been the
// place a COS feature stopped being visible at least once.

const ACC = 'iszzu80'
const NOW = 1_700_000_000

const COSCONTROL_SRC = readFileSync(join(__dirname, '..', '..', 'web', 'coscontrol.js'), 'utf-8')

function escalatedIngestRow() {
  const db = getDb()
  openBatch(db, {
    batchId: 'b-m1', accountId: ACC, cursorBefore: '100', cursorAfter: '150',
    messages: [{ messageId: 'm1', threadId: 't1' }],
  }, NOW)
  markRecoveryRequired(db, ACC, 'm1', 'parse failed three times', NOW)
  reconcileRecoveryQueue(db, NOW)
  for (const t of [10, 100, 300]) recordRecoveryAttempt(db, 'INGEST', `${ACC}/m1`, { ok: false, error: 'parse failed three times' }, NOW + t)
}

describe('W12 §6.7 — the API carries the queue', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('/api/cos/monitoring reports the escalated record with its policy numbers', () => {
    escalatedIngestRow()
    const mon = listMonitoring(getDb())
    expect(mon.recovery.counts.NEEDS_HUMAN).toBe(1)
    const row = mon.recovery.needsHuman[0] as Record<string, unknown>
    expect(row.surface).toBe('INGEST')
    expect(row.ref).toBe(`${ACC}/m1`)
    expect(row.attempts).toBe(3)
    expect(row.maxAttempts).toBe(5)
    expect(row.escalateAfter).toBe(3)
    expect(String(row.pendingAction)).toMatch(/RE_APPLY_LOCAL/)
    expect(row.lastError).toBe('parse failed three times')
  })

  it('the endpoint does NOT reconcile: a queue kept up to date only by the cycle can be seen to be stale', () => {
    const db = getDb()
    openBatch(db, { batchId: 'b-m9', accountId: ACC, cursorBefore: '100', cursorAfter: '150', messages: [{ messageId: 'm9', threadId: 't9' }] }, NOW)
    markRecoveryRequired(db, ACC, 'm9', 'never reconciled', NOW)
    // The source row is parked, but nothing has reconciled yet — and a GET that
    // silently rebuilt the queue would always agree with itself, whether or not
    // the step that maintains it ever ran.
    const mon = listMonitoring(db)
    expect(mon.recovery.needsHuman).toEqual([])
    expect(mon.recovery.pendingRetry).toEqual([])
  })
})

describe('W12 §6.7 — the internal UI renders it', () => {
  beforeEach(() => {
    delete (globalThis as any).window
    delete (globalThis as any).document
    vi.restoreAllMocks()
  })

  function freshDom() {
    const { JSDOM } = require('jsdom')
    return new JSDOM('<!DOCTYPE html><html><body><div id="cosBody"></div></body></html>',
      { url: 'http://localhost:3420', runScripts: 'dangerously' })
  }

  function mount(monitoring: unknown) {
    const dom = freshDom()
    const responses: Record<string, unknown> = {
      '/api/cos/today': { cases: [] }, '/api/cos/cases': { cases: [] },
      '/api/cos/outbound': {}, '/api/cos/campaigns': {}, '/api/cos/radar': {},
      '/api/cos/monitoring': monitoring, '/api/cos/analytics': {},
      '/api/cos/zst-today': { cases: [] }, '/api/cos/zst-cases': { cases: [] },
    }
    const fn = vi.fn(async (url: string) => {
      const s = String(url)
      for (const k of Object.keys(responses)) if (s.startsWith(k)) return { ok: true, json: async () => responses[k] }
      return { ok: true, json: async () => ({}) }
    })
    ;(dom.window as any).fetch = fn
    ;(globalThis as any).fetch = fn
    ;(globalThis as any).window = dom.window
    ;(globalThis as any).document = dom.window.document
    dom.window.eval(COSCONTROL_SRC)
    const cc = (dom.window as any).CosControl
    if (!cc) throw new Error('CosControl not found on window after eval')
    cc.mount()
    return dom
  }

  const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

  it('an escalated record is visible in COS Control, with what it is waiting for', async () => {
    const dom = mount({
      recovery: {
        counts: { NEEDS_HUMAN: 1 },
        needsHuman: [{
          queueId: 'INGEST:iszzu80/m1', surface: 'INGEST', ref: 'iszzu80/m1', caseId: null,
          pendingAction: 'RE_APPLY_LOCAL: re-run the local intake for this message; nothing is sent to any provider',
          lastKnownOutcome: 'RECOVERY_REQUIRED', retryClass: 'INGEST_LOCAL_APPLY',
          attempts: 3, maxAttempts: 5, escalateAfter: 3, escalatedAt: NOW + 300,
          escalationReason: '3 attempt(s) of max 5, escalation threshold 3',
          lastError: 'parse failed three times',
        }],
        pendingRetry: [],
      },
    })
    await tick()
    const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
    expect(html).toContain('Helyre')            // the section exists
    expect(html).toContain('iszzu80/m1')        // the record
    expect(html).toContain('EMBER KELL')        // and that it is a human's now
    expect(html).toContain('3/5')               // the policy numbers, not just a flag
    expect(html).toContain('parse failed three times')
  })

  it('the zero case SPEAKS: an empty queue is written out, not rendered as nothing', async () => {
    const dom = mount({ recovery: { counts: {}, needsHuman: [], pendingRetry: [] } })
    await tick()
    const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
    // A block that disappears when the queue is empty is indistinguishable from
    // one whose data stopped arriving — and noticing that something stopped is
    // this queue's entire job.
    expect(html).toContain('Nincs elakadt helyre')
  })
})
