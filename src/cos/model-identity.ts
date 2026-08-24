// Canonical runtime model identity for triage provenance (Istvan, 2026-08-23,
// activation blocker #1).
//
// WHAT WENT WRONG. The preflight reported `claude-opus-5[1m]` as the deciding
// model. That value was never validated against anything: the preflight's
// resolver was a scratchpad shell script that ran `ps -o args=`, matched
// `--model` with a regex, and printed whatever followed. Three separate defects
// hid inside one plausible-looking string:
//
//   1. `ps -o args=` is a RENDERING of argv, not argv. It joins arguments with
//      spaces, so a value containing a space is indistinguishable from two
//      arguments, and anything the terminal or ps chose to emit rides along.
//      `/proc/<pid>/cmdline` is the raw source: NUL-separated, byte-exact.
//   2. Nothing rejected control characters. An ANSI SGR sequence (ESC `[1m` is
//      literally "bold") reaching a provenance field would be recorded as if it
//      were an identity.
//   3. Nothing validated the SHAPE. Any string at all was accepted as a model id.
//
// THE RULE THIS MODULE ENFORCES. A model identity is only usable as provenance
// if it can be READ from raw argv of the nearest claude ancestor, and it is
// already canonical as read. There is no cleaning step, on purpose: a resolver
// that silently strips a character it did not expect reports a model that no
// process was ever launched with, and the receipt then attests to something that
// did not happen. Unproven is a state we can act on; quietly-corrected is not.
//
// NEAREST ancestor, not "any ancestor with --model". Matching anywhere up the
// tree lets a decoy win: a shell whose command line merely CONTAINS `--model x`,
// or an OUTER claude session running a different model, would both be accepted
// as the identity of THIS process. So exactly one process is authoritative --
// the first claude walking up -- and if that one carries no `--model`, the answer
// is UNRESOLVED. We never keep walking to find a value we like better.
import { readFileSync, readlinkSync } from 'node:fs'

/** Longest model id we will consider. Matches `MODEL_ID_RE` in src/model-id.ts. */
export const MODEL_ID_MAX_LENGTH = 128

/**
 * The canonical shape of a model identifier for PROVENANCE purposes.
 *
 * Dot/underscore/hyphen-separated alphanumeric segments, optionally namespaced
 * with `/`. Covers `claude-opus-5`, `claude-haiku-4-5-20251001`,
 * `deepseek-v4-pro`, `us.anthropic.claude-opus-5`, `anthropic/claude-opus-5`.
 *
 * DELIBERATELY NARROWER than `MODEL_ID_RE` in src/model-id.ts, and the difference
 * is the point of this module. That regex is a shell-injection allowlist for a
 * value on its way to a command line, and it ADMITS `[` and `]` so the fleet's
 * own `[1m]` context-window suffix can be launched. This regex answers a
 * different question -- "is this a canonical model identity we may attest to?" --
 * and a bracketed suffix does not survive it. The two must not be merged: one
 * protects a sink, the other protects a claim.
 *
 * No leading/trailing separator, no empty segment, no space, no bracket, no
 * control character.
 */
export const CANONICAL_MODEL_ID_RE =
  /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*(?:\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)*$/

/** Recorded in a receipt's `model` field when no model could be PROVEN. */
export const MODEL_IDENTITY_UNRESOLVED = 'MODEL_IDENTITY_UNRESOLVED'

export type ModelIdentityFailure =
  /** No claude ancestor, or the nearest one carries no `--model`. */
  | 'MODEL_IDENTITY_UNRESOLVED'
  /** A value was read, but it contains control/ANSI bytes. Never sanitized. */
  | 'MODEL_IDENTITY_CONTROL_CHARACTERS'
  /** A value was read and is clean, but is not a canonical model id. */
  | 'MODEL_IDENTITY_NOT_CANONICAL'

/** Where a value came from, so a report can show provenance rather than assert it. */
export interface ModelIdentitySource {
  /** The pid whose argv was read. */
  pid: number
  /** The file the bytes came from. Always a raw argv source, never a rendering. */
  path: string
  /** argv[0] exactly as read. */
  argv0: string
  /** `/proc/<pid>/exe` target, or null if unreadable. Evidence, not a gate. */
  exe: string | null
  /** Index in argv of the `--model` token that supplied the value. */
  argvIndex: number
  /** How the value was carried: a separate argv element, or `--model=value`. */
  form: 'separate' | 'inline'
}

export interface ModelIdentityResolution {
  ok: boolean
  /** The canonical id. Non-null ONLY when ok. Byte-identical to `raw`. */
  model: string | null
  /** Exactly what was read, uncleaned, for diagnosis. Null when nothing was read. */
  raw: string | null
  reason: ModelIdentityFailure | null
  /** Human-readable why, safe to put in a report. */
  detail: string | null
  source: ModelIdentitySource | null
  /** pids walked, nearest first. Lets a report show the decoys that were skipped. */
  walked: Array<{ pid: number; comm: string; argv0: string; isClaude: boolean }>
}

/** One process, as raw as the OS will give it. */
export interface ProcSnapshot {
  pid: number
  ppid: number | null
  /** `/proc/<pid>/comm`, trailing newline removed by the kernel's own format. */
  comm: string
  /** `/proc/<pid>/cmdline` split on NUL. Never trimmed, never re-joined. */
  argv: string[]
  /** `/proc/<pid>/exe` target, or null. */
  exe: string | null
}

export type ProcReader = (pid: number) => ProcSnapshot | null

/** True for a byte we refuse to see inside an identity: C0, DEL, C1. ESC (0x1b)
 *  is in C0, so every ANSI escape sequence is caught by the first range. */
function hasControlCharacters(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true
  }
  return false
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * Is this process the claude CLI?
 *
 * Both `comm` and `basename(argv[0])` must say `claude`. `/proc/<pid>/exe` is
 * NOT used as the gate: on this install it resolves to a version-numbered file
 * (`.../claude/versions/2.1.241`), so a basename check there would reject the
 * real process. It is captured as evidence instead.
 *
 * Residual, stated rather than hidden: anyone who can execute a program named
 * `claude` inside your own process tree can satisfy this. That attacker already
 * runs code as you, which is strictly worse than a mislabelled model id.
 */
function isClaudeProcess(p: ProcSnapshot): boolean {
  return p.comm === 'claude' && p.argv.length > 0 && basename(p.argv[0]) === 'claude'
}

/** Read `--model` out of ONE process's raw argv. Returns null if absent.
 *  Never trims, never unquotes, never lowercases. */
function readModelArg(
  argv: string[],
): { raw: string; argvIndex: number; form: 'separate' | 'inline' } | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model') {
      // A trailing `--model` with nothing after it is an absent value, not "".
      if (i + 1 >= argv.length) return null
      return { raw: argv[i + 1], argvIndex: i, form: 'separate' }
    }
    if (a.startsWith('--model=')) {
      return { raw: a.slice('--model='.length), argvIndex: i, form: 'inline' }
    }
  }
  return null
}

/** Validate an already-read value. Exported so a test can drive the decision
 *  table without constructing a process tree. */
export function validateCanonicalModelId(
  raw: string,
): { ok: true } | { ok: false; reason: ModelIdentityFailure; detail: string } {
  if (hasControlCharacters(raw)) {
    return {
      ok: false,
      reason: 'MODEL_IDENTITY_CONTROL_CHARACTERS',
      detail:
        'the value carries control/ANSI bytes; it is rejected as read and NOT stripped, '
        + 'because a stripped value attests to a model no process was launched with',
    }
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'MODEL_IDENTITY_NOT_CANONICAL', detail: 'empty value' }
  }
  if (raw.length > MODEL_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'MODEL_IDENTITY_NOT_CANONICAL',
      detail: `length ${raw.length} exceeds ${MODEL_ID_MAX_LENGTH}`,
    }
  }
  if (!CANONICAL_MODEL_ID_RE.test(raw)) {
    return {
      ok: false,
      reason: 'MODEL_IDENTITY_NOT_CANONICAL',
      detail:
        'does not match the canonical model-id grammar (alphanumeric segments joined by '
        + '. _ - and optionally namespaced with /); no character is removed to make it fit',
    }
  }
  return { ok: true }
}

/**
 * Resolve the model identity of the claude process running us.
 *
 * Walks ancestors from `startPid`, stops at the FIRST claude, and answers only
 * from that one. Every outcome is explicit; there is no fallback value.
 */
export function resolveRuntimeModelIdentity(
  startPid: number,
  read: ProcReader,
  maxDepth = 64,
): ModelIdentityResolution {
  const walked: ModelIdentityResolution['walked'] = []
  let pid: number | null = startPid
  const seen = new Set<number>()

  for (let depth = 0; depth < maxDepth && pid !== null && pid > 0; depth++) {
    if (seen.has(pid)) break // a cycle cannot happen on a sane kernel; refuse to loop anyway
    seen.add(pid)
    const p: ProcSnapshot | null = read(pid)
    if (!p) break
    const claude = isClaudeProcess(p)
    walked.push({ pid: p.pid, comm: p.comm, argv0: p.argv[0] ?? '', isClaude: claude })

    if (!claude) {
      // A non-claude ancestor's `--model` is never consulted, even if present.
      // That is the whole defence against a decoy: the value is not weighed and
      // rejected, it is not read at all.
      pid = p.ppid
      continue
    }

    const found = readModelArg(p.argv)
    if (!found) {
      // The nearest claude is authoritative even when it is silent. Walking past
      // it would let an OUTER session's model be reported as this one's.
      return {
        ok: false, model: null, raw: null,
        reason: 'MODEL_IDENTITY_UNRESOLVED',
        detail:
          `the nearest claude ancestor (pid ${p.pid}) was launched without --model; `
          + 'the model it defaulted to is not observable from argv, so it is not provable',
        source: null, walked,
      }
    }

    const source: ModelIdentitySource = {
      pid: p.pid,
      path: `/proc/${p.pid}/cmdline`,
      argv0: p.argv[0] ?? '',
      exe: p.exe,
      argvIndex: found.argvIndex,
      form: found.form,
    }
    const verdict = validateCanonicalModelId(found.raw)
    if (!verdict.ok) {
      return {
        ok: false, model: null, raw: found.raw,
        reason: verdict.reason, detail: verdict.detail, source, walked,
      }
    }
    return { ok: true, model: found.raw, raw: found.raw, reason: null, detail: null, source, walked }
  }

  return {
    ok: false, model: null, raw: null,
    reason: 'MODEL_IDENTITY_UNRESOLVED',
    detail: 'no claude process found among the ancestors of pid ' + startPid,
    source: null, walked,
  }
}

/** Reads the real `/proc`. NUL-split, never `ps`. */
export function procfsReader(): ProcReader {
  return (pid: number): ProcSnapshot | null => {
    let comm: string
    let rawCmdline: string
    let stat: string
    try {
      comm = readFileSync(`/proc/${pid}/comm`, 'utf8').replace(/\n$/, '')
      rawCmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return null
    }
    // cmdline is NUL-SEPARATED and NUL-TERMINATED: the trailing empty element is
    // the terminator, not an empty argument. Only that one is dropped.
    const parts = rawCmdline.split('\0')
    if (parts.length && parts[parts.length - 1] === '') parts.pop()

    // stat field 2 is `(comm)` and may itself contain spaces and parentheses, so
    // fields are counted from after the LAST ')'. ppid is field 4 == index 1 there.
    let ppid: number | null = null
    const close = stat.lastIndexOf(')')
    if (close !== -1) {
      const after = stat.slice(close + 1).trim().split(/\s+/)
      const n = Number(after[1])
      ppid = Number.isInteger(n) && n > 0 ? n : null
    }

    let exe: string | null = null
    try {
      exe = readlinkSync(`/proc/${pid}/exe`)
    } catch {
      exe = null
    }
    return { pid, ppid, comm, argv: parts, exe }
  }
}

/** Convenience for callers that just need the value or the sentinel. The full
 *  resolution is what a REPORT should carry -- this loses the provenance source,
 *  so never use it to build one. */
export function runtimeModelIdOrUnresolved(res: ModelIdentityResolution): string {
  return res.ok && res.model ? res.model : MODEL_IDENTITY_UNRESOLVED
}
