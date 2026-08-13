// §1.4.3 / §26(29): the canonical adjudication packet, and the blinding test.
//
// WHAT THIS IS FOR. §1.4's value gate asks a human whether the proactive side
// produced something the reactive baseline did not. That judgement is worthless
// if the judge can tell which side wrote which packet — and §1.4.3 is explicit
// that hiding the origin label is NOT the same as blinding being effective:
//
//     "Blinding is not proven merely by the origin label being hidden; whether
//      the origin can be inferred FROM THE SHAPE OF THE PACKET must be measured."
//
// So there are two separate jobs here, and conflating them is the whole risk:
//
//   1. CANONICALISATION — map both arms onto one schema with no field that only
//      one side can fill. A packet carrying `planner_trace` is labelled
//      PROACTIVE in every way that matters, whatever the origin column says.
//   2. MEASUREMENT — make the judge guess the origin, before unblinding, and
//      test that guess against chance with a pre-registered rule.
//
// FAIL-CLOSED, in both directions. Not enough packets is not a pass; a judge who
// can guess the origin is not a pass. §1.4.3 names both outcomes, and neither of
// them is silence.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

// ── The canonical packet ────────────────────────────────────────────────

/**
 * §1.4.3's schema, and deliberately nothing more.
 *
 * There is no `origin`, no `runId`, no `initiativeId`, no detector or planner
 * field on this type AT ALL. Not hidden at read time — absent. A field that
 * exists on the object handed to the adjudicator is a field that reaches the
 * screen the moment somebody adds a debug dump, and the parity rule of §1.4.3 is
 * not "do not display the proactive-only fields", it is "do not have them unless
 * the reactive side has an equivalent".
 */
export interface AdjudicationPacket {
  packetId: string
  caseContextSummary: string
  evidenceRefs: string[]
  finding: string
  materiality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  /** §1.4.4's rubric is applied to these. Epoch seconds, labelled, and the SAME
   *  labels on both arms — a timestamp only one side can produce is an origin
   *  tell wearing a neutral name. */
  timelinessRelevantTimestamps: Array<{ label: string; at: number }>
  proposedNextAction: string
  rationale: string
}

export type OriginLabel = 'PROACTIVE' | 'REACTIVE'
export type GuessConfidence = 'LOW' | 'MEDIUM' | 'HIGH'

/** §1.4.3's adjudication record. `originGuess` is mandatory: a judgement without
 *  it cannot be part of the blinding measurement, and a blinding measurement
 *  computed from the subset of judges who happened to guess is not the
 *  pre-registered test. */
export interface AdjudicationRecord {
  packetId: string
  adjudicatorId: string
  judgment: string
  timely: boolean
  material: boolean
  originGuess: OriginLabel
  originGuessConfidence: GuessConfidence
  judgedAt: number
  rubricVersion: string
}

/** The fields a canonical packet may carry. Used by the parity check, so the
 *  list is data rather than only a type. */
export const CANONICAL_PACKET_FIELDS = [
  'packetId', 'caseContextSummary', 'evidenceRefs', 'finding', 'materiality',
  'timelinessRelevantTimestamps', 'proposedNextAction', 'rationale',
] as const

export function ensureAdjudicationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adjudication_sessions (
      session_id       TEXT PRIMARY KEY,
      control_run_id   TEXT NOT NULL,
      proactive_run_id TEXT NOT NULL,
      rubric_version   TEXT NOT NULL,
      /* The shuffle seed. Stored so the packet order is reproducible: a frozen
         experiment whose randomisation cannot be replayed is an experiment
         nobody can check. */
      shuffle_seed     TEXT NOT NULL,
      registration_json TEXT NOT NULL,
      registration_digest TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      unblinded_at     INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS adjudication_packets (
      packet_id        TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL REFERENCES adjudication_sessions(session_id),
      /* The answer. Written at build time, never returned by the read path the
         adjudicator uses, and readable only after a judgment exists. */
      origin_label     TEXT NOT NULL,
      ordinal          INTEGER NOT NULL,
      canonical_json   TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      CHECK (origin_label IN ('PROACTIVE','REACTIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adj_packets_session ON adjudication_packets(session_id, ordinal)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS adjudication_records (
      packet_id        TEXT PRIMARY KEY REFERENCES adjudication_packets(packet_id),
      adjudicator_id   TEXT NOT NULL,
      judgment         TEXT NOT NULL,
      timely           INTEGER NOT NULL,
      material         INTEGER NOT NULL,
      origin_guess     TEXT NOT NULL,
      origin_guess_confidence TEXT NOT NULL,
      judged_at        INTEGER NOT NULL,
      rubric_version   TEXT NOT NULL,
      CHECK (origin_guess IN ('PROACTIVE','REACTIVE')),
      CHECK (origin_guess_confidence IN ('LOW','MEDIUM','HIGH'))
    )
  `)
  // A judgement, once given, is evidence. Re-recording it after unblinding — or
  // at all — would let the sample be tuned to the result it is meant to test.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_adj_records_no_update
    BEFORE UPDATE ON adjudication_records
    BEGIN SELECT RAISE(ABORT, 'an adjudication record is final'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_adj_records_no_delete
    BEFORE DELETE ON adjudication_records
    BEGIN SELECT RAISE(ABORT, 'an adjudication record is final'); END
  `)
}

// ── Parity ──────────────────────────────────────────────────────────────

/** Field names that betray the proactive side. Matched on the RAW source object
 *  before canonicalisation, so an accidental spread (`{...initiative}`) is
 *  caught at the door rather than discovered in an adjudicator's browser. */
const ORIGIN_TELLS = [
  'initiativeId', 'initiative_id', 'signalId', 'signal_id', 'signalIds',
  'plannerTrace', 'planner_trace', 'detector', 'detectorVersion',
  'preparedInitiative', 'dedupeKey', 'noveltyKey', 'qualification',
  'runId', 'run_id', 'arm', 'origin', 'originLabel',
]

export interface ParityViolation { packetId: string; field: string; why: string }

/**
 * §1.4.3's parity rule, checked on real objects.
 *
 * "Proactive-only internal fields must not appear in the adjudicator packet if
 * the reactive control has no equivalent field." The check is on the KEYS,
 * because that is what a shape-based inference reads: an adjudicator does not
 * need to understand `planner_trace` to notice that half the packets have a
 * field the other half never do — and that is above-chance origin inference
 * from packet form, which is precisely what §1.4.3 forbids.
 */
export function parityViolations(packets: Array<{ packetId: string; raw: Record<string, unknown> }>): ParityViolation[] {
  const out: ParityViolation[] = []
  for (const p of packets) {
    for (const key of Object.keys(p.raw)) {
      if (!(CANONICAL_PACKET_FIELDS as readonly string[]).includes(key)) {
        out.push({ packetId: p.packetId, field: key, why: 'nem kanonikus mező' })
      }
      if (ORIGIN_TELLS.includes(key)) {
        out.push({ packetId: p.packetId, field: key, why: 'eredetre utaló mező' })
      }
    }
  }
  return out
}

/** Canonicalise: keep exactly the §1.4.3 fields, drop everything else, and
 *  normalise the shapes so the two arms cannot differ in presentation.
 *
 *  Sorting the evidence refs and the timestamps matters more than it looks.
 *  Source-specific ordering is on §1.4.3's forbidden list by name — if the
 *  proactive arm happens to emit refs newest-first and the reactive arm
 *  oldest-first, the ORDER is the origin label, spelled differently. */
export function canonicalise(
  raw: {
    packetId: string
    caseContextSummary: string
    evidenceRefs: string[]
    finding: string
    materiality: AdjudicationPacket['materiality']
    timelinessRelevantTimestamps: Array<{ label: string; at: number }>
    proposedNextAction: string
    rationale: string
  },
): AdjudicationPacket {
  return {
    packetId: raw.packetId,
    caseContextSummary: raw.caseContextSummary.trim(),
    evidenceRefs: [...raw.evidenceRefs].map(r => r.trim()).sort(),
    finding: raw.finding.trim(),
    materiality: raw.materiality,
    timelinessRelevantTimestamps: [...raw.timelinessRelevantTimestamps]
      .sort((a, b) => a.at - b.at || a.label.localeCompare(b.label)),
    proposedNextAction: raw.proposedNextAction.trim(),
    rationale: raw.rationale.trim(),
  }
}

// ── The session ─────────────────────────────────────────────────────────

/** §1.4.3's pre-registered statistical rule. Frozen before the shadow window
 *  opens; §V4-F14's named FAIL is changing any of it once results are known. */
export interface BlindingRegistration {
  /** Null hypothesis: the judge is guessing. */
  p0: number
  /** The bad-blinding rate the design must be able to detect. */
  p1: number
  alpha: number
  targetPower: number
  /** The pre-registered minimum. Default 40 — see `minSampleForPower` for why
   *  that is not the same number as the mathematical minimum. */
  minPackets: number
}

export const DEFAULT_BLINDING_REGISTRATION: BlindingRegistration = {
  p0: 0.5, p1: 0.7, alpha: 0.05, targetPower: 0.8, minPackets: 40,
}

export function registrationDigest(r: BlindingRegistration): string {
  const canonical = JSON.stringify(r, Object.keys(r).sort() as Array<keyof BlindingRegistration>)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** A small deterministic PRNG. Deterministic because §1.4.3 wants a randomised
 *  packet order AND a reproducible experiment, and `Math.random` gives only the
 *  first — an order nobody can replay is an order nobody can audit. */
function seeded(seed: string): () => number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  let s = h >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

/** Fisher–Yates with the seeded source. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const rnd = seeded(seed)
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export type BuildSessionResult =
  | { ok: true; sessionId: string; packetCount: number }
  | { ok: false; reasons: string[] }

/**
 * Build a blind adjudication session from both arms' outputs.
 *
 * Both arms at once, on purpose. Building the proactive packets first and the
 * reactive ones later would make the packet order carry the origin no matter how
 * well the labels were hidden — and §1.4.3 lists "source-specific ordering"
 * among the things that must not reach the adjudicator.
 */
export function buildSession(
  db: Database.Database,
  input: {
    sessionId: string
    controlRunId: string
    proactiveRunId: string
    rubricVersion: string
    shuffleSeed: string
    registration?: BlindingRegistration
    packets: Array<{ origin: OriginLabel; raw: Parameters<typeof canonicalise>[0] }>
  },
  now: number,
): BuildSessionResult {
  const registration = input.registration ?? DEFAULT_BLINDING_REGISTRATION
  const reasons: string[] = []

  const violations = parityViolations(
    input.packets.map(p => ({ packetId: p.raw.packetId, raw: p.raw as unknown as Record<string, unknown> })),
  )
  for (const v of violations) reasons.push(`${v.packetId}: ${v.field} — ${v.why}`)

  // Both arms must actually be present. A "blind" session containing one side is
  // a session in which every guess is correct, and the accuracy metric would
  // report perfect origin inference for a reason that has nothing to do with
  // blinding.
  const origins = new Set(input.packets.map(p => p.origin))
  if (!origins.has('PROACTIVE') || !origins.has('REACTIVE')) {
    reasons.push('a session mindkét ágból kell hogy tartalmazzon csomagot')
  }
  if (reasons.length) return { ok: false, reasons }

  const ordered = shuffle(input.packets, input.shuffleSeed)
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO adjudication_sessions (session_id, control_run_id, proactive_run_id,
         rubric_version, shuffle_seed, registration_json, registration_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.sessionId, input.controlRunId, input.proactiveRunId, input.rubricVersion,
      input.shuffleSeed, JSON.stringify(registration), registrationDigest(registration), now)
    const ins = db.prepare(
      `INSERT INTO adjudication_packets (packet_id, session_id, origin_label, ordinal, canonical_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    ordered.forEach((p, i) => {
      ins.run(p.raw.packetId, input.sessionId, p.origin, i + 1, JSON.stringify(canonicalise(p.raw)), now)
    })
  })
  tx()
  return { ok: true, sessionId: input.sessionId, packetCount: ordered.length }
}

/**
 * What the adjudicator sees. The origin column is not selected — the query never
 * asks for it, so there is no value to leak into a log, a stack trace or a
 * debug render.
 */
export function packetsForAdjudicator(db: Database.Database, sessionId: string): AdjudicationPacket[] {
  const rows = db.prepare(
    `SELECT canonical_json FROM adjudication_packets WHERE session_id = ? ORDER BY ordinal`,
  ).all(sessionId) as Array<{ canonical_json: string }>
  return rows.map(r => JSON.parse(r.canonical_json) as AdjudicationPacket)
}

export type RecordJudgmentResult = { ok: true } | { ok: false; reason: string }

export function recordJudgment(
  db: Database.Database, rec: AdjudicationRecord,
): RecordJudgmentResult {
  const packet = db.prepare(`SELECT session_id FROM adjudication_packets WHERE packet_id = ?`)
    .get(rec.packetId) as { session_id: string } | undefined
  if (!packet) return { ok: false, reason: `nincs ilyen csomag: ${rec.packetId}` }
  const session = db.prepare(`SELECT unblinded_at, rubric_version FROM adjudication_sessions WHERE session_id = ?`)
    .get(packet.session_id) as { unblinded_at: number | null; rubric_version: string }
  if (session.unblinded_at != null) {
    // The one that turns the whole exercise into theatre. A judgement entered
    // after the origins are known is not a blind judgement, and it would be
    // counted in the accuracy metric as though it were.
    return { ok: false, reason: 'ez a session már fel van fedve — utána rögzített ítélet nem vak ítélet' }
  }
  if (rec.rubricVersion !== session.rubric_version) {
    // §V4-F13: "the rubric changes case by case" is a named FAIL.
    return { ok: false, reason: `a rubrika verziója eltér a sessionétől (${session.rubric_version})` }
  }
  try {
    db.prepare(
      `INSERT INTO adjudication_records (packet_id, adjudicator_id, judgment, timely, material,
         origin_guess, origin_guess_confidence, judged_at, rubric_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(rec.packetId, rec.adjudicatorId, rec.judgment, rec.timely ? 1 : 0, rec.material ? 1 : 0,
      rec.originGuess, rec.originGuessConfidence, rec.judgedAt, rec.rubricVersion)
  } catch {
    return { ok: false, reason: 'erre a csomagra már van ítélet — az ítélet végleges' }
  }
  return { ok: true }
}

export type UnblindResult = { ok: true; unblindedAt: number } | { ok: false; reason: string }

/**
 * §1.4.3: "provenance is unblinded only after both the judgment and the
 * origin_guess have been persisted."
 *
 * Whole-session, not per packet. Unblinding one packet tells the adjudicator
 * which way the coin landed, and every judgement after that is informed by it —
 * the sample would be half blind and reported as whole.
 */
export function unblind(db: Database.Database, sessionId: string, now: number): UnblindResult {
  const pending = (db.prepare(
    `SELECT COUNT(*) AS n FROM adjudication_packets p
      WHERE p.session_id = ?
        AND NOT EXISTS (SELECT 1 FROM adjudication_records r WHERE r.packet_id = p.packet_id)`,
  ).get(sessionId) as { n: number }).n
  if (pending > 0) {
    return { ok: false, reason: `${pending} csomagra még nincs ítélet — a felfedés csak utánuk jöhet` }
  }
  db.prepare(`UPDATE adjudication_sessions SET unblinded_at = ? WHERE session_id = ?`).run(now, sessionId)
  return { ok: true, unblindedAt: now }
}

// ── The blinding-effectiveness test ─────────────────────────────────────

function lgamma(x: number): number {
  const g = 7
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
const logChoose = (n: number, k: number): number => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)

/** P(K >= k) for K ~ Binomial(n, p). Computed in log space: at n in the
 *  hundreds the direct products underflow, and an underflowed p-value reads as
 *  a significant result. */
export function binomialTailGE(k: number, n: number, p: number): number {
  if (k <= 0) return 1
  if (k > n) return 0
  let s = 0
  for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))
  return Math.min(1, s)
}

/** The smallest number of correct guesses that would be significant at alpha. */
export function criticalValue(n: number, p0: number, alpha: number): number {
  for (let k = 0; k <= n; k++) if (binomialTailGE(k, n, p0) <= alpha) return k
  return n + 1
}

/** Power of the one-sided exact test at this n. */
export function powerAt(n: number, r: BlindingRegistration): number {
  const k = criticalValue(n, r.p0, r.alpha)
  return k > n ? 0 : binomialTailGE(k, n, r.p1)
}

/**
 * The smallest n whose OWN power reaches the target — 37 for the defaults.
 *
 * And the reason the registered default is 40 rather than 37: power is NOT
 * monotonic in n for an exact discrete test. Measured with this very function
 * at p0=0.5, p1=0.7, alpha=0.05:
 *
 *     n=37 → 0.807   n=38 → 0.775   n=39 → 0.740   n=40 → 0.807
 *     n=41 → 0.776   n=42 → 0.836   n=43 → 0.808   n=44 → 0.861
 *
 * The critical value jumps in whole counts while n grows continuously, so a
 * larger sample can be less powerful than a smaller one. "37, rounded up for
 * safety" is therefore not quite the right story — 38 and 39 are both WORSE than
 * 37. What makes 40 defensible is that it is pre-registered: the test is
 * evaluated at the n that was frozen before the window opened, not at whatever
 * n the collection happened to reach.
 */
export function minSampleForPower(r: BlindingRegistration = DEFAULT_BLINDING_REGISTRATION, max = 500): number | null {
  for (let n = 2; n <= max; n++) if (powerAt(n, r) >= r.targetPower) return n
  return null
}

export type BlindingVerdict = 'VALID' | 'BLINDING_EVIDENCE_INSUFFICIENT' | 'VALUE_GATE_ADJUDICATION_CAPABILITY_GAP'

export interface BlindingResult {
  verdict: BlindingVerdict
  sampleSize: number
  correct: number
  accuracy: number
  accuracyByConfidence: Record<GuessConfidence, { n: number; correct: number; accuracy: number }>
  pValue: number
  registrationDigest: string
  detail: string
}

/**
 * §1.4.3's fail-closed evaluation.
 *
 * Three outcomes and only one of them is a pass. Note which way the failures
 * point: too few packets is NOT a pass ("the release may be mechanically
 * complete, but it does not qualify as valid value-gate evidence"), and a judge
 * who can pick the origin is NOT a pass either. Silence is not success in either
 * direction, which is the property that makes this measurable at all.
 *
 * The registration digest is carried into the result so a later reader can tell
 * whether the rule this was judged by is the rule that was frozen.
 */
export function evaluateBlinding(
  db: Database.Database, sessionId: string,
): BlindingResult {
  const session = db.prepare(
    `SELECT registration_json, registration_digest FROM adjudication_sessions WHERE session_id = ?`,
  ).get(sessionId) as { registration_json: string; registration_digest: string } | undefined
  const reg: BlindingRegistration = session
    ? JSON.parse(session.registration_json) as BlindingRegistration
    : DEFAULT_BLINDING_REGISTRATION

  const rows = db.prepare(
    `SELECT r.origin_guess AS guess, r.origin_guess_confidence AS conf, p.origin_label AS truth
       FROM adjudication_records r
       JOIN adjudication_packets p ON p.packet_id = r.packet_id
      WHERE p.session_id = ?`,
  ).all(sessionId) as Array<{ guess: string; conf: GuessConfidence; truth: string }>

  const n = rows.length
  const correct = rows.filter(r => r.guess === r.truth).length
  const byConf: BlindingResult['accuracyByConfidence'] = {
    LOW: { n: 0, correct: 0, accuracy: 0 },
    MEDIUM: { n: 0, correct: 0, accuracy: 0 },
    HIGH: { n: 0, correct: 0, accuracy: 0 },
  }
  for (const r of rows) {
    const b = byConf[r.conf]
    b.n++
    if (r.guess === r.truth) b.correct++
  }
  for (const k of ['LOW', 'MEDIUM', 'HIGH'] as const) {
    byConf[k].accuracy = byConf[k].n ? byConf[k].correct / byConf[k].n : 0
  }

  const pValue = n > 0 ? binomialTailGE(correct, n, reg.p0) : 1
  const accuracy = n ? correct / n : 0
  const digest = session?.registration_digest ?? registrationDigest(reg)

  // Sample check FIRST. A significant p-value on nine packets is not evidence of
  // broken blinding; it is evidence of nine packets. Reporting the gap in that
  // situation would be a false alarm with the authority of a statistical test.
  if (n < reg.minPackets) {
    return {
      verdict: 'BLINDING_EVIDENCE_INSUFFICIENT', sampleSize: n, correct, accuracy,
      accuracyByConfidence: byConf, pValue, registrationDigest: digest,
      detail: `${n} ítélet a előre regisztrált ${reg.minPackets} helyett — ez nem PASS, hanem hiányzó bizonyíték`,
    }
  }
  if (pValue <= reg.alpha) {
    return {
      verdict: 'VALUE_GATE_ADJUDICATION_CAPABILITY_GAP', sampleSize: n, correct, accuracy,
      accuracyByConfidence: byConf, pValue, registrationDigest: digest,
      detail: `az eredet ${(accuracy * 100).toFixed(1)}%-ban kitalálható (p=${pValue.toExponential(2)}) — a vakítás nem működik`,
    }
  }
  return {
    verdict: 'VALID', sampleSize: n, correct, accuracy,
    accuracyByConfidence: byConf, pValue, registrationDigest: digest,
    detail: `${n} ítélet, ${(accuracy * 100).toFixed(1)}% találat, p=${pValue.toFixed(3)} — az eredet nem következtethető ki`,
  }
}
