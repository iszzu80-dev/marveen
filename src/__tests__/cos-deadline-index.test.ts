// §10.1–10.3: the deadline ontology and its index.
//
// The audit found deadline data in eleven column names across fourteen tables,
// in three storage conventions, with five indexes covering four unrelated
// concepts and no view that answers "what is due". §11.2 E's deadline-first
// question ordering could only be half-built for that reason: there was nothing
// to order BY.
//
// Two properties carry the weight, and they pull in opposite directions:
//
//   1. The index must SEE every real deadline — a termination date it silently
//      cannot parse is a deadline nobody is tracking, which is worse than one
//      that is merely late.
//   2. The index must NOT see the things that only look like deadlines. Four of
//      the eleven are lease and ticket expiries — machine bookkeeping that
//      happens to be a timestamp — and folding them in would put the engine's
//      own five-minute retry cadence on the list the owner reads as "what am I
//      late for".
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import {
  DEADLINE_ONTOLOGY, INTERNAL_SAFE_LEAD_SEC, deadlineIndex, caseDeadline,
  parseIsoDate, internalSafeDeadline,
} from '../cos/deadline-index.js'

const T0 = 1_700_000_000
const DAY = 86400


/** Every production file that declares a table. The invariant is about the
 *  codebase, so the scan has to be too. */
function declaringFiles(): string[] {
  const REPO = process.cwd()
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(REPO, dir))) return
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(rel)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        if (/CREATE TABLE/i.test(readFileSync(join(REPO, rel), 'utf8'))) out.push(rel)
      }
    }
  }
  walk('src'); walk('scripts')
  return out.sort()
}

describe('§10.3 the ontology itself', () => {
  it('HEADLINE: every deadline-shaped column in the schema has exactly one status', () => {
    // §10.3's first invariant: v1.4 may not create a fourth parallel deadline
    // semantic without justification. Enforced by making the inventory complete
    // and keeping it that way — a twelfth column added to the schema fails here
    // until somebody decides what it IS.
    // EVERY file that declares a table, not just `schema.ts`.
    //
    // The first version read `schema.ts` alone, and the v1.4 proactive sweep
    // walked straight past it: `proactive_sweep_state.next_review_at` is
    // declared in `proactive/sweep.ts`, so the inventory reported itself
    // complete while a twelfth deadline-shaped column existed one directory
    // over. The check was guarding a file when the invariant is about the
    // codebase — the same class of mistake as the scan that was one letter too
    // narrow, found the same way: by adding the thing it was supposed to catch.
    const schema = declaringFiles()
      .map(f => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n')
    const found = new Set<string>()
    for (const line of schema.split('\n')) {
      // `expir`, not `expires`. The first version of this pattern said
      // `expires`, and `zst_contracts.expiry_date` — a real contract deadline,
      // stored as TEXT, read by nothing that orders it — walked straight past
      // it. The test found it by accident, through an unrelated fixture insert,
      // which is exactly how a scan that is one letter too narrow reports a
      // complete inventory.
      const m = /^\s{4,}(\w*(?:due|deadline|wake|follow_up|next_check|next_review|valid_until|expir|horizon)\w*)\s+(INTEGER|TEXT)/.exec(line)
      if (m) found.add(m[1])
    }
    const declared = DEADLINE_ONTOLOGY.map(c => c.field).join(' ')
    const undeclared = [...found].filter(col => !declared.includes(col)).sort()
    expect(undeclared).toEqual([])
    // ...and the scan is not vacuous.
    expect(found.size).toBeGreaterThanOrEqual(8)
  })

  it('every INTENTIONALLY_DISTINCT concept states why', () => {
    // §10.3 requires the reason explicitly, and it is the clause that does the
    // real work: "we have several deadline fields" and "we have several KINDS of
    // deadline" are different situations with different fixes.
    for (const c of DEADLINE_ONTOLOGY.filter(x => x.status === 'INTENTIONALLY_DISTINCT')) {
      expect(c.rationale.length).toBeGreaterThan(40)
      expect(c.normalizedType).toBeNull()
    }
    // And there really are some — a check over an empty set proves nothing.
    expect(DEADLINE_ONTOLOGY.filter(x => x.status === 'INTENTIONALLY_DISTINCT').length).toBeGreaterThanOrEqual(4)
  })

  it('every ADAPTED_TO_INDEX concept has a normalized type and a precedence', () => {
    for (const c of DEADLINE_ONTOLOGY.filter(x => x.status === 'ADAPTED_TO_INDEX')) {
      expect(c.normalizedType).not.toBeNull()
      expect(c.precedenceIfConflict).toBeGreaterThan(0)
      expect(c.semanticOwner).toBeTruthy()
      expect(c.sourceOfTruth).toBeTruthy()
    }
  })

  it('a TEXT-stored concept declares its adapter', () => {
    // The place a silent bug would live. A date in TEXT that reaches a
    // comparison without an adapter is the `reconcile.ts` defect, one table over.
    for (const c of DEADLINE_ONTOLOGY.filter(x => x.storage === 'ISO_DATE_TEXT' && x.status === 'ADAPTED_TO_INDEX')) {
      expect(c.migrationOrAdapter).toBeTruthy()
    }
  })

  it('every normalized type has a deterministic safe-deadline lead', () => {
    for (const c of DEADLINE_ONTOLOGY) {
      if (c.normalizedType) expect(INTERNAL_SAFE_LEAD_SEC[c.normalizedType]).toBeGreaterThanOrEqual(0)
    }
  })

  it('STANDING CHECK: the index is a projection — nothing creates a deadline table', () => {
    // §10.2: "a derived read model, not a fourth source of truth". The strongest
    // available form of that: there is no table to write to. If one appears,
    // this fails and the migration decision §10.2 requires has to be made out
    // loud.
    const src = readFileSync(join(process.cwd(), 'src/cos/deadline-index.ts'), 'utf8')
    expect(src).not.toMatch(/CREATE TABLE/i)
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i)
    const schema = readFileSync(join(process.cwd(), 'src/cos/schema.ts'), 'utf8')
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS deadline_index/i)
  })
})

describe('§10.1 date normalization', () => {
  it('HEADLINE: parses only a real YYYY-MM-DD, and refuses everything else', () => {
    expect(parseIsoDate('2026-09-01')).toBe(Date.UTC(2026, 8, 1) / 1000)
    // The permissive alternative — hand it to Date.parse and take what comes —
    // turns each of these into a plausible wrong answer instead of a refusal.
    expect(parseIsoDate('2026. 09. 01.')).toBeNull()
    expect(parseIsoDate('2026-9-1')).toBeNull()
    expect(parseIsoDate('')).toBeNull()
    expect(parseIsoDate('tomorrow')).toBeNull()
    expect(parseIsoDate(null)).toBeNull()
    expect(parseIsoDate(1_700_000_000)).toBeNull()
  })

  it('refuses a date that does not come back as itself', () => {
    // Date.UTC accepts 2026-02-31 and rolls it into March. A round-trip check is
    // the only thing that separates "a date" from "arithmetic that succeeded".
    expect(parseIsoDate('2026-02-31')).toBeNull()
    expect(parseIsoDate('2026-13-01')).toBeNull()
    expect(parseIsoDate('2024-02-29')).not.toBeNull()   // a real leap day
  })

  it('the safe deadline is deterministic and never negative', () => {
    expect(internalSafeDeadline(T0, 'TERMINATION_DEADLINE')).toBe(T0 - 7 * DAY)
    expect(internalSafeDeadline(T0, 'WAKE')).toBe(T0)
    expect(internalSafeDeadline(100, 'TERMINATION_DEADLINE')).toBe(0)
  })
})

describe('§10.2 the index', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  function personalCase(id: string, cols: Partial<Record<'due_at' | 'follow_up_at' | 'next_wake_at', number>>): void {
    const db = getDb()
    createCase(db, { caseId: id, title: id, caseType: 'ADMIN' }, T0)
    for (const [c, v] of Object.entries(cols)) {
      db.prepare(`UPDATE personal_cases SET ${c} = ? WHERE case_id = ?`).run(v, id)
    }
  }

  it('HEADLINE: orders by the deadline, then by how BINDING it is — never by read order', () => {
    // Precedence is assigned by bindingness, not by imminence: a contract
    // termination is a legal cliff, a wake time is a note the system left itself.
    personalCase('c-wake', { next_wake_at: T0 + DAY })
    personalCase('c-due', { due_at: T0 + DAY })
    personalCase('c-later', { due_at: T0 + 2 * DAY })
    const r = deadlineIndex(getDb(), 'personal', T0)
    expect(r.records.map(x => x.deadlineType)).toEqual(['CASE_DUE', 'WAKE', 'CASE_DUE'])
    expect(r.records[2].caseId).toBe('c-later')
  })

  it('one case with several deadlines yields several records, most binding first', () => {
    personalCase('c1', { due_at: T0 + DAY, next_wake_at: T0 + DAY, follow_up_at: T0 + DAY })
    const top = caseDeadline(getDb(), 'personal', 'c1', T0)
    expect(top?.deadlineType).toBe('CASE_DUE')
  })

  it('a closed case has no deadlines — it cannot be late for anything', () => {
    personalCase('c1', { due_at: T0 + DAY })
    getDb().prepare(`UPDATE personal_cases SET status = 'COMPLETED' WHERE case_id = 'c1'`).run()
    expect(deadlineIndex(getDb(), 'personal', T0).records).toHaveLength(0)
  })

  it('overdue is included by default — an index that hides what is late answers the wrong question', () => {
    personalCase('c1', { due_at: T0 - 10 * DAY })
    expect(deadlineIndex(getDb(), 'personal', T0).records).toHaveLength(1)
    expect(deadlineIndex(getDb(), 'personal', T0, { includeOverdue: false }).records).toHaveLength(0)
  })

  it('the horizon replaces the zst-watch "+N days" window it subsumes', () => {
    personalCase('c-near', { due_at: T0 + 10 * DAY })
    personalCase('c-far', { due_at: T0 + 100 * DAY })
    const r = deadlineIndex(getDb(), 'personal', T0, { withinSec: 45 * DAY })
    expect(r.records.map(x => x.caseId)).toEqual(['c-near'])
  })

  it('§11.2 C: the bound says out loud what it left behind', () => {
    for (let i = 0; i < 5; i++) personalCase(`c${i}`, { due_at: T0 + i * DAY })
    const r = deadlineIndex(getDb(), 'personal', T0, { limit: 2 })
    expect(r.records).toHaveLength(2)
    expect(r.remaining).toBe(3)
  })

  it('HEADLINE: an unparseable stored date is REPORTED, never silently dropped', () => {
    // A termination date the index cannot read is a deadline nobody is
    // tracking. Counting it as zero would be the quietest possible way to miss
    // a legal cliff.
    const db = getDb()
    db.prepare(
      `INSERT INTO zst_contracts (contract_id, title, termination_deadline, created_at, updated_at)
       VALUES ('k1', 'Partneri szerzodes', '2026. 09. 01.', ?, ?)`,
    ).run(T0, T0)
    const r = deadlineIndex(db, 'zst', T0)
    expect(r.records).toHaveLength(0)
    expect(r.unparseable).toHaveLength(1)
    expect(r.unparseable[0].sourceRef).toMatch(/zst_contracts\.termination_deadline/)
  })

  it('a well-formed contract deadline lands, with its lead applied and confidence below 1', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO zst_contracts (contract_id, title, termination_deadline, created_at, updated_at)
       VALUES ('k1', 'Partneri szerzodes', '2026-09-01', ?, ?)`,
    ).run(T0, T0)
    const [rec] = deadlineIndex(db, 'zst', T0).records
    expect(rec.deadlineType).toBe('TERMINATION_DEADLINE')
    expect(rec.internalSafeDeadline).toBe(rec.externalDeadline - 7 * DAY)
    // A parsed date is a date somebody typed; a stored epoch was computed.
    expect(rec.confidence).toBeLessThan(1)
  })

  it('HEADLINE: the two domains never see each other', () => {
    personalCase('p1', { due_at: T0 + DAY })
    createZstCase(getDb(), { caseId: 'z1', title: 'Ceges', caseType: 'ADMIN' }, T0)
    getDb().prepare(`UPDATE zst_cases SET due_at = ? WHERE case_id = 'z1'`).run(T0 + DAY)
    expect(deadlineIndex(getDb(), 'personal', T0).records.map(r => r.caseId)).toEqual(['p1'])
    expect(deadlineIndex(getDb(), 'zst', T0).records.map(r => r.caseId)).toEqual(['z1'])
  })

  it('HEADLINE: the engine cadence and the lease TTLs stay OUT', () => {
    // The four INTENTIONALLY_DISTINCT concepts. next_progression_at is set on
    // every case the engine touches; if it were a deadline, every case in the
    // store would permanently be on the "what am I late for" list.
    personalCase('c1', {})
    getDb().prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
         next_progression_at, progression_claim_expires_at, created_at, updated_at)
       VALUES ('personal','c1',1,'internal',?,?,?,?)`,
    ).run(T0 - DAY, T0 - DAY, T0, T0)
    expect(deadlineIndex(getDb(), 'personal', T0).records).toHaveLength(0)
  })

  it('a missing table is not a missed deadline', () => {
    // Partial installs are a supported state here. An unreadable table is the
    // daily reconcile's finding to report, not this projection's.
    getDb().exec(`DROP TABLE IF EXISTS radar_items`)
    personalCase('c1', { due_at: T0 + DAY })
    expect(deadlineIndex(getDb(), 'personal', T0).records).toHaveLength(1)
  })

  it('is deterministic — same store, same order, every time', () => {
    for (let i = 0; i < 4; i++) personalCase(`c${i}`, { due_at: T0 + DAY })
    const a = deadlineIndex(getDb(), 'personal', T0).records.map(r => r.deadlineId)
    const b = deadlineIndex(getDb(), 'personal', T0).records.map(r => r.deadlineId)
    expect(b).toEqual(a)
  })
})
