// §19 / §26(28): capability preflight, and the WAIT_SYSTEM state behind it.
//
// THE SENTENCE THIS FILE EXISTS FOR: **a system fault must not be "Needs
// István".** When a connector is down, a key is missing or a table cannot be
// read, the case is not waiting on a person — it is waiting on the machine, and
// telling the owner otherwise spends the scarcest thing in the system (his
// attention) on something he cannot act on. Do it twice and he stops reading.
//
// WHAT THE AUDIT FOUND, AND WHY IT WAS THE MOST MISLEADING POINT OF ALL 31.
// `CAPABILITY_RECOVERED` has been in the §10.8 trigger vocabulary and in the run
// ledger's CHECK constraint since they were written — so a capability audit that
// greps the vocabulary reads "present" and moves on. Grep `WAIT_SYSTEM` across
// `src/cos` before this file and the answer was zero. There was a doorbell and
// no door: a trigger meaning "the capability came back" for a state that could
// never be entered, because nothing ever recorded that a capability had gone.
//
// DETERMINISTIC, AND SIDE-EFFECT FREE. Every probe below reads local state — a
// connector-health row, a config file's existence, whether a table answers. None
// of them calls out, because a preflight that performs a network round-trip has
// become the thing it was meant to check, and because §19's recovery trigger has
// to be reproducible on a replay corpus where nothing is reachable at all.

import type Database from 'better-sqlite3'
import { getHealth, isUsable } from './connector-health.js'

export type CapabilityState = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE'

/** §19's shape. */
export interface CapabilityPreflight {
  capability: string
  state: CapabilityState
  retryable: boolean
  /** What the caller may do instead. Present only when there genuinely is
   *  something — an empty fallback that reads as a plan is worse than none. */
  fallback?: string
  /** Why, in one line, for the run ledger. */
  detail: string
}

/** A probe answers one question about local state and never reaches outside. */
export type CapabilityProbe = (db: Database.Database, now: number) => CapabilityPreflight

/**
 * How long a case sleeps before the engine looks at a failed capability again.
 *
 * Not a backoff curve, deliberately. A capability is a shared resource: fifty
 * cases waiting on the same dead connector do not each need their own schedule,
 * and staggering them would only spread the same useless retries over a longer
 * window. One interval, and the RECOVERY trigger below is what actually ends the
 * wait — the timer is just the floor under it.
 */
export const CAPABILITY_RETRY_SEC = 900

/** DEGRADED is not UNAVAILABLE: the work can proceed, and the case should not
 *  sleep for it. Kept as a named constant so the distinction is one decision in
 *  one place rather than a `!== 'UNAVAILABLE'` scattered over the callers. */
export function blocksProgression(p: CapabilityPreflight): boolean {
  return p.state === 'UNAVAILABLE'
}

// ── The registry ────────────────────────────────────────────────────────
//
// Capability names are strings rather than a union type on purpose: the set is
// meant to grow from the deployment side (a new connector, a new store), and a
// name this layer does not recognise must be answerable — see `unknownProbe`.

const PROBES: Record<string, CapabilityProbe> = {
  /** Any connector at all, addressed as `CONNECTOR:<id>`; see resolveProbe. */

  /** The document store. A missing table is a deployment state, not a case
   *  problem, and every case that needs a document is blocked by it equally. */
  DOCUMENT_STORE: (db) => tableProbe(db, 'DOCUMENT_STORE', 'cos_documents',
    'a dokumentumtár nem olvasható'),

  /** The progression run ledger. Without it a run cannot be recorded, and a run
   *  nobody can record is a run that did not happen — better to wait than to
   *  progress a case invisibly. */
  RUN_LEDGER: (db) => tableProbe(db, 'RUN_LEDGER', 'case_progression_runs',
    'a futás-főkönyv nem olvasható'),

  /** The evidence packets the Reader writes. Their absence degrades rather than
   *  blocks: the deterministic engine has always been able to run without a
   *  reading, it just runs with less. */
  EVIDENCE_PACKETS: (db) => {
    const t = tableProbe(db, 'EVIDENCE_PACKETS', 'case_evidence_packets', 'nincs olvasási réteg')
    return t.state === 'UNAVAILABLE'
      ? { ...t, state: 'DEGRADED', fallback: 'a determinisztikus motor olvasás nélkül is fut' }
      : t
  },
}

/** A capability this layer does not recognise.
 *
 *  UNAVAILABLE and NOT retryable, on purpose. The tempting alternative —
 *  "unknown, assume fine" — makes a typo in a requirement list silently
 *  equivalent to declaring no requirement at all, which is the failure mode the
 *  whole file exists to prevent. Not retryable because waiting will not teach
 *  the system a name it does not have; this needs a person, and it is a
 *  DEPLOYMENT fault, which is exactly the kind §19 says must not reach the owner
 *  as a case decision. It reaches the run ledger instead. */
function unknownProbe(capability: string): CapabilityPreflight {
  return {
    capability, state: 'UNAVAILABLE', retryable: false,
    detail: `ismeretlen capability: ${capability} — ez telepítési hiba, nem az ügyé`,
  }
}

function tableProbe(db: Database.Database, capability: string, table: string, why: string): CapabilityPreflight {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    return { capability, state: 'AVAILABLE', retryable: true, detail: 'elérhető' }
  } catch {
    return { capability, state: 'UNAVAILABLE', retryable: true, detail: why }
  }
}

/** `CONNECTOR:<id>` and `CONNECTOR_WRITE:<id>`.
 *
 *  Two names for one connector because "can I read Gmail" and "can I send from
 *  Gmail" are different questions with different answers, and collapsing them is
 *  how a READ_ONLY deployment looks capable of sending right up to the moment it
 *  refuses. */
function connectorProbe(db: Database.Database, capability: string, id: string, requireWrite: boolean): CapabilityPreflight {
  let health
  try { health = getHealth(db, id) } catch { health = undefined }
  if (!health) {
    return {
      capability, state: 'UNAVAILABLE', retryable: true,
      detail: `nincs regisztrált konnektor: ${id}`,
    }
  }
  if (health.mode === 'DISABLED') {
    return {
      capability, state: 'UNAVAILABLE', retryable: false,
      detail: `a konnektor le van tiltva: ${id}`,
      fallback: 'a tiltás szándékos — a feloldás tulajdonosi döntés, nem várakozás kérdése',
    }
  }
  if (requireWrite && health.mode === 'READ_ONLY') {
    return {
      capability, state: 'UNAVAILABLE', retryable: false,
      detail: `a konnektor csak olvasásra van engedélyezve: ${id}`,
      fallback: 'az írás engedélyezése tulajdonosi döntés',
    }
  }
  let usable = false
  try { usable = isUsable(db, id, requireWrite) } catch { usable = false }
  if (!usable) {
    return {
      capability, state: 'UNAVAILABLE', retryable: true,
      detail: `a konnektor nem használható: ${id} (${health.status})`,
    }
  }
  if (health.status === 'DEGRADED') {
    return {
      capability, state: 'DEGRADED', retryable: true,
      detail: `a konnektor akadozik: ${id}`,
      fallback: 'a művelet megkísérelhető, de a hiba valószínűbb a szokásosnál',
    }
  }
  return { capability, state: 'AVAILABLE', retryable: true, detail: 'elérhető' }
}

function resolveProbe(db: Database.Database, capability: string, now: number): CapabilityPreflight {
  if (capability.startsWith('CONNECTOR_WRITE:')) {
    return connectorProbe(db, capability, capability.slice('CONNECTOR_WRITE:'.length), true)
  }
  if (capability.startsWith('CONNECTOR:')) {
    return connectorProbe(db, capability, capability.slice('CONNECTOR:'.length), false)
  }
  const probe = PROBES[capability]
  return probe ? probe(db, now) : unknownProbe(capability)
}

/** Check every named capability. Order is preserved so the first blocker in the
 *  caller's own priority order is the one reported. */
export function checkCapabilities(
  db: Database.Database,
  capabilities: readonly string[],
  now: number,
): CapabilityPreflight[] {
  return capabilities.map(c => resolveProbe(db, c, now))
}

export interface PreflightVerdict {
  /** True when nothing UNAVAILABLE stands in the way. DEGRADED passes. */
  ok: boolean
  /** The first capability that blocks, if any. */
  blocker?: CapabilityPreflight
  results: CapabilityPreflight[]
}

/**
 * The one call a progression path makes.
 *
 * An empty requirement list returns `ok` without touching the database. That is
 * the property that makes this safe to wire into the live engine today: a caller
 * that declares nothing behaves exactly as it did before this file existed, so
 * the preflight is adopted per path, deliberately, rather than switched on for
 * everything at once and discovered in production.
 */
export function preflight(
  db: Database.Database,
  capabilities: readonly string[] | undefined,
  now: number,
): PreflightVerdict {
  if (!capabilities?.length) return { ok: true, results: [] }
  const results = checkCapabilities(db, capabilities, now)
  const blocker = results.find(blocksProgression)
  return { ok: !blocker, blocker, results }
}

// ── The WAIT_SYSTEM state ───────────────────────────────────────────────

export interface WaitSystemState {
  capability: string
  since: number
  retryAt: number
  retryable: boolean
  detail: string
}

/**
 * Park a case on a capability.
 *
 * Writes to `case_progression_state` and nothing else. In particular it does NOT
 * touch the case's own status: a case blocked on a dead connector is not a
 * BLOCKED case in the owner-facing sense, and moving it there would put a
 * machine fault on the board he reads. The engine knows; the board does not need
 * to.
 */
export function enterWaitSystem(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  blocker: CapabilityPreflight,
  now: number,
): WaitSystemState {
  const retryAt = now + CAPABILITY_RETRY_SEC
  const state: WaitSystemState = {
    capability: blocker.capability,
    since: now,
    retryAt,
    retryable: blocker.retryable,
    detail: blocker.detail,
  }
  db.prepare(
    `UPDATE case_progression_state
        SET wait_system_json = @json,
            next_progression_at = CASE
              WHEN @retryable = 1 THEN @retryAt
              ELSE next_progression_at
            END,
            updated_at = @now
      WHERE domain = @domain AND case_id = @caseId`,
  ).run({
    json: JSON.stringify(state),
    // A non-retryable blocker does not get a retry time. Scheduling a re-check
    // for a disabled connector would burn a slot every fifteen minutes on a
    // state only a person can change, and the sweep's bound is a real budget.
    retryable: state.retryable ? 1 : 0,
    retryAt, now, domain, caseId,
  })
  return state
}

export function readWaitSystem(
  db: Database.Database, domain: string, caseId: string,
): WaitSystemState | null {
  try {
    const r = db.prepare(
      `SELECT wait_system_json AS j FROM case_progression_state WHERE domain = ? AND case_id = ?`,
    ).get(domain, caseId) as { j: string | null } | undefined
    if (!r?.j) return null
    return JSON.parse(r.j) as WaitSystemState
  } catch { return null }
}

/** Clear the wait. Returns true when there was one to clear, which is what makes
 *  "the capability came back" distinguishable from "it was never gone". */
export function clearWaitSystem(
  db: Database.Database, domain: string, caseId: string, now: number,
): boolean {
  const had = readWaitSystem(db, domain, caseId) != null
  if (!had) return false
  db.prepare(
    `UPDATE case_progression_state SET wait_system_json = NULL, updated_at = ?
      WHERE domain = ? AND case_id = ?`,
  ).run(now, domain, caseId)
  return true
}

/**
 * §19: "the retry/recovery trigger must be deterministic."
 *
 * This is the door the `CAPABILITY_RECOVERED` doorbell was ringing for. A case
 * parked on a capability wakes when — and only when — that same capability
 * probes AVAILABLE or DEGRADED again. Not on a timer, not on the clock coming
 * round: the retry time is a floor, this is the reason.
 */
export function capabilityRecovered(
  db: Database.Database, domain: string, caseId: string, now: number,
): { recovered: boolean; capability?: string } {
  const wait = readWaitSystem(db, domain, caseId)
  if (!wait) return { recovered: false }
  const p = resolveProbe(db, wait.capability, now)
  if (blocksProgression(p)) return { recovered: false, capability: wait.capability }
  return { recovered: true, capability: wait.capability }
}
