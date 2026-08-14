// Lean Optimization Phase 2 / P2-B -- packet metadata persistence.
//
// Stores the OPTIONAL context-packet metadata of a P2-A dispatch. Measurement
// only: nothing here changes what gets dispatched, and a failure here can never
// stop a send (see recordPacketMetadataSafe, which mirrors P2-A's
// createDispatchSafe fault-isolation pattern).
//
// SEAM: the DDL is invoked from initCostOpsSchema(db) (costops/schema.ts), the
// SAME local-fork CostOps seam P2-A uses -- NOT a second parallel seam and NOT
// db.ts. It runs right after initDispatchSchema(db) because it references the
// dispatches table's id.
//
// WHY A LINKED TABLE AND NOT NULLABLE COLUMNS ON `dispatches` (justification the
// spec asks for):
//  1. `referencedArtifacts` and `contentHashes` are 1:N by nature. Putting them
//     on `dispatches` means either a JSON blob column (unqueryable -- "which
//     dispatches referenced this file at this commit?" becomes a LIKE scan) or N
//     invented columns. A child table keeps path/ref/hash as real, indexed rows.
//  2. Packet metadata is present on a MINORITY of dispatches (it is optional and
//     opt-in per origin). Six-plus nullable columns on the hot `dispatches`
//     table would be NULL on most rows, and every future packet field would ALTER
//     the row that every P2-A read path touches.
//  3. Rollback: ignoring or dropping these two tables leaves `dispatches`
//     byte-identical to its P2-A shape, with zero data loss and no schema change
//     to undo. Nullable columns can be left inert but not removed cleanly on
//     SQLite.
// Two tables, therefore: `dispatch_packets` (1:1 scalars) and
// `dispatch_packet_artifacts` (1:N path/ref/hash rows).
//
// DATA SENSITIVITY (hard): no column here may carry prompt text, packet body,
// excerpt text, PII, or a credential. `artifact_path` + `artifact_ref` +
// `content_hash` are paths and hashes; that is the whole point of the packet
// format. There is deliberately no `packet_body` column to write one into.
//
// `estimate_confidence` is NOT NULL: a persisted token number can never lose its
// confidence marker, so no reader can mistake an estimate for a measurement.

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import type { PacketMetadata, TaskSize, ContextBudgetClass, EstimateConfidence } from '../context-packet.js'

/** Create the packet-metadata tables. Idempotent boot DDL (CREATE TABLE IF NOT
 *  EXISTS + try/catch ALTER), nullable, forward-only, never backfilled. */
export function initPacketMetadataSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_packets (
      dispatch_id           TEXT PRIMARY KEY,
      created_at            INTEGER NOT NULL,
      packet_version        TEXT,
      estimated_fresh_tokens INTEGER,
      -- NOT NULL on purpose: an estimate may never be stored unmarked.
      estimate_confidence   TEXT NOT NULL,
      estimate_method       TEXT,
      task_size             TEXT,
      task_size_source      TEXT,
      context_budget_class  TEXT
    )
  `)
  // APG 1.9 §12.1 packet IDENTITY. Additive, nullable, forward-only, never
  // backfilled -- the same idempotent-ALTER convention every other CostOps
  // column uses. A pre-WP4 row keeps NULL here, which honestly means "this
  // dispatch predates packet identity", never a hash recomputed from a packet
  // nobody kept.
  //
  // These four columns are what give the kernel's `context_packet_hash` a
  // source (execution_identity.py recorded NO_SOURCE_IN_KERNEL for it), and
  // `packet_hash` is the join key: same hash => provably the same delivered
  // context, whatever else differs between two dispatches.
  //
  // Still no `packet_body` column, and there must never be one -- the data
  // sensitivity note above is unchanged by WP4. A hash of the body is not the
  // body; that asymmetry is the whole reason it is safe to store.
  for (const column of ['packet_id TEXT', 'packet_hash TEXT', 'generated_at TEXT', 'execution_role TEXT']) {
    try { db.exec(`ALTER TABLE dispatch_packets ADD COLUMN ${column}`) } catch { /* already exists */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_size ON dispatch_packets(task_size, created_at)`)
  // "Which dispatches ran against THIS context?" -- the query the packet hash
  // exists to make answerable.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_hash ON dispatch_packets(packet_hash)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_packet_artifacts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id   TEXT NOT NULL,
      position      INTEGER NOT NULL,
      artifact_path TEXT NOT NULL,
      artifact_ref  TEXT,
      content_hash  TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_packet_artifacts_dispatch ON dispatch_packet_artifacts(dispatch_id, position)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_packet_artifacts_hash ON dispatch_packet_artifacts(content_hash)`)
}

/** What a caller records. `taskSizeSource` comes from resolveTaskSize() so the
 *  provenance of a size ('explicit' | 'workflow_policy' | 'agent_default') is
 *  auditable -- it is how we can later prove no size was model-guessed. */
export interface PacketMetadataInput extends Omit<PacketMetadata,
  'packetId' | 'packetHash' | 'generatedAt' | 'executionRole'> {
  /** §12.1 identity. OPTIONAL on the input, and required on PacketMetadata --
   *  derivePacketMetadata() always fills them, while a recorder that has no
   *  packet in hand (an origin instrumenting a send it did not build) stores
   *  NULL instead of a hash of something it did not deliver. */
  packetId?: string | null
  packetHash?: string | null
  generatedAt?: string | null
  executionRole?: string | null
  taskSizeSource?: string | null
}

export interface PacketMetadataRow {
  dispatchId: string
  createdAt: number
  packetVersion: string | null
  packetId: string | null
  packetHash: string | null
  generatedAt: string | null
  executionRole: string | null
  estimatedFreshTokens: number | null
  estimateConfidence: EstimateConfidence | string
  estimateMethod: string | null
  taskSize: TaskSize | null
  taskSizeSource: string | null
  contextBudgetClass: ContextBudgetClass | null
  referencedArtifacts: string[]
  contentHashes: string[]
}

const SECRET_SHAPE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{12,}|\bBearer\s+[A-Za-z0-9._-]{20,}/

/**
 * Persist one dispatch's packet metadata. Idempotent per dispatch (re-recording
 * replaces the row and its artifact rows), so a retried origin cannot duplicate.
 *
 * Rejects (throws) rather than silently storing:
 *  - a missing confidence marker on the token estimate;
 *  - an artifact entry whose path looks like a credential.
 * The throw is caught by recordPacketMetadataSafe on the hot path, so a rejected
 * record costs the METADATA, never the dispatch.
 */
export function recordPacketMetadata(
  db: Database.Database,
  dispatchId: string,
  meta: PacketMetadataInput,
  now: number = Date.now(),
): void {
  if (!dispatchId) throw new Error('recordPacketMetadata: dispatchId is required')
  if (!meta.estimateConfidence) {
    throw new Error('recordPacketMetadata: estimatedFreshTokens must carry a confidence marker (never store an estimate as measured)')
  }
  const artifacts = meta.referencedArtifacts ?? []
  const hashes = meta.contentHashes ?? []
  for (const a of artifacts) {
    if (SECRET_SHAPE.test(a)) throw new Error('recordPacketMetadata: refusing an artifact reference that looks like a credential')
  }
  const createdAt = Math.floor(now / 1000)
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO dispatch_packets
        (dispatch_id, created_at, packet_version, packet_id, packet_hash, generated_at,
         execution_role, estimated_fresh_tokens, estimate_confidence,
         estimate_method, task_size, task_size_source, context_budget_class)
      VALUES
        (@dispatch_id, @created_at, @packet_version, @packet_id, @packet_hash, @generated_at,
         @execution_role, @estimated_fresh_tokens, @estimate_confidence,
         @estimate_method, @task_size, @task_size_source, @context_budget_class)
      ON CONFLICT(dispatch_id) DO UPDATE SET
        created_at = excluded.created_at,
        packet_version = excluded.packet_version,
        packet_id = excluded.packet_id,
        packet_hash = excluded.packet_hash,
        generated_at = excluded.generated_at,
        execution_role = excluded.execution_role,
        estimated_fresh_tokens = excluded.estimated_fresh_tokens,
        estimate_confidence = excluded.estimate_confidence,
        estimate_method = excluded.estimate_method,
        task_size = excluded.task_size,
        task_size_source = excluded.task_size_source,
        context_budget_class = excluded.context_budget_class
    `).run({
      dispatch_id: dispatchId,
      created_at: createdAt,
      packet_version: meta.packetVersion ?? null,
      packet_id: meta.packetId ?? null,
      // Stored bare-hex lowercase, the same normalisation the artifact hashes
      // get below, so a hash written by two origins compares equal as SQL.
      packet_hash: meta.packetHash ? meta.packetHash.replace(/^sha256:/i, '').toLowerCase() : null,
      generated_at: meta.generatedAt ?? null,
      execution_role: meta.executionRole ?? null,
      estimated_fresh_tokens: meta.estimatedFreshTokens ?? null,
      estimate_confidence: meta.estimateConfidence,
      estimate_method: meta.estimateMethod ?? null,
      task_size: meta.taskSize ?? null,
      task_size_source: meta.taskSizeSource ?? null,
      context_budget_class: meta.contextBudgetClass ?? null,
    })
    db.prepare('DELETE FROM dispatch_packet_artifacts WHERE dispatch_id = ?').run(dispatchId)
    const ins = db.prepare(`
      INSERT INTO dispatch_packet_artifacts (dispatch_id, position, artifact_path, artifact_ref, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `)
    artifacts.forEach((a, i) => {
      // referencedArtifacts entries are 'path@ref'; split on the LAST '@' so a
      // path containing '@' still keeps its ref.
      const at = a.lastIndexOf('@')
      const path = at > 0 ? a.slice(0, at) : a
      const ref = at > 0 ? a.slice(at + 1) : null
      ins.run(dispatchId, i, path, ref, hashes[i] ?? null)
    })
  })
  tx()
}

/**
 * Best-effort variant for the hot dispatch paths, mirroring P2-A's
 * createDispatchSafe: a measurement failure must NEVER break the actual send.
 * Returns true when the metadata landed, false when it was dropped (logged, not
 * raised). The log line carries ids only -- never the packet body.
 */
export function recordPacketMetadataSafe(
  db: Database.Database,
  dispatchId: string | null | undefined,
  meta: PacketMetadataInput,
  now: number = Date.now(),
): boolean {
  if (!dispatchId) return false
  try {
    recordPacketMetadata(db, dispatchId, meta, now)
    return true
  } catch (err) {
    logger.warn({ err, dispatchId }, 'recordPacketMetadata failed; dispatch packet metadata dropped (send unaffected)')
    return false
  }
}

/** Read one dispatch's packet metadata. Missing row => null (never a guess). */
export function readPacketMetadata(db: Database.Database, dispatchId: string): PacketMetadataRow | null {
  const row = db.prepare(`
    SELECT dispatch_id, created_at, packet_version, packet_id, packet_hash, generated_at,
           execution_role, estimated_fresh_tokens, estimate_confidence,
           estimate_method, task_size, task_size_source, context_budget_class
    FROM dispatch_packets WHERE dispatch_id = ?
  `).get(dispatchId) as {
    dispatch_id: string; created_at: number; packet_version: string | null
    packet_id: string | null; packet_hash: string | null; generated_at: string | null
    execution_role: string | null
    estimated_fresh_tokens: number | null; estimate_confidence: string; estimate_method: string | null
    task_size: string | null; task_size_source: string | null; context_budget_class: string | null
  } | undefined
  if (!row) return null
  const arts = db.prepare(
    'SELECT artifact_path, artifact_ref, content_hash FROM dispatch_packet_artifacts WHERE dispatch_id = ? ORDER BY position ASC'
  ).all(dispatchId) as { artifact_path: string; artifact_ref: string | null; content_hash: string | null }[]
  return {
    dispatchId: row.dispatch_id,
    createdAt: row.created_at,
    packetVersion: row.packet_version,
    packetId: row.packet_id,
    packetHash: row.packet_hash,
    generatedAt: row.generated_at,
    executionRole: row.execution_role,
    estimatedFreshTokens: row.estimated_fresh_tokens,
    estimateConfidence: row.estimate_confidence,
    estimateMethod: row.estimate_method,
    taskSize: (row.task_size as TaskSize | null) ?? null,
    taskSizeSource: row.task_size_source,
    contextBudgetClass: (row.context_budget_class as ContextBudgetClass | null) ?? null,
    referencedArtifacts: arts.map(a => a.artifact_ref ? `${a.artifact_path}@${a.artifact_ref}` : a.artifact_path),
    contentHashes: arts.map(a => a.content_hash ?? ''),
  }
}
