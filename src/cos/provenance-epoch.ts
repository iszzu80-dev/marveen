// Provenance epochs: an activation cutoff that cannot be moved to buy a green
// readiness (Istvan, 2026-08-23, activation blocker #2).
//
// THE INVERTED RULE THIS REPLACES. The rollback plan said a cutoff "moves
// forward, and the reason is recorded", treating a BACKWARD move as the
// dangerous one. That is exactly backwards, and the reason is mechanical:
// `goForwardProvenanceStatus(cutoff)` examines receipts with `decided_at >=
// cutoff`. Raising the cutoff SHRINKS the examined set. So a post-cutoff
// incomplete receipt at t=150 disappears the moment the cutoff moves from 100 to
// 200 -- the failure is not fixed, it is stepped over, and the gate reports PASS.
// Moving the cutoff backward only ever ADMITS more evidence; it is the harmless
// direction. The old text protected the wrong one.
//
// THE RULE NOW. Once an epoch is activated its cutoff is IMMUTABLE -- not
// forward, not backward, not "with the reason recorded". If the provenance
// regime genuinely changes, that is a NEW epoch with a NEW id and its OWN
// cutoff. The previous epoch keeps its result, and a sealed failure stays a
// failure forever: a new epoch is a fresh start for future receipts, never a
// retroactive pardon for past ones.
//
// Everything here is append-only. There is no update path, no delete path, and
// no repair path, for the same reason `recordTriageReceipt` has none: the rows
// are the evidence, and the moment they are worth editing is precisely the
// moment they must not be.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { goForwardProvenanceStatus } from './triage-provenance.js'

export const PROVENANCE_EPOCH_SCHEMA_VERSION = 1

export type EpochStatus = 'PASS' | 'GO_FORWARD_PROVENANCE_INCOMPLETE'

/** Activation reached the cutoff but no receipt has been decided at or after it
 *  yet. Not a PASS: a gate that has examined nothing has proven nothing. */
export const ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE = 'ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE'

export interface ProvenanceEpoch {
  epochId: string
  epochSeq: number
  cutoff: number
  openedAt: number
  reason: string
  sealedStatus: EpochStatus | null
  sealedAt: number | null
  sealedDetail: string | null
}

export function initProvenanceEpochSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_provenance_epoch (
      epoch_id       TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      epoch_seq      INTEGER NOT NULL UNIQUE,
      cutoff         INTEGER NOT NULL,
      opened_at      INTEGER NOT NULL,
      reason         TEXT NOT NULL,
      sealed_status  TEXT,
      sealed_at      INTEGER,
      sealed_detail  TEXT
    );
    -- Append-only observation log. Every readiness evaluation of an epoch lands
    -- here, so a failure that was once true stays visible even if the next
    -- evaluation of the same epoch passes.
    CREATE TABLE IF NOT EXISTS cos_provenance_epoch_observation (
      observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch_id       TEXT NOT NULL,
      observed_at    INTEGER NOT NULL,
      status         TEXT NOT NULL,
      examined       INTEGER NOT NULL,
      incomplete     INTEGER NOT NULL,
      detail         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prov_epoch_obs
      ON cos_provenance_epoch_observation(epoch_id, observed_at);
  `)
}

function rowToEpoch(r: Record<string, unknown>): ProvenanceEpoch {
  return {
    epochId: String(r.epoch_id),
    epochSeq: Number(r.epoch_seq),
    cutoff: Number(r.cutoff),
    openedAt: Number(r.opened_at),
    reason: String(r.reason),
    sealedStatus: (r.sealed_status as EpochStatus | null) ?? null,
    sealedAt: r.sealed_at == null ? null : Number(r.sealed_at),
    sealedDetail: r.sealed_detail == null ? null : String(r.sealed_detail),
  }
}

export function listProvenanceEpochs(db: Database.Database): ProvenanceEpoch[] {
  initProvenanceEpochSchema(db)
  const rows = db.prepare(
    'SELECT * FROM cos_provenance_epoch ORDER BY epoch_seq'
  ).all() as Array<Record<string, unknown>>
  return rows.map(rowToEpoch)
}

/** The epoch currently in force: the highest-sequence one that is not sealed.
 *  Null when none is open (nothing activated, or the last one was sealed). */
export function activeProvenanceEpoch(db: Database.Database): ProvenanceEpoch | null {
  initProvenanceEpochSchema(db)
  const r = db.prepare(
    'SELECT * FROM cos_provenance_epoch WHERE sealed_status IS NULL ORDER BY epoch_seq DESC LIMIT 1'
  ).get() as Record<string, unknown> | undefined
  return r ? rowToEpoch(r) : null
}

function epochIdFor(seq: number, cutoff: number, reason: string): string {
  const canonical = JSON.stringify([PROVENANCE_EPOCH_SCHEMA_VERSION, seq, cutoff, reason])
  return `epoch:${seq}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

/**
 * Open a provenance epoch and fix its cutoff for good.
 *
 * Refuses while another epoch is open: two live cutoffs would mean the gate has
 * a choice of which evidence to look at, which is the same escape hatch this
 * module exists to close, wearing a different hat. Seal the current one first --
 * sealing is what makes its result permanent.
 */
export function openProvenanceEpoch(
  db: Database.Database,
  params: { cutoff: number; reason: string },
  now: number,
): ProvenanceEpoch {
  initProvenanceEpochSchema(db)
  if (!Number.isInteger(params.cutoff) || params.cutoff < 0) {
    throw new Error('PROVENANCE_EPOCH_INVALID_CUTOFF: cutoff must be a non-negative unix second')
  }
  if (!params.reason || !params.reason.trim()) {
    throw new Error('PROVENANCE_EPOCH_REASON_REQUIRED: an epoch without a stated reason is unauditable')
  }
  const open = activeProvenanceEpoch(db)
  if (open) {
    throw new Error(
      `PROVENANCE_EPOCH_ALREADY_OPEN: ${open.epochId} (cutoff ${open.cutoff}) is still open; `
      + 'seal it before opening a new epoch, so its result becomes permanent first')
  }
  const prev = db.prepare(
    'SELECT epoch_seq, cutoff FROM cos_provenance_epoch ORDER BY epoch_seq DESC LIMIT 1'
  ).get() as { epoch_seq: number; cutoff: number } | undefined

  if (prev && params.cutoff <= prev.cutoff) {
    // A new epoch that starts at or before the previous cutoff would re-examine
    // receipts the sealed epoch already judged, and could report PASS over them.
    throw new Error(
      `PROVENANCE_EPOCH_CUTOFF_NOT_AFTER_PREVIOUS: new cutoff ${params.cutoff} must be strictly `
      + `after the previous epoch's cutoff ${prev.cutoff}; a later epoch may not re-judge earlier receipts`)
  }
  const seq = (prev?.epoch_seq ?? 0) + 1
  const epochId = epochIdFor(seq, params.cutoff, params.reason)
  db.prepare(`
    INSERT INTO cos_provenance_epoch
      (epoch_id, schema_version, epoch_seq, cutoff, opened_at, reason, sealed_status, sealed_at, sealed_detail)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).run(epochId, PROVENANCE_EPOCH_SCHEMA_VERSION, seq, params.cutoff, now, params.reason.trim())
  return {
    epochId, epochSeq: seq, cutoff: params.cutoff, openedAt: now,
    reason: params.reason.trim(), sealedStatus: null, sealedAt: null, sealedDetail: null,
  }
}

/**
 * Evaluate an epoch against ITS OWN frozen cutoff, and record the observation.
 *
 * The caller cannot pass a cutoff. That is the fix: the only way to ask "are we
 * ready?" is to ask it at the cutoff that was fixed at activation, so there is
 * no argument to tune until the answer turns green.
 */
export function evaluateProvenanceEpoch(
  db: Database.Database, epochId: string, now: number,
): { epochId: string; cutoff: number; status: EpochStatus | typeof ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE
     examined: number; incomplete: number; offenders: Array<{ receiptId: string; missing: string[] }> } {
  initProvenanceEpochSchema(db)
  const row = db.prepare('SELECT * FROM cos_provenance_epoch WHERE epoch_id=?')
    .get(epochId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`PROVENANCE_EPOCH_UNKNOWN: ${epochId}`)
  const epoch = rowToEpoch(row)

  const g = goForwardProvenanceStatus(db, epoch.cutoff)
  // Zero examined is not a pass. An activated epoch that has judged nothing has
  // proven nothing, and calling that PASS is precisely the false green Istvan
  // asked to be impossible.
  const status = g.examined === 0
    ? ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE
    : g.status

  db.prepare(`
    INSERT INTO cos_provenance_epoch_observation
      (epoch_id, observed_at, status, examined, incomplete, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(epochId, now, status, g.examined, g.incomplete,
    g.offenders.length ? JSON.stringify(g.offenders.slice(0, 50)) : null)

  return { epochId, cutoff: epoch.cutoff, status, examined: g.examined,
    incomplete: g.incomplete, offenders: g.offenders }
}

/**
 * Seal an epoch: freeze its verdict permanently.
 *
 * A sealed epoch is never re-sealed. In particular a FAILED seal cannot be
 * replaced by a later PASS -- not by re-running the gate, not by opening a new
 * epoch, not by both. That is the whole point of blocker #2: history that can be
 * re-graded is not history.
 */
export function sealProvenanceEpoch(
  db: Database.Database, epochId: string, now: number,
): ProvenanceEpoch {
  initProvenanceEpochSchema(db)
  const row = db.prepare('SELECT * FROM cos_provenance_epoch WHERE epoch_id=?')
    .get(epochId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`PROVENANCE_EPOCH_UNKNOWN: ${epochId}`)
  const epoch = rowToEpoch(row)
  if (epoch.sealedStatus) {
    throw new Error(
      `PROVENANCE_EPOCH_ALREADY_SEALED: ${epochId} is sealed ${epoch.sealedStatus}; `
      + 'a sealed epoch is immutable, including a failed one')
  }
  const ev = evaluateProvenanceEpoch(db, epochId, now)
  // Awaiting-evidence is not a verdict, so it cannot be sealed into one.
  if (ev.status === ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE) {
    throw new Error(
      `PROVENANCE_EPOCH_NO_EVIDENCE: ${epochId} has examined 0 post-cutoff receipts; `
      + 'sealing it would record a verdict nothing supports')
  }
  // Any observation that ever failed makes the seal a failure, regardless of the
  // final reading. Otherwise an epoch could be nursed to green and sealed on its
  // best moment.
  const everFailed = db.prepare(
    `SELECT COUNT(*) AS n FROM cos_provenance_epoch_observation
     WHERE epoch_id=? AND status='GO_FORWARD_PROVENANCE_INCOMPLETE'`
  ).get(epochId) as { n: number }

  const status: EpochStatus = everFailed.n > 0 ? 'GO_FORWARD_PROVENANCE_INCOMPLETE' : 'PASS'
  const detail = everFailed.n > 0
    ? `${everFailed.n} incomplete observation(s) recorded during this epoch; last reading `
      + `examined=${ev.examined} incomplete=${ev.incomplete}`
    : `examined=${ev.examined} incomplete=0`

  db.prepare(
    'UPDATE cos_provenance_epoch SET sealed_status=?, sealed_at=?, sealed_detail=? WHERE epoch_id=? AND sealed_status IS NULL'
  ).run(status, now, detail, epochId)
  return { ...epoch, sealedStatus: status, sealedAt: now, sealedDetail: detail }
}

/**
 * The standing activation gate.
 *
 * PASS requires BOTH: the open epoch currently reads PASS over a non-empty set,
 * AND no sealed epoch ever failed. The second half is what makes a new epoch
 * unable to launder an old failure.
 */
export function activationProvenanceReadiness(db: Database.Database, now: number): {
  status: 'PASS' | 'NO_ACTIVE_EPOCH' | typeof ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE
        | 'GO_FORWARD_PROVENANCE_INCOMPLETE' | 'PRIOR_EPOCH_FAILED'
  activeEpoch: ProvenanceEpoch | null
  active: ReturnType<typeof evaluateProvenanceEpoch> | null
  priorFailures: Array<{ epochId: string; cutoff: number; sealedAt: number | null; detail: string | null }>
} {
  initProvenanceEpochSchema(db)
  const failedRows = db.prepare(
    `SELECT epoch_id, cutoff, sealed_at, sealed_detail FROM cos_provenance_epoch
     WHERE sealed_status='GO_FORWARD_PROVENANCE_INCOMPLETE' ORDER BY epoch_seq`
  ).all() as Array<Record<string, unknown>>
  const priorFailures = failedRows.map(r => ({
    epochId: String(r.epoch_id), cutoff: Number(r.cutoff),
    sealedAt: r.sealed_at == null ? null : Number(r.sealed_at),
    detail: r.sealed_detail == null ? null : String(r.sealed_detail),
  }))

  const epoch = activeProvenanceEpoch(db)
  if (!epoch) {
    return {
      status: priorFailures.length ? 'PRIOR_EPOCH_FAILED' : 'NO_ACTIVE_EPOCH',
      activeEpoch: null, active: null, priorFailures,
    }
  }
  const active = evaluateProvenanceEpoch(db, epoch.epochId, now)
  if (priorFailures.length) {
    return { status: 'PRIOR_EPOCH_FAILED', activeEpoch: epoch, active, priorFailures }
  }
  return {
    status: active.status === 'PASS' ? 'PASS' : active.status,
    activeEpoch: epoch, active, priorFailures,
  }
}
