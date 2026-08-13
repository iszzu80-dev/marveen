// Personal Chief of Staff (COS) — store-level data-security helpers (spec §C DoD).
//
// Two of the §C requirements are enforceable in code here:
//   - the SQLite file + store directory must be readable only by the service
//     user (mode 0600 / 0700) — assertStorePermissions checks and (optionally)
//     tightens them;
//   - a sensitive attachment / body must never reach a debug log or an
//     unsanitised skill-trajectory — redactSensitive strips those fields before
//     anything is logged.
//
// Pure filesystem + object helpers, no DB, so they are unit-testable and can be
// called from the dashboard boot (perms) and every logger call site (redaction).

import { statSync, chmodSync } from 'node:fs'

export interface PermCheck {
  path: string
  kind: 'file' | 'dir'
  mode: number          // the permission bits actually found (e.g. 0o644)
  expected: number      // the tightest allowed (file 0o600, dir 0o700)
  tooOpen: boolean
  fixed: boolean
  /** E17: the path was not there, so NOTHING was checked about it. Reported
   *  rather than skipped — see anyMissing. */
  missing?: boolean
}

/**
 * Check (and optionally tighten) permissions on the store's sensitive paths. A
 * file must be ≤ 0600 and a directory ≤ 0700 — any group/other bit is "too open".
 * With enforce:true, an over-open path is chmod'ed down. On non-POSIX platforms
 * (Windows) permission bits are not meaningful, so it reports tooOpen:false.
 */
export function assertStorePermissions(
  entries: Array<{ path: string; kind: 'file' | 'dir' }>,
  opts: { enforce?: boolean } = {},
): PermCheck[] {
  const posix = process.platform !== 'win32'
  const out: PermCheck[] = []
  for (const e of entries) {
    const expected = e.kind === 'dir' ? 0o700 : 0o600
    let mode = 0
    try {
      mode = statSync(e.path).mode & 0o777
    } catch {
      // E17 (review 2026-08-13). A missing path used to `continue` — it produced
      // NO entry at all, so a typo in a caller's path list silently removed that
      // path from the check and anyTooOpen() stayed false. The control then
      // reported success for a file it had never looked at, which is the worst
      // possible answer from a security check: indistinguishable from "clean".
      // A missing path is not too open (there is nothing to open), so it does
      // not fail anyTooOpen — it gets its own entry and its own predicate.
      out.push({ path: e.path, kind: e.kind, mode: 0, expected, tooOpen: false, fixed: false, missing: true })
      continue
    }
    const tooOpen = posix && (mode & ~expected) !== 0
    let fixed = false
    if (tooOpen && opts.enforce) {
      chmodSync(e.path, expected)
      mode = expected
      fixed = true
    }
    out.push({ path: e.path, kind: e.kind, mode, expected, tooOpen: tooOpen && !fixed, fixed })
  }
  return out
}

/** True if any path is still over-open (after any enforcement). */
export function anyTooOpen(checks: PermCheck[]): boolean {
  return checks.some(c => c.tooOpen)
}

/** E17: paths the check could not see at all. Separate from anyTooOpen because
 *  they are a different problem with a different fix — a path that is not there
 *  is either a typo in the caller's list or a store that is not where it is
 *  believed to be, and neither is corrected by a chmod. A caller that treats an
 *  empty result as "all clear" is trusting a check that never ran. */
export function missingPaths(checks: PermCheck[]): string[] {
  return checks.filter(c => c.missing).map(c => c.path)
}

/** Field names whose VALUES are sensitive content and must never be logged raw.
 *  Extend as new payload shapes appear. Matching is case-insensitive on the key. */
export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'body', 'content', 'snippet', 'attachment', 'attachments', 'attachment_text',
  'rendered_payload', 'payload', 'raw', 'html', 'text',
].map(s => s.toLowerCase()))

export const REDACTED = '[REDACTED]'

/**
 * Deep-copy `value`, replacing any property whose key names sensitive content
 * with a redaction marker (the KEY is kept so the shape is still legible, the
 * VALUE is gone). Use before logging or embedding anything derived from an email
 * / attachment into a debug log or skill-trajectory. Cycles are handled; the
 * input is never mutated.
 */
export function redactSensitive(value: unknown, sensitiveKeys: ReadonlySet<string> = SENSITIVE_FIELD_NAMES): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return '[CYCLE]'
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (sensitiveKeys.has(k.toLowerCase())) out[k] = REDACTED
      else out[k] = walk(val)
    }
    return out
  }
  return walk(value)
}
