import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { mintGatePermit } from '../cos/gate-permit.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import {
  planAction, executeAction, SendError,
  type OutboundAdapter, type OutboundAction, type ReadbackResult,
} from '../cos/executor.js'
import {
  getRetryPolicy, DEFAULT_MAX_SEND_ATTEMPTS, DEFAULT_SEND_BACKOFF_SEC,
} from '../cos/recovery-queue.js'

// W12 CLOSURE (Istvan, 2026-08-25): ONE source of truth for the send ceiling.
//
// The first W12 build left executor-core's F-15 constants in place and had
// `DEFAULT_RETRY_POLICIES` repeat the same two numbers by hand. The done report
// named it as a deliberate gap; Istvan refused that closure, and he was right
// about the failure mode: an operator editing `cos_retry_policy.OUTBOUND_SEND`
// would move the QUEUE's view of the budget and not the EXECUTOR's behaviour,
// and nothing anywhere would say so. Two answers to one question, with only one
// of them acting.
//
// These tests are about the behaviour, not the wiring diagram: the policy row is
// edited and the executor is asked to act. If the row does not decide, they fail.

class MockAdapter implements OutboundAdapter {
  readonly actionType = 'EMAIL_SEND'
  sendCalls = 0
  provider = new Set<string>()
  async send(a: OutboundAction): Promise<{ externalRef: string }> {
    this.sendCalls++
    throw new SendError('connection refused before request', { reachedProvider: false, terminal: false })
  }
  async readback(marker: string): Promise<ReadbackResult> {
    return this.provider.has(marker) ? { found: true, externalRef: 'ext-rb' } : { found: false }
  }
}

const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' } }

function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {
  const ctx = {
    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,
    actionId: ledgerId, actionType: 'EMAIL_SEND', intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] })).authorizationId, authorizationContext: ctx }
}

function ensureDraftEvidence(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number): void {
  const row = db.prepare(`SELECT case_id, status, case_version FROM outbound_ledger WHERE ledger_id=?`).get(ledgerId) as
    { case_id: string | null; status: string; case_version: number | null } | undefined
  if (!row?.case_id) return
  const c = db.prepare(`SELECT version FROM personal_cases WHERE case_id=?`).get(row.case_id) as { version: number }
  if (row.case_version == null) db.prepare(`UPDATE outbound_ledger SET case_version=? WHERE ledger_id=?`).run(c.version, ledgerId)
  const exists = db.prepare(`SELECT 1 FROM personal_case_events WHERE case_id=? AND event_type='OUTBOUND_DRAFTED' AND source_reference=? LIMIT 1`).get(row.case_id, ledgerId)
  if (!exists) appendCaseEvent(db, {
    caseId: row.case_id, caseVersion: c.version, actor: 'test', eventType: 'OUTBOUND_DRAFTED',
    reason: 'ceiling test fixture: production-equivalent draft evidence horizon',
    sourceSystem: 'test:ceiling', sourceReference: ledgerId, payload: { ledgerId },
  }, now)
}

/** A row already sitting at `attempt`, retryable, last attempted at `sendingAt`. */
function retryableAt(attempt: number, sendingAt: number): string {
  const db = getDb()
  const p = planAction(db, PLAN, 1000)
  db.prepare(`UPDATE outbound_ledger SET status='FAILED_RETRYABLE', attempt=?, sending_at=? WHERE ledger_id=?`)
    .run(attempt, sendingAt, p.ledgerId)
  return p.ledgerId
}

function setPolicy(patch: { maxAttempts?: number; baseBackoffSec?: number }) {
  const db = getDb()
  if (patch.maxAttempts !== undefined) {
    db.prepare(`UPDATE cos_retry_policy SET max_attempts=? WHERE retry_class='OUTBOUND_SEND'`).run(patch.maxAttempts)
  }
  if (patch.baseBackoffSec !== undefined) {
    db.prepare(`UPDATE cos_retry_policy SET base_backoff_sec=? WHERE retry_class='OUTBOUND_SEND'`).run(patch.baseBackoffSec)
  }
}

describe('W12 closure — the send ceiling has exactly one source of truth', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('LOWERING the policy row gives up sooner — the row decides, not a constant', async () => {
    const db = getDb(), ad = new MockAdapter()
    setPolicy({ maxAttempts: 2 })
    const id = retryableAt(2, 1000)
    ensureDraftEvidence(db, id, 100_000)
    const r = await executeAction(db, ad, id, 100_000, authorized(db, id, 100_000))
    // With the old hardcoded 5 this row had three attempts left and would have
    // been sent again.
    expect(r.status).toBe('FAILED_TERMINAL')
    expect(r.lastError).toMatch(/giving up after 2 attempts/)
    expect(ad.sendCalls).toBe(0)
  })

  it('RAISING it keeps the row alive past the shipped default — both directions, not just one', async () => {
    const db = getDb(), ad = new MockAdapter()
    setPolicy({ maxAttempts: 9, baseBackoffSec: 1 })
    const id = retryableAt(DEFAULT_MAX_SEND_ATTEMPTS + 1, 1000)  // 6, past the shipped 5
    ensureDraftEvidence(db, id, 100_000)
    const r = await executeAction(db, ad, id, 100_000, authorized(db, id, 100_000))
    // Not terminal: the budget is 9 now. The adapter is asked, and fails again,
    // which is the row staying in the retry cycle rather than being given up on.
    expect(r.status).toBe('FAILED_RETRYABLE')
    expect(ad.sendCalls).toBe(1)
  })

  it('the BACKOFF comes from the row too, and holds the send back', async () => {
    const db = getDb(), ad = new MockAdapter()
    setPolicy({ maxAttempts: 9, baseBackoffSec: 3600 })
    const id = retryableAt(1, 100_000)
    ensureDraftEvidence(db, id, 100_060)
    const r = await executeAction(db, ad, id, 100_060, authorized(db, id, 100_060))
    // One minute after the last attempt. With the shipped 30s base this row
    // would have been retried; with the operator's 3600 it must not be.
    expect(ad.sendCalls).toBe(0)
    expect(r.status).toBe('FAILED_RETRYABLE')
  })

  it('an explicit per-call budget still wins — that is a narrower ask, not a second default', async () => {
    const db = getDb(), ad = new MockAdapter()
    setPolicy({ maxAttempts: 9 })
    const id = retryableAt(2, 1000)
    ensureDraftEvidence(db, id, 100_000)
    const r = await executeAction(db, ad, id, 100_000, {
      ...authorized(db, id, 100_000), retry: { maxAttempts: 2, baseBackoffSec: 1 },
    })
    expect(r.status).toBe('FAILED_TERMINAL')
  })

  it('STANDING CHECK: the seeded row IS the constants — the seed cannot drift from the fallback', () => {
    const p = getRetryPolicy(getDb(), 'OUTBOUND_SEND')
    expect(p.maxAttempts).toBe(DEFAULT_MAX_SEND_ATTEMPTS)
    expect(p.baseBackoffSec).toBe(DEFAULT_SEND_BACKOFF_SEC)
  })

  it('STANDING CHECK: executor-core declares no ceiling of its own', () => {
    // Source-level, deliberately. The behavioural tests above prove the row
    // decides TODAY; this one is the guard against somebody reintroducing a
    // literal fallback next to the policy read, which would pass every test
    // above while quietly restoring the two-answers state.
    const src = readFileSync(join(__dirname, '..', 'cos', 'executor-core.ts'), 'utf-8')
    expect(src).not.toMatch(/DEFAULT_MAX_SEND_ATTEMPTS\s*=\s*\d/)
    expect(src).not.toMatch(/DEFAULT_SEND_BACKOFF_SEC\s*=\s*\d/)
    // and it reads the policy where the ceiling is applied
    expect(src).toContain("getRetryPolicy(db, 'OUTBOUND_SEND')")
  })
})
