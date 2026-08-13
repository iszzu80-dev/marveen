/**
 * Mission Control route fixes from the 2026-08-13 code review.
 *
 * Five findings, all on the shared /api/cos surface:
 *   A8  — REQUEST_APPROVAL was missing from QUESTION_DECISIONS, so an approval
 *         question 404'd here and was answerable ONLY over Telegram.
 *   A11 — approveAndDispatchZst recorded a caller-supplied recipient allowlist,
 *         so the request body could WIDEN what the owner approved.
 *   A18 — progressionRan was hardcoded true even when the cycle threw.
 *   E18 — a dispatch refused by the executor's admission step returned
 *         sent:false with no reason at all.
 *   L4  — a Scope-Gate-routed message crossed into the ZST store through a
 *         double cast, carrying a personal vocabulary the ZST side cannot read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { tryClaimProgression } from '../cos/progression-scheduler.js'
import type { RouteContext } from '../web/routes/types.js'

// A18 needs the engine to throw on demand. Everything else in the module keeps
// its real implementation.
const cycleShouldThrow = { value: false }
vi.mock('../cos/progression-pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cos/progression-pipeline.js')>()
  return {
    ...actual,
    runProgressionCycle: (...args: Parameters<typeof actual.runProgressionCycle>) => {
      if (cycleShouldThrow.value) throw new Error('engine exploded')
      return actual.runProgressionCycle(...args)
    },
  }
})

const { tryHandleCos, approveAndDispatchZst, toZstTriagedEmail, dispatchReasons } =
  await import('../web/routes/cos.js')

function fakeCtx(path: string, method = 'GET'): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method, url } as RouteContext, out }
}

function fakeCtxWithBody(path: string, method: string, body: unknown) {
  const { ctx, out } = fakeCtx(path, method)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

const CASE_ID = 'PRI-REVIEW-0813-001'
const APPROVAL_RUN = 'run-approval-0813-01'

function seedApprovalQuestion(db: ReturnType<typeof getDb>) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT OR IGNORE INTO personal_cases
    (case_id, title, case_type, status, priority, sensitivity, source_system, owner, created_at, updated_at)
    VALUES (?, 'Approval case', 'OTHER', 'AWAITING_APPROVAL', 'P2', 'PERSONAL', 'test', 'istvan', ?, ?)`
  ).run(CASE_ID, now, now)
  db.prepare(`INSERT OR REPLACE INTO case_progression_state
    (domain, case_id, semantic_completion_status, progression_enabled, progression_mode,
     plan_version, case_version, goal_version, created_at, updated_at)
    VALUES ('personal', ?, 'IN_PROGRESS', 1, 'shadow', 1, 1, 0, ?, ?)`
  ).run(CASE_ID, now, now)
  db.prepare(`INSERT OR IGNORE INTO case_progression_runs
    (progression_run_id, domain, case_id, trigger_type, decision, reason, status, started_at, completed_at,
     case_version_before, case_version_after, plan_version_before, plan_version_after)
    VALUES (?, 'personal', ?, 'MANUAL', 'REQUEST_APPROVAL', 'needs approval', 'COMPLETED', ?, ?, 1, 1, 1, 1)`
  ).run(APPROVAL_RUN, CASE_ID, now, now)
}

describe('A8: an approval question is answerable from Mission Control', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    cycleShouldThrow.value = false
    seedApprovalQuestion(getDb())
  })

  it('does NOT 404 when the active question is REQUEST_APPROVAL', async () => {
    const { ctx, out } = fakeCtxWithBody(
      `/api/cos/cases/personal/${CASE_ID}/owner-action`, 'POST', {
        eventType: 'OWNER_DECISION', choice: 'YES',
        sourceReference: APPROVAL_RUN, caseVersion: 1,
        idempotencyKey: 'idem-a8-1',
        decision: 'REQUEST_APPROVAL', nextBestAction: null,
      })
    await tryHandleCos(ctx)

    // Before the fix this was 404 "no active question for this case": the
    // decision was simply absent from QUESTION_DECISIONS.
    expect(out.status).not.toBe(404)
    expect(out.body.ok).toBe(true)

    const ev = getDb().prepare(
      `SELECT event_type, payload FROM personal_case_events WHERE case_id = ? ORDER BY event_id DESC LIMIT 1`
    ).get(CASE_ID) as { event_type: string; payload: string }
    expect(ev.event_type).toBe('OWNER_DECISION')
    expect(JSON.parse(ev.payload).choice).toBe('YES')
  })
})

describe('A18: progressionRan reports what actually happened', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    cycleShouldThrow.value = false
    seedApprovalQuestion(getDb())
  })

  // Found BY the A18 fix: with progressionRan hardcoded true, the post-cycle
  // read asked case_progression_runs for next_best_action_json — a column that
  // lives on case_progression_state. It threw on every single owner action,
  // inside the try, and the catch filed it as "the engine failed". So the
  // instant feedback this control exists for had never once worked.
  it('returns the decision AND the next best action the cycle produced', async () => {
    const { ctx, out } = fakeCtxWithBody(
      `/api/cos/cases/personal/${CASE_ID}/owner-action`, 'POST', {
        eventType: 'OWNER_DECISION', choice: 'YES',
        sourceReference: APPROVAL_RUN, caseVersion: 1,
        idempotencyKey: 'idem-a18-2',
        decision: 'REQUEST_APPROVAL', nextBestAction: null,
      })
    await tryHandleCos(ctx)

    expect(out.body.progressionRan).toBe(true)
    expect(out.body.progressionError).toBeUndefined()
    expect(out.body.newDecision).toBeTruthy()
    expect(out.body.newNextBestAction).toBeTruthy()
  })

  it('A14: refuses to cycle a case the heartbeat already holds', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    // The cron runner takes the lease first.
    const held = tryClaimProgression(db, 'personal', CASE_ID, 'heartbeat-run-1', 300, now, { requireDue: false })
    expect(held).toBeTruthy()

    const { ctx, out } = fakeCtxWithBody(
      `/api/cos/cases/personal/${CASE_ID}/owner-action`, 'POST', {
        eventType: 'OWNER_DECISION', choice: 'YES',
        sourceReference: APPROVAL_RUN, caseVersion: 1,
        idempotencyKey: 'idem-a14-1',
        decision: 'REQUEST_APPROVAL', nextBestAction: null,
      })
    await tryHandleCos(ctx)

    // The event still lands — it is the durable part. The cycle does not.
    expect(out.body.ok).toBe(true)
    expect(out.body.eventId).toBeGreaterThan(0)
    expect(out.body.progressionRan).toBe(false)
    expect(String(out.body.progressionError)).toContain('másik ciklus')

    const runs = db.prepare(
      `SELECT count(*) c FROM case_progression_runs
       WHERE case_id = ? AND progression_run_id <> ?`
    ).get(CASE_ID, APPROVAL_RUN) as { c: number }
    expect(runs.c).toBe(0)
  })

  it('reports progressionRan:false and the cause when the cycle throws', async () => {
    cycleShouldThrow.value = true
    const { ctx, out } = fakeCtxWithBody(
      `/api/cos/cases/personal/${CASE_ID}/owner-action`, 'POST', {
        eventType: 'OWNER_DECISION', choice: 'YES',
        sourceReference: APPROVAL_RUN, caseVersion: 1,
        idempotencyKey: 'idem-a18-1',
        decision: 'REQUEST_APPROVAL', nextBestAction: null,
      })
    await tryHandleCos(ctx)

    // The event still lands (the engine failing does not roll it back) — but
    // the response must not claim the engine ran.
    expect(out.body.ok).toBe(true)
    expect(out.body.progressionRan).toBe(false)
    expect(String(out.body.progressionError)).toContain('engine exploded')
  })
})

describe('A11: an approval cannot be widened past what the owner saw', () => {
  const LEDGER = 'zl-review-0813-1'
  const CAMPAIGN = 'zc-review-0813-1'

  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT OR IGNORE INTO zst_cases
      (case_id, title, case_type, status, priority, sensitivity, workspace, scope, source_system, created_at, updated_at)
      VALUES ('ZST-REVIEW-0813', 'Case', 'GENERAL_OPERATION', 'READY', 'P2', 'ZST_INTERNAL', 'OPERATIONS',
              'ZST_OPERATIONS_CONFIRMED', 'test', ?, ?)`).run(now, now)
    db.prepare(`INSERT OR IGNORE INTO zst_campaigns
      (campaign_id, case_id, campaign_type, template_hash, status, version, created_at, updated_at)
      VALUES (?, 'ZST-REVIEW-0813', 'EMAIL', 'tpl-hash-1', 'APPROVED', 1, ?, ?)`).run(CAMPAIGN, now, now)
    db.prepare(`INSERT OR IGNORE INTO zst_outbound_ledger
      (ledger_id, case_id, campaign_id, action_type, sequence_number, internal_idempotency_key,
       external_idempotency_marker, payload, status, attempt, created_at, updated_at)
      VALUES (?, 'ZST-REVIEW-0813', ?, 'EMAIL_SEND', 1, 'idem-z-1', 'marker-z-1', ?, 'PLANNED', 0, ?, ?)`
    ).run(LEDGER, CAMPAIGN,
      JSON.stringify({ to: 'konyvelo@example.com', subject: 'Havi zárás', body: 'Csatolva.' }), now, now)
  })

  it('refuses a request that adds a recipient the draft never had', async () => {
    const r = await approveAndDispatchZst(
      getDb(), LEDGER, undefined, 'istvan',
      ['konyvelo@example.com', 'valaki.mas@example.com'],
      Math.floor(Date.now() / 1000),
    )
    expect(r.sent).toBe(false)
    expect(r.reasons?.join(' ')).toContain('valaki.mas@example.com')

    // And nothing was recorded: a refused widening must not leave an envelope.
    const appr = getDb().prepare(
      'SELECT count(*) c FROM zst_campaign_approvals WHERE campaign_id = ?'
    ).get(CAMPAIGN) as { c: number }
    expect(appr.c).toBe(0)
  })
})

describe('E18: a refusal below the gate still has a reason', () => {
  it('surfaces the executor admission refusal when the gate allowed', () => {
    expect(dispatchReasons({
      sent: false,
      decision: { allowed: true, reasons: [] },
      action: { lastError: 'refused: claim held by another run' },
    })).toEqual(['refused: claim held by another run'])
  })

  it('still prefers the gate reasons when the gate refused', () => {
    expect(dispatchReasons({
      sent: false,
      decision: { allowed: false, reasons: ['nincs jóváhagyás'] },
      action: { lastError: 'irrelevant' },
    })).toEqual(['nincs jóváhagyás'])
  })

  it('says nothing when the send succeeded', () => {
    expect(dispatchReasons({
      sent: true, decision: { allowed: true, reasons: [] }, action: { lastError: null },
    })).toBeUndefined()
  })

  it('never returns an empty explanation for a silent failure', () => {
    const r = dispatchReasons({ sent: false, decision: { allowed: true, reasons: [] }, action: {} })
    expect(r).toHaveLength(1)
    expect(r?.[0]).toBeTruthy()
  })
})

describe('L4: the Scope-Gate boundary translates, it does not cast', () => {
  it('maps the personal sensitivity vocabulary onto the ZST one', () => {
    expect(toZstTriagedEmail({
      accountId: 'a', messageId: 'm', subject: 's', from: 'f', snippet: '', actionable: true,
      declaredSensitivity: 'SENSITIVE_PERSONAL',
    }).declaredSensitivity).toBe('ZST_PERSONAL_DATA')

    expect(toZstTriagedEmail({
      accountId: 'a', messageId: 'm', subject: 's', from: 'f', snippet: '', actionable: true,
      declaredSensitivity: 'PERSONAL',
    }).declaredSensitivity).toBe('ZST_INTERNAL')
  })

  it('drops a personal case type instead of passing a word ZST cannot read', () => {
    // 'EMAIL' has no §8.2 meaning; passing it through silently skipped the
    // extractor triggers, so a supplier invoice never reached the extractor.
    expect(toZstTriagedEmail({
      accountId: 'a', messageId: 'm', subject: 's', from: 'f', snippet: '', actionable: true,
      caseType: 'EMAIL',
    }).caseType).toBeUndefined()

    expect(toZstTriagedEmail({
      accountId: 'a', messageId: 'm', subject: 's', from: 'f', snippet: '', actionable: true,
      caseType: 'INVOICE',
    }).caseType).toBe('INVOICE_INCOMING')
  })

  it('leaves an unmapped sensitivity absent so the ZST side fail-closes', () => {
    expect(toZstTriagedEmail({
      accountId: 'a', messageId: 'm', subject: 's', from: 'f', snippet: '', actionable: true,
      declaredSensitivity: 'NONSENSE' as never,
    }).declaredSensitivity).toBeUndefined()
  })

  it('carries the identifying fields across unchanged', () => {
    const z = toZstTriagedEmail({
      accountId: 'zst@example.com', messageId: 'msg-1', threadId: 'thr-1',
      subject: 'Számla', from: 'szallito@example.com', to: 'zst@example.com',
      snippet: 'részlet', direction: 'INBOUND', actionable: true, title: 'Cím',
      followUpAt: 123, headers: { 'X-Test': '1' },
    })
    expect(z).toMatchObject({
      accountId: 'zst@example.com', messageId: 'msg-1', threadId: 'thr-1',
      subject: 'Számla', from: 'szallito@example.com', to: 'zst@example.com',
      snippet: 'részlet', direction: 'INBOUND', actionable: true, title: 'Cím',
      followUpAt: 123, headers: { 'X-Test': '1' },
    })
  })
})
