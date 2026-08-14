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
import { assertCalibrationStillValid } from './calibration-window.js'

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

// ── Eligible observations (§1.4.1), labelled INDEPENDENTLY ──────────────
//
// MARVEEN'S DEFINITION, 2026-08-13, and the sentence that makes it usable:
//
//     "It must be decidable SOLELY from a snapshot of the store, by somebody who
//      has not seen the detector output. If a observation's eligibility can only
//      be judged knowing that the detector fired, it is not an observation — it
//      is a confirmation."
//
// THE BUG THAT SENTENCE FOUND. Until it was written, this file computed
// `eligibleObservationCount` as `comparison.proactiveCases` — the number of
// cases the PROACTIVE ARM touched. That is the circularity in its purest form:
// the denominator of "how much value did the detector add" was the detector's
// own output, so a detector that noticed less would have looked equally good by
// noticing less of a smaller world.
//
// Eligibility is therefore a SEPARATE, EARLIER labelling pass, and the ordering
// is enforced the same way §1.4.6's control ordering is: labelling recorded
// after the proactive run sealed does not count.

/** Marveen's three shapes, as a closed vocabulary so the label is checkable
 *  rather than an essay. */
export type EligibleObservationShape =
  /** A deadline derivable from stored evidence that passed or approached
   *  without the owner knowing. */
  | 'DEADLINE_PASSED_UNSEEN'
  /** The ball was with the other party and the agreed follow-up time elapsed
   *  with no movement. */
  | 'FOLLOW_UP_ELAPSED_WITHOUT_MOVEMENT'
  /** A state change that invalidated an earlier owner decision. */
  | 'STATE_CHANGE_INVALIDATED_DECISION'
  /**
   * Condition 5 (Marveen's addition, and it is the one I had missed): the
   * labeller is allowed to say they do not know.
   *
   * A binary label forced onto a doubtful case is manufactured certainty. So
   * UNCERTAIN is counted SEPARATELY and folded into neither side — not into the
   * denominator, and not into the "nothing here" pile either. A high UNCERTAIN
   * rate says something about the DEFINITION rather than about the corpus, and
   * that is worth seeing rather than smoothing away.
   */
  | 'UNCERTAIN'

export interface EligibleObservation {
  corpusFingerprint: string
  domain: string
  caseId: string
  shape: EligibleObservationShape
  /**
   * Condition 2, evidence precedence. `observedAt` is the T of the definition —
   * the moment a competent chief of staff would have spoken — and `evidenceAt`
   * is when the evidence entered the store.
   *
   * The evidence must be strictly EARLIER. What only became knowable afterwards
   * is not a missed observation, and without both timestamps that condition is
   * an instruction nobody can check.
   */
  observedAt: number
  evidenceAt: number
  /** Who decided. A label with no author cannot be shown to have been blind. */
  labelledBy: string
  labelledAt: number
  /**
   * Condition 3, owner relevance rather than system relevance: the test is
   * whether the OWNER needed to know, not whether the system could compute it.
   * Not mechanically checkable — but a label whose author could not write a
   * sentence about it is a label nobody weighed, so the store insists on one.
   */
  rationale: string
}

export function ensureEligibilitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eligible_observations (
      corpus_fingerprint TEXT NOT NULL,
      domain             TEXT NOT NULL,
      case_id            TEXT NOT NULL,
      shape              TEXT NOT NULL,
      observed_at        INTEGER NOT NULL,
      evidence_at        INTEGER NOT NULL,
      labelled_by        TEXT NOT NULL,
      labelled_at        INTEGER NOT NULL,
      rationale          TEXT NOT NULL,
      PRIMARY KEY (corpus_fingerprint, domain, case_id),
      CHECK (shape IN ('DEADLINE_PASSED_UNSEEN','FOLLOW_UP_ELAPSED_WITHOUT_MOVEMENT',
        'STATE_CHANGE_INVALIDATED_DECISION','UNCERTAIN')),
      /* Condition 2, in the schema rather than only in the caller. */
      CHECK (evidence_at < observed_at)
    )
  `)
  // A label, once given, is evidence about a snapshot. Editing it later is
  // editing the denominator after seeing the numerator.
  // The labelling PASS itself, recorded separately from the labels.
  //
  // Without this, "nobody looked" and "somebody looked and found none" are the
  // same row count — zero — and they support opposite conclusions. The count
  // below returns null until a pass exists, so an unassessed corpus cannot be
  // read as an empty one.
  db.exec(`
    CREATE TABLE IF NOT EXISTS eligibility_passes (
      corpus_fingerprint TEXT PRIMARY KEY,
      labelled_by        TEXT NOT NULL,
      completed_at       INTEGER NOT NULL,
      note               TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_eligibility_pass_no_update
    BEFORE UPDATE ON eligibility_passes
    BEGIN SELECT RAISE(ABORT, 'an eligibility pass is final'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_eligible_no_update
    BEFORE UPDATE ON eligible_observations
    BEGIN SELECT RAISE(ABORT, 'an eligibility label is final'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_eligible_no_delete
    BEFORE DELETE ON eligible_observations
    BEGIN SELECT RAISE(ABORT, 'an eligibility label is final'); END
  `)
}

export type LabelResult = { ok: true } | { ok: false; reason: string }

/**
 * Record one eligibility label.
 *
 * Refuses once ANY proactive run over this corpus has sealed. That is the whole
 * enforcement: after the detector's output exists, a person labelling the corpus
 * can no longer be shown not to have seen it — and "can no longer be shown" is
 * the standard §1.4.3 applies to blinding, not "probably did not".
 */
export function labelEligibleObservation(
  ledger: Database.Database, obs: EligibleObservation,
): LabelResult {
  const sealed = ledger.prepare(
    `SELECT run_id FROM replay_runs
      WHERE corpus_fingerprint = ? AND arm IN ('PROACTIVE_SHADOW','CALIBRATION')
        AND sealed_at IS NOT NULL LIMIT 1`,
  ).get(obs.corpusFingerprint) as { run_id: string } | undefined
  if (sealed) {
    return {
      ok: false,
      reason:
        `ezen a korpuszon már lezárult egy proaktív futás (${sealed.run_id}) — utána a jogosultsági `
        + 'címkézésről nem mutatható ki, hogy vak volt',
    }
  }
  // Condition 2, checked before the write so the refusal names the reason
  // rather than surfacing as a CHECK constraint nobody can read.
  if (!(obs.evidenceAt < obs.observedAt)) {
    return {
      ok: false,
      reason: 'a bizonyitek nem elozi meg a megfigyeles idopontjat — ami csak kesobb valt '
        + 'tudhatova, az nem elmulasztott megfigyeles (2. feltetel)',
    }
  }
  // Condition 3 has no mechanical test, so the store insists on the one thing
  // that shows somebody weighed it: a sentence.
  if (obs.rationale.trim().length < 10) {
    return { ok: false, reason: 'a cimke indoklas nelkul nem mutatja, hogy barki merlegelte (3. feltetel)' }
  }
  try {
    ledger.prepare(
      `INSERT INTO eligible_observations
         (corpus_fingerprint, domain, case_id, shape, observed_at, evidence_at,
          labelled_by, labelled_at, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(obs.corpusFingerprint, obs.domain, obs.caseId, obs.shape,
      obs.observedAt, obs.evidenceAt, obs.labelledBy, obs.labelledAt, obs.rationale)
  } catch {
    return { ok: false, reason: 'erre az ügyre már van címke — a címke végleges' }
  }
  return { ok: true }
}

/**
 * Declare the labelling pass over this corpus finished.
 *
 * Separate from the labels because the ABSENCE of labels is only informative
 * once somebody has looked. Subject to the same ordering rule: a pass declared
 * after a proactive run sealed cannot be shown to have been blind.
 */
export function completeEligibilityPass(
  ledger: Database.Database,
  pass: { corpusFingerprint: string; labelledBy: string; completedAt: number; note?: string },
): LabelResult {
  const sealed = ledger.prepare(
    `SELECT run_id FROM replay_runs
      WHERE corpus_fingerprint = ? AND arm IN ('PROACTIVE_SHADOW','CALIBRATION')
        AND sealed_at IS NOT NULL LIMIT 1`,
  ).get(pass.corpusFingerprint) as { run_id: string } | undefined
  if (sealed) {
    return {
      ok: false,
      reason: `ezen a korpuszon mar lezarult egy proaktiv futas (${sealed.run_id}) — `
        + 'utana a jogosultsagi atnezesrol nem mutathato ki, hogy vak volt',
    }
  }
  try {
    ledger.prepare(
      `INSERT INTO eligibility_passes (corpus_fingerprint, labelled_by, completed_at, note)
       VALUES (?, ?, ?, ?)`,
    ).run(pass.corpusFingerprint, pass.labelledBy, pass.completedAt, pass.note ?? '')
  } catch {
    return { ok: false, reason: 'ezen a korpuszon mar volt atnezes — az atnezes vegleges' }
  }
  return { ok: true }
}

/**
 * How many eligible observations were labelled for this corpus, or NULL when
 * NOBODY HAS LOOKED.
 *
 * The null is the point. "Nothing was eligible" and "nobody looked" produce the
 * same count and opposite conclusions, and a gate that cannot tell them apart
 * will read an unassessed corpus as a clean one.
 */
export function eligibleObservationCount(
  ledger: Database.Database, corpusFingerprint: string,
): number | null {
  return eligibilityTally(ledger, corpusFingerprint)?.eligible ?? null
}

export interface EligibilityTally {
  /** The denominator. UNCERTAIN is NOT in it. */
  eligible: number
  /** Condition 5. Counted apart, folded into neither side. */
  uncertain: number
  /** `uncertain / (eligible + uncertain)`. A high value is a statement about the
   *  DEFINITION, not about the corpus. */
  uncertainRate: number
}

/**
 * The labelling pass's result, or null when nobody has looked.
 *
 * UNCERTAIN is excluded from `eligible` and reported on its own, which is the
 * whole of condition 5: a binary label forced onto a doubtful case is
 * manufactured certainty, and averaging it into either side hides exactly the
 * signal that would tell us the definition needs work.
 */
export function eligibilityTally(
  ledger: Database.Database, corpusFingerprint: string,
): EligibilityTally | null {
  try {
    const pass = ledger.prepare(
      `SELECT corpus_fingerprint FROM eligibility_passes WHERE corpus_fingerprint = ?`,
    ).get(corpusFingerprint)
    if (!pass) return null
    const row = ledger.prepare(
      `SELECT
         SUM(CASE WHEN shape = 'UNCERTAIN' THEN 0 ELSE 1 END) AS eligible,
         SUM(CASE WHEN shape = 'UNCERTAIN' THEN 1 ELSE 0 END) AS uncertain
       FROM eligible_observations WHERE corpus_fingerprint = ?`,
    ).get(corpusFingerprint) as { eligible: number | null; uncertain: number | null }
    const eligible = row.eligible ?? 0
    const uncertain = row.uncertain ?? 0
    const total = eligible + uncertain
    return { eligible, uncertain, uncertainRate: total ? uncertain / total : 0 }
  } catch { return null }
}

// ── §24.2 value-gate metrics ────────────────────────────────────────────

export type ValueHypothesisResult =
  | 'PASS'
  | 'FAIL'
  | 'NO_EVIDENCE_DUE_TO_LOW_VOLUME'
  | 'EVALUATION_WINDOW_DEGRADED'
  /**
   * A kalibrált küszöb lejárt, mert a fagyasztott készülék megváltozott.
   *
   * SAJÁT kimenet, nem `EVALUATION_WINDOW_DEGRADED`. Marveen pontosan azért
   * kérte előre kimondani, mert ez az a fajta elavulás, amitől semmi nem
   * hibázik: a küszöb tovább él, mint a rendszer, amire mérték, és senki nem
   * veszi észre. Egy általános „degraded" címke alá söpörve pont ez a
   * észrevehetetlenség maradna meg.
   */
  | 'CALIBRATION_EXPIRED'

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
  /**
   * Condition 5's threshold, PRE-REGISTERED or absent.
   *
   * Null means the rate is reported and does not gate — which is the honest
   * default, because a threshold invented after seeing the number is the same
   * move V4-F14 forbids for the catch count. Registering one before the window
   * opens turns "the definition may be unusable" from a discussion into a
   * verdict.
   */
  maxUncertainRate: number | null
}

export const DEFAULT_VALUE_GATE_REGISTRATION: ValueGateRegistration = {
  requiredCatches: 5,
  minEligibleObservations: 30,
  maxUncertainRate: null,
}

export interface ValueGateResult {
  result: ValueHypothesisResult
  /** §24.2 metrics. */
  incrementalMaterialCatchCount: number
  incrementalMaterialCatchRate: number
  missedByReactiveBaselineCount: number
  /** Null when nobody labelled the corpus. Null and 0 are different facts:
   *  "nothing was eligible" and "nobody looked" produce the same number and
   *  opposite conclusions. */
  eligibleObservationCount: number | null
  blindAdjudicationCoverageRate: number
  /** Null — not 1 — when there are too few control runs to measure it. A
   *  reproducibility rate of "1.0 out of one run" is a fabricated green. */
  reactiveControlReproducibilityRate: number | null
  /** Condition 5. Always reported, whether or not a threshold was registered. */
  uncertainCount: number
  uncertainRate: number
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
  /** A FUTÁSKORI konfiguráció. Elhagyva nincs lejárat-ellenőrzés — ugyanaz az
   *  elv, mint az `assertFrozenConfig`-nál: egy kapu, ami az első futást
   *  lehetetlenné teszi, nem kapu. */
  currentConfig?: { detectorConfigFingerprint: string; intakeSurfaceFingerprint: string },
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

  // INDEPENDENTLY LABELLED, never derived from the arm's own output. See the
  // eligibility section above for the bug this replaced.
  const corpusFingerprint = session
    ? (readRun(ledger, session.proactive_run_id)?.corpusFingerprint ?? '')
    : ''
  const tally = eligibilityTally(ledger, corpusFingerprint)
  const labelled = tally?.eligible ?? null
  const eligible = labelled ?? 0
  const incrementalMaterialCatchRate = eligible
    ? incrementalMaterialCatchCount / eligible
    : 0
  const blindAdjudicationCoverageRate = totalPackets ? judged / totalPackets : 0
  const reactiveControlReproducibilityRate = session
    ? controlReproducibility(ledger, session.control_run_id)
    : null

  const base = {
    incrementalMaterialCatchCount,
    incrementalMaterialCatchRate,
    missedByReactiveBaselineCount: comparison.proactiveOnly.length,
    eligibleObservationCount: labelled,
    blindAdjudicationCoverageRate,
    reactiveControlReproducibilityRate,
    uncertainCount: tally?.uncertain ?? 0,
    uncertainRate: tally?.uncertainRate ?? 0,
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
  // 1b. Is the calibration the thresholds rest on still valid?
  //
  // BEFORE the volume questions, deliberately. `minEligibleObservations` was
  // sized for a particular frozen appliance; comparing a count against it after
  // the appliance changed is not a weaker answer, it is an answer to a question
  // nobody asked. Marveen's expiry condition, as a verdict rather than a note.
  if (currentConfig) {
    const validity = assertCalibrationStillValid(ledger, currentConfig)
    if (!validity.ok) {
      return { ...base, result: 'CALIBRATION_EXPIRED', detail: validity.reason }
    }
  }
  // 2a. Was eligibility ever established independently?
  //
  // Before this check the count came from the proactive arm itself, so the gate
  // could return PASS on a corpus nobody had ever assessed. "Nothing was
  // eligible" and "nobody looked" are the same number and opposite conclusions,
  // and only one of them is a result.
  if (labelled === null) {
    return {
      ...base,
      result: 'EVALUATION_WINDOW_DEGRADED',
      detail: 'a korpuszon senki nem jelölte meg az elfogadható megfigyeléseket — a value gate nevezője hiányzik',
    }
  }
  // 2b. Condition 5, when a threshold was pre-registered. A labelling pass that
  //      could not decide most of what it saw has not measured the corpus; it
  //      has reported on the definition.
  if (registration.maxUncertainRate != null
    && (tally?.uncertainRate ?? 0) > registration.maxUncertainRate) {
    return {
      ...base,
      result: 'EVALUATION_WINDOW_DEGRADED',
      detail: `a cimkezes ${((tally?.uncertainRate ?? 0) * 100).toFixed(1)}%-ban UNCERTAIN volt `
        + `(regisztralt hatar ${(registration.maxUncertainRate * 100).toFixed(0)}%) — `
        + 'ez a definiciorol szol, nem a korpuszrol',
    }
  }
  // 2c. Then whether the window could answer the question at all.
  if (labelled < registration.minEligibleObservations) {
    return {
      ...base,
      result: 'NO_EVIDENCE_DUE_TO_LOW_VOLUME',
      detail: `${labelled} megfigyelés a regisztrált ${registration.minEligibleObservations} helyett`,
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
