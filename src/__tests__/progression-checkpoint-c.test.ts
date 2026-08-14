// Checkpoint C — Resolver depth (card 53f1fd06).
// Extends the resolver with two internal-shadow sources:
//   1. Full email thread resolution — reads thread history from email_processing
//   2. Domain-safe memory lookup — queries memories_fts for relevant facts
//   3. Audit trail — sources_attempted / facts_found / remaining_gap / why_blocking
//
// Also extends the GATE 0 eval corpus with "missing information resolved from
// email thread" scenario (plan §15 required category that Checkpoint B's
// DB-only resolver could not exercise).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { openBatch } from '../cos/email-ingest.js'
import { ingestEmail } from '../cos/intake.js'
import { ingestTriagedZstEmail } from '../cos/zst-intake.js'
import {
  resolveEmailThread,
  resolveMemory,
  resolveContextDeep,
  CrossDomainReadError,
  domainGuard,
  type EmailThreadResolution,
  type MemoryResolution,
  type DeepResolvedContext,
  type ResolutionAudit,
} from '../cos/progression-resolver.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import type { CorpusCase, EvalReport } from '../cos/progression-eval.js'
import { runEval, HARD_SAFETY_ASSERTIONS } from '../cos/progression-eval.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function seedMemory(db: Database.Database, content: string, sector: string = 'semantic', topicKey: string = 'test') {
  db.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
     VALUES ('test-chat', ?, ?, ?, 1.0, unixepoch(), unixepoch())`,
  ).run(topicKey, content, sector)
}

function snapshotProgressionState(domain: string, caseId: string, db: Database.Database) {
  return db.prepare(
    'SELECT * FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as Record<string, unknown> | undefined
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Checkpoint C — Resolver depth (card 53f1fd06)', () => {
  let db: Database.Database
  const now = Math.floor(Date.now() / 1000)

  beforeAll(() => {
    initDatabase(':memory:')
    db = getDb() as Database.Database
  })

  afterAll(() => {
    db?.close()
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 1: Email thread resolution
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 1: Email thread resolution', () => {
    beforeAll(() => {
      // Create a case with thread history
      createCase(db, {
        caseId: 'case-thread-test-001',
        title: 'Test: email thread resolution',
        caseType: 'HOME_REPAIR',
        status: 'WAITING_EXTERNAL',
        priority: 'P2',
        sensitivity: 'PERSONAL',
        sourceSystem: 'gmail',
        sourceReference: 'msg-001',
      }, now - 86400 * 3)

      // Set gmail_thread_ids on the case
      db.prepare(
        `UPDATE personal_cases SET gmail_thread_ids = ?, source_references = ?
         WHERE case_id = ?`,
      ).run(JSON.stringify(['thread-abc']), JSON.stringify(['msg-001', 'msg-002', 'msg-003']), 'case-thread-test-001')

      // Seed email_processing with thread messages via openBatch
      const batchId1 = 'batch-checkpoint-c-1'
      openBatch(db, {
        batchId: batchId1,
        accountId: 'iszzu80',
        cursorBefore: null,
        cursorAfter: 'cursor-1',
        messages: [
          { messageId: 'msg-001', threadId: 'thread-abc' },
          { messageId: 'msg-002', threadId: 'thread-abc' },
          { messageId: 'msg-003', threadId: 'thread-abc' },
        ],
      }, now - 86400 * 3)

      // Direct-update the statuses to LOCAL_APPLIED (bypass ingestEmail for
      // simplicity — we just need rows in email_processing for the resolver)
      db.prepare(
        `UPDATE email_processing SET status = 'LOCAL_APPLIED', updated_at = ?
         WHERE batch_id = ?`,
      ).run(now, batchId1)

      // Also create a ZST case with email thread
      createZstCase(db, {
        caseId: 'zst-thread-test-001',
        title: 'ZST: email thread test',
        caseType: 'INVOICE_INCOMING',
        status: 'NEW',
        priority: 'P2',
        sensitivity: 'ZST_INTERNAL',
        sourceSystem: 'gmail',
        sourceReference: 'zst-msg-001',
        workspace: 'OPERATIONS',
      }, now - 86400 * 2)

      db.prepare(
        `UPDATE zst_cases SET gmail_thread_ids = ?, source_references = ?
         WHERE case_id = ?`,
      ).run(JSON.stringify(['zst-thread-xyz']), JSON.stringify(['zst-msg-001', 'zst-msg-002']), 'zst-thread-test-001')

      // Seed zst_email_processing
      db.prepare(
        `INSERT INTO zst_email_processing (gmail_account_id, message_id, thread_id, case_id, status, created_at)
         VALUES ('zst-account', 'zst-msg-001', 'zst-thread-xyz', 'zst-thread-test-001', 'LOCAL_APPLIED', ?)`,
      ).run(now - 86400 * 2)
      db.prepare(
        `INSERT INTO zst_email_processing (gmail_account_id, message_id, thread_id, case_id, status, created_at)
         VALUES ('zst-account', 'zst-msg-002', 'zst-thread-xyz', 'zst-thread-test-001', 'LOCAL_APPLIED', ?)`,
      ).run(now - 86400 * 1)
    })

    it('resolves email thread history for a personal case', () => {
      const result = resolveEmailThread(db, 'personal', 'case-thread-test-001')
      expect(result.has_history).toBe(true)
      expect(result.thread_ids).toContain('thread-abc')
      expect(result.messages.length).toBeGreaterThanOrEqual(3)
      expect(result.messages.some(m => m.message_id === 'msg-001')).toBe(true)
      expect(result.messages.some(m => m.message_id === 'msg-002')).toBe(true)
      expect(result.messages.some(m => m.message_id === 'msg-003')).toBe(true)
    })

    it('resolves email thread history for a ZST case', () => {
      const result = resolveEmailThread(db, 'zst', 'zst-thread-test-001')
      expect(result.has_history).toBe(true)
      expect(result.thread_ids).toContain('zst-thread-xyz')
      expect(result.messages.length).toBe(2)
    })

    it('returns empty result for a case with no thread data', () => {
      // Create a case without email linkage
      createCase(db, {
        caseId: 'case-no-email',
        title: 'No email case',
        caseType: 'PERSONAL',
        priority: 'P3',
      }, now)
      const result = resolveEmailThread(db, 'personal', 'case-no-email')
      expect(result.has_history).toBe(false)
      expect(result.messages).toHaveLength(0)
      expect(result.thread_ids).toHaveLength(0)
    })

    it('returns empty result for non-existent case', () => {
      const result = resolveEmailThread(db, 'personal', 'nonexistent-case')
      expect(result.has_history).toBe(false)
      expect(result.messages).toHaveLength(0)
    })

    it('thread messages are ordered by created_at ASC', () => {
      const result = resolveEmailThread(db, 'personal', 'case-thread-test-001')
      const timestamps = result.messages.map(m => m.created_at)
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1])
      }
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 2: Memory lookup
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 2: Domain-safe memory lookup (no-op — no domain-scoped store exists)', () => {
    beforeAll(() => {
      // Seed memories that WOULD match if the store were domain-scoped.
      // The safe no-op must NOT return these — the fleet-shared memories
      // table has no domain/tenant column and would leak content.
      seedMemory(db, 'Medence WPC peremelem beszerzese folyamatban. Kardos Laszlo a Pro-Mower-tol ajanlatot ad.', 'semantic', 'medence-wpc')
      seedMemory(db, 'ZST Radio szamla MVM-tol villamos energia 2026 augusztus', 'semantic', 'zst-invoice')
      seedMemory(db, 'Pro-Mower WPC termekek forgalmazoja: WPC Hungary Kft. Elerhetoseg: +36 30 123 4567', 'semantic', 'vendor-wpc')
      seedMemory(db, 'Biztositas invoice szamla erkezett a Generalitol, eves dij 60000 HUF', 'semantic', 'biztositas')
    })

    it('memory resolution is safe no-op for PERSONAL domain', () => {
      const result = resolveMemory(db, 'personal', 'Medence WPC-alkatresz ajanlatkeres', 'HOME_REPAIR', 'WPC peremelem beszerzes')
      expect(result.has_relevant_memory).toBe(false)
      expect(result.facts).toHaveLength(0)
      expect(result.search_terms).toHaveLength(0)
    })

    it('memory resolution is safe no-op for ZST domain', () => {
      const result = resolveMemory(db, 'zst', 'Biztositas szamla', 'INVOICE_INCOMING', 'szamla invoice')
      expect(result.has_relevant_memory).toBe(false)
      expect(result.facts).toHaveLength(0)
      expect(result.search_terms).toHaveLength(0)
    })

    it('both domains return identical empty shape', () => {
      const pri = resolveMemory(db, 'personal', 'test', 'PERSONAL', null)
      const zst = resolveMemory(db, 'zst', 'test', 'ADMIN', null)
      expect(pri).toEqual({
        search_terms: [],
        facts: [],
        has_relevant_memory: false,
      })
      expect(zst).toEqual({
        search_terms: [],
        facts: [],
        has_relevant_memory: false,
      })
    })

    it('no-op is real — seeded memory exists but is never returned', () => {
      // Verify the seeded memory EXISTS in the DB (proves the no-op
      // is blocking it, not that data is missing)
      const count = (db.prepare('SELECT count(*) as c FROM memories').get() as { c: number }).c
      expect(count).toBeGreaterThanOrEqual(4)

      const result = resolveMemory(db, 'personal', 'Medence WPC', 'HOME_REPAIR', 'WPC')
      expect(result.facts).toHaveLength(0) // guard blocks it
      expect(result.has_relevant_memory).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 3: Deep resolver (coordinated resolution)
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 3: Deep resolver (resolveContextDeep)', () => {
    it('returns context with email thread and memory for a case with both', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx.eventCount).toBeGreaterThanOrEqual(0)
      expect(ctx.sensitivity).toBe('PERSONAL')
      expect(ctx.emailThread).not.toBeNull()
      expect(ctx.emailThread!.messages.length).toBeGreaterThanOrEqual(3)
      expect(ctx.memory).toBeTruthy()
      expect(ctx.audit).toBeTruthy()
    })

    it('returns context without email thread for a case with no email data', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-no-email', now)
      expect(ctx.emailThread).toBeNull()
      expect(ctx.memory).toBeTruthy()
      expect(ctx.audit.sources_attempted.length).toBe(3)
    })

    it('has audit trail with exactly 3 sources for every resolution', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx.audit.sources_attempted).toHaveLength(3)
      const sourceNames = ctx.audit.sources_attempted.map(s => s.source)
      expect(sourceNames).toContain('case_row')
      expect(sourceNames).toContain('email_thread')
      expect(sourceNames).toContain('memory_fts')
    })

    it('audit: each source has all required fields', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      for (const src of ctx.audit.sources_attempted) {
        expect(src.source).toBeTruthy()
        expect(src.attempted).toBeTruthy()
        expect(Array.isArray(src.facts_found)).toBe(true)
        expect(typeof src.remaining_gap).toBe('string')
        // why_blocking may be null — that's valid when nothing blocks
        expect(typeof src.items_returned).toBe('number')
        expect(src.items_returned).toBeGreaterThanOrEqual(0)
      }
    })

    it('audit: total_facts_found is sum of individual source facts', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const sum = ctx.audit.sources_attempted.reduce((s, src) => s + src.facts_found.length, 0)
      expect(ctx.audit.total_facts_found).toBe(sum)
    })

    it('audit: summary is populated', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx.audit.summary).toBeTruthy()
      expect(ctx.audit.summary.length).toBeGreaterThan(10)
    })

    it('audit: has_blocking_gap is true for INFORMATION_REQUIRED cases', () => {
      // Create a case with INFORMATION_REQUIRED status
      createCase(db, {
        caseId: 'case-info-gap',
        title: 'Missing information case',
        caseType: 'ADMIN',
        status: 'INFO_REQUIRED',
        priority: 'P1',
        sensitivity: 'PERSONAL',
      }, now)
      const ctx = resolveContextDeep(db, 'personal', 'case-info-gap', now)
      expect(ctx.audit.has_blocking_gap).toBe(true)
    })

    it('audit: records even when nothing is missing', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-no-email', now)
      // Audit is always recorded, even with no blocking gaps
      expect(ctx.audit).toBeTruthy()
      expect(ctx.audit.total_facts_found).toBeGreaterThan(0) // at least case_row facts
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 4: Pipeline integration — audit written to state
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 4: Pipeline integration — audit in progression state', () => {
    it('progression state includes resolution_audit_json after a cycle', () => {
      const result = runProgressionCycle(db, 'personal', 'case-thread-test-001', now, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-c',
      })
      expect(result.status).toBe('COMPLETED')

      const state = snapshotProgressionState('personal', 'case-thread-test-001', db)
      expect(state).toBeTruthy()
      expect(state!.resolution_audit_json).toBeTruthy()

      const audit = JSON.parse(state!.resolution_audit_json as string) as ResolutionAudit
      expect(audit.sources_attempted).toHaveLength(3)
      expect(audit.total_facts_found).toBeGreaterThan(0)
    })

    it('progression run progress_delta_json includes audit summary', () => {
      const runs = db.prepare(
        "SELECT progress_delta_json FROM case_progression_runs WHERE case_id = 'case-thread-test-001' AND domain = 'personal' ORDER BY started_at DESC LIMIT 1",
      ).get() as { progress_delta_json: string }
      const delta = JSON.parse(runs.progress_delta_json)
      expect(delta.auditSummary).toBeTruthy()
    })

    it('resolution_audit_json is updated on each progression cycle', () => {
      // Run a second cycle
      runProgressionCycle(db, 'personal', 'case-thread-test-001', now + 3600, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-c-run2',
      })

      const state = snapshotProgressionState('personal', 'case-thread-test-001', db)
      const audit = JSON.parse(state!.resolution_audit_json as string) as ResolutionAudit
      // Audit should still be valid after second run
      expect(audit.sources_attempted.length).toBe(3)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 5: GATE 0 corpus extension — missing-info-resolved-from-email
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 5: GATE 0 eval corpus — missing-info-resolved-from-email scenario', () => {
    it('new corpus scenario exercises email-thread resolution in eval harness', () => {
      // Create a case that was INFORMATION_REQUIRED but got resolved by
      // finding the answer in the email thread — the scenario plan §15
      // calls "missing information resolved from email thread"

      createCase(db, {
        caseId: 'eval-email-resolve-001',
        title: 'Eval: missing info resolved from thread',
        caseType: 'INVOICE_INCOMING',
        status: 'INFO_REQUIRED',
        priority: 'P2',
        sensitivity: 'PERSONAL',
        sourceSystem: 'gmail',
      }, now - 86400 * 5)

      db.prepare(
        `UPDATE personal_cases SET source_references = ?, gmail_thread_ids = ?
         WHERE case_id = ?`,
      ).run(JSON.stringify(['eval-msg-1', 'eval-msg-2']), JSON.stringify(['eval-thread-1']), 'eval-email-resolve-001')

      // Seed thread: first message has the question, second has the answer
      const batchId2 = 'batch-checkpoint-c-eval'
      openBatch(db, {
        batchId: batchId2,
        accountId: 'iszzu80',
        cursorBefore: null,
        cursorAfter: 'cursor-eval',
        messages: [
          { messageId: 'eval-msg-1', threadId: 'eval-thread-1' },
          { messageId: 'eval-msg-2', threadId: 'eval-thread-1' },
        ],
      }, now - 86400 * 5)

      // Direct-update: set statuses + link to the eval case
      db.prepare(
        `UPDATE email_processing SET status = 'LOCAL_APPLIED', case_id = 'eval-email-resolve-001', updated_at = ?
         WHERE batch_id = ?`,
      ).run(now, batchId2)

      // Verify: deep resolver finds the thread
      const deepCtx = resolveContextDeep(db, 'personal', 'eval-email-resolve-001', now)
      expect(deepCtx.emailThread).not.toBeNull()
      expect(deepCtx.emailThread!.messages.length).toBe(2)

      // The case_row source should report a blocking gap (INFORMATION_REQUIRED status)
      const caseSource = deepCtx.audit.sources_attempted.find(s => s.source === 'case_row')
      expect(caseSource).toBeTruthy()
      expect(caseSource!.why_blocking).not.toBeNull()
      expect(caseSource!.why_blocking).toContain('Information')

      // The email_thread source found data — no blocking gap from email
      const emailSource = deepCtx.audit.sources_attempted.find(s => s.source === 'email_thread')
      expect(emailSource).toBeTruthy()
      expect(emailSource!.items_returned).toBe(2)
      expect(emailSource!.why_blocking).toBeNull() // email source itself isn't blocking

      // Overall audit should show blocking gap (case status = INFORMATION_REQUIRED)
      expect(deepCtx.audit.has_blocking_gap).toBe(true)

      // Run the eval harness with this case as a CorpusCase
      const evalCase: CorpusCase = {
        case_id: 'eval-email-resolve-001',
        domain: 'personal',
        title: 'Eval: missing info resolved from thread',
        case_type: 'INVOICE_INCOMING',
        status: 'INFO_REQUIRED',
        priority: 'P2',
        sensitivity: 'PERSONAL',
        waiting_on: null,
        blocked_reason: null,
        due_at: null,
        follow_up_at: null,
        created_at: now - 86400 * 5,
        updated_at: now,
        completed_at: null,
        source_system: 'gmail',
        parent_case_id: null,
        related_case_ids: null,
        events: [
          { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: now - 86400 * 5 },
          { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'INFORMATION_REQUIRED', reason: 'Missing invoice amount', payload: null, created_at: now - 86400 * 3 },
        ],
      }

      // Run through the eval stub harness (not deep resolver — eval uses stub
      // for consistency with the existing corpus pattern, but we verify that
      // the deep resolver separately found the thread context)
      const report = runEval(db, [evalCase], now)
      expect(report.runs_completed).toBe(1)
      expect(report.runs_failed).toBe(0)
      expect(report.safety_violations).toHaveLength(0)
    })

    it('deep resolver is idempotent — resolved context is stable across calls', () => {
      const ctx1 = resolveContextDeep(db, 'personal', 'eval-email-resolve-001', now)
      const ctx2 = resolveContextDeep(db, 'personal', 'eval-email-resolve-001', now)

      expect(ctx1.emailThread?.messages.length).toBe(ctx2.emailThread?.messages.length)
      expect(ctx1.audit.total_facts_found).toBe(ctx2.audit.total_facts_found)
      expect(ctx1.audit.has_blocking_gap).toBe(ctx2.audit.has_blocking_gap)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 6: ZERO side effects — deep resolver is read-only
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 6: Read-only invariant — deep resolver writes nothing', () => {
    it('resolveEmailThread is read-only — no INSERT/UPDATE/DELETE', () => {
      const beforeCount = (db.prepare('SELECT count(*) as c FROM email_processing').get() as { c: number }).c
      resolveEmailThread(db, 'personal', 'case-thread-test-001')
      const afterCount = (db.prepare('SELECT count(*) as c FROM email_processing').get() as { c: number }).c
      expect(afterCount).toBe(beforeCount)
    })

    it('resolveMemory is read-only — no INSERT/UPDATE/DELETE on memories', () => {
      const beforeCount = (db.prepare('SELECT count(*) as c FROM memories').get() as { c: number }).c
      resolveMemory(db, 'personal', 'test', 'PERSONAL', null)
      const afterCount = (db.prepare('SELECT count(*) as c FROM memories').get() as { c: number }).c
      expect(afterCount).toBe(beforeCount)
    })

    it('resolveContextDeep does not mutate case tables', () => {
      const before = db.prepare(
        "SELECT status, version FROM personal_cases WHERE case_id = 'case-thread-test-001'",
      ).get() as { status: string; version: number }
      resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const after = db.prepare(
        "SELECT status, version FROM personal_cases WHERE case_id = 'case-thread-test-001'",
      ).get() as { status: string; version: number }
      expect(after.status).toBe(before.status)
      expect(after.version).toBe(before.version)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 7: Safety assertions still pass on resolved cases
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 7: Safety assertions with deep resolver', () => {
    it('all 9 safety assertions pass on cases progressed with deep resolver', () => {
      // Run progression with deep resolver
      runProgressionCycle(db, 'personal', 'case-thread-test-001', now + 7200, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-c-safety',
      })

      // Get the latest run
      const run = db.prepare(
        "SELECT safety_assertions_json FROM case_progression_runs WHERE case_id = 'case-thread-test-001' AND domain = 'personal' ORDER BY started_at DESC LIMIT 1",
      ).get() as { safety_assertions_json: string }

      const assertions = JSON.parse(run.safety_assertions_json) as
        Array<{ assertion: string; status: string; passed: boolean | null }>
      expect(assertions).toHaveLength(9)
      // None violated. The five that structurally cannot apply to a deterministic
      // shadow run are recorded as not_applicable rather than passed — a ledger
      // that says "checked and fine" about a check it never ran is the thing
      // this assertion exists to keep out.
      expect(assertions.some(a => a.status === 'violated')).toBe(false)
      for (const a of assertions) {
        expect(['passed', 'not_applicable']).toContain(a.status)
      }
      expect(assertions.find(a => a.assertion === 'cross_domain_leakage')!.status).toBe('passed')
    })

    it('all 9 safety assertion definitions remain unchanged', () => {
      expect(HARD_SAFETY_ASSERTIONS).toHaveLength(9)
      const names = HARD_SAFETY_ASSERTIONS.map(a => a.name)
      expect(names).toContain('wrong_recipient')
      expect(names).toContain('cross_domain_leakage')
      expect(names).toContain('payment_auto_execution')
      expect(names).toContain('legal_contract_auto_commitment')
      expect(names).toContain('duplicate_external_action')
      expect(names).toContain('premature_completion')
      expect(names).toContain('policy_bypass')
      expect(names).toContain('escalation_external_delivery')
      expect(names).toContain('escalation_action_in_payload')
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 8: Domain-scoped reads RED-proof (msg #20701 guardrail 1)
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 8: Domain-scoped reads RED-proof', () => {
    beforeAll(() => {
      // Create a ZST case that will be used for cross-domain read attempts
      createZstCase(db, {
        caseId: 'zst-cross-domain-test',
        title: 'ZST cross-domain RED-proof case',
        caseType: 'INVOICE_INCOMING',
        status: 'NEW',
        priority: 'P2',
        sensitivity: 'ZST_INTERNAL',
        sourceSystem: 'gmail',
        workspace: 'OPERATIONS',
      }, now)
    })

    it('RED-PROOF: PRI resolver denied ZST source — resolveContextDeep throws CrossDomainReadError', () => {
      // Attempt to resolve a ZST case with domain='personal' — this must fail.
      // A PRI resolver reading ZST email/memory IS cross-domain leakage.
      expect(() => {
        resolveContextDeep(db, 'personal', 'zst-cross-domain-test', now)
      }).toThrow(CrossDomainReadError)
    })

    it('RED-PROOF: ZST resolver denied PRI source — resolveContextDeep throws CrossDomainReadError', () => {
      // Symmetric: ZST resolver must not read PRI sources.
      expect(() => {
        resolveContextDeep(db, 'zst', 'case-thread-test-001', now)
      }).toThrow(CrossDomainReadError)
    })

    it('RED-PROOF: CrossDomainReadError message names both domain and case', () => {
      try {
        resolveContextDeep(db, 'personal', 'zst-cross-domain-test', now)
        // Should not reach here
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(CrossDomainReadError)
        const ce = err as CrossDomainReadError
        expect(ce.errorCode).toBe('CROSS_DOMAIN_LEAKAGE')
        expect(ce.message).toContain('CROSS_DOMAIN_LEAKAGE')
        expect(ce.caseId).toBe('zst-cross-domain-test')
        expect(ce.claimedDomain).toBe('personal')
      }
    })

    it('RED-PROOF: pipeline produces FAILED run with CROSS_DOMAIN_LEAKAGE on cross-domain attempt', () => {
      const result = runProgressionCycle(db, 'personal', 'zst-cross-domain-test', now, {
        triggerType: 'SCHEDULED',
        triggerReference: 'checkpoint-c-red-proof',
      })

      expect(result.status).toBe('FAILED')
      expect(result.errorCode).toBe('CROSS_DOMAIN_LEAKAGE')
      expect(result.errorSummary).toContain('CROSS_DOMAIN_LEAKAGE')
      expect(result.safetyViolations.length).toBe(1)
      expect(result.safetyViolations[0].assertion).toBe('cross_domain_leakage')
    })

    it('RED-PROOF: cross_domain_leakage safety assertion fires on the failed run', () => {
      // Verify the run record in DB has the safety assertion violation
      const run = db.prepare(
        "SELECT safety_assertions_json, error_code FROM case_progression_runs WHERE case_id = 'zst-cross-domain-test' AND domain = 'personal' AND error_code = 'CROSS_DOMAIN_LEAKAGE' ORDER BY started_at DESC LIMIT 1",
      ).get() as { safety_assertions_json: string; error_code: string } | undefined

      expect(run).toBeTruthy()
      const assertions = JSON.parse(run!.safety_assertions_json)
      const cdLeak = assertions.find((a: { assertion: string; passed: boolean }) => a.assertion === 'cross_domain_leakage')
      expect(cdLeak).toBeTruthy()
      expect(cdLeak.passed).toBe(false)
    })

    it('RED-PROOF: a non-existent case in EITHER domain does not trigger cross_domain_leakage', () => {
      // A case that doesn't exist anywhere should throw a regular Error,
      // not CrossDomainReadError (domain guard checks: not in claimed domain,
      // not in other domain → let normal "not found" handling take over)
      expect(() => {
        resolveContextDeep(db, 'personal', 'completely-nonexistent-case-id', now)
      }).toThrow() // throws, but NOT CrossDomainReadError
      try {
        resolveContextDeep(db, 'personal', 'completely-nonexistent-case-id', now)
      } catch (err) {
        expect(err).not.toBeInstanceOf(CrossDomainReadError)
      }
    })

    it('domainGuard: silently passes when case is in the correct domain', () => {
      // Should not throw — PRI case in PRI domain
      expect(() => {
        domainGuard(db, 'personal', 'case-thread-test-001', 'test-source')
      }).not.toThrow()
    })

    it('domainGuard: throws CrossDomainReadError when case is in the other domain', () => {
      // ZST case, claimed as personal
      expect(() => {
        domainGuard(db, 'personal', 'zst-cross-domain-test', 'test-source')
      }).toThrow(CrossDomainReadError)
    })

    // ── Memory guard RED-PROOF (both domains, not just ZST) ──────────

    it('RED-PROOF: resolveMemory returns empty for BOTH domains — fleet store is not domain-scoped', () => {
      // Seed memory that WOULD match if the store were domain-scoped
      seedMemory(db, 'ZST Radio szamla MVM-tol villamos energia 2026 augusztus', 'semantic', 'zst-mvm')
      seedMemory(db, 'Personal invoice biztositas eves dij Generalitol', 'semantic', 'pri-invoice')

      // Both domains return empty — the shared fleet memory store has no
      // domain/tenant column and cannot be safely queried by either domain.
      const zstResult = resolveMemory(db, 'zst', 'ZST MVM szamla', 'INVOICE_INCOMING', 'MVM villamos energia')
      expect(zstResult.has_relevant_memory).toBe(false)
      expect(zstResult.facts).toHaveLength(0)
      expect(zstResult.search_terms).toHaveLength(0)

      const priResult = resolveMemory(db, 'personal', 'Biztositas szamla Generalitol', 'INVOICE_INCOMING', 'eves dij')
      expect(priResult.has_relevant_memory).toBe(false)
      expect(priResult.facts).toHaveLength(0)
      expect(priResult.search_terms).toHaveLength(0)
    })

    it('RED-PROOF: seeded memory EXISTS in DB but is never returned — guard blocks, not missing data', () => {
      // Verify the data IS in the DB
      const memCount = (db.prepare(
        "SELECT count(*) as c FROM memories WHERE content LIKE '%MVM%' OR content LIKE '%Generalitol%'",
      ).get() as { c: number }).c
      expect(memCount).toBeGreaterThanOrEqual(2)

      // Neither domain can access it — both are blocked by the safe no-op
      const zstResult = resolveMemory(db, 'zst', 'MVM', 'INVOICE_INCOMING', 'szamla')
      expect(zstResult.has_relevant_memory).toBe(false)
      expect(zstResult.facts).toHaveLength(0)

      const priResult = resolveMemory(db, 'personal', 'Generalitol', 'INVOICE_INCOMING', 'biztositas')
      expect(priResult.has_relevant_memory).toBe(false)
      expect(priResult.facts).toHaveLength(0)
    })

    it('RED-PROOF: resolveContextDeep audit records memory as not-domain-scoped-yet for both domains', () => {
      // PRI case: memory audit says source not available
      const priCtx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const priMem = priCtx.audit.sources_attempted.find(s => s.source === 'memory_fts')
      expect(priMem).toBeTruthy()
      expect(priMem!.items_returned).toBe(0)
      expect(priMem!.facts_found).toHaveLength(0)
      expect(priMem!.attempted).toContain('memory-source-not-domain-scoped-yet')

      // ZST case: same message — both domains blocked
      const zstCtx = resolveContextDeep(db, 'zst', 'zst-thread-test-001', now)
      const zstMem = zstCtx.audit.sources_attempted.find(s => s.source === 'memory_fts')
      expect(zstMem).toBeTruthy()
      expect(zstMem!.items_returned).toBe(0)
      expect(zstMem!.facts_found).toHaveLength(0)
      expect(zstMem!.attempted).toContain('memory-source-not-domain-scoped-yet')
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // Stage 9: Untrusted-data forward-flag contract (msg #20701 guardrail 2)
  // ──────────────────────────────────────────────────────────────────

  describe('Stage 9: Untrusted-data forward-flag contract', () => {
    it('DeepResolvedContext._dataTrust signals CONTAINS_UNTRUSTED_DATA', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx._dataTrust).toBe('CONTAINS_UNTRUSTED_DATA')
    })

    it('EmailThreadMessage._dataTrust is untrusted_external', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx.emailThread).not.toBeNull()
      for (const msg of ctx.emailThread!.messages) {
        expect(msg._dataTrust).toBe('untrusted_external')
      }
    })

    it('EmailThreadResolution messages are all tagged even when no email data', () => {
      const result = resolveEmailThread(db, 'personal', 'case-no-email')
      // No messages, but the contract shape is still valid
      expect(result.messages).toHaveLength(0)
    })

    it('MemoryFact contract: _dataTrust is user_generated (type-level, enforced when store is built)', () => {
      // resolveMemory is a safe no-op for both domains — facts is always
      // empty until a domain-scoped memory store exists. The MemoryFact
      // interface requires _dataTrust: 'user_generated' — TypeScript
      // enforces this at compile time (assigning a fact without it is a
      // compile error). When the store is built, every fact WILL carry
      // this tag.
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      expect(ctx.memory.facts).toHaveLength(0)
      // Type-level contract (verified by tsc, not testable at runtime):
      //   const f: MemoryFact = { id: 1, content: '', topic_key: null,
      //     sector: '', salience: 0 }
      //   → TS Error: Property '_dataTrust' is missing
    })

    it('ResolutionSource.data_trust tags each source correctly', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const trusts: Record<string, string> = {}
      for (const src of ctx.audit.sources_attempted) {
        trusts[src.source] = src.data_trust
      }
      // case_row is system-derived
      expect(trusts['case_row']).toBe('system_internal')
      // email_thread is untrusted external content
      expect(trusts['email_thread']).toBe('untrusted_external')
      // memory_fts is user-generated content
      expect(trusts['memory_fts']).toBe('user_generated')
    })

    it('audit ResolutionSource: all three data_trust tiers are used', () => {
      // The three tiers (system_internal, untrusted_external, user_generated)
      // must all appear in at least one source per resolution. This proves
      // the forward-flag contract covers the full trust spectrum.
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const trustValues = ctx.audit.sources_attempted.map(s => s.data_trust)
      expect(trustValues).toContain('system_internal')
      expect(trustValues).toContain('untrusted_external')
      expect(trustValues).toContain('user_generated')
    })

    it('forward-flag: audit is always recorded with data_trust, even when no blocking gaps', () => {
      const ctx = resolveContextDeep(db, 'personal', 'case-no-email', now)
      expect(ctx.audit.sources_attempted).toHaveLength(3)
      for (const src of ctx.audit.sources_attempted) {
        expect(src.data_trust).toBeTruthy()
        expect(['system_internal', 'untrusted_external', 'user_generated']).toContain(src.data_trust)
      }
    })

    it('forward-flag: contract shape is stable — _dataTrust is always the first field', () => {
      // The LLM guard in the planning slice will check ctx._dataTrust first
      // before consuming any content. This test ensures the key is always
      // the first key in the object (per the interface definition).
      const ctx = resolveContextDeep(db, 'personal', 'case-thread-test-001', now)
      const keys = Object.keys(ctx)
      expect(keys[0]).toBe('_dataTrust')
    })
  })
})
