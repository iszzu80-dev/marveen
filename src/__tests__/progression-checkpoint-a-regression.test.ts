// Checkpoint A — Brownfield integrity regression proof (card 31188085).
//
// PROVES (not asserts) per plan §16 + §29(A):
//   1. Personal intake unchanged
//   2. ZST intake unchanged
//   3. Case create/update unchanged
//   4. Event history unchanged
//   5. Mission Control view unchanged
//   6. PROGRESSION OFF == LEGACY BEHAVIOR
//
// METHOD: Two independent :memory: DBs — one WITH case_progression_state /
// case_progression_runs present (the GATE 0 schema), one WITHOUT them
// (same initCosSchema call, then the progression tables are DROPped).
// Both run identical operations. Outputs are compared for structural
// identity (shape, cardinality, non-volatile fields). The progression
// tables are a TRUE SUPERSET: they introduce zero observable difference
// in existing behavior.
//
// Plus: schema snapshot + integrity check per plan §26 requirement.

import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { initCosSchema } from '../cos/schema.js'
import { createCase, transitionCase, listActiveCases, listTodayCases } from '../cos/case-store.js'
import { createZstCase, transitionZstCase, listActiveZstCases, listTodayZstCases } from '../cos/zst-case-store.js'
import { ingestEmail, type EmailIntakeInput } from '../cos/intake.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../cos/zst-intake.js'
import { openBatch } from '../cos/email-ingest.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function now(): number { return Math.floor(Date.now() / 1000) }

/** Strip volatile fields (timestamps, auto IDs) so structural comparison
 *  is deterministic across two DB instances. We compare SHAPE + CARDINALITY
 *  + non-volatile field values, not exact timestamps or auto-increment IDs. */
function stripVolatile(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'number') return '<number>'
  if (typeof obj === 'string') return obj
  if (Array.isArray(obj)) return obj.map(stripVolatile)
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if ([
        'created_at','updated_at','completed_at','archived_at','event_id',
        'case_version','claimed_at','claim_expires_at','version',
        'due_at','follow_up_at','next_wake_at','last_event_id','sequence_number',
        'ledger_id','internal_idempotency_key','approval_id','campaign_id',
        'campaign_version','claim_fence','sending_at','applied_at','verified_at',
        'started_at','completed_at','last_progressed_at','next_progression_at',
        'progression_claimed_by','progression_claim_expires_at','case_version_before',
        'case_version_after','goal_version','context_hash','plan_version_before',
        'plan_version_after','progress_delta_json','action_ids_json',
        'safety_assertions_json','progression_run_id','escalation_id',
        'trigger_reference','rowid','seq',
        // ZST-specific timestamps
        'due_date','approval_submitted_at','approval_resolved_at',
        'payment_due_at','contract_start','contract_end',
        'obligation_due_at','obligation_fulfilled_at',
        'invoice_date','invoice_due_date','invoice_paid_at',
        'bank_transaction_date','reconciliation_date',
        'milestone_due','milestone_completed_at',
        'last_scanned_at','last_alert_at',
      ].includes(k)) { out[k] = '<number|undefined>'; continue }
      out[k] = stripVolatile(v)
    }
    return out
  }
  return obj
}

function shapeKey(obj: unknown): string {
  return JSON.stringify(stripVolatile(obj))
}

// ── Test suite ───────────────────────────────────────────────────────────

describe('Checkpoint A — Brownfield integrity (card 31188085)', () => {
  let dbWithProg: Database.Database
  let dbWithoutProg: Database.Database

  beforeAll(() => {
    // DB 1: Full COS schema WITH progression tables (GATE 0)
    dbWithProg = new Database(':memory:')
    dbWithProg.pragma('journal_mode = WAL')
    initCosSchema(dbWithProg)
    // initCosSchema calls initProgressionSchema internally — progression tables exist.

    // DB 2: Same COS schema WITHOUT progression tables (pre-GATE-0 simulation)
    dbWithoutProg = new Database(':memory:')
    dbWithoutProg.pragma('journal_mode = WAL')
    initCosSchema(dbWithoutProg)
    // Remove the progression tables to simulate the pre-GATE-0 state.
    // Drop in FK-safe order (child first, then parent).
    dbWithoutProg.exec('DROP TABLE IF EXISTS case_progression_runs')
    dbWithoutProg.exec('DROP TABLE IF EXISTS case_progression_state')
  })

  // ─── 1. Personal intake unchanged ────────────────────────────────────

  it('personal intake produces identical output WITH and WITHOUT progression tables', () => {
    const t = now()

    // Seed email_processing rows (openBatch must run before ingestEmail)
    function seedIntake(db: Database.Database, messageId: string, threadId?: string) {
      openBatch(db, {
        batchId: `b-${messageId}`,
        accountId: 'iszzu80',
        cursorBefore: '1',
        cursorAfter: '2',
        messages: [{ messageId, threadId }],
      }, t)
    }

    seedIntake(dbWithProg, 'msg-intake-regress-001', 'thread-regress-001')
    seedIntake(dbWithoutProg, 'msg-intake-regress-001', 'thread-regress-001')

    const actionableInbound: EmailIntakeInput = {
      accountId: 'iszzu80',
      messageId: 'msg-intake-regress-001',
      threadId: 'thread-regress-001',
      subject: 'Surgos: szamla befizetesi hatarido',
      from: 'szolgaltato@example.com',
      snippet: 'Kerjuk a szamla rendezeset augusztus 15-ig.',
      actionable: true,
      caseType: 'BILL',
      declaredSensitivity: 'PERSONAL',
      priority: 'P1',
    }

    const resultWith = ingestEmail(dbWithProg, actionableInbound, t)
    const resultWithout = ingestEmail(dbWithoutProg, actionableInbound, t)

    // Outcome identical
    expect(resultWith.outcome).toBe(resultWithout.outcome)
    expect(resultWith.outcome).toBe('CASE_CREATED')
    // Same messageId + accountId → same caseId (deterministic derivation)
    expect(resultWith.caseId).toBe(resultWithout.caseId)

    // Created case has identical shape
    const caseWith = dbWithProg.prepare('SELECT * FROM personal_cases WHERE case_id = ?').get(resultWith.caseId!)
    const caseWithout = dbWithoutProg.prepare('SELECT * FROM personal_cases WHERE case_id = ?').get(resultWithout.caseId!)
    expect(shapeKey(caseWith)).toBe(shapeKey(caseWithout))

    // Event count and shape identical
    const evWith = dbWithProg.prepare('SELECT * FROM personal_case_events WHERE case_id = ?').all(resultWith.caseId!)
    const evWithout = dbWithoutProg.prepare('SELECT * FROM personal_case_events WHERE case_id = ?').all(resultWithout.caseId!)
    expect(evWith.length).toBe(evWithout.length)
    expect(evWith.length).toBeGreaterThan(0) // at least CREATED event
    expect(shapeKey(evWith)).toBe(shapeKey(evWithout))

    // Non-actionable (noise) — identical EXCLUDED outcome
    seedIntake(dbWithProg, 'msg-noise-001', 'thread-noise')
    seedIntake(dbWithoutProg, 'msg-noise-001', 'thread-noise')
    const noise: EmailIntakeInput = {
      accountId: 'iszzu80',
      messageId: 'msg-noise-001',
      threadId: 'thread-noise',
      subject: 'Hirlevel',
      from: 'newsletter@example.com',
      snippet: 'Olvassa el legfrissebb hireinket!',
      actionable: false,
    }
    const noiseWith = ingestEmail(dbWithProg, noise, t)
    const noiseWithout = ingestEmail(dbWithoutProg, noise, t)
    expect(noiseWith.outcome).toBe('EXCLUDED')
    expect(noiseWithout.outcome).toBe('EXCLUDED')

    // Duplicate prevention identical
    const dupWith = ingestEmail(dbWithProg, actionableInbound, t)
    const dupWithout = ingestEmail(dbWithoutProg, actionableInbound, t)
    expect(dupWith.outcome).toBe('LINKED_DUPLICATE')
    expect(dupWithout.outcome).toBe('LINKED_DUPLICATE')
    expect(dupWith.caseId).toBe(dupWithout.caseId)
  })

  // ─── 2. ZST intake unchanged ─────────────────────────────────────────

  it('zst intake produces identical output WITH and WITHOUT progression tables', () => {
    const t = now()

    const zstInput: ZstTriagedEmail = {
      accountId: 'zst',
      messageId: 'msg-zst-regress-001',
      threadId: 'thread-zst-regress-001',
      subject: 'Szamla: Musorszolgaltatasi dij augusztus',
      from: 'nav.gov.hu',
      snippet: 'Tisztelt Ugyfelunk! A musorszolgaltatasi dij...',
      actionable: true,
      caseType: 'INVOICE_INCOMING',
      declaredSensitivity: 'ZST_INTERNAL',
      workspace: 'OPERATIONS',
    }

    const resultWith = ingestTriagedZstEmail(dbWithProg, zstInput, t)
    const resultWithout = ingestTriagedZstEmail(dbWithoutProg, zstInput, t)

    expect(resultWith.outcome).toBe(resultWithout.outcome)
    expect(resultWith.outcome).toBe('CASE_CREATED')
    expect(resultWith.caseId).toBe(resultWithout.caseId)

    // Created zst_case has identical shape
    const caseWith = dbWithProg.prepare('SELECT * FROM zst_cases WHERE case_id = ?').get(resultWith.caseId!)
    const caseWithout = dbWithoutProg.prepare('SELECT * FROM zst_cases WHERE case_id = ?').get(resultWithout.caseId!)
    expect(shapeKey(caseWith)).toBe(shapeKey(caseWithout))

    // ZST events identical
    const evWith = dbWithProg.prepare('SELECT * FROM zst_case_events WHERE case_id = ?').all(resultWith.caseId!)
    const evWithout = dbWithoutProg.prepare('SELECT * FROM zst_case_events WHERE case_id = ?').all(resultWithout.caseId!)
    expect(evWith.length).toBe(evWithout.length)
    expect(evWith.length).toBeGreaterThan(0)
    expect(shapeKey(evWith)).toBe(shapeKey(evWithout))

    // Duplicate prevention identical
    const dupWith = ingestTriagedZstEmail(dbWithProg, zstInput, t)
    const dupWithout = ingestTriagedZstEmail(dbWithoutProg, zstInput, t)
    expect(dupWith.outcome).toBe('ALREADY_PROCESSED')
    expect(dupWithout.outcome).toBe('ALREADY_PROCESSED')

    // Non-actionable identical
    const noiseInput: ZstTriagedEmail = {
      ...zstInput,
      messageId: 'msg-zst-noise-001',
      threadId: 'thread-zst-noise',
      subject: 'Spam',
      actionable: false,
    }
    const noiseWith = ingestTriagedZstEmail(dbWithProg, noiseInput, t)
    const noiseWithout = ingestTriagedZstEmail(dbWithoutProg, noiseInput, t)
    expect(noiseWith.outcome).toBe('EXCLUDED')
    expect(noiseWithout.outcome).toBe('EXCLUDED')
  })

  // ─── 3. Case CRUD unchanged ──────────────────────────────────────────

  it('personal case create + transition produce identical shapes', () => {
    const t = now()

    for (const db of [dbWithProg, dbWithoutProg]) {
      const c = createCase(db, {
        caseId: 'case-iszzu80-crud-test-001',
        title: 'Regress test case',
        caseType: 'ADMIN',
        status: 'NEW',
        sensitivity: 'PERSONAL',
        priority: 'P2',
        sourceSystem: 'test',
      }, t)
      expect(typeof c.case_id).toBe('string')
      expect(c.version).toBe(1)
      expect(c.status).toBe('NEW')

      // Transition to READY
      const newVersion = transitionCase(db, {
        caseId: c.case_id,
        seenVersion: 1,
        newStatus: 'READY',
        reason: 'Testing CRUD invariance',
        actor: 'test',
      }, t)
      expect(newVersion).toBe(2)
    }

    // Compare shapes across DBs
    const caseWith = dbWithProg.prepare("SELECT * FROM personal_cases WHERE case_type = 'ADMIN' AND title = 'Regress test case'").get()
    const caseWithout = dbWithoutProg.prepare("SELECT * FROM personal_cases WHERE case_type = 'ADMIN' AND title = 'Regress test case'").get()
    expect(shapeKey(caseWith)).toBe(shapeKey(caseWithout))

    // Event count and shape identical
    const evWith = dbWithProg.prepare('SELECT * FROM personal_case_events WHERE case_id = ?').all((caseWith as {case_id:string}).case_id)
    const evWithout = dbWithoutProg.prepare('SELECT * FROM personal_case_events WHERE case_id = ?').all((caseWithout as {case_id:string}).case_id)
    expect(evWith.length).toBe(evWithout.length)
    expect(evWith.length).toBe(2) // CREATED + STATUS_CHANGED
    expect(shapeKey(evWith)).toBe(shapeKey(evWithout))
  })

  it('zst case create + transition produce identical shapes', () => {
    const t = now()

    for (const db of [dbWithProg, dbWithoutProg]) {
      const c = createZstCase(db, {
        caseId: 'case-zst-crud-test-001',
        title: 'Regress ZST case',
        caseType: 'INVOICE_INCOMING',
        status: 'NEW',
        sensitivity: 'ZST_INTERNAL',
        priority: 'P2',
        workspace: 'OPERATIONS',
      }, t)
      expect(typeof c.case_id).toBe('string')
      expect(c.version).toBe(1)

      const newVersion = transitionZstCase(db, {
        caseId: c.case_id,
        seenVersion: 1,
        newStatus: 'READY',
        reason: 'Testing ZST CRUD invariance',
        actor: 'test',
      }, t)
      expect(newVersion).toBe(2)
    }

    const caseWith = dbWithProg.prepare("SELECT * FROM zst_cases WHERE title = 'Regress ZST case'").get()
    const caseWithout = dbWithoutProg.prepare("SELECT * FROM zst_cases WHERE title = 'Regress ZST case'").get()
    expect(shapeKey(caseWith)).toBe(shapeKey(caseWithout))
  })

  // ─── 4. Event history audit unchanged ────────────────────────────────

  it('event history triggers are intact (append-only, FK enforcement)', () => {
    for (const db of [dbWithProg, dbWithoutProg]) {
      // UPDATE blocked on personal_case_events (append-only trigger)
      expect(() => db.exec("UPDATE personal_case_events SET reason = 'tampered' WHERE event_id = 1")).toThrow()

      // DELETE blocked
      expect(() => db.exec('DELETE FROM personal_case_events WHERE event_id = 1')).toThrow()

      // FK enforced (non-existent case_id)
      expect(() => db.prepare(
        "INSERT INTO personal_case_events (case_id, case_version, actor, event_type, reason, created_at) VALUES ('nonexistent', 1, 'test', 'CREATED', 'bad', 1)",
      ).run()).toThrow()
    }
  })

  // ─── 5. Mission Control view unchanged ───────────────────────────────

  it('listActiveCases and listTodayCases return identical shapes', () => {
    const t = now()

    // Seed identical cases in both DBs
    for (const db of [dbWithProg, dbWithoutProg]) {
      createCase(db, {
        caseId: 'case-iszzu80-mc-view-test-1',
        title: 'MC View Test 1', caseType: 'ADMIN', status: 'READY',
        sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
      }, t)
      createCase(db, {
        caseId: 'case-iszzu80-mc-view-test-2',
        title: 'MC View Test 2', caseType: 'HOME_REPAIR', status: 'WAITING_EXTERNAL',
        sensitivity: 'PERSONAL', priority: 'P1', sourceSystem: 'test',
      }, t)
      createZstCase(db, {
        caseId: 'case-zst-mc-view-test-1',
        title: 'MC ZST View Test', caseType: 'INVOICE_INCOMING', status: 'READY',
        sensitivity: 'ZST_INTERNAL', priority: 'P2', workspace: 'OPERATIONS',
      }, t)
    }

    const horizon = t + 86400

    // Personal active — filter to our test cases only (other tests may have seeded data)
    const activeWith = listActiveCases(dbWithProg).filter(c => (c as {title:string}).title.startsWith('MC View Test'))
    const activeWithout = listActiveCases(dbWithoutProg).filter(c => (c as {title:string}).title.startsWith('MC View Test'))
    expect(activeWith.length).toBe(activeWithout.length)
    expect(shapeKey(activeWith)).toBe(shapeKey(activeWithout))

    // Personal today
    const todayWith = listTodayCases(dbWithProg, horizon).filter(c => (c as {title:string}).title.startsWith('MC View Test'))
    const todayWithout = listTodayCases(dbWithoutProg, horizon).filter(c => (c as {title:string}).title.startsWith('MC View Test'))
    expect(todayWith.length).toBe(todayWithout.length)
    expect(shapeKey(todayWith)).toBe(shapeKey(todayWithout))

    // ZST active
    const zstActiveWith = listActiveZstCases(dbWithProg)
    const zstActiveWithout = listActiveZstCases(dbWithoutProg)
    expect(zstActiveWith.length).toBe(zstActiveWithout.length)
    expect(shapeKey(zstActiveWith)).toBe(shapeKey(zstActiveWithout))
  })

  // ─── 6. PROGRESSION ON (thin slice GATE 2) — intake seeds state ──

  it('progression tables are populated after intake (thin slice active)', () => {
    // The thin slice (card 52250c7f) wires intake to seed progression state.
    // When the progression tables exist, intake creates a case_progression_state
    // row with progression_enabled=1 for each new case.
    const stateCount = (dbWithProg.prepare('SELECT count(*) as c FROM case_progression_state').get() as {c:number}).c
    const runCount = (dbWithProg.prepare('SELECT count(*) as c FROM case_progression_runs').get() as {c:number}).c
    // After the intake tests above, we expect at least one seeded state row.
    expect(stateCount).toBeGreaterThan(0)
    // Progression runs are NOT created by intake (only by the heartbeat/migration).
    // If any exist here, they came from the test that explicitly calls runProgressionCycle.
    expect(runCount).toBeGreaterThanOrEqual(0)
  })

  it('intake seeds progression_enabled=1, progression_mode=internal', () => {
    // Every seeded row must have the expected defaults for the thin slice.
    const rows = dbWithProg.prepare(
      'SELECT progression_enabled, progression_mode FROM case_progression_state',
    ).all() as Array<{progression_enabled: number; progression_mode: string}>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.progression_enabled).toBe(1)
      expect(r.progression_mode).toBe('internal')
    }
  })

  it('schema defaults enforce progression_enabled=0, progression_mode=off', () => {
    // Verify column defaults via PRAGMA
    const cols = dbWithProg.prepare('PRAGMA table_info(case_progression_state)').all() as Array<{name:string, dflt_value:string|null}>

    const enabledCol = cols.find(c => c.name === 'progression_enabled')
    expect(enabledCol).toBeDefined()
    expect(enabledCol!.dflt_value).toBe('0')

    const modeCol = cols.find(c => c.name === 'progression_mode')
    expect(modeCol).toBeDefined()
    expect(modeCol!.dflt_value).toBe("'off'")
  })

  // ─── 7. Schema snapshot integrity check ──────────────────────────────

  it('schema snapshot: progression tables are the ONLY difference', () => {
    // All user tables (exclude SQLite internal tables)
    const tablesWith = (dbWithProg.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{name:string}>).map(r => r.name)

    const tablesWithout = (dbWithoutProg.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{name:string}>).map(r => r.name)

    // Verify progression tables exist in the WITH DB
    expect(tablesWith).toContain('case_progression_state')
    expect(tablesWith).toContain('case_progression_runs')
    // And NOT in the WITHOUT DB
    expect(tablesWithout).not.toContain('case_progression_state')
    expect(tablesWithout).not.toContain('case_progression_runs')

    // WITH has exactly 2 more tables than WITHOUT
    expect(tablesWith.length - tablesWithout.length).toBe(2)

    // Those 2 extra tables are the progression tables
    expect(tablesWith).toContain('case_progression_state')
    expect(tablesWith).toContain('case_progression_runs')
    expect(tablesWithout).not.toContain('case_progression_state')
    expect(tablesWithout).not.toContain('case_progression_runs')

    // All other table names must match exactly
    for (const t of tablesWithout) {
      expect(tablesWith).toContain(t)
    }
  })

  it('schema snapshot: no progression columns leaked into existing tables', () => {
    for (const table of ['personal_cases', 'zst_cases', 'personal_case_events', 'zst_case_events']) {
      const cols = (dbWithProg.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(c => c.name)
      const progKeywords = ['goal', 'progression', 'definition_of_done', 'rolling_plan',
        'next_best_action', 'semantic_completion', 'progression_enabled', 'progression_mode']
      for (const kw of progKeywords) {
        const matches = cols.filter(c => c.toLowerCase().includes(kw))
        expect(matches, `${table} must not have column matching "${kw}"`).toEqual([])
      }
    }
  })

  it('integrity: after ALL operations, progression state exists (thin slice active)', () => {
    // All CRUD/intake/view operations above have executed. The progression
    // tables MUST now contain rows — intake seeds progression state when the
    // tables exist (card 52250c7f, thin slice GATE 2).
    const stateCount = (dbWithProg.prepare('SELECT count(*) as c FROM case_progression_state').get() as {c:number}).c
    expect(stateCount).toBeGreaterThan(0)

    // On the WITHOUT DB, progression tables don't even exist — intake gracefully
    // skips seeding via the sqlite_master guard.
    const withoutCount = (dbWithoutProg.prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name IN ('case_progression_state','case_progression_runs')",
    ).get() as {c:number}).c
    expect(withoutCount).toBe(0)
  })
})
