import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { decisionsForCase, projectDecisions } from '../cos/intelligence/decisions.js'
import { projectCommitments } from '../cos/intelligence/commitments.js'

const NOW = 1_800_000_000
const HOUR = 3600

const row = (over: Record<string, unknown> = {}) => ({
  case_id: 'c1', title: 'Contract', status: 'READY', next_action: 'send it',
  blocked_reason: null, waiting_on: null, due_at: null, updated_at: NOW - HOUR, ...over,
}) as never

describe('a decision separates fact, inference and recommendation', () => {
  it('an awaiting-selection case raises a HUMAN_DEPENDENCY decision', () => {
    const d = decisionsForCase(row({ status: 'AWAITING_SELECTION' }), 'personal', NOW)[0]
    expect(d.axis).toBe('HUMAN_DEPENDENCY')
    expect(d.decidableBy).toBe('OWNER')
    expect(d.question).toMatch(/waiting for\?$/)
    expect(d.basis.facts[0].statement).toContain('AWAITING_SELECTION')
    expect(d.basis.inferences[0].statement).toContain('cannot advance')
  })

  it('the three layers stay APART -- a fact is not filed as an inference', () => {
    const d = decisionsForCase(row({ status: 'AWAITING_SELECTION' }), 'personal', NOW)[0]
    expect(d.basis.facts.every((b) => b.kind === 'FACT')).toBe(true)
    expect(d.basis.inferences.every((b) => b.kind === 'INFERENCE')).toBe(true)
    expect(d.basis.recommendations.every((b) => b.kind === 'RECOMMENDATION')).toBe(true)
  })

  it('the element takes the WEAKEST layer present -- resting on an inference makes it an inference', () => {
    const d = decisionsForCase(row({ status: 'AWAITING_SELECTION' }), 'personal', NOW)[0]
    expect(d.basis.inferences.length).toBeGreaterThan(0)
    expect(d.kind).toBe('INFERENCE')
    expect(d.kind).not.toBe('FACT')
  })

  it('a block with NO reason is LOW confidence and says why it cannot be evaluated', () => {
    const d = decisionsForCase(row({ status: 'BLOCKED', blocked_reason: null }), 'personal', NOW)[0]
    expect(d.confidence).toBe('LOW')
    expect(d.basis.inferences[0].statement).toContain('cannot be evaluated')
    const withReason = decisionsForCase(row({ status: 'BLOCKED', blocked_reason: 'legal review' }), 'personal', NOW)[0]
    expect(withReason.confidence).toBe('HIGH')
  })

  it('A DECISION IS NEVER AN AUTHORIZATION -- no field on it can be read as permission', () => {
    const d = decisionsForCase(row({ status: 'BLOCKED', blocked_reason: 'x' }), 'personal', NOW)[0]
    for (const f of ['approved', 'authorized', 'permitted', 'mayExecute', 'allow', 'approval']) {
      expect(f in d).toBe(false)
    }
    // `settled` says a choice was MADE. It still is not permission, and the
    // axis names which question was settled rather than what may now happen.
    expect(d.settled).toBe(false)
    expect(d.axis).toBe('ENGINE_EXECUTION_PERMISSION')
  })

  it('a healthy case raises no decision at all -- silence is the normal case', () => {
    expect(decisionsForCase(row({ status: 'READY' }), 'personal', NOW)).toEqual([])
  })
})

describe('PHASE 2 IS A PROJECTION -- it writes nothing and cannot be a second truth', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDb()
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, next_action, next_action_owner,
        due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('c-open', 'Open one', 'ADMIN', 'READY', 'send it', 'istvan', NOW + 86_400, NOW - 86_400, NOW - HOUR)
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, next_action, completed_at,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('c-claimed', 'Claimed done', 'ADMIN', 'COMPLETED', 'was done', NOW - HOUR, NOW - 86_400, NOW - HOUR)
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, blocked_reason,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('c-blocked', 'Blocked one', 'ADMIN', 'BLOCKED', 'waiting on legal', NOW - 86_400, NOW - HOUR)
  })

  it('projecting twice over an UNCHANGED store gives an identical answer', () => {
    const db = getDb()
    const a = projectCommitments(db, 'personal', NOW)
    const b = projectCommitments(db, 'personal', NOW)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the projection writes NOTHING -- the canonical rows are byte-identical afterwards', () => {
    const db = getDb()
    const snap = () => JSON.stringify(db.prepare('SELECT * FROM personal_cases ORDER BY case_id').all())
    const before = snap()
    projectCommitments(db, 'personal', NOW)
    projectDecisions(db, 'personal', NOW)
    expect(snap()).toBe(before)
  })

  // EDITED 2026-09-01 for P3-A, and deliberately made STRICTER rather than
  // looser. The guard used to ban every table whose name began with an
  // intelligence word. P3-A adds exactly one: `intelligence_surfaced`, the
  // reader's delivery ledger -- what was said, in which band, when. It holds no
  // case status and no verdict, so it cannot be the second truth this guard
  // exists to prevent; deleting it makes the reader repeat itself once and
  // cannot make it wrong.
  //
  // An exemption by name alone would rot: the next person to add a column could
  // put `status` in it and this test would still pass. So the exemption is
  // paired with a COLUMN check below, and the two together are a tighter fence
  // than the single regex was.
  const LEDGER = 'intelligence_surfaced'

  it('there is no intelligence TABLE -- nothing can hold a status that disagrees with the case', () => {
    const db = getDb()
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as Array<{ name: string }>).map((t) => t.name)
    for (const t of tables) {
      if (t === LEDGER) continue
      expect(t).not.toMatch(/^(commitments|decisions|attention|opportunities|intelligence)/)
    }
  })

  it('and the ONE exempted table carries delivery bookkeeping, never case state', () => {
    const db = getDb()
    const cols = (db.prepare(`PRAGMA table_info("${LEDGER}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols.length).toBeGreaterThan(0)      // the exemption must name a real table
    // Every column is an utterance fact. None of these words may ever appear,
    // because each of them is a case fact that could disagree with the case.
    const FORBIDDEN = /status|verdict|due|owner|statement|confidence|resolution|priority|state|completed/i
    for (const c of cols) expect(c).not.toMatch(FORBIDDEN)
    expect(cols.sort()).toEqual([
      'band', 'element_id', 'fingerprint', 'first_surfaced_at',
      'last_surfaced_at', 'namespace', 'times_surfaced',
    ])
  })

  it('a change to the CANONICAL row changes the projection, with no refresh step', () => {
    const db = getDb()
    const before = projectCommitments(db, 'personal', NOW).find((c) => c.caseId === 'c-open')!
    expect(before.status).toBe('OPEN')
    db.prepare(`UPDATE personal_cases SET due_at=? WHERE case_id=?`).run(NOW - HOUR, 'c-open')
    const after = projectCommitments(db, 'personal', NOW).find((c) => c.caseId === 'c-open')!
    expect(after.status).toBe('EXPIRED')
    expect(after.id).toBe(before.id)   // same element, new evidence
  })

  it('the claimed-done case surfaces as UNKNOWN across the real projection', () => {
    const c = projectCommitments(getDb(), 'personal', NOW).find((x) => x.caseId === 'c-claimed')!
    expect(c.status).toBe('UNKNOWN')
    expect(c.fulfillment.proven).toBe(false)
  })

  it('the blocked case surfaces as a decision across the real projection', () => {
    const d = projectDecisions(getDb(), 'personal', NOW).find((x) => x.caseId === 'c-blocked')!
    expect(d.axis).toBe('ENGINE_EXECUTION_PERMISSION')
    expect(d.basis.facts[0].statement).toContain('waiting on legal')
  })
})
