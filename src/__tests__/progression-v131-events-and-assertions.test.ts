// Progression spec v1.3.1 — §16 hard safety assertions, §8 case event history.
//
// WHY THIS FILE EXISTS. The 2026-08-12 review measured two gaps that share one
// shape: a mechanism that was built, tested, and could never fire in traffic.
//
//   §16 — seven hard safety assertions ran on every progression cycle, and five
//         of them tested `run.error_code === '...'` against an object whose
//         `error_code` is hard-coded `null` three lines above the loop. Two more
//         tested decision values that VALID_DECISIONS does not contain, so the
//         CHECK constraint would reject them before any assertion saw them. The
//         suite was green, the counter said "7 assertions passed" on every run,
//         and five of the seven were asking a question their input could not
//         answer yes to.
//
//   §8  — sixteen of the seventeen event types the spec names had no producer
//         anywhere. "What did the engine do?" was answerable from
//         case_progression_runs; "what happened to this case?" was not.
//
// So the tests below are deliberately BEHAVIOURAL rather than structural. Each
// §16 test builds the state the assertion is supposed to catch — a real ledger
// row, a real authorization row, a real engine closure — and requires the
// assertion to fire on it; then builds the innocent version of the same state
// and requires silence. A test that only checked "the assertion exists" would
// have passed for the whole period the assertions were dead.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'

import { initDatabase, getDb } from '../db.js'
import {
  HARD_SAFETY_ASSERTIONS,
  PAYMENT_ACTION_TYPES,
  LEGAL_ACTION_TYPES,
  type AssertionContext,
} from '../cos/progression-eval.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { progressionHistory, PROGRESSION_EVENT_TYPES } from '../cos/progression-events.js'
import {
  initializeDoDVerification,
  satisfyDoDCriterion,
} from '../cos/progression-completion.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

const T = 1_770_000_000

function seedCase(db: Database.Database, caseId: string, status = 'NEW'): void {
  db.prepare(
    `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
     VALUES (?, 'Vízszámla rendezése', 'ADMIN', ?, 'PERSONAL', 1, ?, ?)`,
  ).run(caseId, status, T, T)
}

function seedProgression(db: Database.Database, caseId: string, enabled = 1): void {
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode, created_at, updated_at)
     VALUES ('personal', ?, ?, 'shadow', ?, ?)`,
  ).run(caseId, enabled, T, T)
}

/** An outbound row that LEFT PLANNED — i.e. one that reached the outside world
 *  or tried to. The assertions deliberately ignore PLANNED and CANCELLED. */
function seedOutbound(
  db: Database.Database,
  ledgerId: string,
  caseId: string,
  opts: { actionType?: string; status?: string; marker?: string | null; seq?: number } = {},
): void {
  db.prepare(
    `INSERT INTO outbound_ledger
       (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
        external_idempotency_marker, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ledgerId, caseId, opts.actionType ?? 'EMAIL_SEND', opts.seq ?? 1,
    `int-${ledgerId}`, opts.marker ?? null,
    opts.status ?? 'APPLIED_UNVERIFIED', T, T,
  )
}

function seedAuth(
  db: Database.Database,
  authId: string,
  actionId: string,
  opts: { caseId?: string | null; domain?: string; consumedAt?: number | null } = {},
): void {
  db.prepare(
    `INSERT INTO action_authorizations
       (authorization_id, domain, case_id, action_id, action_type, intent,
        policy_evaluation_hash, issued_at, expires_at, nonce, consumed_at)
     VALUES (?, ?, ?, ?, 'EMAIL_SEND', 'reply', 'hash', ?, ?, ?, ?)`,
  ).run(
    authId, opts.domain ?? 'personal',
    opts.caseId === undefined ? 'c1' : opts.caseId,
    actionId, T, T + 3600, `nonce-${authId}`,
    opts.consumedAt === undefined ? T : opts.consumedAt,
  )
}

function assertion(name: string) {
  const a = HARD_SAFETY_ASSERTIONS.find(x => x.name === name)
  if (!a) throw new Error(`no assertion named ${name}`)
  return a
}

/** The run-shaped object the pipeline hands the assertions. Its `error_code` is
 *  null in production and null here — that is the point. */
function runObj(caseId: string, decision = 'CONTINUE_AUTONOMOUSLY') {
  return {
    run_id: 'run-1', domain: 'personal', case_id: caseId,
    decision, reason: 'test', status: 'COMPLETED' as const,
    error_code: null as string | null, error_summary: null as string | null,
    safety_violations: [],
  }
}

function ctxFor(db: Database.Database, caseId: string): AssertionContext {
  return { db, domain: 'personal', caseId }
}

// ── §16: the assertions read real state ───────────────────────────────────

describe('§16 — hard safety assertions read the case\'s real state', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb(); seedCase(db, 'c1') })

  describe('policy_bypass', () => {
    const a = () => assertion('policy_bypass')

    it('fires on a committed outbound row with no authorization at all', () => {
      seedOutbound(db, 'led-1', 'c1')
      const detail = a().check(runObj('c1'), ctxFor(db, 'c1'))
      expect(detail).toMatch(/led-1/)
      expect(detail).toMatch(/no action authorization/)
    })

    it('fires when the authorization exists but was never consumed — §22.2\'s whole point', () => {
      seedOutbound(db, 'led-2', 'c1')
      seedAuth(db, 'auth-2', 'led-2', { consumedAt: null })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toMatch(/never consumed/)
    })

    it('is silent when the ticket was issued AND consumed', () => {
      seedOutbound(db, 'led-3', 'c1')
      seedAuth(db, 'auth-3', 'led-3', { consumedAt: T + 5 })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    it('ignores PLANNED and CANCELLED rows — nothing left the building', () => {
      seedOutbound(db, 'led-4', 'c1', { status: 'PLANNED' })
      seedOutbound(db, 'led-5', 'c1', { status: 'CANCELLED', seq: 2 })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    it('RED-PROOF: without the context it CANNOT fire — which is what it did for months', () => {
      seedOutbound(db, 'led-6', 'c1')
      expect(a().check(runObj('c1'))).toBeNull()
    })
  })

  describe('wrong_recipient', () => {
    const a = () => assertion('wrong_recipient')

    it('fires when the ticket was issued for a DIFFERENT case', () => {
      seedOutbound(db, 'led-7', 'c1')
      seedAuth(db, 'auth-7', 'led-7', { caseId: 'some-other-case' })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toMatch(/authorised for case some-other-case/)
    })

    it('fires when the ticket was issued in the OTHER domain', () => {
      seedOutbound(db, 'led-8', 'c1')
      seedAuth(db, 'auth-8', 'led-8', { domain: 'zst' })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toMatch(/domain zst/)
    })

    it('is silent when case and domain both match', () => {
      seedOutbound(db, 'led-9', 'c1')
      seedAuth(db, 'auth-9', 'led-9', { caseId: 'c1', domain: 'personal' })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })
  })

  describe('duplicate_external_action', () => {
    const a = () => assertion('duplicate_external_action')

    it('fires on two committed rows sharing one external marker', () => {
      seedOutbound(db, 'led-10', 'c1', { marker: 'MRV-abc', seq: 1 })
      seedOutbound(db, 'led-11', 'c1', { marker: 'MRV-abc', seq: 2 })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toMatch(/share external marker MRV-abc/)
    })

    it('is silent on distinct markers', () => {
      seedOutbound(db, 'led-12', 'c1', { marker: 'MRV-a', seq: 1 })
      seedOutbound(db, 'led-13', 'c1', { marker: 'MRV-b', seq: 2 })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    it('a PLANNED duplicate is not a duplicate — it never went out', () => {
      seedOutbound(db, 'led-14', 'c1', { marker: 'MRV-c', seq: 1 })
      seedOutbound(db, 'led-15', 'c1', { marker: 'MRV-c', seq: 2, status: 'PLANNED' })
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })
  })

  describe('payment_auto_execution and legal_contract_auto_commitment', () => {
    it('payment fires on a committed action of a payment kind', () => {
      seedOutbound(db, 'led-16', 'c1', { actionType: PAYMENT_ACTION_TYPES[0] })
      expect(assertion('payment_auto_execution').check(runObj('c1'), ctxFor(db, 'c1')))
        .toMatch(/autonomous payment action committed/)
    })

    it('legal fires on a committed action of a legal kind', () => {
      seedOutbound(db, 'led-17', 'c1', { actionType: LEGAL_ACTION_TYPES[0] })
      expect(assertion('legal_contract_auto_commitment').check(runObj('c1'), ctxFor(db, 'c1')))
        .toMatch(/autonomous legal\/contract action committed/)
    })

    it('an EMAIL_SEND is neither', () => {
      seedOutbound(db, 'led-18', 'c1', { actionType: 'EMAIL_SEND' })
      expect(assertion('payment_auto_execution').check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
      expect(assertion('legal_contract_auto_commitment').check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    it('a PLANNED payment is a proposal, not an execution', () => {
      seedOutbound(db, 'led-19', 'c1', { actionType: 'PAYMENT', status: 'PLANNED' })
      expect(assertion('payment_auto_execution').check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })
  })

  describe('premature_completion', () => {
    const a = () => assertion('premature_completion')

    /** A closure the ENGINE performed, recorded the way transitionCase records it. */
    function engineClosure(caseId: string): void {
      db.prepare(`UPDATE personal_cases SET status = 'COMPLETED' WHERE case_id = ?`).run(caseId)
      db.prepare(
        `INSERT INTO personal_case_events
           (case_id, case_version, actor, event_type, previous_status, new_status, created_at)
         VALUES (?, 2, 'progression-engine', 'STATUS_CHANGED', 'NEW', 'COMPLETED', ?)`,
      ).run(caseId, T)
    }

    it('fires when the engine closed a case whose DoD criteria were never proven', () => {
      seedProgression(db, 'c1')
      initializeDoDVerification(db, 'personal', 'c1', ['A', 'B'], 'CASE_SPECIFIC', T)
      engineClosure('c1')
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toMatch(/0\/2 definition-of-done criteria proven/)
    })

    it('fires when the DoD was fully met but was the GENERIC per-status template', () => {
      seedProgression(db, 'c1')
      initializeDoDVerification(db, 'personal', 'c1', ['A'], 'GENERIC_STATUS_TEMPLATE', T)
      satisfyDoDCriterion(db, 'personal', 'c1', 0, 'r1', 'case_event:e1', T + 1)
      engineClosure('c1')
      expect(a().check(runObj('c1'), ctxFor(db, 'c1')))
        .toMatch(/GENERIC_STATUS_TEMPLATE definition-of-done/)
    })

    it('is silent on a case-specific DoD proven with evidence', () => {
      seedProgression(db, 'c1')
      initializeDoDVerification(db, 'personal', 'c1', ['A'], 'CASE_SPECIFIC', T)
      satisfyDoDCriterion(db, 'personal', 'c1', 0, 'r1', 'case_event:e1', T + 1)
      engineClosure('c1')
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    // THE NARROWING, AS A TEST. My first version of this assertion asked only
    // "is this case COMPLETED while the gate refuses it?" and fired on states
    // the engine did not cause. It also self-defeated: a violation sets
    // runStatus = FAILED, and the §25 downgrade is gated on runStatus ===
    // 'COMPLETED', so the assertion firing SUPPRESSED the correction that would
    // have stepped the decision back. Two checkpoint-E.4 tests caught it.
    it('is silent on a closure the engine did NOT make, however unproven', () => {
      seedProgression(db, 'c1')
      initializeDoDVerification(db, 'personal', 'c1', ['A', 'B'], 'GENERIC_STATUS_TEMPLATE', T)
      db.prepare(`UPDATE personal_cases SET status = 'COMPLETED' WHERE case_id = ?`).run('c1')
      db.prepare(
        `INSERT INTO personal_case_events
           (case_id, case_version, actor, event_type, previous_status, new_status, created_at)
         VALUES ('c1', 2, 'istvan', 'STATUS_CHANGED', 'NEW', 'COMPLETED', ?)`,
      ).run(T)
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })

    it('is silent on a case that is not closed at all', () => {
      seedProgression(db, 'c1')
      initializeDoDVerification(db, 'personal', 'c1', ['A'], 'GENERIC_STATUS_TEMPLATE', T)
      expect(a().check(runObj('c1'), ctxFor(db, 'c1'))).toBeNull()
    })
  })

  // STANDING CHECK. Five of the seven assertions were unreachable because they
  // read a field of the run object that is hard-coded null. A NEW assertion that
  // only reads `run.error_code` would be the same defect again, so this fails
  // the moment one appears without also reading real state.
  it('STANDING: no assertion may rest on error_code alone', () => {
    const src = readFileSync(new URL('../cos/progression-eval.ts', import.meta.url), 'utf8')
    const body = src
      .slice(src.indexOf('export const HARD_SAFETY_ASSERTIONS'), src.indexOf('// ── Stub progression engine'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

    // Split into per-assertion blocks on the `name:` lines.
    const blocks = body.split(/\n\s*\{\s*\n\s*name: '/).slice(1)
    expect(blocks.length).toBe(HARD_SAFETY_ASSERTIONS.length)
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("'"))
      if (name === 'cross_domain_leakage') continue // documented stub, no state source yet
      const readsErrorCode = /run\.error_code/.test(block)
      const readsState = /\bctx\b/.test(block)
      expect(readsState, `assertion ${name} reads only the run object`).toBe(true)
      void readsErrorCode
    }
  })
})

// ── §8: the progression writes the case's own history ─────────────────────

describe('§8 — a progression run writes into the case event history', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  function history(caseId: string): Array<{ eventType: string }> {
    return progressionHistory(db, 'personal', caseId)
  }

  it('a first run records the goal and the plan', () => {
    seedCase(db, 'h1')
    runProgressionCycle(db, 'personal', 'h1', T)
    const types = history('h1').map(e => e.eventType)
    expect(types).toContain('GOAL_DEFINED')
    expect(types).toContain('PLAN_CREATED')
  })

  it('every event is attributed to the progression, not to the owner', () => {
    seedCase(db, 'h2')
    runProgressionCycle(db, 'personal', 'h2', T)
    const rows = db.prepare(
      `SELECT actor, source_system, source_reference FROM personal_case_events
        WHERE case_id = 'h2' AND source_system = 'progression'`,
    ).all() as Array<{ actor: string; source_system: string; source_reference: string | null }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.actor).toBe('marveen')
      expect(r.source_reference).toBeTruthy() // the run that produced it
    }
  })

  // THE ONE THAT MATTERS FOR THE HISTORY BEING READABLE. The cycle runs every
  // ten minutes. A case sitting in the same state must not collect one event per
  // wake-up, or the history becomes a log and §27's panel becomes unreadable.
  it('repeated runs in the same state do NOT collect one event per run', () => {
    seedCase(db, 'h3')
    for (let i = 0; i < 5; i++) runProgressionCycle(db, 'personal', 'h3', T + i * 600)
    const types = history('h3').map(e => e.eventType)
    expect(types.filter(t => t === 'GOAL_DEFINED').length).toBe(1)
    expect(types.filter(t => t === 'PLAN_CREATED').length).toBe(1)
    for (const t of PROGRESSION_EVENT_TYPES) {
      expect(types.filter(x => x === t).length, `${t} repeated`).toBeLessThanOrEqual(1)
    }
  })

  // THE LOOP recordOwnerAnswer WARNS ABOUT. Its comment says plainly why the
  // engine's own events must not wake the engine: "waking on EVERY event would
  // make each run schedule the next one." The trigger contract hashes
  // `last_event_id` from the CASE ROW, so appending events is invisible to it —
  // provided nothing here touches that column. This is that guarantee, measured.
  it('appending progression events does NOT move the case\'s last_event_id', () => {
    seedCase(db, 'h4')
    const before = db.prepare(`SELECT last_event_id FROM personal_cases WHERE case_id = 'h4'`)
      .get() as { last_event_id: number | null }
    runProgressionCycle(db, 'personal', 'h4', T)
    expect(history('h4').length).toBeGreaterThan(0)
    const after = db.prepare(`SELECT last_event_id FROM personal_cases WHERE case_id = 'h4'`)
      .get() as { last_event_id: number | null }
    expect(after.last_event_id).toBe(before.last_event_id)
  })

  it('STANDING: the events module never writes last_event_id', () => {
    const src = readFileSync(new URL('../cos/progression-events.ts', import.meta.url), 'utf8')
    const executable = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(executable).not.toMatch(/last_event_id/)
  })
})

// ── §25: the semantic status the schema allows and nobody wrote ────────────

describe('§25 — semantic_completion_status reaches VERIFIED', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  function semantic(caseId: string): string | null {
    return (db.prepare(
      `SELECT semantic_completion_status FROM case_progression_state
        WHERE domain = 'personal' AND case_id = ?`,
    ).get(caseId) as { semantic_completion_status: string | null } | undefined)
      ?.semantic_completion_status ?? null
  }

  it('an open case is IN_PROGRESS', () => {
    seedCase(db, 's1')
    runProgressionCycle(db, 'personal', 's1', T)
    expect(semantic('s1')).toBe('IN_PROGRESS')
  })

  // THE GAP THIS CLOSES. The column's CHECK names four values; the pipeline only
  // ever wrote two of them (`COMPLETED ? 'PROPOSED' : 'IN_PROGRESS'`), so
  // VERIFIED had no writer anywhere in the codebase and every closed case sat at
  // PROPOSED whether its outcome contract had been proven or not. The column
  // restated the case's STATUS instead of recording its MEANING.
  it('a case closed on paper but unproven is PROPOSED, not VERIFIED', () => {
    seedCase(db, 's2', 'COMPLETED')
    seedProgression(db, 's2')
    initializeDoDVerification(db, 'personal', 's2', ['A', 'B'], 'GENERIC_STATUS_TEMPLATE', T)
    runProgressionCycle(db, 'personal', 's2', T + 1)
    expect(semantic('s2')).toBe('PROPOSED')
  })

  it('a case whose own contract was proven with evidence reaches VERIFIED', () => {
    seedCase(db, 's3', 'COMPLETED')
    seedProgression(db, 's3')
    initializeDoDVerification(db, 'personal', 's3', ['A'], 'CASE_SPECIFIC', T)
    satisfyDoDCriterion(db, 'personal', 's3', 0, 'r1', 'case_event:e1', T + 1)
    runProgressionCycle(db, 'personal', 's3', T + 2)
    expect(semantic('s3')).toBe('VERIFIED')
  })

  it('the two sides of the §25 gate produce DIFFERENT events', () => {
    seedCase(db, 's4', 'COMPLETED')
    seedProgression(db, 's4')
    initializeDoDVerification(db, 'personal', 's4', ['A'], 'GENERIC_STATUS_TEMPLATE', T)
    runProgressionCycle(db, 'personal', 's4', T + 1)

    seedCase(db, 's5', 'COMPLETED')
    seedProgression(db, 's5')
    initializeDoDVerification(db, 'personal', 's5', ['A'], 'CASE_SPECIFIC', T)
    satisfyDoDCriterion(db, 'personal', 's5', 0, 'r1', 'case_event:e1', T + 1)
    runProgressionCycle(db, 'personal', 's5', T + 2)

    const t4 = progressionHistory(db, 'personal', 's4').map(e => e.eventType)
    const t5 = progressionHistory(db, 'personal', 's5').map(e => e.eventType)
    expect(t4).toContain('COMPLETION_PROPOSED')
    expect(t4).not.toContain('CASE_COMPLETED_SEMANTICALLY')
    expect(t5).toContain('CASE_COMPLETED_SEMANTICALLY')
  })

  it('STANDING: the pipeline can write every value the CHECK constraint allows', () => {
    const schema = readFileSync(new URL('../cos/schema.ts', import.meta.url), 'utf8')
    const m = schema.match(/semantic_completion_status IN \(([^)]*)\)/)
    expect(m).toBeTruthy()
    const allowed = [...(m as RegExpMatchArray)[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1])

    const pipeline = readFileSync(new URL('../cos/progression-pipeline.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

    // NOT_STARTED is the column default and needs no writer; every other value
    // the constraint permits must be one the engine can actually reach, or the
    // vocabulary is bigger than the behaviour and the extra words mean nothing.
    for (const value of allowed) {
      if (value === 'NOT_STARTED') continue
      expect(pipeline.includes(`'${value}'`), `${value} has no writer in the pipeline`).toBe(true)
    }
  })
})
