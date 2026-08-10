// Personal Chief of Staff (COS) — connector health matrix (Slice 1 reliability).
//
// One row per connector. The preCheck gates actions on isUsable(); repeated
// failures degrade OK → DEGRADED → DOWN and a success resets to OK. `mode`
// records the current capability so a connector that is only READ_ONLY (Gmail
// before the write-scope consent) or DISABLED can never be used for a write.
// Pure DB logic.

import type Database from 'better-sqlite3'

export type ConnectorMode = 'READ_ONLY' | 'READ_WRITE' | 'DISABLED'
export type ConnectorStatus = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'

/** consecutive_failures at/after which status becomes DEGRADED, then DOWN. */
export const DEGRADED_THRESHOLD = 3
export const DOWN_THRESHOLD = 6

export interface ConnectorHealth {
  connectorId: string
  kind: string
  mode: ConnectorMode
  status: ConnectorStatus
  consecutiveFailures: number
  lastOkAt: number | null
  lastErrorAt: number | null
  lastError: string | null
}

interface Row {
  connector_id: string
  kind: string
  mode: ConnectorMode
  status: ConnectorStatus
  consecutive_failures: number
  last_ok_at: number | null
  last_error_at: number | null
  last_error: string | null
}

function toHealth(r: Row): ConnectorHealth {
  return {
    connectorId: r.connector_id, kind: r.kind, mode: r.mode, status: r.status,
    consecutiveFailures: r.consecutive_failures, lastOkAt: r.last_ok_at,
    lastErrorAt: r.last_error_at, lastError: r.last_error,
  }
}

/** Ensure a connector row exists (idempotent). Sets kind/mode on first insert;
 *  an existing row keeps its status/counters. */
export function registerConnector(
  db: Database.Database, connectorId: string, kind: string, mode: ConnectorMode, now: number,
): void {
  db.prepare(
    `INSERT INTO connector_health (connector_id, kind, mode, status, updated_at)
     VALUES (@id, @kind, @mode, 'UNKNOWN', @now)
     ON CONFLICT(connector_id) DO NOTHING`
  ).run({ id: connectorId, kind, mode, now })
}

export function getHealth(db: Database.Database, connectorId: string): ConnectorHealth | undefined {
  const r = db.prepare(`SELECT * FROM connector_health WHERE connector_id = ?`).get(connectorId) as Row | undefined
  return r ? toHealth(r) : undefined
}

/**
 * F-10 / B.3: record that this connector's idempotency marker provably survives
 * a send-and-read-back round trip. verifyMarkerPersistence produces the report;
 * this is where the result stops being a printout and becomes state that
 * something else consults.
 */
export function recordMarkerProof(
  db: Database.Database, connectorId: string, report: { passed: boolean; detail: string }, now: number,
): void {
  const info = db.prepare(
    `UPDATE connector_health SET marker_proof_at=@at, marker_proof_detail=@detail, updated_at=@now WHERE connector_id=@id`
  ).run({ id: connectorId, at: report.passed ? now : null, detail: report.detail, now })
  if (info.changes === 0) throw new Error(`connector not registered: ${connectorId}`)
}

/** Has a marker-persistence proof been recorded for this connector? */
export function hasMarkerProof(db: Database.Database, connectorId: string): boolean {
  const r = db.prepare(`SELECT marker_proof_at FROM connector_health WHERE connector_id=?`)
    .get(connectorId) as { marker_proof_at: number | null } | undefined
  return !!r?.marker_proof_at
}

/** Set the connector's capability mode (e.g. flip Gmail READ_ONLY → READ_WRITE
 *  when the consent lands, or DISABLED to fence it off).
 *
 *  F-10 / B.3: "if the marker cannot be proven, EXECUTE mode may NOT be
 *  activated." That was a sentence in the spec and a manual habit — the gate
 *  function existed with no caller, so the rule lived in whoever remembered it.
 *  Raising a connector TO a write mode now requires a recorded proof. Lowering
 *  it, and every other transition, is untouched: a rule that made it harder to
 *  DISABLE a misbehaving connector would be a worse rule than none. */
export function setMode(db: Database.Database, connectorId: string, mode: ConnectorMode, now: number): void {
  if (mode === 'READ_WRITE' && !hasMarkerProof(db, connectorId)) {
    throw new Error(
      `refusing to put "${connectorId}" in READ_WRITE: no marker-persistence proof on record (B.3). ` +
      `Run verifyMarkerPersistence and recordMarkerProof first.`
    )
  }
  const info = db.prepare(`UPDATE connector_health SET mode=@mode, updated_at=@now WHERE connector_id=@id`).run({ id: connectorId, mode, now })
  if (info.changes === 0) throw new Error(`connector not registered: ${connectorId}`)
}

/** A successful call: reset failures, status → OK. */
export function recordSuccess(db: Database.Database, connectorId: string, now: number): ConnectorHealth {
  const info = db.prepare(
    `UPDATE connector_health SET status='OK', consecutive_failures=0, last_ok_at=@now, updated_at=@now WHERE connector_id=@id`
  ).run({ id: connectorId, now })
  if (info.changes === 0) throw new Error(`connector not registered: ${connectorId}`)
  return getHealth(db, connectorId)!
}

/** A failed call: bump the counter and degrade OK → DEGRADED → DOWN by threshold. */
export function recordFailure(db: Database.Database, connectorId: string, error: string, now: number): ConnectorHealth {
  const cur = getHealth(db, connectorId)
  if (!cur) throw new Error(`connector not registered: ${connectorId}`)
  const failures = cur.consecutiveFailures + 1
  const status: ConnectorStatus = failures >= DOWN_THRESHOLD ? 'DOWN' : failures >= DEGRADED_THRESHOLD ? 'DEGRADED' : 'OK'
  db.prepare(
    `UPDATE connector_health SET status=@status, consecutive_failures=@failures, last_error_at=@now, last_error=@error, updated_at=@now WHERE connector_id=@id`
  ).run({ id: connectorId, status, failures, error, now })
  return getHealth(db, connectorId)!
}

/** The preCheck gate: may we USE this connector for an action right now? DOWN,
 *  DISABLED, or an unregistered connector → false (fail-closed). `requireWrite`
 *  additionally requires READ_WRITE mode (a write cannot go to a READ_ONLY
 *  connector). */
export function isUsable(db: Database.Database, connectorId: string, requireWrite = false): boolean {
  const h = getHealth(db, connectorId)
  if (!h) return false
  if (h.mode === 'DISABLED') return false
  if (requireWrite && h.mode !== 'READ_WRITE') return false
  return h.status === 'OK' || h.status === 'DEGRADED' || h.status === 'UNKNOWN'
}
