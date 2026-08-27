/**
 * ACP v1.4.5 CPP telemetry adapter -- the cycle's READER.
 *
 * Extracted from scripts/cos-cycle.ts on 2026-08-27. It lived inside a
 * top-level-await entry point that spawns thirteen child processes on import,
 * so no test could reach it: importing the module ran a live cycle. The
 * existing cycle-report test says as much in its own header and re-implements
 * the merge logic locally to get around it -- a second definition of the thing
 * under test, which is the definition that drifts.
 *
 * That mattered concretely. `recoveryQueue` reported runStatus UNKNOWN on every
 * pinned cycle from the 2026-08-24 cutover onward, and the defect was HERE, in
 * the reader, not in the step. An unreachable reader is how a reader stays
 * wrong. This file exists so the next one is caught by a test instead of by
 * reading two consecutive heartbeat reports at three in the morning.
 *
 * Pure functions only: no DB, no spawn, no I/O.
 */
import { standardFeatureResult, type FeatureRunResult } from './consumer-manifest.js'

/**
 * Legacy steps do not all expose the same counters yet. The adapter is
 * deliberately conservative: it only uses explicitly named numeric counters.
 * If a successful step exposes no trustworthy counters, the result is UNKNOWN —
 * never a fabricated NO_DATA/zero. That distinction is the release invariant.
 */
function numeric(o: Record<string, unknown> | null, keys: string[]): number | null {
  if (!o) return null
  for (const key of keys) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return null
}

function arrayCount(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  const v = o[key]
  return Array.isArray(v) ? v.length : null
}

/** Sum a counter that lives one level down under `personal` and `zst`.
 *
 *  Added 2026-08-24 during the pinned-cutover: five of ten steps reported
 *  outcome=UNKNOWN ("successful exit but payload exposes no CPP counters"), and
 *  every one of them was in fact exposing usable numbers -- just nested, or under
 *  a name this normaliser did not know. UNKNOWN was therefore telling the truth
 *  about the READER, not about the step. That is worth being precise about: an
 *  UNKNOWN that means "I did not look properly" is a different defect from one
 *  that means "this step cannot say what it did", and only the second is the
 *  thing the semantics were built to surface. */
function nestedSum(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  let total: number | null = null
  for (const side of ['personal', 'zst']) {
    const branch = o[side]
    if (branch && typeof branch === 'object') {
      const v = (branch as Record<string, unknown>)[key]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total = (total ?? 0) + v
    }
  }
  return total
}

/** Length of an array nested under `personal` and `zst`, summed. */
function nestedArrayCount(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  let total: number | null = null
  for (const side of ['personal', 'zst']) {
    const branch = o[side]
    if (branch && typeof branch === 'object') {
      const v = (branch as Record<string, unknown>)[key]
      if (Array.isArray(v)) total = (total ?? 0) + v.length
    }
  }
  return total
}

/** Add two counters when at least one of them is present. Returns null only when
 *  BOTH are absent, so a step that reports `drafted: []` and `skipped: 17` is
 *  measured rather than declared unknowable. */
function sumOf(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

function progressionCount(o: Record<string, unknown> | null): number | null {
  if (!o) return null
  const p = typeof o.personal === 'number' ? o.personal : null
  const z = typeof o.zst === 'number' ? o.zst : null
  return p !== null && z !== null ? p + z : null
}

export function cppResult(
  step: string,
  payload: Record<string, unknown> | null,
  hardFailure: string | null,
): FeatureRunResult {
  const nestedHeartbeat = payload?.heartbeat && typeof payload.heartbeat === 'object'
    ? payload.heartbeat as Record<string, unknown> : null
  const source = nestedHeartbeat ?? payload

  const failures = arrayCount(source, 'failures') ?? arrayCount(payload, 'failures') ?? 0
  if (hardFailure || failures > 0 || source?.failed === true || payload?.failed === true) {
    return standardFeatureResult({
      examined: numeric(source, ['examined', 'checked', 'scanned', 'processed']) ?? progressionCount(source) ?? 0,
      matched: numeric(source, ['matched', 'pending', 'due', 'candidates']) ?? 0,
      acted: numeric(source, ['acted', 'sent', 'drafted', 'closed', 'cleared', 'asked']) ?? progressionCount(source) ?? 0,
      failed: Math.max(1, failures),
      outcome: 'FAILED',
      reason: hardFailure ?? `${step} reported ${Math.max(1, failures)} failure(s)`,
    })
  }

  // `count` and `woken`/`drafted` are added to the name lists rather than special-
  // cased per step: a per-step table would have to be edited every time a step is
  // added, and the step that nobody remembered to add would report UNKNOWN while
  // looking exactly like a step that genuinely cannot say what it did.
  const examined = numeric(source, ['examined', 'checked', 'scanned', 'processed', 'read', 'count'])
    ?? progressionCount(source)
    ?? nestedSum(source, 'examined')
    ?? sumOf(arrayCount(source, 'drafted'), numeric(source, ['skipped']))
  const matched = numeric(source, ['matched', 'pending', 'due', 'candidates'])
    ?? arrayCount(source, 'woken')
    ?? nestedArrayCount(source, 'proseOnly')
  const acted = numeric(source, ['acted', 'sent', 'drafted', 'closed', 'cleared', 'asked', 'closures'])
    ?? progressionCount(source)
    ?? arrayCount(source, 'drafted')
    ?? arrayCount(source, 'woken')
    ?? (typeof source?.posted === 'boolean' ? (source.posted ? 1 : 0) : null)

  // No counters means absence of evidence, not evidence of zero work.
  if (examined === null && matched === null && acted === null) {
    return {
      examined: 0, matched: 0, acted: 0, failed: 0, outcome: 'UNKNOWN',
      reason: `${step}: successful exit but payload exposes no CPP counters`,
    }
  }

  const e = examined ?? Math.max(matched ?? 0, acted ?? 0)
  const m = matched ?? Math.min(e, acted ?? 0)
  const a = acted ?? 0
  return standardFeatureResult({
    examined: e, matched: m, acted: a, failed: 0,
    reason: `${step}: normalized from explicit step counters`,
  })
}
