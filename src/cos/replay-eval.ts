// §26(32) / §21.1 / §24.2: the instrumentation that joins the two arms to the
// value gate.
//
// WHAT WAS MISSING. After §26(26) there are two sealed, immutable replay runs.
// After §26(29) there is a canonical adjudication packet and a blinding test.
// Nothing connected them: no way to take two arms and produce the blind session
// that the value gate is measured from, and no metric that could be computed
// from the result. This file is that link, and the metrics on top of it.
//
// THE RULE THAT OUTRANKS EVERY METRIC HERE, from §24.2:
//
//     "The value gate may be qualified as PASS only with a VALID
//      blinding-effectiveness status."
//
// So the gate is not "did we catch enough things". It is "did we catch enough
// things AND can we show the judge was not reading the origin off the packet".
// A count of catches produced under broken blinding is not a smaller result — it
// is not a result. `evaluateValueGate` composes them in that order, and the
// blinding verdict can only ever veto, never rescue.
//
// ONE MAPPER, BOTH ARMS. §1.4.3's parity requirement is a property of the two
// packet SETS, and the cheapest way to get it wrong is to write a proactive
// mapper and a reactive mapper and keep them in step by hand. So `buildSessionFromRuns`
// takes ONE mapper and applies it to both arms' outputs. A field can then only
// appear on one side if the mapper emits it conditionally — which the parity
// check catches, in the same run, before an adjudicator sees anything.

import type Database from 'better-sqlite3'
import {
  assertComparable, readOutputs, readRun,
  type ReplayOutput, type ReplayRun,
} from './replay-run.js'
import {
  buildSession, evaluateBlinding, canonicalise,
  type AdjudicationPacket, type BlindingResult, type OriginLabel,
} from './adjudication.js'

// ── Arm comparison ──────────────────────────────────────────────────────

export interface ArmComparison {
  /** Cases both arms produced an output for. */
  bothArms: string[]
  /** Cases only the proactive arm reached. The raw material for
   *  `missed_by_reactive_baseline_count` — raw, because whether a catch was
   *  MATERIAL is a human judgement, not a set difference. */
  proactiveOnly: string[]
  /** Cases only the control reached. Reported for the same reason a reconcile
   *  reports what it could not read: a proactive arm that MISSES what the
   *  baseline caught is the failure nobody thinks to look for. */
  controlOnly: string[]
  controlCases: number
  proactiveCases: number
}

/** Domain-qualified so two cases with the same id on opposite sides of the house
 *  can never be counted as one. */
const key = (o: ReplayOutput): string => `${o.domain}/${o.caseId}`

/**
 * What each arm reached, as sets of cases.
 *
 * Deliberately NOT a verdict. This function says who touched what; whether a
 * proactive-only touch was worth anything is exactly the question §1.4.3 sends
 * to a blind human, and answering it here — with a heuristic, from the same
 * codebase that produced the output — would be the system marking its own work.
 */
export function compareArms(
  ledger: Database.Database, controlRunId: string, proactiveRunId: string,
): ArmComparison {
  const control = new Set(readOutputs(ledger, controlRunId).map(key))
  const proactive = new Set(readOutputs(ledger, proactiveRunId).map(key))
  return {
    bothArms: [...proactive].filter(k => control.has(k)).sort(),
    proactiveOnly: [...proactive].filter(k => !control.has(k)).sort(),
    controlOnly: [...control].filter(k => !proactive.has(k)).sort(),
    controlCases: control.size,
    proactiveCases: proactive.size,
  }
}

// ── The bridge: two sealed arms → one blind session ─────────────────────

/** Turns one arm's output into the canonical fields. The SAME function runs over
 *  both arms; it is given no arm argument, on purpose — a mapper that knows
 *  which side it is on is a mapper that can differ between them. */
export type PacketMapper = (
  out: ReplayOutput,
  index: number,
) => Omit<Parameters<typeof canonicalise>[0], 'packetId'>

export type BuildFromRunsResult =
  | { ok: true; sessionId: string; packetCount: number; comparison: ArmComparison }
  | { ok: false; reasons: string[] }

/**
 * §26(32): build the blind adjudication session from two sealed replay runs.
 *
 * Refuses before doing anything if the two runs are not comparable under
 * §1.4.6 — different corpora, an unsealed arm, an overlap. That check is cheap
 * and the alternative is expensive in the worst way: an adjudicator's afternoon
 * spent on packets that were never admissible, and a number at the end of it
 * that looks exactly like a valid one.
 */
export function buildSessionFromRuns(
  ledger: Database.Database,
  input: {
    sessionId: string
    controlRunId: string
    proactiveRunId: string
    rubricVersion: string
    shuffleSeed: string
    mapper: PacketMapper
  },
  now: number,
): BuildFromRunsResult {
  const verdict = assertComparable(ledger, input.controlRunId, input.proactiveRunId)
  if (!verdict.comparable) return { ok: false, reasons: verdict.reasons }

  const packets: Array<{ origin: OriginLabel; raw: Parameters<typeof canonicalise>[0] }> = []
  const push = (runId: string, origin: OriginLabel): void => {
    readOutputs(ledger, runId).forEach((out, i) => {
      packets.push({
        origin,
        // The packet id encodes the ARM, and that is safe precisely because it
        // never reaches the adjudicator: the canonical packet's id is what the
        // judgement is keyed on, and the ordinal — not the id — is what governs
        // presentation order. Making it traceable is worth more than making it
        // opaque, because an untraceable packet cannot be re-derived from the
        // sealed run it came from.
        raw: { packetId: `${runId}#${i + 1}`, ...input.mapper(out, i) },
      })
    })
  }
  push(input.controlRunId, 'REACTIVE')
  push(input.proactiveRunId, 'PROACTIVE')

  const built = buildSession(ledger, {
    sessionId: input.sessionId,
    controlRunId: input.controlRunId,
    proactiveRunId: input.proactiveRunId,
    rubricVersion: input.rubricVersion,
    shuffleSeed: input.shuffleSeed,
    packets,
  }, now)
  if (!built.ok) return { ok: false, reasons: built.reasons }
  return {
    ok: true,
    sessionId: built.sessionId,
    packetCount: built.packetCount,
    comparison: compareArms(ledger, input.controlRunId, input.proactiveRunId),
  }
}

// ── §24.2 value-gate metrics ────────────────────────────────────────────

export type ValueHypothesisResult =
  | 'PASS'
  | 'FAIL'
  | 'NO_EVIDENCE_DUE_TO_LOW_VOLUME'
  | 'EVALUATION_WINDOW_DEGRADED'

/** §1.4 / V4-F14. Frozen before the shadow window opens. */
export interface ValueGateRegistration {
  /** How many incremental material catches the window must produce. The default
   *  candidate of 5 is only valid if the historical eligible volume makes it
   *  measurable — which is §1.4.1's calibration, and needs live data. */
  requiredCatches: number
  /** Below this many eligible observations the window cannot answer the
   *  question at all, and says so rather than reporting a small number as a
   *  FAIL. */
  minEligibleObservations: number
}

export const DEFAULT_VALUE_GATE_REGISTRATION: ValueGateRegistration = {
  requiredCatches: 5,
  minEligibleObservations: 30,
}

export interface ValueGateResult {
  result: ValueHypothesisResult
  /** §24.2 metrics. */
  incrementalMaterialCatchCount: number
  incrementalMaterialCatchRate: number
  missedByReactiveBaselineCount: number
  eligibleObservationCount: number
  blindAdjudicationCoverageRate: number
  /** Null — not 1 — when there are too few control runs to measure it. A
   *  reproducibility rate of "1.0 out of one run" is a fabricated green. */
  reactiveControlReproducibilityRate: number | null
  blinding: BlindingResult
  detail: string
}

/**
 * §24.2's composed gate.
 *
 * ORDER MATTERS, and it is the opposite of the intuitive one. The blinding
 * status is checked FIRST, before the catches are even counted — because a count
 * produced under broken blinding is not a weaker result, it is not a result, and
 * printing it next to a failed blinding status invites exactly the reading the
 * spec forbids ("we caught seven, admittedly the blinding was iffy").
 *
 * The blinding verdict can only veto. There is no path by which good catch
 * numbers make a broken blind acceptable.
 */
export function evaluateValueGate(
  ledger: Database.Database,
  sessionId: string,
  registration: ValueGateRegistration = DEFAULT_VALUE_GATE_REGISTRATION,
): ValueGateResult {
  const blinding = evaluateBlinding(ledger, sessionId)
  const session = ledger.prepare(
    `SELECT control_run_id, proactive_run_id FROM adjudication_sessions WHERE session_id = ?`,
  ).get(sessionId) as { control_run_id: string; proactive_run_id: string } | undefined

  const comparison = session
    ? compareArms(ledger, session.control_run_id, session.proactive_run_id)
    : { bothArms: [], proactiveOnly: [], controlOnly: [], controlCases: 0, proactiveCases: 0 }

  const totalPackets = (ledger.prepare(
    `SELECT COUNT(*) AS n FROM adjudication_packets WHERE session_id = ?`,
  ).get(sessionId) as { n: number }).n
  const judged = (ledger.prepare(
    `SELECT COUNT(*) AS n FROM adjudication_records r
       JOIN adjudication_packets p ON p.packet_id = r.packet_id
      WHERE p.session_id = ?`,
  ).get(sessionId) as { n: number }).n

  // An "incremental material catch": a PROACTIVE packet that a blind judge
  // called material AND timely, on a case the control arm never reached.
  //
  // Stated as an operationalisation rather than presented as the definition.
  // §24.2 names the metric and does not spell out the join; this is the
  // narrowest reading — material, timely, and genuinely absent from the control
  // — because a looser one would inflate the number the release gate reads, and
  // the release gate is the thing this is for.
  const proactiveOnly = new Set(comparison.proactiveOnly)
  const catches = (ledger.prepare(
    `SELECT p.canonical_json AS j
       FROM adjudication_records r
       JOIN adjudication_packets p ON p.packet_id = r.packet_id
      WHERE p.session_id = ? AND p.origin_label = 'PROACTIVE'
        AND r.material = 1 AND r.timely = 1`,
  ).all(sessionId) as Array<{ j: string }>)
    .map(r => JSON.parse(r.j) as AdjudicationPacket)

  // The packet does not carry a case id — by §1.4.3 design, since a case id
  // format could itself be an origin tell. The link back is the sealed run.
  const proactiveOutputs = session ? readOutputs(ledger, session.proactive_run_id) : []
  const catchKeys = new Set<string>()
  for (const packet of catches) {
    const idx = Number(packet.packetId.split('#')[1]) - 1
    const out = proactiveOutputs[idx]
    if (out && proactiveOnly.has(key(out))) catchKeys.add(key(out))
  }
  const incrementalMaterialCatchCount = catchKeys.size

  const eligibleObservationCount = comparison.proactiveCases
  const incrementalMaterialCatchRate = eligibleObservationCount
    ? incrementalMaterialCatchCount / eligibleObservationCount
    : 0
  const blindAdjudicationCoverageRate = totalPackets ? judged / totalPackets : 0
  const reactiveControlReproducibilityRate = session
    ? controlReproducibility(ledger, session.control_run_id)
    : null

  const base = {
    incrementalMaterialCatchCount,
    incrementalMaterialCatchRate,
    missedByReactiveBaselineCount: comparison.proactiveOnly.length,
    eligibleObservationCount,
    blindAdjudicationCoverageRate,
    reactiveControlReproducibilityRate,
    blinding,
  }

  // 1. Blinding first, and it can only veto.
  if (blinding.verdict !== 'VALID') {
    return {
      ...base,
      result: blinding.verdict === 'BLINDING_EVIDENCE_INSUFFICIENT'
        ? 'EVALUATION_WINDOW_DEGRADED'
        : 'FAIL',
      detail: `a vakítás státusza ${blinding.verdict} — a value gate csak VALID mellett minősíthető PASS-nak (§24.2)`,
    }
  }
  // 2. Then whether the window could answer the question at all.
  if (eligibleObservationCount < registration.minEligibleObservations) {
    return {
      ...base,
      result: 'NO_EVIDENCE_DUE_TO_LOW_VOLUME',
      detail: `${eligibleObservationCount} megfigyelés a regisztrált ${registration.minEligibleObservations} helyett`,
    }
  }
  // 3. Only now the hypothesis itself.
  if (incrementalMaterialCatchCount < registration.requiredCatches) {
    return {
      ...base,
      result: 'FAIL',
      detail: `${incrementalMaterialCatchCount} inkrementális találat a szükséges ${registration.requiredCatches} helyett`,
    }
  }
  return {
    ...base,
    result: 'PASS',
    detail: `${incrementalMaterialCatchCount} inkrementális találat, vakítás VALID`,
  }
}

/**
 * §1.4.6(5), turned into a rate.
 *
 * Null when there are fewer than two comparable control runs. A reproducibility
 * rate computed from a single run would be 1.0 — a perfect score reported for
 * never having tried, which is the exact shape of metric this whole release is
 * supposed to stop producing.
 */
export function controlReproducibility(ledger: Database.Database, controlRunId: string): number | null {
  const run = readRun(ledger, controlRunId)
  if (!run?.outputDigest) return null
  const peers = ledger.prepare(
    `SELECT output_digest FROM replay_runs
      WHERE arm = 'REACTIVE_CONTROL' AND corpus_fingerprint = ? AND config_version = ?
        AND sealed_at IS NOT NULL AND output_digest IS NOT NULL`,
  ).all(run.corpusFingerprint, run.configVersion) as Array<{ output_digest: string }>
  if (peers.length < 2) return null
  const matching = peers.filter(p => p.output_digest === run.outputDigest).length
  return matching / peers.length
}

/** §21.1's shadow-evaluation counters that this layer can actually compute.
 *
 *  The ones it CANNOT are absent rather than zeroed. `true_positive_rate`,
 *  `false_positive_rate` and `missed_material_signal_rate` all need a ground
 *  truth this system does not have — that is what the blind adjudication is
 *  for — and reporting them as 0 would be a capability gap wearing a metric's
 *  clothes, which §22's fixture-set acceptance rules out by name. */
export interface ShadowEvalCounters {
  existingCaseReuseRate: number
  duplicateInitiativeRate: number
  /** Named as unavailable, with the reason, so a dashboard cannot render a zero. */
  unavailable: Array<{ metric: string; why: string }>
}

export function shadowEvalCounters(
  ledger: Database.Database, controlRunId: string, proactiveRunId: string,
): ShadowEvalCounters {
  const c = compareArms(ledger, controlRunId, proactiveRunId)
  const outputs = readOutputs(ledger, proactiveRunId)
  const seen = new Set<string>()
  let duplicates = 0
  for (const o of outputs) {
    const k = `${key(o)}#${o.cycle}`
    if (seen.has(k)) duplicates++
    seen.add(k)
  }
  return {
    existingCaseReuseRate: c.proactiveCases ? c.bothArms.length / c.proactiveCases : 0,
    duplicateInitiativeRate: outputs.length ? duplicates / outputs.length : 0,
    unavailable: [
      { metric: 'true_positive_rate', why: 'nincs ground truth — ezt a vak adjudikáció adja meg (§1.4.3)' },
      { metric: 'false_positive_rate', why: 'ugyanaz: emberi ítélet nélkül nem számolható' },
      { metric: 'missed_material_signal_rate', why: 'a nem észlelt jel definíció szerint nincs a főkönyvben' },
    ],
  }
}
