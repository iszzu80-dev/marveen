// ACTION_APPROVAL_PRODUCER_WIRING — the owner's first Phase 1 pre-release
// blocker, 2026-08-27.
//
//   "A MANUAL_ACTION_REQUIRED high-risk progressionnek legyen tényleges
//    user-facing útja az existing action_authorizations objektum létrehozására.
//    Ne építs új approval rendszert."
//
// WHAT WAS WRONG BEFORE THIS FILE. `human-answer-class.ts` shipped with its own
// confession in its header: HUMAN_ACTION_APPROVAL was "a built and tested path
// with no live producer today". Every field of the owner's required scope was
// already a column on `action_authorizations`, the consumption rules were
// tested, and NOTHING in the system ever issued one for a progression step. So
// Invariant E's single allow-branch for a high-risk action was unreachable by
// any sequence of real events -- a door with no handle on the inside, which is
// indistinguishable from a wall until you need it.
//
// Each of the owner's seven mandatory proofs is a test below, by name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { recordOwnerAnswer } from '../cos/owner-question.js'
import {
  requestActionApproval, decideActionApproval, openApprovalRequestForQuestion,
  type ApprovalRequestRow,
} from '../cos/action-approval-request.js'
import {
  evaluateProgressionApproval, PROGRESSION_APPROVAL_TTL_SEC, APPROVAL_REQUEST_TTL_SEC,
} from '../cos/progression-approval-gate.js'
import { engageKillSwitch } from '../cos/kill-switch.js'
import { progressionPayloadHash } from '../cos/human-answer-class.js'
import {
  issueAuthorization, policyEvaluationHash, type AuthorizationContext,
} from '../cos/action-authorization.js'
import { mintGatePermit } from '../cos/gate-permit.js'
import {
  planAction, executeAction, type OutboundAdapter, type OutboundAction, type ReadbackResult,
} from '../cos/executor.js'
import { reconcileRecoveryQueue, getRecovery } from '../cos/recovery-queue.js'

const NOW = 1_700_000_000
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

// ── The fixture: a case the engine will refuse to advance on its own ─────

function seedHighRiskCase(caseId: string): void {
  const db = getDb()
  createCase(db, {
    caseId, title: `Ügy ${caseId}`, caseType: 'SELECTION', status: 'AWAITING_SELECTION',
    sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
  }, NOW - 100)
  db.prepare(
    `INSERT INTO case_progression_state
      (domain, case_id, progression_enabled, progression_mode, goal, summary,
       next_progression_at, dod_verification_json, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', 'Test goal', 'Test summary', ?, ?, ?, ?)`,
  ).run(caseId, NOW - 100, JSON.stringify({
    criteria: [{ label: '_seed_guard', met: true, met_at: NOW - 100, met_by_run: '_seed' }],
    all_met: true, evaluated_at: NOW - 100,
  }), NOW - 100, NOW - 100)
}

const lastRun = (caseId: string): { decision: string; sa: string } =>
  getDb().prepare(
    `SELECT decision, safety_assertions_json AS sa FROM case_progression_runs
      WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(caseId) as { decision: string; sa: string }

const openRequest = (caseId: string): ApprovalRequestRow | undefined =>
  getDb().prepare(
    `SELECT * FROM cos_action_approval_requests WHERE case_id=? AND decided_at IS NULL`,
  ).get(caseId) as ApprovalRequestRow | undefined

const anyRequest = (caseId: string): ApprovalRequestRow | undefined =>
  getDb().prepare(
    `SELECT * FROM cos_action_approval_requests WHERE case_id=? ORDER BY requested_at DESC LIMIT 1`,
  ).get(caseId) as ApprovalRequestRow | undefined

const tickets = (): Array<Record<string, unknown>> =>
  getDb().prepare(`SELECT * FROM action_authorizations`).all() as Array<Record<string, unknown>>

/** What `cos-channel-send` does after a successful Telegram call. Simulated
 *  rather than skipped: `matchAnswerTarget` only considers questions that were
 *  DELIVERED on the channel the answer arrived on, so a test that never marks
 *  delivery would be answering a question the real system has not asked yet. */
function deliver(caseId: string, questionHash: string, messageId = 4242): void {
  getDb().prepare(
    `UPDATE cos_owner_questions SET channel=?, channel_target=?
      WHERE case_id=? AND question_hash=?`,
  ).run(CHANNEL, `${CHAT}:${messageId}`, caseId, questionHash)
}

/** Answer the CURRENT question with a raw case event, the way Mission Control
 *  does. Used only to walk the plan forward to the EXECUTE step; the approval
 *  answers below go through `recordOwnerAnswer`, the real path. */
function rawAnswer(caseId: string, payload: Record<string, unknown>, at: number, type = 'OWNER_DECISION'): void {
  const runId = (getDb().prepare(
    `SELECT progression_run_id AS id FROM case_progression_runs
      WHERE case_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(caseId) as { id: string }).id
  appendCaseEvent(getDb(), {
    caseId, caseVersion: 1, actor: 'istvan', eventType: type,
    payload, sourceSystem: 'mission_control', sourceReference: runId,
  }, at)
}

/** Drive a case to the Invariant E refusal that opens the door.
 *
 *  The intermediate answer is not decoration: the plan's HIGH-risk step is the
 *  EXECUTE that follows the decision step, so the case has to be walked to it
 *  before Invariant E has anything to refuse. Same shape as the fixture in
 *  cos-human-answer-approval.test.ts, which is where this defect lives. */
function driveToRefusal(caseId: string): ApprovalRequestRow {
  seedHighRiskCase(caseId)
  runProgressionCycle(getDb(), 'personal', caseId, NOW, { triggerType: 'MANUAL', triggerReference: 't0' })
  runProgressionCycle(getDb(), 'personal', caseId, NOW + 10, { triggerType: 'MANUAL', triggerReference: 't1' })
  rawAnswer(caseId, { choice: 'YES' }, NOW + 20)
  runProgressionCycle(getDb(), 'personal', caseId, NOW + 30, { triggerType: 'MANUAL', triggerReference: 't2' })
  const req = openRequest(caseId)
  if (!req) throw new Error(`no approval request was opened for ${caseId}: ${lastRun(caseId)?.sa}`)
  deliver(caseId, req.question_hash!)
  return req
}

/** Istvan answers on the channel, through the real recording path. */
function answer(caseId: string, text: string, at = NOW + 50): void {
  const rec = recordOwnerAnswer(getDb(), {
    caseId, domain: 'personal', text, now: at, channel: { channel: CHANNEL, target: CHAT },
  })
  if (!rec) throw new Error(`the answer was not recorded for ${caseId}`)
}

// ── The producer ────────────────────────────────────────────────────────

describe('the refusal opens a door, and the door names the action', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a HIGH-risk Invariant E refusal opens a scoped approval request', () => {
    const req = driveToRefusal('ap-1')
    const run = lastRun('ap-1')
    expect(run.decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(run.sa).toMatch(/INVARIANT_E_REFUSAL/)

    // The owner's required scope, one column each rather than one blob.
    expect(req.action_id).toBe(`personal:ap-1:plan-step:${req.plan_step}`)
    expect(req.action_type).toBeTruthy()
    expect(req.target_reference).toBe('ap-1')
    expect(req.payload_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(req.case_version).toBeGreaterThan(0)
    expect(req.expires_at).toBe(req.requested_at + APPROVAL_REQUEST_TTL_SEC)
    expect(req.decided_at).toBeNull()
    // ...and no ticket exists yet. The request is a question, not authority.
    expect(tickets()).toHaveLength(0)
  })

  it('the QUESTION Istvan reads names the concrete action, the target and the payload', () => {
    const req = driveToRefusal('ap-2')
    const q = getDb().prepare(
      `SELECT question_text AS t FROM cos_owner_questions WHERE case_id='ap-2' AND question_hash=?`,
    ).get(req.question_hash) as { t: string }
    expect(q.t).toContain(req.description)
    expect(q.t).toContain(req.action_type)
    expect(q.t).toContain('ap-2')
    expect(q.t).toContain(req.payload_hash.slice(0, 12))
    // The owner's own writing rule for this channel.
    expect(q.t).not.toContain('—')
  })

  it('a second refusal on the same step does not put a second question on his pile', () => {
    driveToRefusal('ap-3')
    runProgressionCycle(getDb(), 'personal', 'ap-3', NOW + 20, { triggerType: 'MANUAL', triggerReference: 't2' })
    const rows = getDb().prepare(
      `SELECT COUNT(*) AS n FROM cos_action_approval_requests WHERE case_id='ap-3'`,
    ).get() as { n: number }
    expect(rows.n).toBe(1)
    const open = getDb().prepare(
      `SELECT COUNT(*) AS n FROM cos_owner_questions
        WHERE case_id='ap-3' AND answered_at IS NULL AND superseded_at IS NULL`,
    ).get() as { n: number }
    expect(open.n).toBe(1)
  })
})

// ── The owner's seven mandatory proofs ──────────────────────────────────

describe("the owner's seven proofs", () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('PROOF 1a: information does not manufacture an authorization', () => {
    driveToRefusal('p1a')
    // Free text is not a decision, so the request is not even decided by it.
    answer('p1a', 'A cím egyébként 12/B.')
    expect(tickets()).toHaveLength(0)
    expect(openRequest('p1a')).toBeTruthy()
  })

  it('PROOF 1b: a decision on a DIFFERENT question does not manufacture one either', () => {
    const req = driveToRefusal('p1b')
    // An ordinary reader question, open on the same case, delivered on the same
    // channel and answered with a plain yes. The approval lookup is by QUESTION
    // HASH, so this yes decides the question it was asked about and nothing else.
    const db = getDb()
    db.prepare(
      `UPDATE cos_owner_questions SET superseded_at=NULL WHERE case_id='p1b'`,
    ).run()
    db.prepare(
      `INSERT INTO cos_owner_questions
         (case_id, domain, question_hash, question_text, asked_at, channel, channel_target)
       VALUES ('p1b','personal','other-hash','Kérjünk másik ajánlatot?',?,?,?)`,
    ).run(NOW + 45, CHANNEL, `${CHAT}:99`)
    // NEWER than the approval question, so `recordOwnerAnswer` matches THIS one.
    answer('p1b', 'igen', NOW + 50)
    expect(tickets()).toHaveLength(0)
    // The approval request is untouched: it was never the question answered.
    expect(openApprovalRequestForQuestion(db, 'personal', 'p1b', req.question_hash!)).toBeTruthy()
  })

  it('PROOF 2: an explicit approval of the exact action DOES produce a ticket', () => {
    const req = driveToRefusal('p2')
    answer('p2', 'igen')

    const t = tickets()
    expect(t).toHaveLength(1)
    expect(t[0]!.action_id).toBe(req.action_id)
    expect(t[0]!.action_type).toBe(req.action_type)
    expect(t[0]!.target_reference).toBe('p2')
    expect(t[0]!.payload_hash).toBe(req.payload_hash)
    expect(t[0]!.case_id).toBe('p2')
    expect(t[0]!.case_version).toBe(req.case_version)
    expect(t[0]!.single_use).toBe(1)
    expect(t[0]!.consumed_at).toBeNull()
    expect(Number(t[0]!.expires_at) - Number(t[0]!.issued_at)).toBe(PROGRESSION_APPROVAL_TTL_SEC)

    // The request is spent, and it names the ticket it produced.
    const decided = anyRequest('p2')!
    expect(decided.decision).toBe('APPROVED')
    expect(decided.authorization_id).toBe(t[0]!.authorization_id)

    // AND THE ANSWER EVENT CARRIES IT, which is the only way the pipeline can
    // find it. A ticket in the table that no event references is a ticket the
    // consumer will never look for.
    const ev = getDb().prepare(
      `SELECT payload FROM personal_case_events WHERE case_id='p2'
        AND event_type='OWNER_DECISION' ORDER BY event_id DESC LIMIT 1`,
    ).get() as { payload: string }
    expect(JSON.parse(ev.payload).authorizationId).toBe(t[0]!.authorization_id)
  })

  it('PROOF 2b: END TO END — the approved step is exempt from Invariant E, once', () => {
    driveToRefusal('p2b')
    answer('p2b', 'igen')
    runProgressionCycle(getDb(), 'personal', 'p2b', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })

    const run = lastRun('p2b')
    expect(run.sa).toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
    expect(run.sa).toMatch(/HUMAN_ACTION_APPROVAL/)
    expect(run.sa).not.toMatch(/INVARIANT_E_REFUSAL/)
    expect(run.decision).not.toBe('MANUAL_ACTION_REQUIRED')
    // Spent, and the audit says WHEN.
    expect(tickets()[0]!.consumed_at).not.toBeNull()
  })

  /** Re-stamp the issued ticket as though the gate had authorised a DIFFERENT
   *  action, by recomputing the stored policy hash from a changed context.
   *
   *  WHY THIS AND NOT `UPDATE action_authorizations SET payload_hash=...`. The
   *  first version of these two tests did exactly that, and they were green for
   *  the wrong reason -- they were not green at all, they failed, and the reason
   *  they failed is the point. `policy_evaluation_hash` is what consumption
   *  compares; the individual columns are the audit trail beside it. Changing
   *  `payload_hash` alone changes the record of what was authorised in a way the
   *  check does not read, which tests the audit column rather than the binding.
   *
   *  Re-stamping the HASH is the faithful simulation: the ticket now says "I was
   *  issued for a payload/recipient that is not the one about to happen", which
   *  is precisely the state a re-plan or an edited recipient produces. */
  function restampTicket(caseId: string, over: Partial<AuthorizationContext>): void {
    const req = anyRequest(caseId)!
    const base: AuthorizationContext = {
      domain: 'personal', caseId, caseVersion: req.case_version, goalVersion: req.goal_version,
      actionId: req.action_id, actionType: req.action_type, intent: 'PROGRESSION_STEP',
      targetReference: req.target_reference, recipient: req.recipient,
      payloadHash: req.payload_hash, approvalId: null,
    }
    getDb().prepare(`UPDATE action_authorizations SET policy_evaluation_hash = ?`)
      .run(policyEvaluationHash({ ...base, ...over }))
  }

  it('PROOF 3a: a PAYLOAD change after the approval invalidates the ticket', () => {
    driveToRefusal('p3a')
    answer('p3a', 'igen')
    restampTicket('p3a', { payloadHash: progressionPayloadHash('egy egészen más lépés') })
    runProgressionCycle(getDb(), 'personal', 'p3a', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't3' })
    const run = lastRun('p3a')
    expect(run.sa).toMatch(/HUMAN_ANSWER_NOT_APPROVAL/)
    expect(run.sa).toMatch(/policy evaluation hash mismatch/)
    expect(run.decision).toBe('MANUAL_ACTION_REQUIRED')
  })

  it('PROOF 3b: a RECIPIENT change invalidates it', () => {
    driveToRefusal('p3b')
    answer('p3b', 'igen')
    restampTicket('p3b', { recipient: 'valaki.mas@example.com' })
    runProgressionCycle(getDb(), 'personal', 'p3b', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't3' })
    expect(lastRun('p3b').decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(lastRun('p3b').sa).toMatch(/policy evaluation hash mismatch/)
  })

  it('PROOF 3d: the CASE moving on after the approval invalidates it too', () => {
    driveToRefusal('p3d')
    answer('p3d', 'igen')
    restampTicket('p3d', { caseVersion: 999 })
    runProgressionCycle(getDb(), 'personal', 'p3d', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't3' })
    expect(lastRun('p3d').decision).toBe('MANUAL_ACTION_REQUIRED')
    expect(lastRun('p3d').sa).toMatch(/policy evaluation hash mismatch/)
  })

  it('PROOF 3c: an ACTION change invalidates it — the ticket is for one step', () => {
    driveToRefusal('p3c')
    answer('p3c', 'igen')
    getDb().prepare(`UPDATE action_authorizations SET action_id='personal:p3c:plan-step:99'`).run()
    runProgressionCycle(getDb(), 'personal', 'p3c', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
    expect(lastRun('p3c').sa).toMatch(/was issued for action/)
    expect(lastRun('p3c').decision).toBe('MANUAL_ACTION_REQUIRED')
  })

  it('PROOF 4: REJECT produces no ticket and no execution', () => {
    driveToRefusal('p4')
    answer('p4', 'nem')
    expect(tickets()).toHaveLength(0)
    const decided = anyRequest('p4')!
    expect(decided.decision).toBe('REJECTED')
    expect(decided.authorization_id).toBeNull()

    runProgressionCycle(getDb(), 'personal', 'p4', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
    // An explicit no BLOCKS the case for replanning; either way the step did not
    // run autonomously and no owner authorisation was recorded.
    expect(lastRun('p4').sa).not.toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
  })

  it('PROOF 5a: the approval is single-use — a second run gets nothing', () => {
    driveToRefusal('p5a')
    answer('p5a', 'igen')
    runProgressionCycle(getDb(), 'personal', 'p5a', NOW + 60, { triggerType: 'MANUAL', triggerReference: 't2' })
    expect(lastRun('p5a').sa).toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
    // The next run has no fresh answer at all, so it is autonomous again.
    runProgressionCycle(getDb(), 'personal', 'p5a', NOW + 120, { triggerType: 'MANUAL', triggerReference: 't3' })
    expect(lastRun('p5a').sa).not.toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
  })

  it('PROOF 5b: the REQUEST is single-use too — one yes cannot be decided twice', () => {
    const req = driveToRefusal('p5b')
    answer('p5b', 'igen')
    const again = decideActionApproval(getDb(), req.request_id, 'APPROVE', NOW + 60)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/már el lett döntve/)
    expect(tickets()).toHaveLength(1)
  })

  it('PROOF 5c: a REJECT cannot be talked back into an approval either', () => {
    // The other direction of the same latch. Without it, "he said no, ask the
    // engine again" would be a way to turn a refusal into a ticket.
    const req = driveToRefusal('p5c')
    answer('p5c', 'nem')
    const again = decideActionApproval(getDb(), req.request_id, 'APPROVE', NOW + 60)
    expect(again.ok).toBe(false)
    expect(tickets()).toHaveLength(0)
  })

  it('the gate can refuse AT ANSWER TIME, and the refusal is recorded, not thrown', () => {
    // A yes is an input to the gate, not a replacement for it: everything the
    // gate checks is a way for the yes to be true and the ticket still wrong.
    // Here the case moves on between the question and the answer.
    //
    // AND IT MUST NOT THROW. `issueAuthorization` refuses a refused permit by
    // throwing, which would unwind out of `recordOwnerAnswer` and lose the
    // owner's message -- the one thing that whole path exists to prevent.
    driveToRefusal('pgate')
    getDb().prepare(`UPDATE personal_cases SET version = version + 1 WHERE case_id='pgate'`).run()

    expect(() => answer('pgate', 'igen')).not.toThrow()
    expect(tickets()).toHaveLength(0)
    const decided = anyRequest('pgate')!
    expect(decided.decision).toBe('REJECTED')
    expect(decided.refusal).toMatch(/azóta változott/)
    // The owner's words were still recorded on the case.
    const ev = getDb().prepare(
      `SELECT payload FROM personal_case_events WHERE case_id='pgate'
        AND event_type='OWNER_DECISION' ORDER BY event_id DESC LIMIT 1`,
    ).get() as { payload: string }
    expect(JSON.parse(ev.payload).approvalRefused).toMatch(/azóta változott/)
  })

  it('PROOF 6: the approval survives a hard crash before execution', () => {
    // Driven as a separate PROCESS killed with SIGKILL: a thrown error unwinds,
    // runs finally blocks and lets sqlite roll back politely, which is exactly
    // the behaviour a crash does NOT have.
    const dir = mkdtempSync(join(tmpdir(), 'approval-crash-'))
    const dbPath = join(dir, 'claudeclaw.db')
    try {
      // CONTROL FIRST: the same child, not killed. Without it, "the ticket is
      // still there after the kill" cannot be told apart from "the child never
      // issued one".
      const control = child(dbPath, 'c-ok', 'none')
      expect(control.status, control.stderr).toBe(0)
      initDatabase(dbPath)
      const ctl = getDb().prepare(
        `SELECT * FROM action_authorizations WHERE case_id='c-ok'`,
      ).all() as Array<Record<string, unknown>>
      expect(ctl).toHaveLength(1)
      expect(ctl[0]!.consumed_at).toBeNull()
      getDb().close()

      const killed = child(dbPath, 'c-kill', 'after-approval')
      // ASSERT THE KILL. A clean exit would mean the seam never fired, and every
      // assertion after it would be about a process that simply finished.
      expect(killed.signal).toBe('SIGKILL')

      initDatabase(dbPath)
      const db = getDb()
      // THE APPROVAL IS NOT LOST. It was committed before the crash, so it is
      // still there, still unconsumed, still bound to the same action.
      const t = db.prepare(
        `SELECT * FROM action_authorizations WHERE case_id='c-kill'`,
      ).all() as Array<Record<string, unknown>>
      expect(t).toHaveLength(1)
      expect(t[0]!.consumed_at).toBeNull()
      expect(t[0]!.revoked_at).toBeNull()
      expect(db.prepare(
        `SELECT decision FROM cos_action_approval_requests WHERE case_id='c-kill'`,
      ).get()).toEqual({ decision: 'APPROVED' })

      // AND IT IS STILL USABLE. A ticket that survives and cannot be spent is
      // the same loss with a better audit trail.
      const after = child(dbPath, 'c-kill', 'consume')
      expect(after.status, after.stderr).toBe(0)
      initDatabase(dbPath)
      const sa = getDb().prepare(
        `SELECT safety_assertions_json AS sa FROM case_progression_runs
          WHERE case_id='c-kill' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      ).get() as { sa: string }
      expect(sa.sa).toMatch(/INVARIANT_E_OWNER_AUTHORISED/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})

function child(dbPath: string, caseId: string, seam: 'none' | 'after-approval' | 'consume') {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'src/__tests__/support/approval-crash-child.ts'),
    dbPath, caseId, String(NOW), seam,
  ], { encoding: 'utf8', timeout: 150_000 })
}

// ── PROOF 7: intent persisted, outcome uncertain → recovery, never a resend ──
//
// THE SEAM THIS IS ABOUT, said plainly because the arc has two legs and only one
// of them talks to a provider. An approval authorises a PROGRESSION STEP; the
// outbound send that step may then plan is authorised separately, by the
// dispatch gate, with its own ticket bound to the ledger row. That layering is
// deliberate -- a step approval must not become a licence to send -- and it
// means the "provider/readback outcome" half of the owner's flow lives in the
// executor.
//
// What is NEW here, and what the producer makes possible for the first time, is
// the failure this pair of legs can produce together: ask Istvan again, get a
// second perfectly valid approval, and resend a message whose first attempt may
// already have arrived. So the assertion is not merely "an uncertain outcome
// goes to recovery" (cos-executor and cos-w12 cover that) -- it is that a FRESH,
// VALID ticket does not buy a resend of it.

class UncertainAdapter implements OutboundAdapter {
  readonly actionType = 'EMAIL_SEND'
  sendCalls = 0
  async send(): Promise<{ externalRef: string }> {
    this.sendCalls++
    // The provider was reached, or was not; the process cannot tell. This is the
    // state that must never be resolved by trying again.
    throw new Error('timeout waiting for provider response')
  }
  async readback(): Promise<ReadbackResult> {
    return { found: false, available: false }   // cannot prove absence either
  }
}

describe('PROOF 7: after the intent is durable, an unknown outcome is recovery work', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'e1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  /** The draft-evidence horizon a first send requires. Production writes it when
   *  the draft is created; these tests drive the state machine directly, so they
   *  create it the same way rather than being handed a bypass. */
  function ensureDraftEvidence(ledgerId: string, now: number): void {
    const db = getDb()
    const row = db.prepare(`SELECT case_id, status, case_version FROM outbound_ledger WHERE ledger_id=?`).get(ledgerId) as
      { case_id: string | null; status: string; case_version: number | null } | undefined
    if (!row?.case_id) return
    const c = db.prepare(`SELECT version FROM personal_cases WHERE case_id=?`).get(row.case_id) as { version: number }
    if (row.case_version == null) db.prepare(`UPDATE outbound_ledger SET case_version=? WHERE ledger_id=?`).run(c.version, ledgerId)
    appendCaseEvent(db, {
      caseId: row.case_id, caseVersion: c.version, actor: 'test', eventType: 'OUTBOUND_DRAFTED',
      reason: 'fixture: production-equivalent draft evidence horizon',
      sourceSystem: 'test:approval', sourceReference: ledgerId, payload: { ledgerId },
    }, now)
  }

  function ticketFor(ledgerId: string, now: number) {
    const ctx = {
      domain: 'personal' as const, caseId: 'e1', caseVersion: null, goalVersion: null,
      actionId: ledgerId, actionType: 'EMAIL_SEND', intent: 'SEND_APPROVED_EMAIL',
      targetReference: null, recipient: 'x@y.z', payloadHash: null, approvalId: null,
    }
    return {
      authorizationId: issueAuthorization(
        getDb(), ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] }),
      ).authorizationId,
      authorizationContext: ctx,
    }
  }

  it('an unknown outcome parks the action and enqueues W12 recovery', async () => {
    const db = getDb()
    const ad = new UncertainAdapter()
    const a = planAction(db, { caseId: 'e1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' } }, NOW)
    ensureDraftEvidence(a.ledgerId, NOW)
    const r = await executeAction(db, ad, a.ledgerId, NOW, ticketFor(a.ledgerId, NOW))
    expect(ad.sendCalls).toBe(1)
    expect(r.status).toBe('OUTCOME_UNKNOWN')

    const rec = reconcileRecoveryQueue(db, NOW)
    expect(rec.enqueued).toBeGreaterThanOrEqual(1)
    const q = getRecovery(db, 'OUTBOUND', a.ledgerId)!
    expect(q.status).toBe('PENDING_RETRY')
    expect(q.lastKnownOutcome).toBe('OUTCOME_UNKNOWN')
  })

  it('HEADLINE: a fresh, valid approval does NOT buy a resend of an unknown outcome', async () => {
    const db = getDb()
    const ad = new UncertainAdapter()
    const a = planAction(db, { caseId: 'e1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' } }, NOW)
    ensureDraftEvidence(a.ledgerId, NOW)
    await executeAction(db, ad, a.ledgerId, NOW, ticketFor(a.ledgerId, NOW))
    expect(ad.sendCalls).toBe(1)

    // A SECOND, entirely valid ticket -- exactly what a second "igen" from
    // Istvan would produce. It authorises; it does not resolve uncertainty.
    const again = await executeAction(db, ad, a.ledgerId, NOW + 60, ticketFor(a.ledgerId, NOW + 60))
    expect(ad.sendCalls).toBe(1)
    expect(again.status).toBe('OUTCOME_UNKNOWN')
  })
})

// ── The gate itself ─────────────────────────────────────────────────────

describe('the approval gate refuses for reasons a yes cannot answer', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const facts = (over: Record<string, unknown> = {}) => ({
    domain: 'personal' as const, caseId: 'g1', caseVersion: 1, planStep: 3,
    actionId: 'personal:g1:plan-step:3', riskClasses: [] as never[],
    requestedAt: NOW, expiresAt: NOW + 3600, ...over,
  })

  function seedGateCase(): void {
    seedHighRiskCase('g1')
  }

  it('refuses when the case moved on after the question went out', () => {
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    const d = evaluateProgressionApproval(getDb(), facts({ caseVersion: v.version + 1 }), NOW + 10)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/azóta változott/)
  })

  it('refuses when the step was completed in the meantime', () => {
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    getDb().prepare(
      `UPDATE case_progression_state SET completed_plan_step=5 WHERE domain='personal' AND case_id='g1'`,
    ).run()
    const d = evaluateProgressionApproval(getDb(), facts({ caseVersion: v.version }), NOW + 10)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/elkészült/)
  })

  it('refuses when the kill switch came down between the ask and the answer', () => {
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    engageKillSwitch(getDb(), { reason: 'teszt', actor: 'test' }, NOW + 5)
    const d = evaluateProgressionApproval(getDb(), facts({ caseVersion: v.version }), NOW + 10)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/kill switch/)
  })

  it('refuses a stale request', () => {
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    const d = evaluateProgressionApproval(getDb(), facts({ caseVersion: v.version, expiresAt: NOW - 1 }), NOW)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/lejárt/)
  })

  it('refuses a risk class the owner said an approval may never waive', () => {
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    const d = evaluateProgressionApproval(
      getDb(), facts({ caseVersion: v.version, riskClasses: ['FINANCIAL_CONTRACTUAL'] }), NOW + 10,
    )
    expect(d.allowed).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/FINANCIAL_CONTRACTUAL/)
  })

  it('ALLOWS the case it is supposed to allow', () => {
    // The counter-case. A gate that refuses everything is not a gate, and every
    // test above would pass against one.
    seedGateCase()
    const v = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='g1'`).get() as { version: number }
    const d = evaluateProgressionApproval(getDb(), facts({ caseVersion: v.version }), NOW + 10)
    expect(d.reasons).toEqual([])
    expect(d.allowed).toBe(true)
  })
})
