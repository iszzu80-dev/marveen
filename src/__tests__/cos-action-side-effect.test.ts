// E1 — the side-effect classification, and the approval question it gates.
//
// THE LIVE DEFECT THIS FILE IS ABOUT, 2026-08-28. The ZST case for the NVIDIA
// Inception application produced an approval request on the owner's Telegram
// channel whose headline read:
//
//     Művelet: Identify required actions and dependencies
//
// It asked him to authorise an IRREVERSIBLE_EXTERNAL act. The step it named
// declares `needsExternal: false`, sends nothing, and reaches nobody. Two
// separate faults produced one message: a classifier that derived externality
// from the plan-step KIND, and a question that put an internal English plan
// label where the action should be.
//
// The owner's ruling, 2026-08-28, in three parts, and there is a test below for
// each: EXECUTE is not a side-effect class; a contradiction between the sources
// is never an approval question; a question that cannot say what changes
// outside must not be asked at all.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { runProgressionCycle, internalPlanLabels } from '../cos/progression-pipeline.js'
import {
  classifyActionSideEffect, MUTATES_BY_KIND, IRREVERSIBLE_OPERATION_TYPES,
  READ_ONLY_OPERATION_TYPES, REVERSIBLE_OPERATION_TYPES, classifiedOperationTypes,
  type ActionSideEffectSignals,
} from '../cos/action-side-effect.js'
import { STEP_SENTENCE, buildNarration, renderApprovalQuestion } from '../cos/approval-narration.js'
import { revokeOpenApprovalRequests } from '../cos/action-approval-request.js'

const NOW = 1_700_000_000

const sig = (over: Partial<ActionSideEffectSignals> = {}): ActionSideEffectSignals => ({
  declaredExternal: false, resolvedExternalTarget: null, dispatchIntents: [],
  operationType: null, financialExposure: null, legalExposure: null, sensitivity: null,
  unreadableSources: [], mutates: false, ...over,
})

// ── The classifier ──────────────────────────────────────────────────────

describe('E1: the side-effect class comes from evidence, not from the plan-step kind', () => {
  it('HEADLINE: the live NVIDIA shape is INTERNAL, not IRREVERSIBLE_EXTERNAL', () => {
    // An EXECUTE step that declares it needs nothing external, on a case with
    // no queued outbound work. This is exactly what produced the false approval.
    const v = classifyActionSideEffect(sig({ declaredExternal: false, mutates: true }))
    expect(v.klass).toBe('INTERNAL')
    expect(v.reachesOutside).toBe(false)
    expect(v.executable).toBe(true)
    // It still MUTATES, so the capability contract is still required. INTERNAL
    // is not a synonym for harmless.
    expect(v.legacy).toBe('MUTATING')
  })

  it('a read-only internal step stays READ_ONLY for the gates written against it', () => {
    expect(classifyActionSideEffect(sig({ mutates: false })).legacy).toBe('READ_ONLY')
  })

  it('a queued send bound to the step IS irreversible and external', () => {
    const v = classifyActionSideEffect(sig({
      declaredExternal: true, mutates: true,
      resolvedExternalTarget: 'gmail', operationType: 'EMAIL_SEND',
    }))
    expect(v.klass).toBe('IRREVERSIBLE_EXTERNAL')
    expect(v.reachesOutside).toBe(true)
    expect(v.legacy).toBe('HIGH_RISK')
  })

  it('reaching outside without changing anything is READ_ONLY_EXTERNAL, not high risk', () => {
    const v = classifyActionSideEffect(sig({ declaredExternal: true, mutates: false }))
    expect(v.klass).toBe('READ_ONLY_EXTERNAL')
    expect(v.legacy).toBe('MUTATING')
  })

  it('CONTRADICTORY when the step says internal and a bound source says otherwise', () => {
    const v = classifyActionSideEffect(sig({
      declaredExternal: false, mutates: true,
      resolvedExternalTarget: 'gmail', operationType: 'EMAIL_SEND',
    }))
    expect(v.klass).toBe('CONTRADICTORY')
    expect(v.executable).toBe(false)
    expect(v.reachesOutside).toBe(false)
    expect(v.conflicts.join(' ')).toMatch(/needsExternal=false/)
  })

  it('UNKNOWN when a source could not be read at all', () => {
    const v = classifyActionSideEffect(sig({ unreadableSources: ['outbound_ledger'] }))
    expect(v.klass).toBe('UNKNOWN')
    expect(v.executable).toBe(false)
    expect(v.legacy).toBe('HIGH_RISK')
  })

  it('UNKNOWN when it reaches out and mutates and nothing names the operation', () => {
    // The permissive guess would be REVERSIBLE_EXTERNAL, because most things
    // are. Two facts are known and the third is not, so the verdict is the gap.
    const v = classifyActionSideEffect(sig({ declaredExternal: true, mutates: true }))
    expect(v.klass).toBe('UNKNOWN')
    expect(v.executable).toBe(false)
  })

  it('COUNTER-EXAMPLE: a case-scoped dispatch intent classifies NOTHING', () => {
    // The subtler half of the same category error, and it bit during
    // development: an AWAIT_DECISION step whose whole job is to check whether an
    // answer arrived came back IRREVERSIBLE_EXTERNAL because the CASE had a
    // send queued behind it. The ledger records a case and no plan step, so it
    // cannot say anything about THIS action, in either direction.
    const internal = classifyActionSideEffect(sig({
      declaredExternal: false, mutates: true, dispatchIntents: ['EMAIL_SEND'],
    }))
    expect(internal.klass).toBe('INTERNAL')

    const waiting = classifyActionSideEffect(sig({
      declaredExternal: true, mutates: false, dispatchIntents: ['EMAIL_SEND'],
    }))
    expect(waiting.klass).toBe('READ_ONLY_EXTERNAL')
    // It is still SAID, so a reader can see the case has outward work pending.
    expect(waiting.reasons.join(' ')).toMatch(/nem ehhez a lépéshez kötve/)
  })

  it('the policy taxonomy escalates an external act and cannot create one', () => {
    const external = classifyActionSideEffect(sig({
      declaredExternal: true, mutates: true, operationType: 'DRAFT_CREATE',
      financialExposure: 250_000,
    }))
    expect(external.klass).toBe('IRREVERSIBLE_EXTERNAL')

    // The same money on an internal step changes nothing about where it reaches.
    const inside = classifyActionSideEffect(sig({
      declaredExternal: false, mutates: true, financialExposure: 250_000,
    }))
    expect(inside.klass).toBe('INTERNAL')
  })

  it('the operation vocabularies do not overlap', () => {
    const all = classifiedOperationTypes()
    expect(new Set(all).size).toBe(all.length)
    for (const t of IRREVERSIBLE_OPERATION_TYPES) {
      expect(READ_ONLY_OPERATION_TYPES).not.toContain(t)
      expect(REVERSIBLE_OPERATION_TYPES).not.toContain(t)
    }
  })

  it('every plan-step kind has a mutation answer -- a new kind fails the build, not the gate', () => {
    for (const k of Object.keys(MUTATES_BY_KIND)) {
      expect(typeof MUTATES_BY_KIND[k as keyof typeof MUTATES_BY_KIND]).toBe('boolean')
    }
  })
})

// ── The narration ───────────────────────────────────────────────────────

describe('E1: the approval question the owner reads', () => {
  const base = {
    machineLabel: 'Execute first recovery action',
    caseId: 'c-1', caseVersion: 3, caseTitle: 'NVIDIA Inception',
    planStep: 3, target: 'gmail', operationTypes: ['EMAIL_SEND'],
    riskClasses: ['IRREVERSIBLE_EXTERNAL'] as const,
    sideEffectClass: 'IRREVERSIBLE_EXTERNAL' as const,
    sideEffectReasons: ['kimenő szándék: EMAIL_SEND'],
    payloadFingerprint: 'abcdef0123456789',
  }

  it('EVERY plan-step label the planner can emit has a Hungarian sentence', () => {
    // Driven from the planner rather than from a list somebody maintains, for
    // the same reason `isUsableRecommendation` is: a label added tomorrow must
    // fail the suite, not reach Istvan as English.
    const missing = [...internalPlanLabels()].filter(l => !STEP_SENTENCE[l])
    expect(missing, `nincs magyar mondat: ${missing.join(' | ')}`).toEqual([])
  })

  it('carries the five elements and keeps the machine label on the audit line only', () => {
    const n = buildNarration(base)
    expect(n.defects).toEqual([])
    const text = renderApprovalQuestion(n, base)
    for (const h of ['MIT FOGOK TENNI', 'MILYEN CÉLPONTON', 'MI VÁLTOZIK KINT A VILÁGBAN',
      'MIÉRT KÉREM A JÓVÁHAGYÁSODAT', 'MIT TARTALMAZ']) expect(text).toContain(h)
    const labelLines = text.split('\n').filter(l => l.includes(base.machineLabel))
    expect(labelLines).toHaveLength(1)
    expect(labelLines[0].startsWith('Audit:')).toBe(true)
  })

  it('HEADLINE: an INTERNAL action cannot be narrated, and the refusal says why', () => {
    const n = buildNarration({ ...base, sideEffectClass: 'INTERNAL', operationTypes: [], target: null })
    expect(n.defects.length).toBeGreaterThan(0)
    expect(n.defects.join(' ')).toMatch(/nincs bizonyított külső változás/)
    // And it REFUSES to render rather than producing a graceful sentence about
    // an act that will not happen.
    expect(() => renderApprovalQuestion(n, { ...base, sideEffectClass: 'INTERNAL' })).toThrow()
  })

  it('a CONTRADICTORY action cannot be narrated either', () => {
    const n = buildNarration({ ...base, sideEffectClass: 'CONTRADICTORY' })
    expect(n.defects.length).toBeGreaterThan(0)
  })

  it('an outward act nobody can describe is a defect, not a vague sentence', () => {
    const n = buildNarration({ ...base, operationTypes: ['SOMETHING_NEW'] })
    expect(n.defects.join(' ')).toMatch(/nincs leírás ezekhez a művelet-típusokhoz/)
  })

  it('the channel writing rule holds: no em dash anywhere in the question', () => {
    expect(renderApprovalQuestion(buildNarration(base), base)).not.toContain('—')
  })
})

// ── Through the pipeline, on a store ────────────────────────────────────

describe('E1: end to end, on a real store', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function seed(caseId: string, status: 'NEW' | 'CALL_REQUIRED' | 'RECOVERY_REQUIRED', outbound: boolean): void {
    const db = getDb()
    createCase(db, {
      caseId, title: `Ügy ${caseId}`, caseType: 'SELECTION', status,
      sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
    }, NOW - 100)
    db.prepare(
      `INSERT INTO case_progression_state
        (domain, case_id, progression_enabled, progression_mode, goal, summary,
         next_progression_at, dod_verification_json, created_at, updated_at)
       VALUES ('personal', ?, 1, 'internal', 'g', 's', ?, ?, ?, ?)`,
    ).run(caseId, NOW - 100, JSON.stringify({
      criteria: [{ label: '_seed_guard', met: true, met_at: NOW - 100, met_by_run: '_seed' }],
      all_met: true, evaluated_at: NOW - 100,
    }), NOW - 100, NOW - 100)
    if (outbound) {
      db.prepare(
        `INSERT INTO outbound_ledger
           (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
            status, created_at, updated_at)
         VALUES (?, ?, 'EMAIL_SEND', 1, ?, 'PLANNED', ?, ?)`,
      ).run(`led-${caseId}`, caseId, `idem-${caseId}`, NOW - 100, NOW - 100)
    }
  }

  const drive = (caseId: string, n = 4): void => {
    for (let i = 0; i < n; i++) {
      runProgressionCycle(getDb(), 'personal', caseId, NOW + i * 10, {
        triggerType: 'MANUAL', triggerReference: `t${i}`,
      })
    }
  }

  /** Across EVERY run of the case, not only the last one. A revocation happens
   *  on the run that first sees the new classification, and reading only the
   *  latest run would make a durable assertion look absent because a later,
   *  quieter run came after it. */
  const assertions = (caseId: string): string[] => {
    const rows = getDb().prepare(
      `SELECT safety_assertions_json AS sa FROM case_progression_runs WHERE case_id=?`,
    ).all(caseId) as Array<{ sa: string | null }>
    return rows.flatMap(r => (JSON.parse(r.sa ?? '[]') as Array<{ assertion: string }>).map(a => a.assertion))
  }

  const requestCount = (caseId: string): number => (getDb().prepare(
    `SELECT COUNT(*) AS n FROM cos_action_approval_requests WHERE case_id=?`,
  ).get(caseId) as { n: number }).n

  it('HEADLINE: the NVIDIA shape produces NO approval request and no refusal', () => {
    seed('e1-nvidia', 'NEW', false)
    drive('e1-nvidia')
    expect(requestCount('e1-nvidia')).toBe(0)
    expect(assertions('e1-nvidia')).not.toContain('INVARIANT_E_REFUSAL')
  })

  it('a CONTRADICTORY action is recorded and produces NO approval request', () => {
    // CALL_REQUIRED step 2 declares `needsExternal: false` while a queued send
    // is bound to it by the resolution layer. The sources disagree.
    seed('e1-contra', 'CALL_REQUIRED', true)
    drive('e1-contra')
    expect(assertions('e1-contra')).toContain('ACTION_SEMANTICS_CONTRADICTION')
    expect(requestCount('e1-contra')).toBe(0)
    // No ticket either: a contradiction may not be legalised by an approval.
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM action_authorizations`)
      .get() as { n: number }).n).toBe(0)
  })

  it('a genuinely external action DOES open a request, with a human question', () => {
    seed('e1-real', 'RECOVERY_REQUIRED', true)
    drive('e1-real')
    expect(requestCount('e1-real')).toBe(1)
    const q = getDb().prepare(
      `SELECT question_text AS t FROM cos_owner_questions WHERE case_id='e1-real'`,
    ).get() as { t: string }
    expect(q.t).toContain('MI VÁLTOZIK KINT A VILÁGBAN')
    expect(q.t).toMatch(/Elküldött levelet nem lehet visszavonni/)
  })

  it('HEADLINE: an open request on a step that is no longer outward is REVOKED', () => {
    // The owner's instruction for the three requests that existed on
    // 2026-08-28: "A jelenlegi hibás requestet revoke-old. Ne generálj helyette
    // újat ugyanarra a stepre." A request written under the old classification
    // is planted here and the corrected pipeline is run over it.
    seed('e1-revoke', 'NEW', false)
    const db = getDb()
    db.prepare(
      `INSERT INTO cos_action_approval_requests
         (request_id, domain, case_id, case_version, goal_version, plan_step,
          action_id, action_type, description, target_reference, recipient,
          payload_hash, risk_classes_json, question_hash, progression_run_id,
          requested_at, expires_at)
       VALUES ('req-old','personal','e1-revoke',1,1,3,
          'personal:e1-revoke:plan-step:3','EXECUTE',
          'Identify required actions and dependencies','e1-revoke',NULL,
          'deadbeef','["IRREVERSIBLE_EXTERNAL"]','qh-old',NULL,?,?)`,
    ).run(NOW - 50, NOW + 500_000)
    db.prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at)
       VALUES ('e1-revoke','personal','qh-old','Művelet: Identify required actions and dependencies',?)`,
    ).run(NOW - 50)

    drive('e1-revoke')

    const after = db.prepare(
      `SELECT decision, refusal, decided_at FROM cos_action_approval_requests WHERE request_id='req-old'`,
    ).get() as { decision: string | null; refusal: string | null; decided_at: number | null }
    expect(after.decision).toBe('REJECTED')
    expect(after.decided_at).not.toBeNull()
    expect(after.refusal).toMatch(/RECLASSIFIED_INTERNAL/)
    // Its question is off the board too, so nothing answerable is left behind.
    const q = db.prepare(
      `SELECT superseded_at FROM cos_owner_questions WHERE question_hash='qh-old'`,
    ).get() as { superseded_at: number | null }
    expect(q.superseded_at).not.toBeNull()
    // And no replacement was opened for the same step.
    expect(requestCount('e1-revoke')).toBe(1)
    expect(assertions('e1-revoke')).toContain('APPROVAL_REQUEST_REVOKED')
  })

  it('HEADLINE: a HIGH-risk INTERNAL action still gets NO approval request', () => {
    // THE GUARD A MUTATION SURVIVED, and the reason it needed its own test.
    // Deleting `&& sideEffectVerdict.reachesOutside` from the producer branch
    // left the whole suite green, because every INTERNAL step in the other
    // fixtures is only MEDIUM risk and never reaches the branch at all. So the
    // one condition standing between the owner and a repeat of 2026-08-28 was
    // covered by nothing.
    //
    // It is reachable, and this is how: `assessRisk` escalates to HIGH on the
    // CASE's financial exposure, independently of what the action does. A
    // purely internal step on a case with money attached is therefore HIGH
    // risk, and `reachesOutside` is the only thing that stops it becoming a
    // question about an irreversible external act that does not exist.
    //
    // (The case-level escalation itself is left alone deliberately: changing
    // what makes a case high-risk is a policy decision, not a classification
    // repair, and it is not this packet's to make.)
    const db = getDb()
    db.prepare(
      `INSERT INTO zst_cases (case_id, title, case_type, status, workspace, sensitivity,
         priority, financial_exposure, source_system, created_at, updated_at)
       VALUES ('e1-money','Pénzes ügy','VENDOR','NEW','OPERATIONS','ZST_INTERNAL',
         'P2', 250000, 'test', ?, ?)`,
    ).run(NOW - 100, NOW - 100)
    db.prepare(
      `INSERT INTO case_progression_state
        (domain, case_id, progression_enabled, progression_mode, goal, summary,
         next_progression_at, dod_verification_json, created_at, updated_at)
       VALUES ('zst','e1-money',1,'internal','g','s',?,?,?,?)`,
    ).run(NOW - 100, JSON.stringify({
      criteria: [{ label: '_seed_guard', met: true, met_at: NOW - 100, met_by_run: '_seed' }],
      all_met: true, evaluated_at: NOW - 100,
    }), NOW - 100, NOW - 100)

    for (let i = 0; i < 4; i++) {
      runProgressionCycle(db, 'zst', 'e1-money', NOW + i * 10, {
        triggerType: 'MANUAL', triggerReference: `m${i}`,
      })
    }

    // The premise: the engine really does call this HIGH risk.
    const st = db.prepare(
      `SELECT decision_risk AS r, decision_assessment_json AS a
         FROM case_progression_state WHERE domain='zst' AND case_id='e1-money'`,
    ).get() as { r: string | null; a: string | null }
    expect(st.r).toBe('HIGH')
    // ...and it is HIGH for a reason that is about the CASE, not the action.
    expect(st.a).toMatch(/financial-exposure/)
    // ...while the action itself reaches nothing.
    expect(JSON.parse(st.a ?? '{}').actionSideEffect ?? 'INTERNAL').not.toMatch(/EXTERNAL/)

    // THE CLAIM: no question, and not merely a question that failed to render.
    expect(requestCount('e1-money')).toBe(0)
    const a = (db.prepare(
      `SELECT safety_assertions_json AS sa FROM case_progression_runs WHERE case_id='e1-money'`,
    ).all() as Array<{ sa: string | null }>)
      .flatMap(r => (JSON.parse(r.sa ?? '[]') as Array<{ assertion: string }>).map(x => x.assertion))
    expect(a).not.toContain('APPROVAL_REQUEST_NOT_CREATED')
  })

  it('the revoker leaves the CURRENT payload alone when one is excepted', () => {
    seed('e1-keep', 'NEW', false)
    const db = getDb()
    for (const [id, hash] of [['r-a', 'hash-a'], ['r-b', 'hash-b']]) {
      db.prepare(
        `INSERT INTO cos_action_approval_requests
           (request_id, domain, case_id, case_version, goal_version, plan_step,
            action_id, action_type, description, target_reference, recipient,
            payload_hash, risk_classes_json, question_hash, progression_run_id,
            requested_at, expires_at)
         VALUES (?, 'personal','e1-keep',1,1,3,'personal:e1-keep:plan-step:3','EXECUTE',
            'x','e1-keep',NULL,?,'[]',NULL,NULL,?,?)`,
      ).run(id, hash, NOW - 50, NOW + 500_000)
    }
    const revoked = revokeOpenApprovalRequests(
      db, { domain: 'personal', caseId: 'e1-keep', actionId: 'personal:e1-keep:plan-step:3', exceptPayloadHash: 'hash-b' },
      NOW, 'test',
    )
    expect(revoked).toEqual(['r-a'])
    expect((db.prepare(
      `SELECT decision FROM cos_action_approval_requests WHERE request_id='r-b'`,
    ).get() as { decision: string | null }).decision).toBeNull()
  })
})
