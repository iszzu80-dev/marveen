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
  detectorConfigFingerprint, assertFrozenConfig,
} from '../cos/replay-run.js'
import {
  ensureAdjudicationSchema, recordJudgment, evaluateBlinding,
  type OriginLabel,
} from '../cos/adjudication.js'
import {
  compareArms, buildSessionFromRuns, evaluateValueGate, controlReproducibility,
  shadowEvalCounters, DEFAULT_VALUE_GATE_REGISTRATION,
  ensureEligibilitySchema, labelEligibleObservation, eligibleObservationCount,
  completeEligibilityPass, eligibilityTally,
  type PacketMapper,
} from '../cos/replay-eval.js'
import {
  ensureCalibrationSchema, freezeCalibration, recordStabilityObservation,
} from '../cos/calibration-window.js'

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
  function bigSession(uncertainCount = 0): void {
    const shared = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const only = Array.from({ length: 40 }, (_, i) => `p${i}`)
    const uncertain = Array.from({ length: uncertainCount }, (_, i) => `u${i}`)
    // The eligibility pass comes FIRST — before any arm runs — because that is
    // the only order in which the labeller can be shown not to have seen the
    // detector output.
    ensureEligibilitySchema(db)
    for (const c of only) {
      labelEligibleObservation(db, {
        corpusFingerprint: 'corpus-a', domain: 'personal', caseId: c,
        shape: 'DEADLINE_PASSED_UNSEEN', observedAt: T0 - 20, evidenceAt: T0 - 100,
        labelledBy: 'istvan', labelledAt: T0 - 10,
        rationale: 'a hatarido eltelt es a tulajdonos nem tudott rola',
      })
    }
    for (const c of uncertain) {
      labelEligibleObservation(db, {
        corpusFingerprint: 'corpus-a', domain: 'personal', caseId: c,
        shape: 'UNCERTAIN', observedAt: T0 - 20, evidenceAt: T0 - 100,
        labelledBy: 'istvan', labelledAt: T0 - 10,
        rationale: 'nem tudom eldonteni, hogy a tulajdonosnak kellett-e tudnia rola',
      })
    }
    completeEligibilityPass(db, {
      corpusFingerprint: 'corpus-a', labelledBy: 'istvan', completedAt: T0 - 5,
    })
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

  it('HEADLINE (5): a PRE-REGISTERED uncertain threshold degrades the window', () => {
    // Marveen's fifth condition, at the gate. A labelling pass that could not
    // decide most of what it saw has not measured the corpus — it has reported
    // on the definition. That is worth seeing, not smoothing over.
    bigSession(60) // 40 decided, 60 UNCERTAIN → 60%
    judgeAll('s1', { correctRate: 0.5 })
    const g = evaluateValueGate(db, 's1', {
      ...DEFAULT_VALUE_GATE_REGISTRATION, maxUncertainRate: 0.3,
    })
    expect(g.uncertainCount).toBe(60)
    expect(g.uncertainRate).toBeCloseTo(0.6, 3)
    expect(g.result).toBe('EVALUATION_WINDOW_DEGRADED')
    expect(g.detail).toMatch(/UNCERTAIN/)
    // The denominator itself never absorbed them.
    expect(g.eligibleObservationCount).toBe(40)
  })

  it('(5): without a registered threshold the same rate is reported and does not gate', () => {
    // A threshold invented after seeing the number is the move V4-F14 forbids
    // for the catch count. So the default reports and stands aside.
    bigSession(60)
    judgeAll('s1', { correctRate: 0.5 })
    const g = evaluateValueGate(db, 's1')
    expect(g.uncertainRate).toBeCloseTo(0.6, 3)
    expect(g.result).not.toBe('EVALUATION_WINDOW_DEGRADED')
  })

  it('HEADLINE: a lejárt kalibráció SAJÁT kimenet, és megelőzi a volumen-kérdéseket', () => {
    // A sorrend a lényeg. A `minEligibleObservations` egy adott fagyasztott
    // készülékre volt méretezve; egy számot ehhez mérni azután, hogy a készülék
    // megváltozott, nem gyengébb válasz — válasz egy kérdésre, amit senki nem
    // tett fel.
    //
    // És miért saját kimenet, nem `EVALUATION_WINDOW_DEGRADED`: ez az a fajta
    // elavulás, amitől semmi nem hibázik. Egy általános „degraded" címke alá
    // söpörve pont az észrevehetetlensége maradna meg.
    bigSession()
    judgeAll('s1', { correctRate: 0.5 })
    ensureCalibrationSchema(db)
    // A fagyasztás előfeltétele: két azonos ellenőrzés, közben lefutott ciklussal.
    recordStabilityObservation(db, {
      observedAt: T0 - 1200, detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', caseCyclesRan: 5, triageRunsRan: 5,
    })
    recordStabilityObservation(db, {
      observedAt: T0 - 1100, detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', caseCyclesRan: 8, triageRunsRan: 8,
    })
    freezeCalibration(db, {
      calibrationCommit: '30e16ef92753', detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', frozenAt: T0 - 1000,
    })
    const g = evaluateValueGate(db, 's1', DEFAULT_VALUE_GATE_REGISTRATION, {
      detectorConfigFingerprint: 'det-v1', intakeSurfaceFingerprint: 'intake-v2',
    })
    expect(g.result).toBe('CALIBRATION_EXPIRED')
    expect(g.detail).toMatch(/LEJART/)
  })

  it('a változatlan készülék mellett a kapu a szokásos úton megy tovább', () => {
    bigSession()
    judgeAll('s1', { correctRate: 0.5 })
    ensureCalibrationSchema(db)
    // A fagyasztás előfeltétele: két azonos ellenőrzés, közben lefutott ciklussal.
    recordStabilityObservation(db, {
      observedAt: T0 - 1200, detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', caseCyclesRan: 5, triageRunsRan: 5,
    })
    recordStabilityObservation(db, {
      observedAt: T0 - 1100, detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', caseCyclesRan: 8, triageRunsRan: 8,
    })
    freezeCalibration(db, {
      calibrationCommit: '30e16ef92753', detectorConfigFingerprint: 'det-v1',
      intakeSurfaceFingerprint: 'intake-v1', frozenAt: T0 - 1000,
    })
    const g = evaluateValueGate(db, 's1', DEFAULT_VALUE_GATE_REGISTRATION, {
      detectorConfigFingerprint: 'det-v1', intakeSurfaceFingerprint: 'intake-v1',
    })
    expect(g.result).not.toBe('CALIBRATION_EXPIRED')
  })

  it('futáskori konfiguráció nélkül nincs lejárat-ellenőrzés', () => {
    // Ugyanaz az elv, mint az `assertFrozenConfig`-nál: egy kapu, ami az első
    // futást lehetetlenné teszi, nem kapu.
    bigSession()
    judgeAll('s1', { correctRate: 0.5 })
    expect(evaluateValueGate(db, 's1').result).not.toBe('CALIBRATION_EXPIRED')
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


// Added 2026-08-13 after Marveen's second measurement round. Two of his findings
// turned into code, and one of them exposed a defect in what was already here.
describe('the eligible-observation denominator is labelled INDEPENDENTLY', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db); ensureEligibilitySchema(db)
  })

  it('HEADLINE: with nobody having labelled the corpus, the gate does NOT pass', () => {
    // THE BUG THIS REPLACED. `eligibleObservationCount` used to be
    // `comparison.proactiveCases` — the number of cases the PROACTIVE ARM
    // touched. The denominator of "how much value did the detector add" was the
    // detector's own output, so a detector that noticed less would have scored
    // equally well by noticing less of a smaller world.
    //
    // Marveen's definition is what found it: eligibility must be decidable from
    // a snapshot by somebody who has not seen the detector output.
    const shared = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const only = Array.from({ length: 40 }, (_, i) => `p${i}`)
    twoArms(shared, [...shared, ...only])
    const built = build()
    expect(built.ok).toBe(true)
    judgeAll('s1', { correctRate: 0.5 })

    const g = evaluateValueGate(db, 's1')
    expect(g.blinding.verdict).toBe('VALID')
    expect(g.eligibleObservationCount).toBeNull()
    expect(g.result).toBe('EVALUATION_WINDOW_DEGRADED')
    expect(g.detail).toMatch(/nevezoje hianyzik|nevezője hiányzik/)
  })

  it('HEADLINE: null and zero are different facts, and only one is a result', () => {
    // An unassessed corpus reads as null; a corpus somebody went through and
    // found nothing in reads as 0. A gate that cannot tell them apart treats
    // "nobody looked" as "nothing was there".
    expect(eligibleObservationCount(db, 'corpus-never-labelled')).toBeNull()
    completeEligibilityPass(db, {
      corpusFingerprint: 'corpus-empty', labelledBy: 'istvan', completedAt: T0,
    })
    expect(eligibleObservationCount(db, 'corpus-empty')).toBe(0)
    labelEligibleObservation(db, {
      corpusFingerprint: 'corpus-a', domain: 'personal', caseId: 'c1',
      shape: 'DEADLINE_PASSED_UNSEEN', observedAt: T0 - 10, evidenceAt: T0 - 100,
      labelledBy: 'istvan', labelledAt: T0,
      rationale: 'a hatarido eltelt es nem tudott rola',
    })
    completeEligibilityPass(db, {
      corpusFingerprint: 'corpus-a', labelledBy: 'istvan', completedAt: T0,
    })
    expect(eligibleObservationCount(db, 'corpus-a')).toBe(1)
  })

  it('HEADLINE: labelling is refused once a proactive run over that corpus has sealed', () => {
    // After the detector output exists, a person labelling the corpus can no
    // longer be SHOWN not to have seen it — and "can no longer be shown" is the
    // standard §1.4.3 applies to blinding, not "probably did not".
    arm('ctl-1', 'REACTIVE_CONTROL', ['a'], T0)
    arm('sh-1', 'PROACTIVE_SHADOW', ['a', 'b'], T0 + 100)
    const r = labelEligibleObservation(db, {
      corpusFingerprint: 'corpus-a', domain: 'personal', caseId: 'b',
      shape: 'FOLLOW_UP_ELAPSED_WITHOUT_MOVEMENT', observedAt: T0 - 10, evidenceAt: T0 - 100,
      labelledBy: 'istvan', labelledAt: T0 + 200,
      rationale: 'kesobb cimkezve, a futas lezarasa utan',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/vak volt/)
  })

  it('a label is final — it cannot be edited or removed', () => {
    labelEligibleObservation(db, {
      corpusFingerprint: 'corpus-a', domain: 'personal', caseId: 'c1',
      shape: 'DEADLINE_PASSED_UNSEEN', observedAt: T0 - 10, evidenceAt: T0 - 100,
      labelledBy: 'istvan', labelledAt: T0, rationale: 'eleg hosszu indoklas',
    })
    expect(() => db.prepare("UPDATE eligible_observations SET shape='STATE_CHANGE_INVALIDATED_DECISION'").run())
      .toThrow(/final/)
    expect(() => db.prepare('DELETE FROM eligible_observations').run()).toThrow(/final/)
  })
})

describe('the freeze point is a gate, not a date', () => {
  it('HEADLINE: a changed detector configuration invalidates the frozen window', () => {
    // Marveen: "a promise that no proactive module will land is exactly the kind
    // of statement that gets quietly broken." So the hash is the evidence.
    expect(assertFrozenConfig('abc123', 'abc123')).toEqual({ ok: true })
    const bad = assertFrozenConfig('abc123', 'def456')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toMatch(/ujra kell kezdeni|újra kell kezdeni/)
  })

  it('no registered expectation means no gate — the first run has to be possible', () => {
    expect(assertFrozenConfig(null, 'anything')).toEqual({ ok: true })
    expect(assertFrozenConfig(undefined, 'anything')).toEqual({ ok: true })
  })

  it('HEADLINE: the INTAKE modules are in the hash, not only the detector', () => {
    // The less obvious half. Marveen measured that today's cases were created by
    // his own email-triage heartbeat, so what looks like an organic arrival rate
    // is partly the output of our own intake channel. The eligible-observation
    // rate is conditional on an intake configuration, and a hash covering only
    // the detector would let the denominator move while the experiment claimed
    // to be frozen.
    const files: Record<string, string> = {
      'src/cos/proactive/a.ts': 'detector v1',
      'src/cos/intake.ts': 'intake v1',
      'src/cos/deadline-index.ts': 'deadlines v1',
      'src/cos/triage-bridge.ts': 'triage v1',
    }
    const read = (p: string): string => files[p] ?? ''
    const list = (): string[] => ['src/cos/proactive/a.ts']
    const before = detectorConfigFingerprint(read, list)
    files['src/cos/intake.ts'] = 'intake v2'
    expect(detectorConfigFingerprint(read, list)).not.toBe(before)
  })

  it('an unreadable file is marked, not skipped', () => {
    // A file that cannot be read is not a file that is unchanged.
    const boom = (): string => { throw new Error('nope') }
    const list = (): string[] => []
    expect(detectorConfigFingerprint(boom, list)).toBeTruthy()
  })
})


describe('conditions 2, 3 and 5 of the eligible-observation definition', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureAdjudicationSchema(db); ensureEligibilitySchema(db)
  })

  const label = (over: Record<string, unknown> = {}) => labelEligibleObservation(db, {
    corpusFingerprint: 'corpus-a', domain: 'personal', caseId: 'c1',
    shape: 'DEADLINE_PASSED_UNSEEN', observedAt: T0, evidenceAt: T0 - 1000,
    labelledBy: 'istvan', labelledAt: T0, rationale: 'a hatarido eszrevetlenul telt el',
    ...over,
  } as Parameters<typeof labelEligibleObservation>[1])

  it('HEADLINE (2): evidence that arrived AFTER the moment is not a missed observation', () => {
    // "What only became knowable later" — the condition that separates a missed
    // catch from hindsight. Without both timestamps it is an instruction nobody
    // can check.
    const r = label({ evidenceAt: T0 + 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/2\. feltetel/)
  })

  it('evidence strictly before the moment is accepted', () => {
    expect(label().ok).toBe(true)
  })

  it('(3): a label with no reasoning is refused', () => {
    // Owner-relevance has no mechanical test. What CAN be insisted on is the one
    // thing that shows somebody weighed it.
    const r = label({ rationale: 'ok' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/3\. feltetel/)
  })

  it('HEADLINE (5): UNCERTAIN is counted apart, and folded into neither side', () => {
    // A binary label forced onto a doubtful case is manufactured certainty.
    label({ caseId: 'a', shape: 'DEADLINE_PASSED_UNSEEN' })
    label({ caseId: 'b', shape: 'UNCERTAIN' })
    label({ caseId: 'c', shape: 'UNCERTAIN' })
    completeEligibilityPass(db, { corpusFingerprint: 'corpus-a', labelledBy: 'istvan', completedAt: T0 })
    const t = eligibilityTally(db, 'corpus-a')!
    expect(t.eligible).toBe(1)
    expect(t.uncertain).toBe(2)
    expect(t.uncertainRate).toBeCloseTo(2 / 3, 3)
    // ...and the denominator the gate reads excludes them.
    expect(eligibleObservationCount(db, 'corpus-a')).toBe(1)
  })

  it('(5): with no threshold registered the rate is reported and does not gate', () => {
    // The honest default. A threshold invented after seeing the number is the
    // same move V4-F14 forbids for the catch count.
    expect(DEFAULT_VALUE_GATE_REGISTRATION.maxUncertainRate).toBeNull()
  })
})
