// Progression thin slice tests (card 52250c7f).
//
// Covers: schema deployment, seeding, initial progression, heartbeat,
// intake wiring (with and without progression tables), and the
// sqlite_master guard that keeps intake working pre-deployment.
//
// RED-first discipline: every new test must fail against the unfixed code
// before the implementation makes it pass. The commit that introduces
// these tests must show the RED state.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase, transitionCase, listActiveCases } from '../cos/case-store.js'
import { createZstCase, listActiveZstCases } from '../cos/zst-case-store.js'
import { ingestEmail, type EmailIntakeInput } from '../cos/intake.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../cos/zst-intake.js'
import { openBatch } from '../cos/email-ingest.js'
import {
  deployProgressionSchema,
  seedProgressionState,
  runInitialProgressionForAll,
  deployAndSeedProgression,
} from '../cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'

function now(): number { return Math.floor(Date.now() / 1000) }
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initCosSchema(db)
  return db
}

// ── Schema deployment ──────────────────────────────────────────────────

describe('deployProgressionSchema', () => {
  it('creates tables when they do not exist', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // Call initCosSchema but then drop progression tables to simulate pre-deploy
    initCosSchema(db)
    db.exec('DROP TABLE IF EXISTS case_progression_runs')
    db.exec('DROP TABLE IF EXISTS case_progression_state')

    const created = deployProgressionSchema(db)
    expect(created).toBe(true)

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('case_progression_state','case_progression_runs') ORDER BY name",
    ).all() as Array<{name:string}>
    expect(tables.map(t => t.name)).toEqual(['case_progression_runs', 'case_progression_state'])
  })

  it('returns false when tables already exist (idempotent)', () => {
    const db = freshDb()
    // Tables already exist from initCosSchema
    const created = deployProgressionSchema(db)
    expect(created).toBe(false)
  })

  it('is safe to call multiple times', () => {
    const db = freshDb()
    deployProgressionSchema(db)
    deployProgressionSchema(db)
    deployProgressionSchema(db)
    // Tables still exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('case_progression_state','case_progression_runs')",
    ).all()
    expect(tables.length).toBe(2)
  })
})

// ── Seeding ────────────────────────────────────────────────────────────

describe('seedProgressionState', () => {
  it('seeds progression state for existing cases without one', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createCase(db, { caseId: 'c2', title: 'B', caseType: 'EMAIL', status: 'READY', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createZstCase(db, { caseId: 'z1', title: 'Z1', caseType: 'GENERAL_OPERATION', status: 'NEW', sensitivity: 'ZST_INTERNAL', priority: 'P2', workspace: 'OPERATIONS' }, t)

    const { personalSeeded, zstSeeded } = seedProgressionState(db, t)
    expect(personalSeeded).toBe(2)
    expect(zstSeeded).toBe(1)

    // Verify rows inserted with correct defaults
    const rows = db.prepare(
      'SELECT domain, case_id, progression_enabled, progression_mode FROM case_progression_state ORDER BY domain, case_id',
    ).all() as Array<{domain:string; case_id:string; progression_enabled:number; progression_mode:string}>
    expect(rows.length).toBe(3)
    for (const r of rows) {
      expect(r.progression_enabled).toBe(1)
      expect(r.progression_mode).toBe('internal')
    }
  })

  it('skips cases that already have progression state (idempotent)', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)

    // First seed
    const { personalSeeded: first } = seedProgressionState(db, t)
    expect(first).toBe(1)

    // Second seed — should skip
    const { personalSeeded: second } = seedProgressionState(db, t)
    expect(second).toBe(0)

    // Only one row
    const count = (db.prepare('SELECT count(*) as c FROM case_progression_state').get() as {c:number}).c
    expect(count).toBe(1)
  })

  it('skips COMPLETED, CANCELLED, and ARCHIVED cases', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'active', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createCase(db, { caseId: 'c2', title: 'done', caseType: 'ADMIN', status: 'COMPLETED', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createCase(db, { caseId: 'c3', title: 'cancelled', caseType: 'ADMIN', status: 'CANCELLED', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)

    const { personalSeeded } = seedProgressionState(db, t)
    expect(personalSeeded).toBe(1)

    const rows = db.prepare('SELECT case_id FROM case_progression_state').all() as Array<{case_id:string}>
    expect(rows.map(r => r.case_id)).toEqual(['c1'])
  })
})

// ── Initial progression (deterministic) ────────────────────────────────

describe('runInitialProgressionForAll', () => {
  it('runs progression cycle for every newly-seeded case', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'Test 1', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createCase(db, { caseId: 'c2', title: 'Test 2', caseType: 'EMAIL', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)

    seedProgressionState(db, t)
    const { personalProgressed, errors } = runInitialProgressionForAll(db, t, 'test-initial')

    expect(personalProgressed).toBe(2)
    expect(errors.length).toBe(0)

    // Each case should now have last_progressed_at set
    const states = db.prepare(
      'SELECT case_id, last_progressed_at FROM case_progression_state ORDER BY case_id',
    ).all() as Array<{case_id:string; last_progressed_at:number}>
    for (const s of states) {
      expect(s.last_progressed_at).toBeGreaterThan(0)
    }

    // Each case should have at least one progression run
    const runCount = (db.prepare('SELECT count(*) as c FROM case_progression_runs').get() as {c:number}).c
    expect(runCount).toBe(2)
  })

  it('produces a decision and reason for each case', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'Decision test', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)

    seedProgressionState(db, t)
    runInitialProgressionForAll(db, t, 'test-decision')

    const runs = db.prepare(
      'SELECT decision, reason, domain FROM case_progression_runs ORDER BY started_at',
    ).all() as Array<{decision:string; reason:string; domain:string}>

    expect(runs.length).toBe(1)
    expect(runs[0].domain).toBe('personal')
    expect(typeof runs[0].decision).toBe('string')
    expect(runs[0].decision.length).toBeGreaterThan(0)
    expect(typeof runs[0].reason).toBe('string')
    expect(runs[0].reason.length).toBeGreaterThan(0)
  })

  it('is deterministic: same input → same decision', () => {
    const db1 = freshDb()
    const db2 = freshDb()
    const t = now()

    // Create identical cases in both DBs
    for (const db of [db1, db2]) {
      createCase(db, { caseId: 'c1', title: 'Same case', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
      seedProgressionState(db, t)
      runInitialProgressionForAll(db, t, 'test-det')
    }

    const r1 = db1.prepare('SELECT decision, reason FROM case_progression_runs WHERE case_id = ? AND domain = ?').get('c1', 'personal') as {decision:string; reason:string}
    const r2 = db2.prepare('SELECT decision, reason FROM case_progression_runs WHERE case_id = ? AND domain = ?').get('c1', 'personal') as {decision:string; reason:string}

    expect(r1.decision).toBe(r2.decision)
    expect(r1.reason).toBe(r2.reason)
  })

  it('skips already-progressed cases (idempotent)', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'Once', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    seedProgressionState(db, t)

    const first = runInitialProgressionForAll(db, t, 'first')
    expect(first.personalProgressed).toBe(1)

    const second = runInitialProgressionForAll(db, t, 'second')
    expect(second.personalProgressed).toBe(0)

    // Still only one run per case
    const runCount = (db.prepare('SELECT count(*) as c FROM case_progression_runs').get() as {c:number}).c
    expect(runCount).toBe(1)
  })
})

// ── Full deployment ────────────────────────────────────────────────────

describe('deployAndSeedProgression', () => {
  it('returns complete MigrationResult with all counts', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'One', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createCase(db, { caseId: 'c2', title: 'Two', caseType: 'EMAIL', status: 'READY', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createZstCase(db, { caseId: 'z1', title: 'Z', caseType: 'GENERAL_OPERATION', status: 'NEW', sensitivity: 'ZST_INTERNAL', priority: 'P2', workspace: 'OPERATIONS' }, t)

    const result = deployAndSeedProgression(db, t, 'test-deploy')

    expect(result.tablesCreated).toBe(false) // initCosSchema already created them
    expect(result.personalSeeded).toBe(2)
    expect(result.zstSeeded).toBe(1)
    expect(result.personalProgressed).toBe(2)
    expect(result.zstProgressed).toBe(1)
    expect(result.errors.length).toBe(0)
  })

  it('works on a completely fresh DB (tablesCreated=true)', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initCosSchema(db)
    // Drop progression tables to simulate pre-deploy state
    db.exec('DROP TABLE IF EXISTS case_progression_runs')
    db.exec('DROP TABLE IF EXISTS case_progression_state')

    createCase(db, { caseId: 'c1', title: 'Fresh', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, now())

    const result = deployAndSeedProgression(db, now(), 'test-fresh')
    expect(result.tablesCreated).toBe(true)
    expect(result.personalSeeded).toBe(1)
    expect(result.errors.length).toBe(0)
  })
})

// ── Heartbeat ──────────────────────────────────────────────────────────

describe('runProgressionHeartbeat', () => {
  it('processes due cases in both domains', () => {
    const db = freshDb()
    const t = now()

    // Seeding sets next_progression_at = now, so heartbeat picks them up
    createCase(db, { caseId: 'c1', title: 'P', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    createZstCase(db, { caseId: 'z1', title: 'Z', caseType: 'GENERAL_OPERATION', status: 'NEW', sensitivity: 'ZST_INTERNAL', priority: 'P2', workspace: 'OPERATIONS' }, t)
    seedProgressionState(db, t)

    const result = runProgressionHeartbeat(db, t, 50)

    expect(result.personal).toBe(1)
    expect(result.zst).toBe(1)
    expect(result.cycleErrors).toBe(0)
    expect(result.errors.length).toBe(0)
  })

  it('respects maxPerDomain limit', () => {
    const db = freshDb()
    const t = now()

    // Create 5 cases
    for (let i = 0; i < 5; i++) {
      createCase(db, { caseId: `c${i}`, title: `Case ${i}`, caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    }
    seedProgressionState(db, t)

    const result = runProgressionHeartbeat(db, t, 2)
    expect(result.personal).toBeLessThanOrEqual(2)
  })

  it('skips cases already claimed by another runner', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'Claimed', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    seedProgressionState(db, t)

    // Manually claim the case (simulating another runner)
    db.prepare(
      'UPDATE case_progression_state SET progression_claimed_by = ?, progression_claim_expires_at = ? WHERE case_id = ? AND domain = ?',
    ).run('other-runner', t + 300, 'c1', 'personal')

    const result = runProgressionHeartbeat(db, t, 50)
    expect(result.skippedClaimed).toBeGreaterThanOrEqual(1)
    expect(result.personal).toBe(0)
  })

  it('releases claims after processing (no leaked claims)', () => {
    const db = freshDb()
    const t = now()

    createCase(db, { caseId: 'c1', title: 'Release', caseType: 'ADMIN', status: 'NEW', sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test' }, t)
    seedProgressionState(db, t)

    runProgressionHeartbeat(db, t, 50)

    // After heartbeat, no claims should remain
    const claimed = db.prepare(
      "SELECT case_id FROM case_progression_state WHERE progression_claimed_by IS NOT NULL",
    ).all()
    expect(claimed.length).toBe(0)
  })

  it('heartbeat against empty DB returns zeros', () => {
    const db = freshDb()
    const result = runProgressionHeartbeat(db, now(), 50)
    expect(result.personal).toBe(0)
    expect(result.zst).toBe(0)
    expect(result.errors.length).toBe(0)
  })
})

// ── Intake wiring: progression tables EXIST ───────────────────────────

describe('intake seeds progression state when tables exist', () => {
  let db: Database.Database
  const t = now()

  beforeEach(() => {
    db = freshDb()
  })

  function seedBatch(messageId: string, threadId?: string) {
    openBatch(db, {
      batchId: `b-${messageId}`,
      accountId: 'iszzu80',
      cursorBefore: '1',
      cursorAfter: '2',
      messages: [{ messageId, threadId }],
    }, t)
  }

  it('personal intake creates case_progression_state row', () => {
    seedBatch('msg-prog-personal-1', 'thread-prog-p1')
    const result = ingestEmail(db, {
      accountId: 'iszzu80',
      messageId: 'msg-prog-personal-1',
      threadId: 'thread-prog-p1',
      subject: 'Test progression seed',
      from: 'test@example.com',
      snippet: 'Testing.',
      actionable: true,
      caseType: 'ADMIN',
      declaredSensitivity: 'PERSONAL',
    }, t)

    expect(result.outcome).toBe('CASE_CREATED')

    const state = db.prepare(
      "SELECT * FROM case_progression_state WHERE domain = 'personal' AND case_id = ?",
    ).get(result.caseId!) as Record<string,unknown> | undefined
    expect(state).not.toBeUndefined()
    expect(state!.progression_enabled).toBe(1)
    expect(state!.progression_mode).toBe('internal')
    expect(state!.next_progression_at).toBe(t)
  })

  it('ZST intake creates case_progression_state row', () => {
    const result = ingestTriagedZstEmail(db, {
      accountId: 'zst',
      messageId: 'msg-prog-zst-1',
      threadId: 'thread-prog-z1',
      subject: 'ZST progression seed',
      from: 'test@zst.hu',
      snippet: 'Testing ZST.',
      actionable: true,
      caseType: 'GENERAL_OPERATION',
      workspace: 'OPERATIONS',
    }, t)

    expect(result.outcome).toBe('CASE_CREATED')

    const state = db.prepare(
      "SELECT * FROM case_progression_state WHERE domain = 'zst' AND case_id = ?",
    ).get(result.caseId!) as Record<string,unknown> | undefined
    expect(state).not.toBeUndefined()
    expect(state!.progression_enabled).toBe(1)
    expect(state!.progression_mode).toBe('internal')
  })

  it('intake return values unchanged (outcome, caseId, case shape)', () => {
    // Prove that progression seeding is a transparent side-effect:
    // return values and case creation are identical.
    seedBatch('msg-return-val-1', 'thread-rv1')
    const result = ingestEmail(db, {
      accountId: 'iszzu80',
      messageId: 'msg-return-val-1',
      threadId: 'thread-rv1',
      subject: 'Return value test',
      from: 'test@example.com',
      snippet: 'Testing return values.',
      actionable: true,
      caseType: 'ADMIN',
      declaredSensitivity: 'PERSONAL',
    }, t)

    expect(result.outcome).toBe('CASE_CREATED')
    expect(typeof result.caseId).toBe('string')
    expect(result.caseId!.length).toBeGreaterThan(0)

    // Case exists and has expected fields
    const c = db.prepare('SELECT * FROM personal_cases WHERE case_id = ?').get(result.caseId!) as Record<string,unknown>
    expect(c).not.toBeUndefined()
    expect(c.title).toBe('Return value test')
    expect(c.status).toBe('NEW')
  })
})

// ── Intake wiring: progression tables ABSENT ──────────────────────────

describe('intake works without progression tables (pre-deploy compatibility)', () => {
  it('personal intake does not throw when progression tables are missing', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initCosSchema(db)
    db.exec('DROP TABLE IF EXISTS case_progression_runs')
    db.exec('DROP TABLE IF EXISTS case_progression_state')

    const t = now()

    // Seed the email batch
    openBatch(db, {
      batchId: 'b-no-prog-1',
      accountId: 'iszzu80',
      cursorBefore: '1',
      cursorAfter: '2',
      messages: [{ messageId: 'msg-no-prog-1', threadId: 'thread-no-prog-1' }],
    }, t)

    const result = ingestEmail(db, {
      accountId: 'iszzu80',
      messageId: 'msg-no-prog-1',
      threadId: 'thread-no-prog-1',
      subject: 'No progression tables',
      from: 'test@example.com',
      snippet: 'Should work fine.',
      actionable: true,
    }, t)

    expect(result.outcome).toBe('CASE_CREATED')
    expect(typeof result.caseId).toBe('string')
  })

  it('ZST intake does not throw when progression tables are missing', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initCosSchema(db)
    db.exec('DROP TABLE IF EXISTS case_progression_runs')
    db.exec('DROP TABLE IF EXISTS case_progression_state')

    const t = now()
    const result = ingestTriagedZstEmail(db, {
      accountId: 'zst',
      messageId: 'msg-zst-no-prog-1',
      subject: 'No progression ZST',
      from: 'test@zst.hu',
      snippet: 'Works.',
      actionable: true,
      caseType: 'GENERAL_OPERATION',
      workspace: 'OPERATIONS',
    }, t)

    expect(result.outcome).toBe('CASE_CREATED')
    expect(typeof result.caseId).toBe('string')
  })

  it('intake return values identical WITH and WITHOUT progression tables', () => {
    const t = now()

    const dbWith = freshDb()
    const dbWithout = new Database(':memory:')
    dbWithout.pragma('journal_mode = WAL')
    initCosSchema(dbWithout)
    dbWithout.exec('DROP TABLE IF EXISTS case_progression_runs')
    dbWithout.exec('DROP TABLE IF EXISTS case_progression_state')

    // Seed identical state in both
    for (const db of [dbWith, dbWithout]) {
      openBatch(db, {
        batchId: 'b-compare-1',
        accountId: 'iszzu80',
        cursorBefore: '1', cursorAfter: '2',
        messages: [{ messageId: 'msg-compare-1', threadId: 'thread-compare-1' }],
      }, t)
    }

    const input: EmailIntakeInput = {
      accountId: 'iszzu80',
      messageId: 'msg-compare-1',
      threadId: 'thread-compare-1',
      subject: 'Compare test',
      from: 'test@example.com',
      snippet: 'Compare.',
      actionable: true,
      caseType: 'ADMIN',
      declaredSensitivity: 'PERSONAL',
    }

    const rWith = ingestEmail(dbWith, input, t)
    const rWithout = ingestEmail(dbWithout, input, t)

    expect(rWith.outcome).toBe(rWithout.outcome)
    expect(rWith.caseId).toBe(rWithout.caseId)
    expect(rWith.messageStatus).toBe(rWithout.messageStatus)
    expect(rWith.sensitivity).toBe(rWithout.sensitivity)
  })
})
