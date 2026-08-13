// §1.4.3 / §26(29): the canonical adjudication packet and the blinding test.
//
// §1.4's value gate asks a human whether the proactive side produced something
// the reactive baseline did not. The judgement is worthless if the judge can
// tell which side wrote which packet — and the spec is explicit that hiding the
// origin label is NOT the same as blinding being effective:
//
//     "Blinding is not proven merely by the origin label being hidden; whether
//      the origin can be inferred FROM THE SHAPE OF THE PACKET must be measured."
//
// So the tests split the same way the module does: parity (can the shape tell?)
// and measurement (did the judge actually tell?). Conflating them is the risk.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureAdjudicationSchema, buildSession, packetsForAdjudicator, recordJudgment,
  unblind, evaluateBlinding, parityViolations, canonicalise, shuffle,
  powerAt, minSampleForPower, criticalValue, binomialTailGE,
  registrationDigest, DEFAULT_BLINDING_REGISTRATION, CANONICAL_PACKET_FIELDS,
  type OriginLabel, type GuessConfidence,
} from '../cos/adjudication.js'

const T0 = 1_700_000_000
let db: Database.Database

function raw(id: string, over: Record<string, unknown> = {}) {
  return {
    packetId: id,
    caseContextSummary: 'A berleti szerzodes felmondasi hatarideje kozeledik.',
    evidenceRefs: ['doc-2', 'doc-1'],
    finding: 'A felmondasi hatarido 2026-09-01, es meg nincs dontes.',
    materiality: 'HIGH' as const,
    timelinessRelevantTimestamps: [
      { label: 'source_event', at: T0 - 7 * 86400 },
      { label: 'deadline', at: T0 + 30 * 86400 },
    ],
    proposedNextAction: 'Dontes elokeszitese a felmondasrol.',
    rationale: 'A hatarido elmulasztasa automatikus hosszabbitast jelent.',
    ...over,
  }
}

/** A session with `n` packets, alternating arms. */
function session(n: number, sessionId = 's1'): void {
  const packets = Array.from({ length: n }, (_, i) => ({
    origin: (i % 2 === 0 ? 'PROACTIVE' : 'REACTIVE') as OriginLabel,
    raw: raw(`pk-${String(i).padStart(3, '0')}`),
  }))
  const r = buildSession(db, {
    sessionId, controlRunId: 'ctl-1', proactiveRunId: 'sh-1',
    rubricVersion: 'rubric-1', shuffleSeed: 'seed-1', packets,
  }, T0)
  if (!r.ok) throw new Error(`fixture session refused: ${r.reasons.join('; ')}`)
}

/** Judge every packet. `correctRate` picks how often the guess is right, so a
 *  blinding failure can be simulated deterministically. */
function judgeAll(sessionId = 's1', correctRate = 0.5, conf: GuessConfidence = 'MEDIUM'): void {
  const rows = db.prepare(
    `SELECT packet_id, origin_label FROM adjudication_packets WHERE session_id = ? ORDER BY ordinal`,
  ).all(sessionId) as Array<{ packet_id: string; origin_label: OriginLabel }>
  rows.forEach((row, i) => {
    const beRight = i < Math.round(rows.length * correctRate)
    const guess: OriginLabel = beRight
      ? row.origin_label
      : (row.origin_label === 'PROACTIVE' ? 'REACTIVE' : 'PROACTIVE')
    const r = recordJudgment(db, {
      packetId: row.packet_id, adjudicatorId: 'istvan', judgment: 'hasznos',
      timely: true, material: true, originGuess: guess, originGuessConfidence: conf,
      judgedAt: T0 + 100 + i, rubricVersion: 'rubric-1',
    })
    if (!r.ok) throw new Error(r.reason)
  })
}

describe('§1.4.3 parity — the shape must not carry the origin', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureAdjudicationSchema(db) })

  it('HEADLINE: a proactive-only field is refused at build time', () => {
    // An adjudicator does not need to understand `plannerTrace` to notice that
    // half the packets have a field the other half never do. That IS
    // above-chance origin inference from packet form.
    const r = buildSession(db, {
      sessionId: 's1', controlRunId: 'c', proactiveRunId: 'p',
      rubricVersion: 'v1', shuffleSeed: 'x',
      packets: [
        { origin: 'PROACTIVE', raw: raw('a', { plannerTrace: ['step1'] }) as never },
        { origin: 'REACTIVE', raw: raw('b') },
      ],
    }, T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/plannerTrace/)
  })

  it('names every non-canonical field, not just the recognised tells', () => {
    const v = parityViolations([{ packetId: 'a', raw: { ...raw('a'), somethingNew: 1 } }])
    expect(v.map(x => x.field)).toContain('somethingNew')
  })

  it('the canonical type has no origin field at all — not hidden, absent', () => {
    // "Do not display the proactive-only fields" is a weaker rule than "do not
    // have them". A field on the object reaches the screen the moment somebody
    // adds a debug dump.
    expect(CANONICAL_PACKET_FIELDS as readonly string[]).not.toContain('origin')
    const c = canonicalise(raw('a')) as unknown as Record<string, unknown>
    expect(Object.keys(c).sort()).toEqual([...CANONICAL_PACKET_FIELDS].sort())
  })

  it('HEADLINE: canonicalisation normalises ORDER, because order is an origin tell', () => {
    // §1.4.3 lists "source-specific ordering" by name. If one arm emits refs
    // newest-first and the other oldest-first, the order IS the origin label,
    // spelled differently.
    const a = canonicalise(raw('x', { evidenceRefs: ['doc-2', 'doc-1'] }))
    const b = canonicalise(raw('x', { evidenceRefs: ['doc-1', 'doc-2'] }))
    expect(a.evidenceRefs).toEqual(b.evidenceRefs)
    expect(a.timelinessRelevantTimestamps[0].label).toBe('source_event')
  })

  it('refuses a session containing only one arm', () => {
    // Every guess would be correct, and the accuracy metric would report perfect
    // origin inference for a reason that has nothing to do with blinding.
    const r = buildSession(db, {
      sessionId: 's1', controlRunId: 'c', proactiveRunId: 'p',
      rubricVersion: 'v1', shuffleSeed: 'x',
      packets: [{ origin: 'PROACTIVE', raw: raw('a') }, { origin: 'PROACTIVE', raw: raw('b') }],
    }, T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/mindkét ágból/)
  })
})

describe('§1.4.3 the adjudicator never sees the origin', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureAdjudicationSchema(db); session(6) })

  it('HEADLINE: the packets handed over carry no origin, under any key', () => {
    const packets = packetsForAdjudicator(db, 's1')
    expect(packets).toHaveLength(6)
    const serialised = JSON.stringify(packets)
    expect(serialised).not.toMatch(/PROACTIVE|REACTIVE|origin/i)
  })

  it('the order is randomised, and reproducible from the stored seed', () => {
    // Randomised so the arms do not alternate on screen; reproducible because a
    // frozen experiment whose randomisation cannot be replayed is one nobody can
    // check.
    const ordinals = db.prepare(
      `SELECT origin_label FROM adjudication_packets WHERE session_id='s1' ORDER BY ordinal`,
    ).all() as Array<{ origin_label: string }>
    const labels = ordinals.map(o => o.origin_label)
    expect(labels.join('')).not.toBe('PROACTIVEREACTIVEPROACTIVEREACTIVEPROACTIVEREACTIVE')
    expect(shuffle([1, 2, 3, 4, 5], 'seed-1')).toEqual(shuffle([1, 2, 3, 4, 5], 'seed-1'))
    expect(shuffle([1, 2, 3, 4, 5], 'seed-1')).not.toEqual(shuffle([1, 2, 3, 4, 5], 'seed-2'))
  })

  it('HEADLINE: unblinding is refused while any packet is unjudged', () => {
    // Whole-session, not per packet. Unblinding one tells the judge which way
    // the coin landed, and every judgement after that is informed — the sample
    // would be half blind and reported as whole.
    expect(unblind(db, 's1', T0 + 1)).toMatchObject({ ok: false })
    judgeAll('s1')
    expect(unblind(db, 's1', T0 + 999)).toMatchObject({ ok: true })
  })

  it('a judgement recorded AFTER unblinding is refused', () => {
    const rows = db.prepare(`SELECT packet_id FROM adjudication_packets WHERE session_id='s1'`)
      .all() as Array<{ packet_id: string }>
    judgeAll('s1')
    unblind(db, 's1', T0 + 999)
    // The record already exists, so re-recording is refused twice over; the
    // session check is what this pins.
    const r = recordJudgment(db, {
      packetId: rows[0].packet_id, adjudicatorId: 'x', judgment: 'y', timely: true, material: true,
      originGuess: 'PROACTIVE', originGuessConfidence: 'HIGH', judgedAt: T0 + 1000, rubricVersion: 'rubric-1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/fel van fedve/)
  })

  it('V4-F13: a rubric that differs from the session is refused', () => {
    const row = db.prepare(`SELECT packet_id FROM adjudication_packets WHERE session_id='s1' LIMIT 1`)
      .get() as { packet_id: string }
    const r = recordJudgment(db, {
      packetId: row.packet_id, adjudicatorId: 'x', judgment: 'y', timely: true, material: true,
      originGuess: 'PROACTIVE', originGuessConfidence: 'HIGH', judgedAt: T0 + 1, rubricVersion: 'rubric-2',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/rubrika/)
  })

  it('a judgement is final — it cannot be edited or deleted', () => {
    judgeAll('s1')
    expect(() => db.prepare(`UPDATE adjudication_records SET origin_guess='PROACTIVE'`).run())
      .toThrow(/final/)
    expect(() => db.prepare(`DELETE FROM adjudication_records`).run()).toThrow(/final/)
  })
})

describe('§1.4.3 the blinding test is fail-closed', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureAdjudicationSchema(db) })

  it('HEADLINE: too few packets is NOT a pass', () => {
    // "The release may be mechanically complete, but it does not qualify as
    // valid value-gate evidence." Silence is not success.
    session(10)
    judgeAll('s1', 0.5)
    const r = evaluateBlinding(db, 's1')
    expect(r.verdict).toBe('BLINDING_EVIDENCE_INSUFFICIENT')
    expect(r.sampleSize).toBe(10)
  })

  it('the sample check comes FIRST, so a small significant sample is not a false alarm', () => {
    // A significant p-value on nine packets is evidence of nine packets, not of
    // broken blinding. Reporting the capability gap there would be a false alarm
    // with the authority of a statistical test.
    session(10)
    judgeAll('s1', 1.0)
    expect(evaluateBlinding(db, 's1').verdict).toBe('BLINDING_EVIDENCE_INSUFFICIENT')
  })

  it('HEADLINE: a judge who can pick the origin is NOT a pass either', () => {
    session(40)
    judgeAll('s1', 0.9)
    const r = evaluateBlinding(db, 's1')
    expect(r.verdict).toBe('VALUE_GATE_ADJUDICATION_CAPABILITY_GAP')
    expect(r.pValue).toBeLessThanOrEqual(0.05)
  })

  it('chance-level guessing at the registered sample size is VALID', () => {
    session(40)
    judgeAll('s1', 0.5)
    const r = evaluateBlinding(db, 's1')
    expect(r.verdict).toBe('VALID')
    expect(r.accuracy).toBeCloseTo(0.5, 2)
  })

  it('reports accuracy broken down by the guess confidence', () => {
    session(40)
    judgeAll('s1', 0.5, 'HIGH')
    const r = evaluateBlinding(db, 's1')
    expect(r.accuracyByConfidence.HIGH.n).toBe(40)
    expect(r.accuracyByConfidence.LOW.n).toBe(0)
  })

  it('carries the registration digest, so a later reader can check the rule was frozen', () => {
    session(40)
    judgeAll('s1', 0.5)
    expect(evaluateBlinding(db, 's1').registrationDigest)
      .toBe(registrationDigest(DEFAULT_BLINDING_REGISTRATION))
  })
})

describe('the pre-registered power design', () => {
  it('HEADLINE: power is NOT monotonic in n — 38 and 39 are WORSE than 37', () => {
    // The finding that makes "37, rounded up for safety" the wrong story. The
    // critical value jumps in whole counts while n grows continuously, so a
    // LARGER sample can be less powerful than a smaller one. What makes 40
    // defensible is not that it is bigger; it is that it is pre-registered.
    const r = DEFAULT_BLINDING_REGISTRATION
    expect(powerAt(37, r)).toBeGreaterThanOrEqual(r.targetPower)
    expect(powerAt(38, r)).toBeLessThan(r.targetPower)
    expect(powerAt(39, r)).toBeLessThan(r.targetPower)
    expect(powerAt(40, r)).toBeGreaterThanOrEqual(r.targetPower)
  })

  it('the mathematical minimum is 37, exactly as the spec states', () => {
    expect(minSampleForPower()).toBe(37)
  })

  it('the registered default of 40 does meet the target', () => {
    expect(powerAt(DEFAULT_BLINDING_REGISTRATION.minPackets, DEFAULT_BLINDING_REGISTRATION))
      .toBeGreaterThanOrEqual(DEFAULT_BLINDING_REGISTRATION.targetPower)
  })

  it('the one-sided exact test behaves at the boundaries', () => {
    expect(binomialTailGE(0, 10, 0.5)).toBe(1)
    expect(binomialTailGE(11, 10, 0.5)).toBe(0)
    expect(binomialTailGE(5, 10, 0.5)).toBeCloseTo(0.623, 3)
    // 26 of 40 is the smallest count that is significant at alpha=0.05.
    expect(criticalValue(40, 0.5, 0.05)).toBe(26)
    expect(binomialTailGE(26, 40, 0.5)).toBeLessThanOrEqual(0.05)
    expect(binomialTailGE(25, 40, 0.5)).toBeGreaterThan(0.05)
  })

  it('does not underflow at a sample size where naive products would', () => {
    // Computed in log space on purpose: at n in the hundreds the direct product
    // underflows, and an underflowed p-value reads as a significant result.
    expect(binomialTailGE(500, 1000, 0.5)).toBeGreaterThan(0.5)
    expect(binomialTailGE(600, 1000, 0.5)).toBeGreaterThan(0)
    expect(binomialTailGE(600, 1000, 0.5)).toBeLessThan(1e-9)
  })
})
