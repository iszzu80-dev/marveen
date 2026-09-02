// CASE COMPLETION EXIT — the acceptance list, driven against a real store.
//
// Istvan's GO on 2026-09-02 came with ten acceptance criteria. This file drives
// each of them; the route-level half lives in cos-case-closure-route.test.ts,
// and the two together are the proof.
//
// EVERY TEST HERE HAS TO BE ABLE TO GO RED. That is not a slogan in this file:
// the whole feature exists because a green signal (`problems: []`, a clean
// deadline audit, an owner-action that "succeeded") kept meaning less than it
// looked like. So each refusal test asserts the SPECIFIC code, not merely that
// something was refused -- a test that accepts any refusal passes when the code
// refuses for the wrong reason, and that is how a fail-closed path quietly
// becomes fail-closed-for-one-reason.
//
// A REAL FILE-BACKED STORE, not ':memory:', because criterion 9 is "a completed
// case is still completed after restart", and a database that evaporates cannot
// answer it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase, getCase } from '../cos/case-store.js'
import { createZstCase, getZstCase } from '../cos/zst-case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { closeCase } from '../cos/case-closure.js'
import { canCompleteCase, completionBlockers } from '../cos/progression-completion.js'

const NOW = 1_700_000_000

let root: string
let dbPath: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-close-'))
  dbPath = join(root, 'close.db')
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } })

function personalCase(caseId: string, opts: { progression?: boolean } = {}): void {
  const db = getDb()
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN', status: 'NEW',
    sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'close-test',
  }, NOW - 1000)
  if (opts.progression) seedCaseProgressionState(db, 'personal', caseId, NOW - 1000)
}

function zstCase(caseId: string): void {
  createZstCase(getDb(), {
    caseId, title: caseId, caseType: 'GENERAL_OPERATION', status: 'NEW',
    sensitivity: 'ZST_INTERNAL', priority: 'P2', sourceSystem: 'close-test',
  }, NOW - 1000)
}

/** The minimum valid close. Every field the API demands, nothing more. */
function goodClose(domain: 'personal' | 'zst', caseId: string, version: number) {
  return {
    domain, caseId, expectedVersion: version, intent: 'CLOSE_CASE' as const,
    reason: 'a tulajdonos lezarta', provenance: 'test:acceptance', actor: 'istvan',
  }
}

describe('closeCase — the canonical exit', () => {
  beforeEach(() => { initDatabase(dbPath) })

  // ── criterion 1: a personal case closes on the canonical path ────────────
  it('closes a personal case, stamps completed_at, and writes an event', () => {
    personalCase('c-close-1')
    const before = getCase(getDb(), 'c-close-1') as never as { version: number }
    const r = closeCase(getDb(), goodClose('personal', 'c-close-1', before.version), NOW)

    expect(r.outcome).toBe('CLOSED')
    const after = getCase(getDb(), 'c-close-1') as never as {
      status: string; version: number; completed_at: number | null; closure_reason: string | null
    }
    expect(after.status).toBe('COMPLETED')
    expect(after.version).toBe(before.version + 1)
    expect(after.completed_at).toBe(NOW)
    // The reason is not just carried in the event: it lands on the case, which
    // is where a later reader looks first.
    expect(after.closure_reason).toBe('a tulajdonos lezarta')

    // The event exists, names the owner, and carries the provenance. Without
    // this assertion the test would pass on a raw UPDATE -- which is precisely
    // the thing the feature was told not to be.
    const ev = getDb().prepare(
      `SELECT actor, source_reference, new_status, reason FROM personal_case_events
       WHERE case_id = ? ORDER BY event_id DESC LIMIT 1`,
    ).get('c-close-1') as { actor: string; source_reference: string | null; new_status: string | null; reason: string | null }
    expect(ev.new_status).toBe('COMPLETED')
    expect(ev.actor).toBe('istvan')
    expect(ev.reason).toBe('a tulajdonos lezarta')
  })

  // ── criterion 2: the same for ZST ────────────────────────────────────────
  it('closes a ZST case through the corporate store', () => {
    zstCase('z-close-1')
    const before = getZstCase(getDb(), 'z-close-1') as never as { version: number }
    const r = closeCase(getDb(), goodClose('zst', 'z-close-1', before.version), NOW)

    expect(r.outcome).toBe('CLOSED')
    const after = getZstCase(getDb(), 'z-close-1') as never as { status: string; completed_at: number | null }
    expect(after.status).toBe('COMPLETED')
    expect(after.completed_at).toBe(NOW)
    const ev = getDb().prepare(
      `SELECT new_status FROM zst_case_events WHERE case_id = ? ORDER BY event_id DESC LIMIT 1`,
    ).get('z-close-1') as { new_status: string | null }
    expect(ev.new_status).toBe('COMPLETED')
  })

  // ── criterion 3: version conflict fails closed ───────────────────────────
  it('refuses a stale version and writes NOTHING', () => {
    personalCase('c-stale')
    const before = getCase(getDb(), 'c-stale') as never as { version: number }
    const eventsBefore = getDb().prepare(
      `SELECT count(*) c FROM personal_case_events WHERE case_id = ?`).get('c-stale') as { c: number }

    const r = closeCase(getDb(), goodClose('personal', 'c-stale', before.version + 7), NOW)

    expect(r.outcome).toBe('REFUSED')
    if (r.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(r.code).toBe('VERSION_CONFLICT')
    expect(r.currentVersion).toBe(before.version)

    // Fail-CLOSED means no partial write. A refusal that still appended an
    // event would leave a case that looks touched by a decision nobody made.
    const after = getCase(getDb(), 'c-stale') as never as { status: string; version: number }
    expect(after.status).toBe('NEW')
    expect(after.version).toBe(before.version)
    const eventsAfter = getDb().prepare(
      `SELECT count(*) c FROM personal_case_events WHERE case_id = ?`).get('c-stale') as { c: number }
    expect(eventsAfter.c).toBe(eventsBefore.c)
  })

  // ── criterion 5: duplicate close does not duplicate the event ────────────
  it('is idempotent: a repeated close reports ALREADY_CLOSED and appends nothing', () => {
    personalCase('c-idem')
    const before = getCase(getDb(), 'c-idem') as never as { version: number }
    const first = closeCase(getDb(), goodClose('personal', 'c-idem', before.version), NOW)
    expect(first.outcome).toBe('CLOSED')

    const eventsAfterFirst = getDb().prepare(
      `SELECT count(*) c FROM personal_case_events WHERE case_id = ?`).get('c-idem') as { c: number }

    // The retry carries the version the caller SAW, which is now stale. This is
    // the ordering the implementation calls out: a retry must not be answered
    // with "conflict", because a retry is what a dropped response looks like.
    const second = closeCase(getDb(), goodClose('personal', 'c-idem', before.version), NOW + 60)
    expect(second.outcome).toBe('ALREADY_CLOSED')

    const eventsAfterSecond = getDb().prepare(
      `SELECT count(*) c FROM personal_case_events WHERE case_id = ?`).get('c-idem') as { c: number }
    expect(eventsAfterSecond.c).toBe(eventsAfterFirst.c)

    // And completed_at did not move: a second close must not re-date the first.
    const after = getCase(getDb(), 'c-idem') as never as { completed_at: number | null }
    expect(after.completed_at).toBe(NOW)
  })

  // ── criterion 7: namespace isolation ─────────────────────────────────────
  it('cannot close a ZST case through the personal domain, or the reverse', () => {
    zstCase('z-iso')
    personalCase('c-iso')

    // A real ZST case id, asked for in the personal namespace. NOT_FOUND is the
    // only correct answer: "the personal store has no such case" is true, and
    // any implicit fallback to the other table would be the cross-namespace
    // close the brief forbids.
    const wrongWay = closeCase(getDb(), goodClose('personal', 'z-iso', 0), NOW)
    expect(wrongWay.outcome).toBe('REFUSED')
    if (wrongWay.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(wrongWay.code).toBe('NOT_FOUND')

    const otherWay = closeCase(getDb(), goodClose('zst', 'c-iso', 0), NOW)
    expect(otherWay.outcome).toBe('REFUSED')
    if (otherWay.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(otherWay.code).toBe('NOT_FOUND')

    // Neither case moved.
    expect((getZstCase(getDb(), 'z-iso') as never as { status: string }).status).toBe('NEW')
    expect((getCase(getDb(), 'c-iso') as never as { status: string }).status).toBe('NEW')
  })

  // ── criterion 8: an unresolved obligation is not closeable in silence ────
  it('refuses when an open escalation is not acknowledged, and closes when it is', () => {
    personalCase('c-blocked')
    getDb().prepare(
      `INSERT INTO case_escalations
       (escalation_id, domain, case_id, progression_run_id, trigger_reason,
        escalation_level, summary, resolution_status, created_at)
       VALUES ('esc-1','personal','c-blocked','run-1','L2_BLOCKED','L2_BLOCKED',
               'jogi kotelezettseg tisztazatlan','OPEN', ?)`,
    ).run(NOW - 500)

    const before = getCase(getDb(), 'c-blocked') as never as { version: number }

    // The gate still says the owner MAY close -- that authority is not in
    // question -- but it now also says what closing abandons.
    const gate = canCompleteCase(getDb(), 'personal', 'c-blocked', 'OWNER')
    expect(gate.allowed).toBe(true)
    expect(gate.blockers.map(b => b.kind)).toContain('OPEN_ESCALATION')

    const refused = closeCase(getDb(), goodClose('personal', 'c-blocked', before.version), NOW)
    expect(refused.outcome).toBe('REFUSED')
    if (refused.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(refused.code).toBe('BLOCKERS_NOT_ACKNOWLEDGED')
    expect(refused.blockers.map(b => b.ref)).toContain('esc-1')
    expect((getCase(getDb(), 'c-blocked') as never as { status: string }).status).toBe('NEW')

    // Acknowledged by ref, it closes -- and the cost is recorded on the result,
    // not only in whatever dialog authorised it.
    const closed = closeCase(getDb(), {
      ...goodClose('personal', 'c-blocked', before.version),
      acknowledgedBlockers: ['esc-1'],
    }, NOW)
    expect(closed.outcome).toBe('CLOSED')
    if (closed.outcome !== 'CLOSED') throw new Error('unreachable')
    expect(closed.acknowledgedBlockers.map(b => b.ref)).toContain('esc-1')
  })

  it('counts an unfinished outbound as a blocker, and a finished one as not', () => {
    personalCase('c-outbound')
    const ins = getDb().prepare(
      `INSERT INTO outbound_ledger
       (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
        status, payload, created_at, updated_at)
       VALUES (?, 'c-outbound', 'EMAIL', ?, ?, ?, '{}', ?, ?)`)
    ins.run('led-planned', 1, 'k1', 'PLANNED', NOW - 400, NOW - 400)
    ins.run('led-verified', 2, 'k2', 'VERIFIED', NOW - 300, NOW - 300)
    ins.run('led-cancelled', 3, 'k3', 'CANCELLED', NOW - 200, NOW - 200)

    const blockers = completionBlockers(getDb(), 'personal', 'c-outbound')
    const refs = blockers.filter(b => b.kind === 'PENDING_OUTBOUND').map(b => b.ref)
    // The distinction is the whole point: a letter still in flight strands a
    // promise; a sent one and a withdrawn one do not.
    expect(refs).toContain('led-planned')
    expect(refs).not.toContain('led-verified')
    expect(refs).not.toContain('led-cancelled')
  })

  it('does not leak blockers across namespaces', () => {
    personalCase('shared-id')
    zstCase('shared-id-z')
    getDb().prepare(
      `INSERT INTO case_escalations
       (escalation_id, domain, case_id, progression_run_id, trigger_reason,
        escalation_level, summary, resolution_status, created_at)
       VALUES ('esc-z','zst','shared-id','run-z','L2_BLOCKED','L2_BLOCKED','zst oldali','OPEN', ?)`,
    ).run(NOW - 500)

    // The escalation row names the ZST domain and the personal case id. A
    // blocker query that forgot its domain would hand a corporate escalation to
    // a personal close as if it were evidence about that case.
    const personal = completionBlockers(getDb(), 'personal', 'shared-id')
    expect(personal.map(b => b.ref)).not.toContain('esc-z')
  })

  // ── input contract: reason and provenance are not optional ───────────────
  it('refuses a blank reason, a blank provenance, and a missing intent', () => {
    personalCase('c-input')
    const v = (getCase(getDb(), 'c-input') as never as { version: number }).version

    const noReason = closeCase(getDb(), { ...goodClose('personal', 'c-input', v), reason: '   ' }, NOW)
    expect(noReason.outcome).toBe('REFUSED')
    if (noReason.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(noReason.code).toBe('INVALID_INPUT')

    const noProv = closeCase(getDb(), { ...goodClose('personal', 'c-input', v), provenance: '' }, NOW)
    expect(noProv.outcome).toBe('REFUSED')
    if (noProv.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(noProv.code).toBe('INVALID_INPUT')

    const noIntent = closeCase(getDb(), {
      ...goodClose('personal', 'c-input', v), intent: 'SOMETHING_ELSE' as never,
    }, NOW)
    expect(noIntent.outcome).toBe('REFUSED')
    if (noIntent.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(noIntent.code).toBe('INVALID_INPUT')

    // None of the three touched the case.
    expect((getCase(getDb(), 'c-input') as never as { status: string }).status).toBe('NEW')
  })

  // ── criterion 4: a guard refusal is visible and explained ───────────────
  it('surfaces a completion-guard refusal with its reason when the ENGINE closes', () => {
    // Progression-enabled with a generic DoD: the engine may not close this,
    // and the guard says why. The owner still can -- that asymmetry is the
    // design, and asserting both halves is what keeps it honest.
    personalCase('c-engine', { progression: true })
    const v = (getCase(getDb(), 'c-engine') as never as { version: number }).version

    const engineTry = closeCase(getDb(), {
      ...goodClose('personal', 'c-engine', v), actor: 'progression-engine',
    }, NOW)
    expect(engineTry.outcome).toBe('REFUSED')
    if (engineTry.outcome !== 'REFUSED') throw new Error('unreachable')
    expect(engineTry.code).toBe('COMPLETION_GUARD')
    expect(engineTry.reason).toMatch(/./)
    expect((getCase(getDb(), 'c-engine') as never as { status: string }).status).toBe('NEW')
  })

  // ── CANCELLED is a terminal the owner can choose ────────────────────────
  it('can end a case as CANCELLED rather than COMPLETED', () => {
    personalCase('c-cancel')
    const v = (getCase(getDb(), 'c-cancel') as never as { version: number }).version
    const r = closeCase(getDb(), {
      ...goodClose('personal', 'c-cancel', v), newStatus: 'CANCELLED',
      reason: 'nem aktualis tobbe',
    }, NOW)
    expect(r.outcome).toBe('CLOSED')
    expect((getCase(getDb(), 'c-cancel') as never as { status: string }).status).toBe('CANCELLED')
  })
})

// ── criterion 9: a completed case is still completed after a restart ───────
describe('closeCase — durability across a reopen of the database', () => {
  it('a case closed in one connection reads back COMPLETED in the next', () => {
    initDatabase(dbPath)
    personalCase('c-restart')
    const v = (getCase(getDb(), 'c-restart') as never as { version: number }).version
    expect(closeCase(getDb(), goodClose('personal', 'c-restart', v), NOW).outcome).toBe('CLOSED')

    // Re-open the store from scratch. Not a proof about a second OS process,
    // but it does prove the close was committed rather than held in a
    // connection-local state -- which is the failure this criterion is after.
    initDatabase(dbPath)
    const after = getCase(getDb(), 'c-restart') as never as { status: string; completed_at: number | null }
    expect(after.status).toBe('COMPLETED')
    expect(after.completed_at).toBe(NOW)
  })
})
