// §26(32) / §24.2: the instrumentation that joins the two arms to the value gate.
//
// After §26(26) there are two sealed replay runs. After §26(29) there is a
// canonical packet and a blinding test. Nothing connected them — this is that
// link, and the metrics on top of it.
//
// The rule that outranks every metric here, from §24.2:
//
//     "The value gate may be qualified as PASS only with a VALID
//      blinding-effectiveness status."
//
// A count of catches produced under broken blinding is not a weaker result. It
// is not a result. The headline tests below are about that ordering.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureReplaySchema, beginRun, recordOutput, sealRun,
} from '../cos/replay-run.js'
import {
  ensureAdjudicationSchema, recordJudgment, evaluateBlinding,
  type OriginLabel,
} from '../cos/adjudication.js'
import {
  compareArms, buildSessionFromRuns, evaluateValueGate, controlReproducibility,
  shadowEvalCounters, DEFAULT_VALUE_GATE_REGISTRATION,
  type PacketMapper,
} from '../cos/replay-eval.js'

const T0 = 1_700_000_000
let db: Database.Database

/** The one mapper, used for both arms — which is what makes parity structural
 *  rather than a thing somebody has to maintain. */
const MAPPER: PacketMapper = (out) => ({
  caseContextSummary: `Ugy ${out.caseId} a ${out.domain} domainen.`,
  evidenceRefs: [`case:${out.caseId}`],
  finding: `A motor dontese: ${out.decision}.`,
  materiality: 'HIGH' as const,
  timelinessRelevantTimestamps: [{ label: 'cycle', at: T0 + out.cycle * 600 }],
  proposedNextAction: 'Kovetkezo lepes elokeszitese.',
  rationale: out.reason || 'nincs kulon indoklas',
})

function arm(runId: string, armName: 'REACTIVE_CONTROL' | 'PROACTIVE_SHADOW', cases: string[], at: number): void {
  const r = beginRun(db, { runId, arm: armName, corpusFingerprint: 'corpus-a', config: { cycles: 1 } }, at)
  if (!r.ok) throw new Error(r.reason)
  cases.forEach(c => recordOutput(db, {
    runId, domain: 'personal', caseId: c, cycle: 1, decision: 'CONTINUE_AUTONOMOUSLY', reason: '',
  }))
  sealRun(db, runId, at + 10)
}

/** Control first, then proactive — the §1.4.6 order the ledger enforces. */
function twoArms(controlCases: string[], proactiveCases: string[]): void {
  arm('ctl-1', 'REACTIVE_CONTROL', controlCases, T0)
  arm('sh-1', 'PROACTIVE_SHADOW', proactiveCases, T0 + 100)
}

function build(sessionId = 's1') {
  return buildSessionFromRuns(db, {
    sessionId, controlRunId: 'ctl-1', proactiveRunId: 'sh-1',
    rubricVersion: 'rubric-1', shuffleSeed: 'seed-1', mapper: MAPPER,
  }, T0 + 200)
}

/** Judge every packet. `guessCorrect` drives the blinding outcome; `material`
 *  drives the catch count. */
function judgeAll(sessionId: string, opts: { correctRate: number; material?: boolean }): void {
  const rows = db.prepare(
    `SELECT packet_id, origin_label FROM adjudication_packets WHERE session_id = ? ORDER BY ordinal`,
  ).all(sessionId) as Array<{ packet_id: string; origin_label: OriginLabel }>
  rows.forEach((row, i) => {
    const right = i < Math.round(rows.length * opts.correctRate)
    const guess: OriginLabel = right
      ? row.origin_label
      : (row.origin_label === 'PROACTIVE' ? 'REACTIVE' : 'PROACTIVE')
    const r = recordJudgment(db, {
      packetId: row.packet_id, adjudicatorId: 'istvan', judgment: 'ok',
      timely: true, material: opts.material ?? true,
      originGuess: guess, originGuessConfidence: 'MEDIUM',
      judgedAt: T0 + 300 + i, rubricVersion: 'rubric-1',
    })
    if (!r.ok) throw new Error(r.reason)
  })
}

describe('§26(32) comparing the two arms', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db)
  })

  it('HEADLINE: says what only the proactive arm reached — and what only the control did', () => {
    // The second half matters as much as the first. A proactive arm that MISSES
    // what the baseline caught is the failure nobody thinks to look for, because
    // the release is being sold on what it adds.
    twoArms(['a', 'b'], ['b', 'c'])
    const c = compareArms(db, 'ctl-1', 'sh-1')
    expect(c.proactiveOnly).toEqual(['personal/c'])
    expect(c.controlOnly).toEqual(['personal/a'])
    expect(c.bothArms).toEqual(['personal/b'])
  })

  it('keys on domain AND case, so a shared id across domains is two cases', () => {
    arm('ctl-1', 'REACTIVE_CONTROL', [], T0)
    beginRun(db, { runId: 'sh-1', arm: 'PROACTIVE_SHADOW', corpusFingerprint: 'corpus-a', config: {} }, T0 + 100)
    recordOutput(db, { runId: 'sh-1', domain: 'personal', caseId: 'x', cycle: 1, decision: 'D', reason: '' })
    recordOutput(db, { runId: 'sh-1', domain: 'zst', caseId: 'x', cycle: 1, decision: 'D', reason: '' })
    sealRun(db, 'sh-1', T0 + 110)
    expect(compareArms(db, 'ctl-1', 'sh-1').proactiveOnly).toEqual(['personal/x', 'zst/x'])
  })

  it('does NOT judge — it says who touched what, nothing more', () => {
    // Deciding here whether a proactive-only touch was worth anything would be
    // the system marking its own work; §1.4.3 sends that question to a blind
    // human on purpose.
    twoArms(['a'], ['b'])
    const c = compareArms(db, 'ctl-1', 'sh-1')
    expect(Object.keys(c).sort()).toEqual(
      ['bothArms', 'controlCases', 'controlOnly', 'proactiveCases', 'proactiveOnly'],
    )
  })
})

describe('§26(32) building the blind session from two sealed runs', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db)
  })

  it('HEADLINE: refuses before doing anything when the arms are not comparable', () => {
    // Cheap to check, and the alternative is expensive in the worst way: an
    // adjudicator's afternoon on packets that were never admissible, and a
    // number at the end that looks exactly like a valid one.
    arm('ctl-1', 'REACTIVE_CONTROL', ['a'], T0)
    beginRun(db, { runId: 'sh-1', arm: 'PROACTIVE_SHADOW', corpusFingerprint: 'corpus-B', config: {} }, T0 + 100)
    recordOutput(db, { runId: 'sh-1', domain: 'personal', caseId: 'b', cycle: 1, decision: 'D', reason: '' })
    sealRun(db, 'sh-1', T0 + 110)
    const r = build()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/ugyanazon a korpuszon/)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM adjudication_packets`).get()).toEqual({ n: 0 })
  })

  it('refuses an unsealed arm', () => {
    arm('ctl-1', 'REACTIVE_CONTROL', ['a'], T0)
    beginRun(db, { runId: 'sh-1', arm: 'PROACTIVE_SHADOW', corpusFingerprint: 'corpus-a', config: {} }, T0 + 100)
    recordOutput(db, { runId: 'sh-1', domain: 'personal', caseId: 'b', cycle: 1, decision: 'D', reason: '' })
    const r = build()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/nincs lezárva/)
  })

  it('HEADLINE: one mapper drives both arms, so parity is structural', () => {
    // The cheapest way to break §1.4.3 parity is two mappers kept in step by
    // hand. There is one, it takes no arm argument, and it therefore cannot
    // differ between the sides.
    twoArms(['a', 'b'], ['b', 'c'])
    const r = build()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packetCount).toBe(4)
    const packets = db.prepare(`SELECT canonical_json FROM adjudication_packets`).all() as Array<{ canonical_json: string }>
    const shapes = new Set(packets.map(p => Object.keys(JSON.parse(p.canonical_json)).sort().join(',')))
    expect(shapes.size).toBe(1)
  })

  it('the packets carry no arm marking that reaches the adjudicator', () => {
    twoArms(['a'], ['b'])
    build()
    const packets = db.prepare(`SELECT canonical_json FROM adjudication_packets`).all() as Array<{ canonical_json: string }>
    const body = packets.map(p => {
      const o = JSON.parse(p.canonical_json) as Record<string, unknown>
      delete o.packetId          // the id is traceability, and never shown as origin
      return JSON.stringify(o)
    }).join(' ')
    expect(body).not.toMatch(/ctl-1|sh-1|REACTIVE|PROACTIVE/)
  })
})

describe('§24.2 the value gate — blinding can only veto', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db)
  })

  /** 20 shared + 40 proactive-only cases: enough packets for the blinding
   *  minimum and enough proactive-only cases for the catch threshold. */
  function bigSession(): void {
    const shared = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const only = Array.from({ length: 40 }, (_, i) => `p${i}`)
    twoArms(shared, [...shared, ...only])
    const r = build()
    if (!r.ok) throw new Error(r.reasons.join('; '))
  }

  it('HEADLINE: broken blinding is FAIL, whatever the catch count says', () => {
    // Not a smaller result — not a result. Printing the catches next to a failed
    // blinding status invites exactly the reading the spec forbids ("we caught
    // seven, admittedly the blinding was iffy").
    bigSession()
    judgeAll('s1', { correctRate: 0.95 })
    const g = evaluateValueGate(db, 's1')
    expect(g.blinding.verdict).toBe('VALUE_GATE_ADJUDICATION_CAPABILITY_GAP')
    expect(g.result).toBe('FAIL')
    expect(g.incrementalMaterialCatchCount).toBeGreaterThan(DEFAULT_VALUE_GATE_REGISTRATION.requiredCatches)
  })

  it('HEADLINE: too few judged packets is EVALUATION_WINDOW_DEGRADED, not PASS', () => {
    twoArms(['a'], ['b', 'c'])
    build()
    judgeAll('s1', { correctRate: 0.5 })
    const g = evaluateValueGate(db, 's1')
    expect(g.blinding.verdict).toBe('BLINDING_EVIDENCE_INSUFFICIENT')
    expect(g.result).toBe('EVALUATION_WINDOW_DEGRADED')
  })

  it('with valid blinding and enough catches, it passes', () => {
    bigSession()
    judgeAll('s1', { correctRate: 0.5 })
    const g = evaluateValueGate(db, 's1')
    expect(g.blinding.verdict).toBe('VALID')
    expect(g.result).toBe('PASS')
    expect(g.incrementalMaterialCatchCount).toBe(40)
  })

  it('valid blinding but nothing judged material is a FAIL, not a pass by default', () => {
    bigSession()
    judgeAll('s1', { correctRate: 0.5, material: false })
    const g = evaluateValueGate(db, 's1')
    expect(g.blinding.verdict).toBe('VALID')
    expect(g.result).toBe('FAIL')
    expect(g.incrementalMaterialCatchCount).toBe(0)
  })

  it('HEADLINE: a catch counts only when the control never reached that case', () => {
    // Shared cases are judged material too, and must not inflate the number the
    // release gate reads.
    bigSession()
    judgeAll('s1', { correctRate: 0.5 })
    const g = evaluateValueGate(db, 's1')
    expect(g.missedByReactiveBaselineCount).toBe(40)
    // 60 proactive packets are material; only the 40 proactive-only ones count.
    expect(g.incrementalMaterialCatchCount).toBe(40)
  })

  it('too few observations says so, instead of reporting FAIL on a question it could not ask', () => {
    twoArms([], ['a', 'b'])
    build()
    // Force a valid blinding verdict on a tiny sample by lowering the bar the
    // session registered with... which is not possible, and that is the point:
    // the registration is frozen. So this asserts the DEGRADED path instead.
    judgeAll('s1', { correctRate: 0.5 })
    expect(evaluateValueGate(db, 's1').result).toBe('EVALUATION_WINDOW_DEGRADED')
  })

  it('reports coverage, so a half-judged session cannot look complete', () => {
    bigSession()
    const rows = db.prepare(`SELECT packet_id FROM adjudication_packets WHERE session_id='s1' LIMIT 10`)
      .all() as Array<{ packet_id: string }>
    rows.forEach((r, i) => recordJudgment(db, {
      packetId: r.packet_id, adjudicatorId: 'i', judgment: 'ok', timely: true, material: true,
      originGuess: 'PROACTIVE', originGuessConfidence: 'LOW', judgedAt: T0 + 400 + i, rubricVersion: 'rubric-1',
    }))
    const g = evaluateValueGate(db, 's1')
    // 20 control packets + 60 proactive = 80; ten judged.
    expect(g.blindAdjudicationCoverageRate).toBeCloseTo(10 / 80, 3)
  })
})

describe('§1.4.6(5) reproducibility, and the metrics that refuse to be faked', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db)
  })

  it('HEADLINE: a single control run has NO reproducibility rate — null, not 1.0', () => {
    // A perfect score reported for never having tried is the exact shape of
    // metric this release is supposed to stop producing.
    arm('ctl-1', 'REACTIVE_CONTROL', ['a'], T0)
    expect(controlReproducibility(db, 'ctl-1')).toBeNull()
  })

  it('two identical control runs reproduce; a differing one drags the rate down', () => {
    arm('ctl-1', 'REACTIVE_CONTROL', ['a'], T0)
    arm('ctl-2', 'REACTIVE_CONTROL', ['a'], T0 + 20)
    expect(controlReproducibility(db, 'ctl-1')).toBe(1)
    arm('ctl-3', 'REACTIVE_CONTROL', ['a', 'b'], T0 + 40)
    expect(controlReproducibility(db, 'ctl-1')).toBeCloseTo(2 / 3, 3)
  })

  it('HEADLINE: §21.1 metrics that need a ground truth are NAMED unavailable, not zeroed', () => {
    // A capability gap wearing a metric's clothes is what §22's fixture-set
    // acceptance rules out by name: "any capability gap is reported as a
    // capability gap rather than a false zero/green metric".
    twoArms(['a'], ['a', 'b'])
    const c = shadowEvalCounters(db, 'ctl-1', 'sh-1')
    expect(c.unavailable.map(u => u.metric)).toEqual([
      'true_positive_rate', 'false_positive_rate', 'missed_material_signal_rate',
    ])
    for (const u of c.unavailable) expect(u.why.length).toBeGreaterThan(20)
  })

  it('the counters it CAN compute are computed', () => {
    twoArms(['a'], ['a', 'b'])
    const c = shadowEvalCounters(db, 'ctl-1', 'sh-1')
    expect(c.existingCaseReuseRate).toBeCloseTo(0.5, 3)
    expect(c.duplicateInitiativeRate).toBe(0)
  })
})
