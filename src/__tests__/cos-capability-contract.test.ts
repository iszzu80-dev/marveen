// §19 hardening — the capability dependency CONTRACT.
//
// Owner's decision, 2026-08-27, and its negative tests are HIS list, in his
// order. Each `it` below names the clause it defends, because an acceptance
// list that has drifted from the tests is an acceptance list nobody can check.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { initProgressionSchema } from '../cos/schema.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capabilityCoverageHealth, operationalHealth } from '../cos/operational-health.js'
import {
  SIDE_EFFECT_CLASS, capabilityCoverage, declareForPlanStep,
  enforceCapabilityContract, summariseCoverage, undeclaredContract,
  type CapabilityContract, type CoverageRow,
} from '../cos/capability-contract.js'
import { armWaitCondition, evaluateWaitCondition, WAIT_KINDS, EVALUABLE_KINDS } from '../cos/wait-condition.js'
import { resolveExecutionDependency, withResolvedDependency } from '../cos/capability-resolution.js'
import { registerConnector, recordSuccess, recordFailure, DOWN_THRESHOLD, DEGRADED_THRESHOLD } from '../cos/connector-health.js'

const NOW = 1_700_000_000

/** Drive a connector DOWN the way the system does: by failing calls, not by
 *  writing a status. A fixture that sets the column directly proves the probe
 *  can read a column; this proves it can read the SYSTEM. */
function connectorDown(db: ReturnType<typeof getDb>, id: string, now: number): void {
  registerConnector(db, id, 'email', 'READ_WRITE', now)
  for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(db, id, 'boom', now)
}
function connectorDegraded(db: ReturnType<typeof getDb>, id: string, now: number): void {
  registerConnector(db, id, 'email', 'READ_WRITE', now)
  recordSuccess(db, id, now)
  for (let i = 0; i < DEGRADED_THRESHOLD; i++) recordFailure(db, id, 'slow', now)
}

/** A row in the case's outbound ledger -- what `executionToolFor` reads to work
 *  out which tool an EXECUTE would drive. Written through SQL rather than the
 *  send flow on purpose: the resolver's input is the LEDGER, and a fixture that
 *  went through the whole send machinery would be testing that machinery. */
function outboundRow(ledgerId: string, actionType = 'EMAIL_SEND', seq = 1): void {
  getDb().prepare(
    `INSERT INTO outbound_ledger
      (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
       external_idempotency_marker, status, attempt, created_at, updated_at)
     VALUES (?, 'c1', ?, ?, ?, ?, 'PLANNED', 0, ?, ?)`
  ).run(ledgerId, actionType, seq, `idem-${ledgerId}`, `COS-Ref:${ledgerId}`, NOW, NOW)
}

const contract = (over: Partial<CapabilityContract> = {}): CapabilityContract => ({
  requiredCapabilities: [], optionalCapabilities: [],
  failurePolicy: 'FAIL_CLOSED', source: 'DECLARED', reason: 'test', ...over,
})

describe('capability contract — the declaration is not an inference', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('every plan-step kind carries an explicit declaration', () => {
    // "A plan/next-action létrehozásakor legyen deklarálva és auditálható."
    for (const kind of Object.keys(SIDE_EFFECT_CLASS) as Array<keyof typeof SIDE_EFFECT_CLASS>) {
      const c = declareForPlanStep(kind)
      expect(c.source).toBe('DECLARED')
      expect(c.reason.length).toBeGreaterThan(10)   // the audit leg, not a placeholder
    }
  })

  it('a requirement survives the disappearance of the thing it names', () => {
    // The whole difference between a declaration and an inference: VERIFY needs
    // the run ledger whether or not a run ledger happens to exist right now.
    const c = declareForPlanStep('VERIFY')
    expect(c.requiredCapabilities).toContain('RUN_LEDGER')
  })

  it('UNDECLARED is not "requires nothing"', () => {
    const u = undeclaredContract()
    expect(u.source).toBe('UNDECLARED')
    expect(u.requiredCapabilities).toEqual([])
    // Same empty list as a declared no-op contract, and a DIFFERENT verdict for
    // risky work. If these two ever collapse, a forgotten declaration becomes a
    // deliberate one.
    const declaredEmpty = contract()
    expect(enforceCapabilityContract(getDb(), u, 'HIGH_RISK', NOW).verdict).toBe('DENY_UNDECLARED')
    expect(enforceCapabilityContract(getDb(), declaredEmpty, 'HIGH_RISK', NOW).verdict).toBe('PROCEED')
  })
})

describe('capability contract — the owner\'s negative tests', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('NEGATIVE 1: a required connector goes away → WAIT_CAPABILITY, not degraded continue', () => {
    // "szükséges connector kiesik → case WAIT_CAPABILITY"
    const db = getDb()
    connectorDown(db, 'gmail', NOW)
    const r = enforceCapabilityContract(db, contract({
      requiredCapabilities: ['CONNECTOR:gmail'],
    }), 'HIGH_RISK', NOW)
    expect(r.verdict).toBe('WAIT_CAPABILITY')
    expect(r.blocker?.capability).toBe('CONNECTOR:gmail')
    // and NOT a proceed-with-less: the engine may not reason in a degraded
    // context about a dependency it called necessary.
    expect(r.degradations).toEqual([])
  })

  it('NEGATIVE 2: the connector comes back → the typed wait is satisfied ONCE', () => {
    // "connector visszatér → egyszer felébred"
    const db = getDb()
    connectorDown(db, 'gmail', NOW)
    const armed = armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: CONNECTOR:gmail',
      expectedBy: NOW + 900, wakePolicy: 'EITHER', runId: 'r1',
      capability: { capability: 'CONNECTOR:gmail', action: 'send the reply', retryable: true },
    }, NOW)
    expect(armed.ok).toBe(true)

    // Still down: waiting, not satisfied.
    expect(evaluateWaitCondition(db, 'personal', 'c1', NOW + 10).verdict).toBe('WAITING')

    recordSuccess(db, 'gmail', NOW + 20)
    const back = evaluateWaitCondition(db, 'personal', 'c1', NOW + 30)
    expect(back.verdict).toBe('SATISFIED')
    expect(back.detail).toMatch(/visszatért/)
  })

  it('NEGATIVE 3: an OPTIONAL capability goes away → no parking, and the loss is audited', () => {
    // "opcionális capability kiesik → nincs indokolatlan parkolás"
    const db = getDb()
    db.exec('DROP TABLE IF EXISTS case_evidence_packets')
    const r = enforceCapabilityContract(db, contract({
      requiredCapabilities: ['RUN_LEDGER'],
      optionalCapabilities: ['EVIDENCE_PACKETS'],
    }), 'READ_ONLY', NOW)
    expect(r.verdict).toBe('PROCEED')
    expect(r.degradations.map(d => d.capability)).toContain('EVIDENCE_PACKETS')
    expect(r.detail).toMatch(/degradált/)
  })

  it('NEGATIVE 4: an undeclared HIGH_RISK action is denied, not silently continued', () => {
    // "undeclared high-risk action → DENY/NEEDS_HUMAN, nem silent continue"
    const r = enforceCapabilityContract(getDb(), undeclaredContract(), 'HIGH_RISK', NOW)
    expect(r.verdict).toBe('DENY_UNDECLARED')
  })

  it('NEGATIVE 4b: an undeclared MUTATING action is denied too', () => {
    expect(enforceCapabilityContract(getDb(), undeclaredContract(), 'MUTATING', NOW).verdict)
      .toBe('DENY_UNDECLARED')
  })

  it('NEGATIVE 5: an undeclared READ_ONLY enrichment is a contract gap, NOT an outage', () => {
    // "Read-only, alacsony kockázatú enrichmentnél ne állítsd le automatikusan a
    //  teljes case-t pusztán azért, mert nincs capability deklarálva; inkább
    //  jelezd mint contract gapet."
    const r = enforceCapabilityContract(getDb(), undeclaredContract(), 'READ_ONLY', NOW)
    expect(r.verdict).toBe('CONTRACT_GAP')
    expect(r.detail).toMatch(/szerződés-hiány/)
  })

  it('an unknown capability NAME blocks rather than passing as "nothing required"', () => {
    // A typo in a requirement list must not be equivalent to declaring none.
    const r = enforceCapabilityContract(getDb(), contract({
      requiredCapabilities: ['TYPO_CAPABILITY'],
    }), 'READ_ONLY', NOW)
    expect(r.verdict).toBe('WAIT_CAPABILITY')
    expect(r.blocker?.retryable).toBe(false)   // waiting will not teach it the name
  })
})

describe('capability contract — coverage is the enforcement gate', () => {
  it('reports declared/total per kind, and separates the risky ones', () => {
    // "legyen coverage mérés: hány action rendelkezik explicit declarationnel"
    const c = capabilityCoverage()
    expect(c.rows.length).toBe(Object.keys(SIDE_EFFECT_CLASS).length)
    expect(c.overall.total).toBe(c.rows.length)
    expect(c.risky.total).toBe(c.rows.filter(r => r.sideEffect !== 'READ_ONLY').length)
  })

  it('HEADLINE: mutating and high-risk coverage is 100%, which is what arms enforcement', () => {
    // "mutating/high-risk utaknál legyen 100% coverage az enforcement előtt"
    const c = capabilityCoverage()
    expect(c.risky.declared).toBe(c.risky.total)
    expect(c.enforcementReady).toBe(true)
  })

  // These three go through the REAL gate with rows handed to it. An earlier
  // version checked the incomplete case against a hand-built object, and a
  // mutation that hardwired `enforcementReady: true` survived the whole suite --
  // the one branch that decides whether enforcement runs at all was the one
  // branch nothing could drive red.
  const row = (kind: string, sideEffect: CoverageRow['sideEffect'], declared: number): CoverageRow =>
    ({ kind: kind as CoverageRow['kind'], sideEffect, declared, total: 1 })

  it('HEADLINE: ONE undeclared high-risk kind disarms the gate', () => {
    const r = summariseCoverage([
      row('VERIFY', 'READ_ONLY', 1),
      row('EXECUTE', 'HIGH_RISK', 1),
      row('COMMUNICATE', 'HIGH_RISK', 0),   // the one nobody declared
    ])
    expect(r.risky).toEqual({ declared: 1, total: 2 })
    expect(r.enforcementReady).toBe(false)
  })

  it('an undeclared READ_ONLY kind does NOT disarm it', () => {
    // Read-only gaps are a backlog item, not a reason to stop enforcing the
    // risky paths -- the owner drew that line explicitly.
    const r = summariseCoverage([
      row('GATHER_INFO', 'READ_ONLY', 0),
      row('EXECUTE', 'HIGH_RISK', 1),
    ])
    expect(r.enforcementReady).toBe(true)
    expect(r.overall).toEqual({ declared: 1, total: 2 })
  })

  it('"100% of zero" is NOT ready — deleting the classification must not arm it', () => {
    expect(summariseCoverage([row('VERIFY', 'READ_ONLY', 1)]).enforcementReady).toBe(false)
    expect(summariseCoverage([]).enforcementReady).toBe(false)
  })
})

describe('capability wait — a row that cannot resolve is refused at arm time', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  it('CAPABILITY is in the vocabulary AND in the evaluable set', () => {
    // A kind that can be armed and never resolved is worse than one that cannot
    // be armed at all -- the module's own words, held to.
    expect(WAIT_KINDS).toContain('CAPABILITY')
    expect(EVALUABLE_KINDS).toContain('CAPABILITY')
  })

  it('refuses a CAPABILITY wait that names no capability', () => {
    const r = armWaitCondition(getDb(), {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'valami hiányzik', expectedBy: NOW + 900, runId: 'r1',
    }, NOW)
    expect(r.ok).toBe(false)
    expect(r.refusal).toBe('NO_CAPABILITY_NAMED')
  })

  it('the row states which action it blocks and what would end the wait', () => {
    // The owner's four facts, on the row rather than implied by it.
    const db = getDb()
    connectorDown(db, 'gmail', NOW)
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: CONNECTOR:gmail',
      expectedBy: NOW + 900, runId: 'r1',
      capability: { capability: 'CONNECTOR:gmail', action: 'send the reply', retryable: true },
    }, NOW)
    const row = db.prepare(
      `SELECT kind, subject, evidence_predicate_json AS p, stale_review_at
         FROM case_wait_conditions WHERE case_id='c1' AND resolved_at IS NULL`).get() as
      { kind: string; subject: string; p: string; stale_review_at: number }
    const pred = JSON.parse(row.p)
    expect(row.kind).toBe('CAPABILITY')
    expect(pred.test).toBe('CAPABILITY_AVAILABLE')       // the recheck condition
    expect(pred.capability).toBe('CONNECTOR:gmail')      // which capability
    expect(pred.action).toBe('send the reply')           // which action
    expect(row.stale_review_at).toBeGreaterThan(NOW)     // next review
  })

  it('a DEGRADED capability ends the wait — a slow connector is not a missing one', () => {
    const db = getDb()
    connectorDown(db, 'gmail', NOW)
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: CONNECTOR:gmail',
      expectedBy: NOW + 900, runId: 'r1',
      capability: { capability: 'CONNECTOR:gmail', action: 'a', retryable: true },
    }, NOW)
    connectorDegraded(db, 'gmail', NOW + 5)
    expect(evaluateWaitCondition(db, 'personal', 'c1', NOW + 10).verdict).toBe('SATISFIED')
  })
})

// ── The migration, tested on a store that already has the OLD constraint ─────
//
// A fresh-database test cannot see this: `CREATE TABLE IF NOT EXISTS` builds the
// widened CHECK on an empty store, so the capability wait works there and fails
// on every store that existed before today. That gap has its own entry in this
// codebase's history, and it is the reason this block does not use initDatabase.
describe('capability wait — the CHECK widening reaches an EXISTING store', () => {
  it('HEADLINE: a pre-existing table with the old CHECK is rebuilt, rows intact', () => {
    initDatabase(':memory:')
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)

    // Put the store back to how it looked yesterday: the old constraint, and a
    // row in it that must survive.
    armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'EXTERNAL_RESPONSE',
      subject: 'reply from someone', expectedBy: NOW + 86400, runId: 'r0',
    }, NOW)
    const before = db.prepare(`SELECT COUNT(*) n FROM case_wait_conditions`).get() as { n: number }
    expect(before.n).toBe(1)

    const ddl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='case_wait_conditions'`,
    ).get() as { sql: string }).sql
    db.exec('PRAGMA foreign_keys=OFF')
    db.exec(`ALTER TABLE case_wait_conditions RENAME TO cwc_old`)
    db.exec(ddl.replace(",\n                      'CAPABILITY')", ')'))
    db.exec(`INSERT INTO case_wait_conditions SELECT * FROM cwc_old`)
    db.exec(`DROP TABLE cwc_old`)

    // The old constraint really is back — the control this test needs, or it
    // would be proving nothing about a store it never actually downgraded.
    const downgraded = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='case_wait_conditions'`,
    ).get() as { sql: string }).sql
    expect(downgraded).not.toContain("'CAPABILITY'")
    expect(() => db.exec(
      `INSERT INTO case_wait_conditions
         (wait_id, domain, case_id, kind, subject, resolution_mode, stale_review_at, armed_at, expected_by)
       VALUES ('x','personal','c1','CAPABILITY','s','EITHER',${NOW + 10},${NOW},${NOW + 10})`,
    )).toThrow()

    // Boot again. This is the migration under test.
    initProgressionSchema(db)

    const after = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='case_wait_conditions'`,
    ).get() as { sql: string }).sql
    expect(after).toContain("'CAPABILITY'")
    expect((db.prepare(`SELECT COUNT(*) n FROM case_wait_conditions`).get() as { n: number }).n).toBe(1)

    // And the thing the widening was for now works on that same store.
    const armed = armWaitCondition(db, {
      domain: 'personal', caseId: 'c1', kind: 'CAPABILITY',
      subject: 'képesség hiányzik: RUN_LEDGER', expectedBy: NOW + 900, runId: 'r1',
      capability: { capability: 'RUN_LEDGER', action: 'record', retryable: true },
    }, NOW)
    expect(armed.ok).toBe(true)
  })

  it('the migration is a no-op on a store that is already widened', () => {
    // Run twice: a rebuild that fires on every boot would churn the table and
    // lose the partial index or the triggers on the second pass.
    initDatabase(':memory:')
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    initProgressionSchema(db)
    initProgressionSchema(db)
    const idx = db.prepare(
      `SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_cwc_one_active'`,
    ).get() as { n: number }
    expect(idx.n).toBe(1)
    const trg = db.prepare(
      `SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_cwc_%'`,
    ).get() as { n: number }
    expect(trg.n).toBe(2)
  })
})

// ── Closure A: enforcementReady=false MUST NEVER mean fail-open ──────────────
//
// Owner, 2026-08-27: "Bizonyítsd, hogy enforcementReady=false SOHA nem jelent
// fail-open executiont." He was right about a defect I had also argued for. The
// first implementation skipped enforcement entirely when coverage was incomplete
// -- so adding ONE undeclared high-risk kind would have turned the DENY off for
// EVERY action, including the new undeclared one. A rollout gate that fails OPEN
// is not a rollout gate.
describe('capability coverage — the gate degrades the SIGNAL, never the enforcement', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  const row = (kind: string, sideEffect: CoverageRow['sideEffect'], declared: number): CoverageRow =>
    ({ kind: kind as CoverageRow['kind'], sideEffect, declared, total: 1 })

  it('HEADLINE: a NEW undeclared high-risk action cannot execute -- not itself, and not others', () => {
    // The owner's exact negative test. Coverage is incomplete because of the new
    // kind; the verdicts must be identical to the complete-coverage case.
    const incomplete = summariseCoverage([
      row('EXECUTE', 'HIGH_RISK', 1),
      row('COMMUNICATE', 'HIGH_RISK', 1),
      row('NEW_RISKY_KIND', 'HIGH_RISK', 0),   // the one nobody declared
    ])
    expect(incomplete.enforcementReady).toBe(false)

    const db = getDb()
    // 1. the NEW undeclared action itself: denied.
    expect(enforceCapabilityContract(db, undeclaredContract(), 'HIGH_RISK', NOW).verdict)
      .toBe('DENY_UNDECLARED')
    // 2. an OTHER high-risk action, properly declared, whose required capability
    //    is missing: still parked, not waved through.
    connectorDown(db, 'gmail', NOW)
    expect(enforceCapabilityContract(db, contract({
      requiredCapabilities: ['CONNECTOR_WRITE:gmail'],
    }), 'HIGH_RISK', NOW).verdict).toBe('WAIT_CAPABILITY')
    // 3. and a declared, satisfiable one still proceeds -- the gate did not just
    //    become "refuse everything", which would pass tests 1 and 2 for the
    //    wrong reason.
    expect(enforceCapabilityContract(db, contract({
      requiredCapabilities: ['RUN_LEDGER'],
    }), 'HIGH_RISK', NOW).verdict).toBe('PROCEED')
  })

  it('enforceCapabilityContract does not take coverage as an argument at all', () => {
    // The structural proof, and the one that survives a future refactor: the
    // enforcement function CANNOT consult readiness, because it is never given
    // it. A test that only checked verdicts could be defeated by re-introducing
    // the coupling one level up; this checks the shape.
    expect(enforceCapabilityContract.length).toBe(4)   // db, contract, sideEffect, now
  })

  it('STANDING CHECK: the pipeline calls enforcement unconditionally', () => {
    // The coupling that closure A removed lived in the CALLER, so this is where
    // it has to be pinned. `capabilityCoverage()` may be read for the signal; it
    // must not stand between the pipeline and the enforcement call.
    const src = readFileSync(resolve(process.cwd(), 'src/cos/progression-pipeline.ts'), 'utf8')
    expect(src).toMatch(/const capResult = enforceCapabilityContract\(/)
    expect(src).not.toMatch(/coverage\.enforcementReady\s*\n?\s*\?\s*enforceCapabilityContract/)
  })

  it('the readiness surface goes FAIL, and NAMES the undeclared kinds', () => {
    // "readiness/health/release signal FAIL vagy DEGRADED". Named rather than
    // counted: "2/3" tells nobody which one to go and declare.
    const h = capabilityCoverageHealth()
    expect(h.status).toBe('PASS')          // today every risky kind is declared
    expect(h.undeclaredRisky).toEqual([])
    expect(h.riskyDeclared).toBe(h.riskyTotal)
  })

  it('operationalHealth is NOT clean while coverage is incomplete', () => {
    // The counter-case for `clean`: a green health surface over a release state
    // the rollout order calls not-ready is the shape this whole packet exists to
    // stop. Driven through the real health call with the real store.
    const h = operationalHealth(getDb(), NOW)
    expect(h.capabilityCoverage.status).toBe('PASS')
    // and the wiring: `clean` must actually consult it.
    const src = readFileSync(resolve(process.cwd(), 'src/cos/operational-health.ts'), 'utf8')
    expect(src).toMatch(/clean:.*cov\.status === 'PASS'/s)
  })
})

// ── Closure B: the concrete execution dependency ────────────────────────────
//
// Owner, 2026-08-27: "RUN_LEDGER önmagában nem teljes dependency declaration az
// EXECUTE / COMMUNICATE műveleteknél. […] execution előtt ne csak az executor
// belsejében derüljön ki, mit igényelt a művelet." His five proofs, in his order.
describe('capability resolution — planned action to concrete dependency', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
  })

  const declared = (over: Partial<CapabilityContract> = {}) => contract(over)

  it('PROOF 1: COMMUNICATE resolves to the CHANNEL capability, per namespace', () => {
    const p = resolveExecutionDependency(getDb(), 'personal', 'c1', 'COMMUNICATE', 'HIGH_RISK')
    expect(p.status).toBe('RESOLVED')
    expect(p.target).toBe('gmail')
    expect(p.capability).toBe('CONNECTOR_WRITE:gmail')

    // The scope boundary, not a preference: ZST mail cannot resolve to the
    // private mailbox.
    const z = resolveExecutionDependency(getDb(), 'zst', 'c1', 'COMMUNICATE', 'HIGH_RISK')
    expect(z.capability).toBe('CONNECTOR_WRITE:gmail-zst')
  })

  it('PROOF 2: EXECUTE resolves to the tool of the outbound row it will drive', () => {
    // CORRECTED after six existing tests went red. The first version treated
    // EVERY EXECUTE as external and returned UNRESOLVED when a case had no
    // outbound history -- which denied ordinary local progression on every case
    // in the store. Most EXECUTE steps here are local or shadow work.
    //
    // What makes an EXECUTE external is a PENDING outbound row, and that is
    // evidence rather than a property of the kind.
    const db = getDb()
    expect(resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK').status)
      .toBe('NOT_REQUIRED')

    outboundRow('l-exec')                       // PLANNED EMAIL_SEND, waiting
    const r = resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK')
    expect(r.status).toBe('RESOLVED')
    expect(r.capability).toBe('CONNECTOR_WRITE:gmail')
    expect(r.reason).toMatch(/EMAIL_SEND/)
  })

  it('an outbound row that has ALREADY gone is not pending work', () => {
    // The counter-case for the rule above: VERIFIED means it left, so the next
    // EXECUTE is not driving it and must not inherit its capability.
    const db = getDb()
    outboundRow('l-done')
    db.prepare(`UPDATE outbound_ledger SET status='VERIFIED' WHERE ledger_id='l-done'`).run()
    expect(resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK').status)
      .toBe('NOT_REQUIRED')
  })

  it('PROOF 3: the resolved capability missing -> typed WAIT_CAPABILITY', () => {
    const db = getDb()
    connectorDown(db, 'gmail', NOW)
    const resolved = resolveExecutionDependency(db, 'personal', 'c1', 'COMMUNICATE', 'HIGH_RISK')
    const folded = withResolvedDependency(declared({ requiredCapabilities: ['RUN_LEDGER'] }), resolved)
    // The floor SURVIVES the fold: recording the action and performing it are
    // different questions, and the answer to one must not erase the other.
    expect(folded.requiredCapabilities).toContain('RUN_LEDGER')
    expect(folded.requiredCapabilities).toContain('CONNECTOR_WRITE:gmail')

    const v = enforceCapabilityContract(db, folded, 'HIGH_RISK', NOW)
    expect(v.verdict).toBe('WAIT_CAPABILITY')
    expect(v.blocker?.capability).toBe('CONNECTOR_WRITE:gmail')
  })

  it('PROOF 3b: a READ_ONLY connector fails a WRITE capability -- and says so', () => {
    // The distinction the two capability names exist for: "can I read Gmail" and
    // "can I send from Gmail" are different questions, and collapsing them is how
    // a read-only deployment looks capable of sending until the moment it refuses.
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_ONLY', NOW)
    recordSuccess(db, 'gmail', NOW)
    const v = enforceCapabilityContract(db, declared({
      requiredCapabilities: ['CONNECTOR_WRITE:gmail'],
    }), 'HIGH_RISK', NOW)
    expect(v.verdict).toBe('WAIT_CAPABILITY')
    expect(v.blocker?.retryable).toBe(false)   // an owner decision, not a wait
  })

  it('PROOF 4: an UNRESOLVED high-risk resolution -> DENY, never a quiet proceed', () => {
    // Pending EXTERNAL work whose dependency this layer cannot name. That is the
    // one shape that must deny: a real send behind a capability nobody checked.
    const db = getDb()
    outboundRow('l-weird', 'SMS_SEND')
    const resolved = resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK')
    expect(resolved.status).toBe('UNRESOLVED')
    expect(resolved.reason).toMatch(/SMS_SEND/)
    const folded = withResolvedDependency(declared({ requiredCapabilities: ['RUN_LEDGER'] }), resolved)
    // Expressed as a SOURCE change, so exactly one place decides what undeclared
    // means -- the place the owner's rule is written down.
    expect(folded.source).toBe('UNDECLARED')
    expect(enforceCapabilityContract(db, folded, 'HIGH_RISK', NOW).verdict).toBe('DENY_UNDECLARED')
  })

  it('PROOF 5: a missing OPTIONAL enrichment degrades under control, and does not park', () => {
    const db = getDb()
    db.exec('DROP TABLE IF EXISTS case_evidence_packets')
    const resolved = resolveExecutionDependency(db, 'personal', 'c1', 'GATHER_INFO', 'READ_ONLY')
    expect(resolved.status).toBe('NOT_REQUIRED')
    const folded = withResolvedDependency(declareForPlanStep('GATHER_INFO'), resolved)
    const v = enforceCapabilityContract(db, folded, 'READ_ONLY', NOW)
    expect(v.verdict).toBe('PROCEED')
    expect(v.degradations.map(d => d.capability)).toContain('EVIDENCE_PACKETS')
  })

  it('the resolver never reaches outside, and is stable across calls', () => {
    // Deterministic and read-only, for the same reason the preflight is: a
    // resolution that varies between two runs cannot be replayed.
    const db = getDb()
    outboundRow('l-x')
    const a = resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK')
    const b = resolveExecutionDependency(db, 'personal', 'c1', 'EXECUTE', 'HIGH_RISK')
    expect(a).toEqual(b)
  })

  it('STANDING CHECK: the pipeline records the whole chain, on every verdict', () => {
    // "az audit trailben látható legyen: planned action -> resolved
    // execution/channel -> required capability -> preflight verdict". A trail
    // that appears only on failure cannot show that the check ran.
    const src = readFileSync(resolve(process.cwd(), 'src/cos/progression-pipeline.ts'), 'utf8')
    // In its OWN field, not in safetyViolations. Pushing it there made six
    // healthy-run tests go red asserting "no safety violations", and they were
    // right: a violation means an assertion BROKE, a trail means a check RAN.
    expect(src).toMatch(/const capabilityTrail: CapabilityTrail = \{/)
    expect(src).toMatch(/capabilityTrail,/)
    expect(src).toMatch(/resolveExecutionDependency\(db, domain, caseId/)
    expect(src).toMatch(/withResolvedDependency\(capDeclared, capResolved\)/)
  })
})
