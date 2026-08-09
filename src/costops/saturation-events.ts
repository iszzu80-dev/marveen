// Lean Optimization Phase 2 / P2-C -- observed context-saturation events.
//
// WHY THIS TABLE EXISTS. `context_saturation_events` is one of the Phase 2 KPIs,
// and before P2-C it had NO data source at all:
//
//  * `routing_events.capacity_state` looks like the obvious source, but
//    createDispatch() writes the literal 'normal' into it on every row regardless
//    of the real live saturation. Counting it would produce a confident, measured-
//    looking 0 that is not a measurement of anything -- the exact false-green this
//    program keeps paying for. It is deliberately NOT used here.
//  * The P2-B admission gate DOES compute a real, measured saturation state at
//    every kanban dispatch, but a REFUSAL creates no dispatch row, so the one
//    event that matters most left no trace in the measurement stack -- only a
//    kanban comment and a log line.
//
// So this table records the gate's own observation, for BOTH outcomes, and only
// when the saturation signal was genuinely measured (`measured === true`). A
// fail-open default ('ok' because tmux/transcript was unreadable) is NOT an
// observation and is never stored -- otherwise a broken measurement path would
// manufacture a stream of reassuring 'ok' events.
//
// DATA SENSITIVITY: agent id, a state enum, a percentage, a task size, an
// admitted flag, and an optional opaque dispatch_id. No prompt text, no card
// title, no PII, no credential.

import type Database from 'better-sqlite3'
import { logger } from '../logger.js'

/** Create the saturation-event table. Idempotent boot DDL, on the CostOps seam. */
export function initSaturationEventsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_saturation_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at   INTEGER NOT NULL,
      agent        TEXT NOT NULL,
      -- NULL is meaningful: a refusal has no dispatch to point at.
      dispatch_id  TEXT,
      card_id      TEXT,
      state        TEXT NOT NULL,
      pct          REAL,
      task_size    TEXT,
      admitted     INTEGER NOT NULL,
      refusal_code TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_saturation_events_agent ON dispatch_saturation_events(agent, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_saturation_events_state ON dispatch_saturation_events(state, created_at)`)
}

/**
 * The saturation states that COUNT as a saturation event. 'ok' is recorded too
 * (so the denominator "how many measured admissions did we see" is real), but it
 * is not itself an event -- see countSaturationEvents.
 */
export const SATURATION_EVENT_STATES: readonly string[] = [
  'warning', 'no_new_large_task', 'checkpoint_required', 'hard_stop',
]

export interface SaturationEventInput {
  agent: string
  dispatchId?: string | null
  cardId?: string | null
  state: string
  pct: number | null
  taskSize?: string | null
  admitted: boolean
  refusalCode?: string | null
  /** True only when the saturation signal was really observed. */
  measured: boolean
}

/**
 * Record one observed saturation event. Returns true when a row landed.
 *
 * Returns false WITHOUT writing when `measured` is false: a fail-open default is
 * not an observation, and storing it would let a broken measurement path
 * manufacture reassuring data.
 */
export function recordSaturationEvent(
  db: Database.Database,
  input: SaturationEventInput,
  now: number = Date.now(),
): boolean {
  if (!input.measured) return false
  if (!input.agent) throw new Error('recordSaturationEvent: agent is required')
  if (!input.state) throw new Error('recordSaturationEvent: state is required')
  db.prepare(`
    INSERT INTO dispatch_saturation_events
      (created_at, agent, dispatch_id, card_id, state, pct, task_size, admitted, refusal_code)
    VALUES (@created_at, @agent, @dispatch_id, @card_id, @state, @pct, @task_size, @admitted, @refusal_code)
  `).run({
    created_at: Math.floor(now / 1000),
    agent: input.agent,
    dispatch_id: input.dispatchId ?? null,
    card_id: input.cardId ?? null,
    state: input.state,
    pct: input.pct ?? null,
    task_size: input.taskSize ?? null,
    admitted: input.admitted ? 1 : 0,
    refusal_code: input.refusalCode ?? null,
  })
  return true
}

/**
 * Fault-isolated variant for the hot dispatch path, mirroring P2-A's
 * createDispatchSafe and P2-B's recordPacketMetadataSafe: a measurement failure
 * must NEVER be the reason a real dispatch does not happen.
 */
export function recordSaturationEventSafe(
  db: Database.Database,
  input: SaturationEventInput,
  now: number = Date.now(),
): boolean {
  try {
    return recordSaturationEvent(db, input, now)
  } catch (err) {
    logger.warn({ err, agent: input.agent }, 'recordSaturationEvent failed; saturation event dropped (dispatch unaffected)')
    return false
  }
}

export interface SaturationEventCounts {
  /** Measured observations in the window (all states, including 'ok'). */
  observations: number
  /** Observations whose state is in SATURATION_EVENT_STATES. */
  events: number
  /** Of those, the ones that actually stopped work. */
  refusals: number
}

/**
 * Count observations/events/refusals for an agent (or fleet-wide) in a window.
 * Returns zeros with observations === 0 when nothing was observed -- callers MUST
 * treat observations === 0 as "unknown", never as "no saturation happened".
 */
export function countSaturationEvents(
  db: Database.Database,
  opts: { agent?: string | null; from?: number | null; to?: number | null } = {},
): SaturationEventCounts {
  const conds: string[] = []
  const params: unknown[] = []
  if (opts.agent) { conds.push('agent = ?'); params.push(opts.agent) }
  if (opts.from != null) { conds.push('created_at >= ?'); params.push(opts.from) }
  // Upper bound INCLUSIVE: `to` is normally "now", and an event recorded in this
  // same second is exactly the one an operator is asking about. A half-open window
  // here would silently drop it.
  if (opts.to != null) { conds.push('created_at <= ?'); params.push(opts.to) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const placeholders = SATURATION_EVENT_STATES.map(() => '?').join(',')
  const row = db.prepare(`
    SELECT COUNT(*) AS observations,
           SUM(CASE WHEN state IN (${placeholders}) THEN 1 ELSE 0 END) AS events,
           SUM(CASE WHEN admitted = 0 THEN 1 ELSE 0 END) AS refusals
    FROM dispatch_saturation_events ${where}
  `).get(...SATURATION_EVENT_STATES, ...params) as { observations: number; events: number | null; refusals: number | null }
  return {
    observations: row?.observations ?? 0,
    events: row?.events ?? 0,
    refusals: row?.refusals ?? 0,
  }
}
