// P3 — the progress stage, derived from status and never replacing it.
//
// The owner's constraint: "P3-ban ne próbáld a meglévő 9-10 státuszt négyre
// összevonni." So these tests check two things that pull in opposite directions:
// that EVERY status has a stage, and that NO status lost its identity to one.
//
// The acceptance criterion is unusually specific about method, and it is the
// reason this file exists in the shape it does:
//
//   "proven by a test that reads the LIVE status vocabulary rather than a
//    hard-coded list, so a new status added later fails loudly instead of
//    silently becoming unmapped"
//   "the mapping is derived from the code that defines the statuses, not from a
//    document"
//
// A `Record<CaseStatus, ProgressStage>` already makes the compiler refuse an
// unmapped status. That is the strongest guard and it costs nothing at runtime --
// but it only checks the map against the TYPESCRIPT union. The DATABASE enforces
// its own CHECK constraint, and those two are different artefacts that can drift.
// So the headline tests below read the constraint out of `sqlite_master` and
// compare against the map: the one place a hard-coded list could still hide.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { projectCase } from '../cos/case-projection.js'
import { CASE_STATUSES, ZST_CASE_STATUSES } from '../cos/schema.js'
import {
  PROGRESS_STAGES, PERSONAL_STAGE, ZST_STAGE, stageFor, statusVocabulary,
  stageForCase, deriveStage, type CaseDomain,
} from '../cos/progress-stage.js'
import { armWaitCondition } from '../cos/wait-condition.js'

const NOW = 1_700_000_000

/** The status vocabulary the DATABASE will actually accept, parsed out of the
 *  live CHECK constraint. Deliberately not imported from anywhere: the point is
 *  to compare the map against something that is NOT another copy of the map. */
function liveVocabulary(table: string): string[] {
  const ddl = (getDb().prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table) as { sql: string }).sql
  const m = /status[^,]*?IN\s*\(([^)]*)\)/is.exec(ddl)
  if (!m) throw new Error(`no status CHECK found on ${table}`)
  return m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describe('P3 — every LIVE status maps to exactly one stage', () => {
  beforeEach(() => { initDatabase(':memory:') })

  for (const [domain, table] of [
    ['personal', 'personal_cases'], ['zst', 'zst_cases'],
  ] as Array<[CaseDomain, string]>) {
    it(`HEADLINE (${domain}): the live CHECK vocabulary is fully mapped`, () => {
      const live = liveVocabulary(table)
      expect(live.length).toBeGreaterThan(10)   // it parsed something real
      const unmapped = live.filter(s => stageFor(domain, s) === null)
      expect(unmapped).toEqual([])
      // ...and every mapped value is a declared stage, not free text.
      for (const s of live) expect(PROGRESS_STAGES).toContain(stageFor(domain, s)!)
    })

    it(`(${domain}) the code vocabulary and the live constraint are the SAME set`, () => {
      // The drift this catches: adding a status to the TypeScript union without
      // the CHECK, or to the CHECK without the union. Either way the map would
      // look total against one artefact and be missing a value against the
      // other, and only one of the two decides what a row may contain.
      expect([...statusVocabulary(domain)].sort()).toEqual(liveVocabulary(table).sort())
    })
  }

  it('a status NOT in the vocabulary gets null, never a plausible stage', () => {
    // The counter-case for the two above. A lookup with a default would make an
    // unmapped status indistinguishable from a deliberately-ACTIONABLE one, and
    // both headline tests would still pass.
    expect(stageFor('personal', '__NO_SUCH_STATUS__')).toBeNull()
    expect(stageFor('zst', '__NO_SUCH_STATUS__')).toBeNull()
    expect(stageFor('personal', 'TRIAGE_REQUIRED')).toBeNull()   // ZST spelling
    expect(stageFor('zst', 'TRIAGE')).toBeNull()                 // personal spelling
  })
})

describe('P3 — derive, do NOT replace', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the statuses are untouched: 17 personal, 21 ZST, all still distinct', () => {
    // The owner's actual instruction. A packet that quietly collapsed the
    // vocabulary would pass every mapping test above.
    expect(CASE_STATUSES).toHaveLength(17)
    expect(ZST_CASE_STATUSES).toHaveLength(21)
    expect(new Set(CASE_STATUSES).size).toBe(17)
    expect(new Set(ZST_CASE_STATUSES).size).toBe(21)
  })

  it('the stage is coarser than the status, and provably so', () => {
    // If every stage had exactly one status the mapping would be a rename, and
    // if every status mapped to one stage it would be a collapse. Neither.
    expect(new Set(Object.values(PERSONAL_STAGE)).size).toBeGreaterThan(1)
    expect(new Set(Object.values(PERSONAL_STAGE)).size).toBeLessThan(CASE_STATUSES.length)
    expect(new Set(Object.values(ZST_STAGE)).size).toBeGreaterThan(1)
    expect(new Set(Object.values(ZST_STAGE)).size).toBeLessThan(ZST_CASE_STATUSES.length)
  })

  it('the two namespaces are mapped separately, not by name-matching', () => {
    // ZST's REVIEW_REQUIRED and AWAITING_INTERNAL_INPUT have no personal
    // counterpart at all. A shared string-keyed table would have to invent one.
    expect(stageFor('zst', 'REVIEW_REQUIRED')).toBe('NEEDS_USER')
    expect(stageFor('zst', 'AWAITING_INTERNAL_INPUT')).toBe('NEEDS_USER')
    expect(stageFor('personal', 'REVIEW_REQUIRED')).toBeNull()
  })

  it('the two judgement calls are pinned, so a later edit is deliberate', () => {
    // BLOCKED is NEEDS_USER: stopped on something waiting cannot clear.
    expect(stageFor('personal', 'BLOCKED')).toBe('NEEDS_USER')
    // RECOVERY_REQUIRED is ACTIONABLE: §19's "a system fault must not read as
    // 'needs Istvan'". It reaches him through the recovery queue instead.
    expect(stageFor('personal', 'RECOVERY_REQUIRED')).toBe('ACTIONABLE')
    expect(stageFor('zst', 'FAILED_RECOVERABLE')).toBe('ACTIONABLE')
    expect(stageFor('zst', 'FAILED_TERMINAL')).toBe('COMPLETED')
  })
})

describe('P3 — the stage reaches the board', () => {
  beforeEach(() => { initDatabase(':memory:') })

  /** A case with a next action, so ACTIONABLE is reachable and the other stages
   *  are therefore a genuine override rather than the only available answer. */
  function boardCase(status: string): void {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    db.prepare(`UPDATE personal_cases SET status=? WHERE case_id='c1'`).run(status)
    db.prepare(
      `UPDATE case_progression_state SET next_best_action_json=?
        WHERE domain='personal' AND case_id='c1'`,
    ).run(JSON.stringify({ kind: 'EXECUTE', planStep: 2, description: 'do it' }))
  }
  const boardStage = (table = 'personal_cases', id = 'c1'): string | null => (getDb().prepare(
    `SELECT proj_progress_stage AS s FROM ${table} WHERE case_id=?`,
  ).get(id) as { s: string | null }).s

  it('a real projection writes the stage the FACTS imply', () => {
    // Rewritten for the closure. It used to assert WAITING for a
    // WAITING_EXTERNAL status with no wait armed -- which is precisely the
    // status-is-the-only-input error the owner sent it back for.
    boardCase('WAITING_EXTERNAL')
    projectCase(getDb(), 'personal', 'c1', NOW)
    expect(boardStage()).toBe('ACTIONABLE')          // no typed wait exists yet
  })

  it('arming a wait moves the BOARD, with the status untouched', () => {
    boardCase('WAITING_EXTERNAL')
    const db = getDb()
    projectCase(db, 'personal', 'c1', NOW)
    expect(boardStage()).toBe('ACTIONABLE')

    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE',
      subject: 'reply', expectedBy: NOW + 86400, runId: 'r1',
    }, NOW)
    projectCase(db, 'personal', 'c1', NOW + 10)
    expect(boardStage()).toBe('WAITING')
    // ...and the business status is exactly what it was. Derive, do not replace.
    expect((db.prepare(
      `SELECT status FROM personal_cases WHERE case_id='c1'`,
    ).get() as { status: string }).status).toBe('WAITING_EXTERNAL')
  })

  it('the ZST board derives from ZST facts', () => {
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'T', caseType: 'VENDOR' }, NOW - 100)
    seedCaseProgressionState(db, 'zst', 'z1', NOW - 100)
    db.prepare(`UPDATE zst_cases SET status='AWAITING_INTERNAL_INPUT' WHERE case_id='z1'`).run()
    db.prepare(
      `UPDATE case_progression_state SET next_best_action_json=?
        WHERE domain='zst' AND case_id='z1'`,
    ).run(JSON.stringify({ kind: 'EXECUTE', planStep: 2, description: 'do it' }))
    projectCase(db, 'zst', 'z1', NOW)
    // The status carries "somebody inside ZST owes an answer", and no other fact
    // outranks it -- so here the status IS the deciding input, which is allowed:
    // one input, not the only one.
    expect(boardStage('zst_cases', 'z1')).toBe('NEEDS_USER')
  })
})

// ── P3 CLOSURE: the stage is the FACTS, not the status ──────────────────────
//
// Owner, 2026-08-27: "progress_stage ne kizárólag status leképezése legyen. A
// stage a canonical progression facts összegzett állapota legyen. A status lehet
// egyik bemenet, de nem az egyetlen."
//
// My first version was a pure status table. It passed every test I wrote and was
// wrong in a way those tests could not see: two cases with the SAME status are
// not in the same place if one has an active wait and the other does not. His
// five counter-examples are below, in his order, and the first three are the
// same status three times.
describe('P3 closure — same status, different facts, different stage', () => {
  beforeEach(() => { initDatabase(':memory:') })

  /** A personal case in a business status, with a next action so ACTIONABLE is
   *  reachable at all. Everything else is added per-test. */
  function caseWithAction(status: string): void {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    db.prepare(`UPDATE personal_cases SET status=? WHERE case_id='c1'`).run(status)
    db.prepare(
      `UPDATE case_progression_state SET next_best_action_json=?
        WHERE domain='personal' AND case_id='c1'`,
    ).run(JSON.stringify({ kind: 'EXECUTE', planStep: 2, description: 'do the thing' }))
  }

  it('COUNTER-EXAMPLE 1: the status alone, no typed wait -> ACTIONABLE', () => {
    caseWithAction('EXECUTING')
    expect(stageForCase(getDb(), 'personal', 'c1', NOW)).toBe('ACTIONABLE')
  })

  it('COUNTER-EXAMPLE 2: the SAME status with an active typed wait -> WAITING', () => {
    caseWithAction('EXECUTING')
    armWaitCondition(getDb(), {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE',
      subject: 'reply from someone', expectedBy: NOW + 86400, runId: 'r1',
    }, NOW)
    expect(stageForCase(getDb(), 'personal', 'c1', NOW)).toBe('WAITING')
  })

  it('COUNTER-EXAMPLE 3: the SAME status with an unanswered owner question -> NEEDS_USER', () => {
    caseWithAction('EXECUTING')
    const db = getDb()
    db.prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at)
       VALUES ('c1','personal','h1','Melyiket válasszuk?', ?)`,
    ).run(NOW)
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBe('NEEDS_USER')
  })

  it('COUNTER-EXAMPLE 3b: and an OPEN escalation does the same', () => {
    caseWithAction('EXECUTING')
    const db = getDb()
    db.prepare(
      `INSERT INTO case_escalations
        (escalation_id, domain, case_id, trigger_reason, escalation_level, summary,
         resolution_status, created_at)
       VALUES ('e1','personal','c1','DECISION','L2_BLOCKED','kell egy döntés','OPEN', ?)`,
    ).run(NOW)
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBe('NEEDS_USER')
  })

  it('COUNTER-EXAMPLE 4: a terminal-looking status WITHOUT evidence is not COMPLETED', () => {
    // The owner's words: "terminal-looking status completion evidence nélkül ne
    // legyen automatikusan COMPLETED". It becomes NEEDS_USER, because a case
    // claiming a completion it cannot show is exactly what a person must look at.
    caseWithAction('COMPLETED')
    const stage = stageForCase(getDb(), 'personal', 'c1', NOW)
    expect(stage).not.toBe('COMPLETED')
    expect(stage).toBe('NEEDS_USER')
  })

  it('COUNTER-EXAMPLE 5: NEEDS_HUMAN recovery outranks a RECOVERY_REQUIRED status', () => {
    // "recovery NEEDS_HUMAN esetén ne tudjon a case projection ACTIONABLE-nak
    // látszani pusztán azért, mert a business status RECOVERY_REQUIRED."
    //
    // The detailed recovery surface stays the source of truth for WHAT is stuck;
    // the case stage must simply not contradict it.
    caseWithAction('RECOVERY_REQUIRED')
    const db = getDb()
    // Control first: without a NEEDS_HUMAN row this status IS actionable, so the
    // assertion below measures the recovery fact and not the status.
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBe('ACTIONABLE')

    db.prepare(
      `INSERT INTO cos_recovery_queue
        (queue_id, surface, ref, case_id, status, pending_action, idempotency_key,
         last_known_outcome, retry_class, attempt_count, max_attempts,
         escalate_after_attempts, created_at, updated_at)
       VALUES ('q-h','INGEST','acc/m1','c1','NEEDS_HUMAN','HUMAN_VERIFY','acc/m1',
         'RECOVERY_REQUIRED','INGEST_LOCAL_APPLY', 3, 5, 3, ?, ?)`,
    ).run(NOW, NOW)
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBe('NEEDS_USER')
  })

  it('a NON-retryable capability wait is NEEDS_USER, not WAITING', () => {
    // No probe will ever end it -- a disabled connector or an unknown capability
    // name is a deployment fault only a person clears. Calling it WAITING would
    // file it under "the world owes an answer" for ever.
    caseWithAction('EXECUTING')
    armWaitCondition(getDb(), {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: CONNECTOR_WRITE:gmail',
      expectedBy: NOW + 86400, runId: 'r1',
      capability: { capability: 'CONNECTOR_WRITE:gmail', action: 'send', retryable: false },
    }, NOW)
    expect(stageForCase(getDb(), 'personal', 'c1', NOW)).toBe('NEEDS_USER')
  })

  it('a RETRYABLE capability wait is WAITING -- the control for the line above', () => {
    caseWithAction('EXECUTING')
    armWaitCondition(getDb(), {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: CONNECTOR:gmail',
      expectedBy: NOW + 900, runId: 'r1',
      capability: { capability: 'CONNECTOR:gmail', action: 'read', retryable: true },
    }, NOW)
    expect(stageForCase(getDb(), 'personal', 'c1', NOW)).toBe('WAITING')
  })

  it('no next action, nothing owed, nothing waiting -> null, never ACTIONABLE', () => {
    // A case the engine has nothing to say about. An empty cell is the honest
    // answer; ACTIONABLE would be a claim that something can be done.
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    db.prepare(`UPDATE personal_cases SET status='READY' WHERE case_id='c1'`).run()
    db.prepare(
      `UPDATE case_progression_state SET next_best_action_json=NULL
        WHERE domain='personal' AND case_id='c1'`,
    ).run()
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBeNull()
  })

  it('CANCELLED is COMPLETED without any DoD evidence -- abandoning is not completing', () => {
    caseWithAction('CANCELLED')
    expect(stageForCase(getDb(), 'personal', 'c1', NOW)).toBe('COMPLETED')
  })

  it('the precedence is honoured when several facts are true at once', () => {
    // Owner decision AND an active wait: his order puts NEEDS_USER first, and it
    // has to, or a case blocked on him would hide behind a wait he cannot end.
    caseWithAction('EXECUTING')
    const db = getDb()
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE',
      subject: 'reply', expectedBy: NOW + 86400, runId: 'r1',
    }, NOW)
    db.prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at)
       VALUES ('c1','personal','h2','?', ?)`,
    ).run(NOW)
    expect(stageForCase(db, 'personal', 'c1', NOW)).toBe('NEEDS_USER')
  })
})
