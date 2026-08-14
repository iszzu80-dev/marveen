// §1.4.6 / §26(26): the immutable replay run ledger, and the control arm.
//
// WHAT THE AUDIT FOUND. `scripts/cos-dryrun-progression.ts` is a genuine
// live-safe replay driver — it runs over a copy, refuses the live database by
// name, does N cycles. But it reports to stdout and nothing else. There is no
// run ID, no config version, no persisted output. And one level deeper there is
// no concept of a control ARM at all: today there is one engine, not two
// comparable configurations.
//
// WHY THAT MATTERS MORE THAN IT SOUNDS. §1.4's entire value gate rests on the
// claim "the reactive baseline would not have surfaced this". §1.4.6 spells out
// what makes that claim admissible, and the last line is the one that bites:
//
//     "A baseline reconstructed from memory, by manual retrospection, or with
//      knowledge of the proactive output is NOT an acceptable control."
//
// A baseline you run AFTER seeing what the proactive side found is not evidence,
// however honestly it is produced — you cannot un-know the answer while choosing
// what to measure. That is not a discipline problem to be solved by asking
// people to be careful. It is an ordering constraint, and this file enforces it:
// once a PROACTIVE_SHADOW run exists over a corpus, `beginRun` REFUSES to create
// a REACTIVE_CONTROL run over that same corpus. The control goes first or it
// does not count.
//
// WHERE THIS LIVES, AND WHY NOT IN THE CORPUS. The ledger is a SEPARATE database
// from the corpus copy the run drives. Writing run rows into the corpus would
// change the corpus — so the fingerprint taken at the start would no longer
// describe the thing the next arm runs over, and "the same frozen corpus" (the
// first of §1.4.6's five conditions) would be false by construction, in a way
// that is invisible unless you go looking.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DETECTOR_BEHAVIOUR_SCOPE } from './detector-scope.js'

/**
 * §1.4.6: the two sides of the comparison — plus a third that is not a side.
 *
 * CALIBRATION exists because of a measurement Marveen took on 2026-08-13: the
 * 90-day corpus §26/3 asks for does not exist anywhere. The live Case layer is
 * eight days deep on the personal side and six on the corporate one. So the
 * eligible-observation VOLUME — the thing the 90 days was a proxy for — has to
 * be measured forward rather than backward.
 *
 * A calibration run measures volume and NOTHING ELSE. Its outputs never enter an
 * adjudication session, which is what keeps V4-F14's named FAIL out of reach:
 * choosing a threshold after seeing RESULTS is manufacturing a PASS, and results
 * are what adjudication produces. Volume is not a result. The firewall between
 * them is enforced below rather than remembered.
 */
export type ReplayArm = 'REACTIVE_CONTROL' | 'PROACTIVE_SHADOW' | 'CALIBRATION'

export interface ReplayRun {
  runId: string
  arm: ReplayArm
  /** Identifies the corpus this run was driven over. Two runs may only be
   *  compared when these match. */
  corpusFingerprint: string
  /** Identifies the configuration that produced it, so §1.4.6's fifth condition
   *  — "reproducible by run ID and config version" — is checkable rather than
   *  asserted. */
  configVersion: string
  configJson: string
  startedAt: number
  sealedAt: number | null
  /** Digest of every output row, computed at seal time. Two runs with the same
   *  corpus, the same config and the same digest are the same run. */
  outputDigest: string | null
  outputCount: number
}

export interface ReplayOutput {
  runId: string
  domain: string
  caseId: string
  cycle: number
  decision: string
  reason: string
}

export function ensureReplaySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_runs (
      run_id             TEXT PRIMARY KEY,
      arm                TEXT NOT NULL,
      corpus_fingerprint TEXT NOT NULL,
      config_version     TEXT NOT NULL,
      config_json        TEXT NOT NULL,
      started_at         INTEGER NOT NULL,
      sealed_at          INTEGER,
      output_digest      TEXT,
      output_count       INTEGER NOT NULL DEFAULT 0,
      CHECK (arm IN ('REACTIVE_CONTROL','PROACTIVE_SHADOW','CALIBRATION'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_replay_corpus ON replay_runs(corpus_fingerprint, arm)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_outputs (
      run_id    TEXT NOT NULL REFERENCES replay_runs(run_id),
      seq       INTEGER NOT NULL,
      domain    TEXT NOT NULL,
      case_id   TEXT NOT NULL,
      cycle     INTEGER NOT NULL,
      decision  TEXT NOT NULL,
      reason    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (run_id, seq)
    )
  `)

  // IMMUTABILITY, enforced by the database rather than by the callers.
  //
  // §1.4.6 requires the control's output to be recorded "independently and
  // immutably, before the adjudication". A sealed run that an application-layer
  // check protects is a sealed run that the next script to be written can edit
  // by accident. These triggers make the edit impossible from any code path,
  // including a REPL — the same posture the case event log already takes.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_replay_outputs_no_update
    BEFORE UPDATE ON replay_outputs
    BEGIN SELECT RAISE(ABORT, 'replay_outputs is append-only'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_replay_outputs_no_delete
    BEFORE DELETE ON replay_outputs
    BEGIN SELECT RAISE(ABORT, 'replay_outputs is append-only'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_replay_outputs_sealed
    BEFORE INSERT ON replay_outputs
    WHEN (SELECT sealed_at FROM replay_runs WHERE run_id = NEW.run_id) IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'this replay run is sealed'); END
  `)
  // A sealed run's own header is frozen too, except for the one transition that
  // seals it — which is why the trigger tests the OLD row, not the new one.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_replay_runs_sealed
    BEFORE UPDATE ON replay_runs
    WHEN OLD.sealed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'this replay run is sealed'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_replay_runs_no_delete
    BEFORE DELETE ON replay_runs
    BEGIN SELECT RAISE(ABORT, 'replay runs are permanent'); END
  `)
}

/**
 * A deterministic fingerprint of the corpus a run will be driven over.
 *
 * Content, not file bytes. A copy of a SQLite database differs from its original
 * in page layout, WAL state and free-page ordering, so hashing the file would
 * call two identical corpora different and make the whole comparison
 * unavailable. What matters is the material the engine will read: which cases
 * exist, in what version, in what state.
 *
 * The `updated_at` of each case is included on purpose. Two corpora with the
 * same cases in the same states but at different points in time are NOT the same
 * corpus — every deadline and staleness rule in the engine reads exactly that.
 */
export function corpusFingerprint(corpus: Database.Database): string {
  const h = createHash('sha256')
  for (const table of ['personal_cases', 'zst_cases']) {
    let rows: Array<{ id: string; v: number; s: string; u: number }> = []
    try {
      rows = corpus.prepare(
        `SELECT case_id AS id, version AS v, status AS s, updated_at AS u
           FROM ${table} ORDER BY case_id`,
      ).all() as Array<{ id: string; v: number; s: string; u: number }>
    } catch {
      // A corpus without one of the two domains is a legitimate corpus. It is
      // marked as absent rather than skipped, so "no zst cases" and "no zst
      // table" cannot produce the same fingerprint.
      h.update(`${table}:ABSENT\u0000`)
      continue
    }
    h.update(`${table}:${rows.length}\u0000`)
    for (const r of rows) h.update(`${r.id}\u0001${r.v}\u0001${r.s}\u0001${r.u}\u0000`)
  }
  return h.digest('hex').slice(0, 32)
}

/** A config's identity. Key order is normalised, because `{a,b}` and `{b,a}` are
 *  the same configuration and a naive JSON hash would call them different runs. */
export function configVersion(config: Record<string, unknown>): string {
  const canonical = JSON.stringify(config, Object.keys(config).sort())
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export type BeginRunResult =
  | { ok: true; run: ReplayRun }
  | { ok: false; reason: string }

/**
 * Open a replay run.
 *
 * The refusal below is the whole point of the module. §1.4.6's last line rules
 * out a baseline produced with knowledge of the proactive output, and the only
 * way to enforce that mechanically is to make the ORDER a precondition rather
 * than a habit: the control arm runs first, or there is no control.
 *
 * Deliberately NOT symmetric. A proactive run after a control run is the
 * intended order; a control run after a proactive run is the failure. Refusing
 * both would only mean nobody could run the second arm at all.
 */
export function beginRun(
  ledger: Database.Database,
  input: {
    runId: string
    arm: ReplayArm
    corpusFingerprint: string
    config: Record<string, unknown>
  },
  now: number,
): BeginRunResult {
  const existing = ledger.prepare(`SELECT run_id FROM replay_runs WHERE run_id = ?`).get(input.runId)
  if (existing) return { ok: false, reason: `ez a run azonosító már létezik: ${input.runId}` }

  if (input.arm === 'REACTIVE_CONTROL') {
    // A CALIBRATION run counts here exactly as a shadow run does, and that is
    // deliberate. It produces proactive output — unadjudicated, but seen — and
    // a control built afterwards was built by someone who had seen it. The
    // consequence falls out as a property worth having: calibration and
    // measurement cannot share a corpus.
    const proactive = ledger.prepare(
      `SELECT run_id, arm FROM replay_runs
        WHERE corpus_fingerprint = ? AND arm IN ('PROACTIVE_SHADOW','CALIBRATION')
        ORDER BY started_at LIMIT 1`,
    ).get(input.corpusFingerprint) as { run_id: string; arm: string } | undefined
    if (proactive) {
      return {
        ok: false,
        reason:
          `ezen a korpuszon már futott proaktív ág (${proactive.run_id}, ${proactive.arm}), ezért a `
          + 'reaktív kontroll most már nem hozható létre: a §1.4.6 szerint a proaktív kimenet '
          + 'ismeretében előállított baseline nem elfogadható kontroll',
      }
    }
  }

  const version = configVersion(input.config)
  ledger.prepare(
    `INSERT INTO replay_runs (run_id, arm, corpus_fingerprint, config_version, config_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.runId, input.arm, input.corpusFingerprint, version, JSON.stringify(input.config), now)

  return { ok: true, run: readRun(ledger, input.runId)! }
}

/** Append one decision. Throws once the run is sealed — by trigger, not by a
 *  check this function performs, so the guarantee survives a caller that goes
 *  around it. */
export function recordOutput(ledger: Database.Database, out: ReplayOutput): void {
  const seq = (ledger.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM replay_outputs WHERE run_id = ?`,
  ).get(out.runId) as { m: number }).m + 1
  ledger.prepare(
    `INSERT INTO replay_outputs (run_id, seq, domain, case_id, cycle, decision, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(out.runId, seq, out.domain, out.caseId, out.cycle, out.decision, out.reason)
}

/**
 * Seal the run: no more output, and a digest over everything it produced.
 *
 * The digest is over the outputs in SEQUENCE order, not sorted. Two runs that
 * reached the same decisions in a different order are not the same run — the
 * order is part of what the engine did, and a sorted digest would hide a
 * scheduling change that altered which case saw which state first.
 */
export function sealRun(ledger: Database.Database, runId: string, now: number): ReplayRun {
  const rows = ledger.prepare(
    `SELECT domain, case_id, cycle, decision, reason FROM replay_outputs
      WHERE run_id = ? ORDER BY seq`,
  ).all(runId) as Array<{ domain: string; case_id: string; cycle: number; decision: string; reason: string }>
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.domain}\u0001${r.case_id}\u0001${r.cycle}\u0001${r.decision}\u0000`)
  ledger.prepare(
    `UPDATE replay_runs SET sealed_at = ?, output_digest = ?, output_count = ? WHERE run_id = ?`,
  ).run(now, h.digest('hex').slice(0, 32), rows.length, runId)
  return readRun(ledger, runId)!
}

export function readRun(ledger: Database.Database, runId: string): ReplayRun | null {
  const r = ledger.prepare(`SELECT * FROM replay_runs WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    runId: r.run_id as string,
    arm: r.arm as ReplayArm,
    corpusFingerprint: r.corpus_fingerprint as string,
    configVersion: r.config_version as string,
    configJson: r.config_json as string,
    startedAt: r.started_at as number,
    sealedAt: (r.sealed_at as number | null) ?? null,
    outputDigest: (r.output_digest as string | null) ?? null,
    outputCount: r.output_count as number,
  }
}

export function readOutputs(ledger: Database.Database, runId: string): ReplayOutput[] {
  return (ledger.prepare(
    `SELECT run_id, domain, case_id, cycle, decision, reason FROM replay_outputs
      WHERE run_id = ? ORDER BY seq`,
  ).all(runId) as Array<Record<string, unknown>>).map(r => ({
    runId: r.run_id as string,
    domain: r.domain as string,
    caseId: r.case_id as string,
    cycle: r.cycle as number,
    decision: r.decision as string,
    reason: r.reason as string,
  }))
}

export interface ComparabilityVerdict {
  comparable: boolean
  reasons: string[]
  control?: ReplayRun
  proactive?: ReplayRun
}

/**
 * May these two runs be compared at all?
 *
 * §1.4.6's five conditions, checked rather than assumed. This function exists so
 * the answer arrives BEFORE an adjudicator spends an hour on packets that were
 * never admissible — and so "we compared them" is a claim with a verdict behind
 * it instead of an assumption nobody wrote down.
 *
 * It cannot check everything. "The control did not see the proactive output"
 * is enforced by `beginRun`'s ordering rule, and "it received the same source
 * data" is a property of how the driver was invoked, not of these rows. What is
 * checkable is checked; what is not is named as such rather than quietly
 * counted as passed.
 */
export function assertComparable(
  ledger: Database.Database, controlRunId: string, proactiveRunId: string,
): ComparabilityVerdict {
  const control = readRun(ledger, controlRunId) ?? undefined
  const proactive = readRun(ledger, proactiveRunId) ?? undefined
  const reasons: string[] = []
  if (!control) reasons.push(`nincs ilyen kontroll-futás: ${controlRunId}`)
  if (!proactive) reasons.push(`nincs ilyen proaktív futás: ${proactiveRunId}`)
  if (control && proactive) {
    // The calibration firewall, stated where it bites. A calibration run exists
    // to size the window; letting one into an adjudication session would put the
    // very observations that CHOSE the threshold inside the sample the threshold
    // is applied to.
    for (const r of [control, proactive]) {
      if (r.arm === 'CALIBRATION') {
        reasons.push(`a(z) ${r.runId} kalibrációs futás — kalibrációs kimenet nem kerülhet adjudikációba`)
      }
    }
    if (control.arm !== 'REACTIVE_CONTROL') reasons.push('a kontrollnak jelölt futás nem REACTIVE_CONTROL ágon van')
    if (proactive.arm !== 'PROACTIVE_SHADOW') reasons.push('a proaktívnak jelölt futás nem PROACTIVE_SHADOW ágon van')
    if (control.corpusFingerprint !== proactive.corpusFingerprint) {
      reasons.push('a két futás nem ugyanazon a korpuszon ment')
    }
    if (!control.sealedAt) reasons.push('a kontroll-futás nincs lezárva — az adjudikáció előtt le kell zárni')
    if (!proactive.sealedAt) reasons.push('a proaktív futás nincs lezárva')
    if (control.sealedAt && proactive.startedAt < control.sealedAt) {
      // Not the same check as beginRun's. That one stops a control being CREATED
      // after a proactive run; this one catches the overlap — a proactive arm
      // that started while the control was still open could have influenced it
      // through the shared corpus.
      reasons.push('a proaktív futás a kontroll lezárása előtt indult — a két ág átfedett')
    }
  }
  return { comparable: reasons.length === 0, reasons, control, proactive }
}

/** §1.4.6 condition 5: reproducible by run ID and config version. Given a fresh
 *  run over the same corpus with the same config, its digest must match. */
export function reproduces(a: ReplayRun, b: ReplayRun): boolean {
  return a.corpusFingerprint === b.corpusFingerprint
    && a.configVersion === b.configVersion
    && a.outputDigest !== null
    && a.outputDigest === b.outputDigest
}


/**
 * The DETECTOR configuration's fingerprint — the freeze point as a gate rather
 * than a date.
 *
 * Marveen's objection, 2026-08-13: "a promise that no proactive module will land
 * is exactly the kind of statement that gets quietly broken." So the calibration
 * run records this hash and refuses to run against a different one. Frozen from
 * the commit the calibration starts on, with the hash as the evidence.
 *
 * It hashes the SOURCE of the detector modules, not a version string somebody
 * has to remember to bump. A version string is another promise.
 *
 * The intake modules are in the hash too, and that is the less obvious half.
 * Marveen measured that today's cases were created by his own email-triage
 * heartbeat — so what looks like an organic arrival rate is partly the output of
 * our own intake channel. The eligible-observation rate is therefore CONDITIONAL
 * on an intake configuration, and changing intake invalidates a frozen window
 * exactly as changing the detector does. A hash covering only the detector would
 * let the denominator move while the experiment claimed to be frozen.
 */
export function detectorConfigFingerprint(
  readFile: (path: string) => string,
  listFiles: (dir: string) => string[],
  roots: readonly string[] = DETECTOR_BEHAVIOUR_SCOPE,
): string {
  const h = createHash('sha256')
  const files: string[] = []
  for (const root of roots) {
    if (root.endsWith('.ts')) { files.push(root); continue }
    files.push(...listFiles(root))
  }
  for (const f of [...files].sort()) {
    let body = ''
    try { body = readFile(f) } catch { body = '<<UNREADABLE>>' }
    h.update(f + ' ' + body + ' ')
  }
  return h.digest('hex').slice(0, 32)
}

export type ConfigGateResult = { ok: true } | { ok: false; reason: string }

/**
 * §26/2 as a gate: refuse a run whose detector configuration differs from the
 * one the registration froze.
 *
 * Returns ok when no expectation was registered — a run before the freeze is
 * legitimate, and refusing it would make the first run impossible. The gate
 * bites the moment somebody has committed to a hash.
 */
export function assertFrozenConfig(
  expected: string | null | undefined,
  actual: string,
): ConfigGateResult {
  if (!expected) return { ok: true }
  if (expected === actual) return { ok: true }
  return {
    ok: false,
    reason:
      'a detektor-konfiguracio megvaltozott a regisztracio ota (vart ' + expected
      + ', kapott ' + actual + ') — a befagyasztott ablakban felhalmozott meres ervenytelen, '
      + 'a kalibraciot ujra kell kezdeni',
  }
}
