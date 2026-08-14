// §1.4.6 / §26(26): the replay run ledger and the control arm.
//
// §1.4's whole value gate rests on one claim: "the reactive baseline would not
// have surfaced this". §1.4.6 says what makes that claim admissible, and the
// line that bites is the last:
//
//     "A baseline reconstructed from memory, by manual retrospection, or with
//      knowledge of the proactive output is NOT an acceptable control."
//
// You cannot un-know the answer while choosing what to measure. That is not a
// discipline problem solvable by asking people to be careful — it is an ordering
// constraint, and the headline test below is the one that enforces it.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import {
  ensureReplaySchema, beginRun, recordOutput, sealRun, readRun, readOutputs,
  corpusFingerprint, configVersion, assertComparable, reproduces,
} from '../cos/replay-run.js'

const T0 = 1_700_000_000
const CONFIG = { cycles: 6, engine: 'progression-pipeline' }

let ledger: Database.Database

function newLedger(): Database.Database {
  const d = new Database(':memory:')
  ensureReplaySchema(d)
  return d
}

function begin(runId: string, arm: 'REACTIVE_CONTROL' | 'PROACTIVE_SHADOW', fp = 'corpus-a', at = T0) {
  return beginRun(ledger, { runId, arm, corpusFingerprint: fp, config: CONFIG }, at)
}

describe('§1.4.6 the control arm must go first', () => {
  beforeEach(() => { ledger = newLedger() })

  it('HEADLINE: a control run cannot be created after a proactive run on the same corpus', () => {
    // The failure §1.4.6 names by name: a baseline produced with knowledge of
    // the proactive output. Enforced as an ordering precondition, because a
    // rule that depends on somebody remembering not to look is not a rule.
    expect(begin('p1', 'PROACTIVE_SHADOW').ok).toBe(true)
    const control = begin('c1', 'REACTIVE_CONTROL')
    expect(control.ok).toBe(false)
    if (!control.ok) expect(control.reason).toMatch(/§1\.4\.6/)
  })

  it('but the same control IS allowed on a corpus the proactive arm has not touched', () => {
    // The refusal has to be about THIS corpus, not about the ledger having ever
    // seen a proactive run. Otherwise one experiment would poison every later
    // one.
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a')
    expect(begin('c1', 'REACTIVE_CONTROL', 'corpus-b').ok).toBe(true)
  })

  it('the rule is deliberately one-directional: proactive-after-control is the intended order', () => {
    expect(begin('c1', 'REACTIVE_CONTROL').ok).toBe(true)
    expect(begin('p1', 'PROACTIVE_SHADOW').ok).toBe(true)
  })

  it('a run id cannot be reused', () => {
    expect(begin('r1', 'REACTIVE_CONTROL').ok).toBe(true)
    expect(begin('r1', 'REACTIVE_CONTROL').ok).toBe(false)
  })
})

describe('§1.4.6 the output is immutable once sealed', () => {
  beforeEach(() => { ledger = newLedger() })

  it('HEADLINE: a sealed run cannot take another output', () => {
    begin('r1', 'REACTIVE_CONTROL')
    recordOutput(ledger, { runId: 'r1', domain: 'personal', caseId: 'c1', cycle: 1, decision: 'WAIT_EXTERNAL', reason: '' })
    sealRun(ledger, 'r1', T0 + 10)
    expect(() => recordOutput(ledger, {
      runId: 'r1', domain: 'personal', caseId: 'c2', cycle: 1, decision: 'COMPLETE', reason: '',
    })).toThrow(/sealed/)
  })

  it('an output can never be edited or removed, sealed or not', () => {
    // Enforced by trigger rather than by an application check: a rule the next
    // script to be written can bypass by accident is not immutability.
    begin('r1', 'REACTIVE_CONTROL')
    recordOutput(ledger, { runId: 'r1', domain: 'personal', caseId: 'c1', cycle: 1, decision: 'COMPLETE', reason: 'x' })
    expect(() => ledger.prepare(`UPDATE replay_outputs SET decision='WAIT_TIME' WHERE run_id='r1'`).run())
      .toThrow(/append-only/)
    expect(() => ledger.prepare(`DELETE FROM replay_outputs WHERE run_id='r1'`).run())
      .toThrow(/append-only/)
  })

  it('a sealed run header is frozen, and no run can be deleted', () => {
    begin('r1', 'REACTIVE_CONTROL')
    sealRun(ledger, 'r1', T0 + 10)
    expect(() => ledger.prepare(`UPDATE replay_runs SET config_json='{}' WHERE run_id='r1'`).run())
      .toThrow(/sealed/)
    expect(() => ledger.prepare(`DELETE FROM replay_runs WHERE run_id='r1'`).run())
      .toThrow(/permanent/)
  })

  it('the digest covers order, not just content', () => {
    // Two runs that reached the same decisions in a different order are not the
    // same run: the order is part of what the engine did, and a sorted digest
    // would hide a scheduling change that altered which case saw which state
    // first.
    begin('r1', 'REACTIVE_CONTROL', 'corpus-a')
    recordOutput(ledger, { runId: 'r1', domain: 'personal', caseId: 'a', cycle: 1, decision: 'X', reason: '' })
    recordOutput(ledger, { runId: 'r1', domain: 'personal', caseId: 'b', cycle: 1, decision: 'Y', reason: '' })
    const one = sealRun(ledger, 'r1', T0 + 1)

    begin('r2', 'REACTIVE_CONTROL', 'corpus-a')
    recordOutput(ledger, { runId: 'r2', domain: 'personal', caseId: 'b', cycle: 1, decision: 'Y', reason: '' })
    recordOutput(ledger, { runId: 'r2', domain: 'personal', caseId: 'a', cycle: 1, decision: 'X', reason: '' })
    const two = sealRun(ledger, 'r2', T0 + 2)

    expect(two.outputDigest).not.toBe(one.outputDigest)
  })

  it('§1.4.6(5): the same corpus, config and outputs reproduce', () => {
    begin('r1', 'REACTIVE_CONTROL', 'corpus-a')
    recordOutput(ledger, { runId: 'r1', domain: 'personal', caseId: 'a', cycle: 1, decision: 'X', reason: '' })
    const one = sealRun(ledger, 'r1', T0 + 1)
    begin('r2', 'REACTIVE_CONTROL', 'corpus-a')
    recordOutput(ledger, { runId: 'r2', domain: 'personal', caseId: 'a', cycle: 1, decision: 'X', reason: '' })
    const two = sealRun(ledger, 'r2', T0 + 2)
    expect(reproduces(one, two)).toBe(true)
    expect(readOutputs(ledger, 'r1')).toHaveLength(1)
  })

  it('a different config is a different run even with identical output', () => {
    begin('r1', 'REACTIVE_CONTROL', 'corpus-a')
    const one = sealRun(ledger, 'r1', T0 + 1)
    beginRun(ledger, { runId: 'r2', arm: 'REACTIVE_CONTROL', corpusFingerprint: 'corpus-a', config: { cycles: 12 } }, T0)
    const two = sealRun(ledger, 'r2', T0 + 2)
    expect(reproduces(one, two)).toBe(false)
  })
})

describe('the config version', () => {
  it('does not depend on key order — {a,b} and {b,a} are one configuration', () => {
    expect(configVersion({ a: 1, b: 2 })).toBe(configVersion({ b: 2, a: 1 }))
    expect(configVersion({ a: 1, b: 2 })).not.toBe(configVersion({ a: 1, b: 3 }))
  })
})

describe('the corpus fingerprint', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('HEADLINE: is about CONTENT, so a copy of a corpus is the same corpus', () => {
    // Hashing the file would call two identical corpora different — a SQLite
    // copy differs in page layout, WAL state and free-page ordering — and the
    // whole comparison would become unavailable for a reason that has nothing
    // to do with the data.
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, T0)
    const a = corpusFingerprint(getDb())
    const copy = new Database(':memory:')
    copy.exec(`CREATE TABLE personal_cases (case_id TEXT, version INTEGER, status TEXT, updated_at INTEGER)`)
    const row = getDb().prepare(`SELECT case_id, version, status, updated_at FROM personal_cases`).get() as Record<string, unknown>
    copy.prepare(`INSERT INTO personal_cases VALUES (?,?,?,?)`).run(row.case_id, row.version, row.status, row.updated_at)
    copy.exec(`CREATE TABLE zst_cases (case_id TEXT, version INTEGER, status TEXT, updated_at INTEGER)`)
    expect(corpusFingerprint(copy)).toBe(a)
  })

  it('changes when a case changes state', () => {
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, T0)
    const before = corpusFingerprint(getDb())
    transitionCase(getDb(), { caseId: 'c1', seenVersion: 1, newStatus: 'READY', actor: 'test' }, T0 + 10)
    expect(corpusFingerprint(getDb())).not.toBe(before)
  })

  it('changes when a case is added to EITHER domain', () => {
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, T0)
    const before = corpusFingerprint(getDb())
    createZstCase(getDb(), { caseId: 'z1', title: 'Z', caseType: 'ADMIN' }, T0)
    expect(corpusFingerprint(getDb())).not.toBe(before)
  })

  it('"no zst cases" and "no zst table" are not the same corpus', () => {
    // The quiet one. A corpus missing a whole domain and a corpus with an empty
    // domain would compare as identical under a skip-on-error fingerprint, and
    // an arm driven over one could be compared against an arm driven over the
    // other.
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, T0)
    const withEmptyZst = corpusFingerprint(getDb())
    getDb().exec(`DROP TABLE zst_cases`)
    expect(corpusFingerprint(getDb())).not.toBe(withEmptyZst)
  })
})

describe('§1.4.6 comparability is a verdict, not an assumption', () => {
  beforeEach(() => { ledger = newLedger() })

  it('HEADLINE: two properly ordered, sealed runs on one corpus are comparable', () => {
    begin('c1', 'REACTIVE_CONTROL', 'corpus-a', T0)
    sealRun(ledger, 'c1', T0 + 100)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a', T0 + 200)
    sealRun(ledger, 'p1', T0 + 300)
    expect(assertComparable(ledger, 'c1', 'p1')).toMatchObject({ comparable: true, reasons: [] })
  })

  it('refuses when the two ran over different corpora', () => {
    begin('c1', 'REACTIVE_CONTROL', 'corpus-a', T0)
    sealRun(ledger, 'c1', T0 + 100)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-b', T0 + 200)
    sealRun(ledger, 'p1', T0 + 300)
    const v = assertComparable(ledger, 'c1', 'p1')
    expect(v.comparable).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/ugyanazon a korpuszon/)
  })

  it('refuses an unsealed control — the output must be frozen before adjudication', () => {
    begin('c1', 'REACTIVE_CONTROL', 'corpus-a', T0)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a', T0 + 200)
    sealRun(ledger, 'p1', T0 + 300)
    expect(assertComparable(ledger, 'c1', 'p1').reasons.join(' ')).toMatch(/nincs lezárva/)
  })

  it('HEADLINE: refuses OVERLAPPING arms, which beginRun alone cannot catch', () => {
    // beginRun stops a control being CREATED after a proactive run. This catches
    // the other shape: a proactive arm that started while the control was still
    // open could have influenced it through the shared corpus, and both runs
    // would look correctly ordered by creation time.
    begin('c1', 'REACTIVE_CONTROL', 'corpus-a', T0)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a', T0 + 50)
    sealRun(ledger, 'p1', T0 + 60)
    sealRun(ledger, 'c1', T0 + 100)
    const v = assertComparable(ledger, 'c1', 'p1')
    expect(v.comparable).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/átfedtek|lezárása előtt indult/)
  })

  it('refuses a run labelled as the wrong arm', () => {
    begin('c1', 'PROACTIVE_SHADOW', 'corpus-a', T0)
    sealRun(ledger, 'c1', T0 + 10)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a', T0 + 20)
    sealRun(ledger, 'p1', T0 + 30)
    expect(assertComparable(ledger, 'c1', 'p1').reasons.join(' ')).toMatch(/nem REACTIVE_CONTROL/)
  })

  it('names a missing run instead of quietly comparing nothing', () => {
    expect(assertComparable(ledger, 'nope', 'also-nope').reasons).toHaveLength(2)
  })

  it('readRun returns null rather than throwing for an unknown id', () => {
    expect(readRun(ledger, 'nope')).toBeNull()
  })
})

// The CALIBRATION arm, added 2026-08-13 after Marveen measured the live store
// and found what §26/3 assumes does not exist: the Case layer is eight days
// deep on the personal side, six on the corporate one. There is no 90-day
// corpus to replay, anywhere.
//
// So the eligible-observation VOLUME — the thing the 90 days was a proxy for —
// has to be measured forward. A calibration run does that and nothing else, and
// the firewall below is what keeps it from contaminating the measurement it
// exists to size: V4-F14's named FAIL is choosing a threshold after seeing
// RESULTS, and results are what adjudication produces. Volume is not a result.
describe('the CALIBRATION arm is walled off from adjudication', () => {
  beforeEach(() => { ledger = newLedger() })

  it('HEADLINE: a calibration run may never enter an adjudication comparison', () => {
    beginRun(ledger, { runId: 'cal-1', arm: 'CALIBRATION', corpusFingerprint: 'corpus-a', config: CONFIG }, T0)
    sealRun(ledger, 'cal-1', T0 + 10)
    begin('p1', 'PROACTIVE_SHADOW', 'corpus-a', T0 + 20)
    sealRun(ledger, 'p1', T0 + 30)
    const v = assertComparable(ledger, 'cal-1', 'p1')
    expect(v.comparable).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/kalibrációs kimenet nem kerülhet adjudikációba/)
  })

  it('HEADLINE: calibrating a corpus disqualifies it for the control arm', () => {
    // A calibration run produces proactive output — unadjudicated, but seen. A
    // control built afterwards was built by someone who had seen it. The
    // consequence is a property worth having: calibration and measurement cannot
    // share a corpus.
    beginRun(ledger, { runId: 'cal-1', arm: 'CALIBRATION', corpusFingerprint: 'corpus-a', config: CONFIG }, T0)
    const control = begin('c1', 'REACTIVE_CONTROL', 'corpus-a', T0 + 10)
    expect(control.ok).toBe(false)
    if (!control.ok) expect(control.reason).toMatch(/CALIBRATION/)
  })

  it('a fresh corpus is still available for the real experiment', () => {
    beginRun(ledger, { runId: 'cal-1', arm: 'CALIBRATION', corpusFingerprint: 'corpus-a', config: CONFIG }, T0)
    expect(begin('c1', 'REACTIVE_CONTROL', 'corpus-b', T0 + 10).ok).toBe(true)
  })
})
