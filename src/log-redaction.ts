// W13 / §7.2 — everything that keeps a secret out of a log line.
//
// Split out of logger.ts so the pieces are testable without booting a logger,
// and so nothing in the cos domain has to be imported by a module that every
// file in the repository depends on.
//
// THREE SURFACES, because a probe (2026-08-26) showed that covering one is not
// covering the logger:
//
//   1. the log OBJECT            → formatters.log        (was the only one)
//   2. the MESSAGE STRING        → hooks.logMethod
//   3. CHILD BINDINGS            → a wrapped .child()
//
// Measured, not assumed. With only `formatters.log` installed:
//   logger.child({ token: 'CHILDTOK' }).info({ a: 1 }, 'x')
//     → {"token":"CHILDTOK","a":1,...}      the formatter saw only ["a"]
//   logger.error({ err: new Error('boom SECRET') }, 'x')
//     → the message AND stack went out verbatim
// Both are closed here. The evidence is in w13-log-redaction.test.ts, which
// asserts each surface separately rather than trusting that one implies another.

import { LOG_REDACTED_FIELD_NAMES, REDACTED } from './cos/store-security.js'

/**
 * Secret-shaped values inside FREE TEXT — a URL query parameter, an
 * Authorization header, a basic-auth userinfo.
 *
 * STRUCTURAL patterns only, and the distinction is the whole design. A list of
 * prefixes that "look like" keys (sk-, ghp_, xoxb-) would be a blocklist of the
 * leaks we happen to have seen already, and it would grow one incident at a
 * time while reading as complete. What is matched here is a SHAPE the secret
 * sits in — `?token=<value>`, `Bearer <value>`, `https://user:pass@host` —
 * which does not depend on which provider issued it.
 *
 * The limit is real and stated: a bare secret in prose (`the key is abc123`) is
 * not matched by anything here, because nothing distinguishes it from prose.
 */
const TEXT_SECRET_PATTERNS: Array<{ re: RegExp; as: string }> = [
  // ?token=… &api_key=… #access_token=… (query/fragment parameters)
  {
    re: /([?&#](?:access_token|refresh_token|id_token|api[-_]?key|apikey|token|secret|password|passwd|auth|key)=)([^&\s"'#]+)/gi,
    as: `$1${REDACTED}`,
  },
  // Authorization: Bearer … / Basic … / Token …
  { re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, as: `$1 ${REDACTED}` },
  // https://user:password@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^/\s@]+)@/gi, as: `$1:${REDACTED}@` },
]

/** Scrub secret-shaped values out of a string. Returns the input unchanged when
 *  nothing matches, so an ordinary log line is untouched. */
export function scrubSecretText(text: string): string {
  let out = text
  for (const p of TEXT_SECRET_PATTERNS) out = out.replace(p.re, p.as)
  return out
}

/** An Error rendered as a plain object with its text scrubbed.
 *
 *  The first version of the logger passed Errors through untouched so pino's
 *  serializer could keep the stack. That was half right: the stack IS worth
 *  keeping, and it is also where a credential-bearing URL ends up when an HTTP
 *  client throws. Rendering it here keeps `message`, `stack` and `cause` — and
 *  runs all three through the text scrubber. */
function renderError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: err.name || 'Error',
    message: scrubSecretText(String(err.message ?? '')),
  }
  if (err.stack) out.stack = scrubSecretText(err.stack)
  const cause = (err as { cause?: unknown }).cause
  if (cause !== undefined) {
    out.cause = cause instanceof Error ? renderError(cause) : redactLogValue(cause)
  }
  return out
}

/**
 * The value walker: key-name redaction for secrets and case content, text
 * scrubbing for everything that survives as a string, Errors rendered.
 *
 * A cycle becomes '[CYCLE]'; the input is never mutated.
 */
export function redactLogValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubSecretText(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return renderError(value)
  if (seen.has(value)) return '[CYCLE]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(v => redactLogValue(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (LOG_REDACTED_FIELD_NAMES.has(k.toLowerCase())) out[k] = REDACTED
    else out[k] = redactLogValue(v, seen)
  }
  return out
}

/**
 * FAIL-SAFE wrapper (Istvan, 2026-08-25): "a védelem bukása ne eredményezhesse a
 * raw secret kiírását", and equally, a failing log line must not fail the
 * action that wrote it.
 *
 * On a throw — an exploding getter, a proxy, an exotic object — the WHOLE
 * payload is dropped for a marker. Not just the field that threw: after a
 * failure we do not know how far the walk got, so nothing from it may be
 * trusted onto the line.
 */
export function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return redactLogValue(obj) as Record<string, unknown>
  } catch (err) {
    return {
      logRedactionFailed: true,
      reason: err instanceof Error ? scrubSecretText(err.message) : 'unknown',
    }
  }
}

/** The pino `hooks.logMethod` hook: scrubs the MESSAGE STRING.
 *
 *  `formatters.log` never sees the message — it receives the merging object
 *  only — so without this a secret interpolated into the text goes out whole.
 *  Inherited by child loggers (measured), which is why the message surface
 *  needs no per-child handling and the BINDINGS surface does. */
export function makeLogMethodHook() {
  return function logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void): void {
    let scrubbed: unknown[]
    try {
      scrubbed = args.map(a => (typeof a === 'string' ? scrubSecretText(a) : a))
    } catch {
      // Never fail the caller for a log line.
      scrubbed = args
    }
    method.apply(this, scrubbed)
  }
}


/**
 * Close the CHILD BINDINGS surface, recursively.
 *
 * Measured on 2026-08-26: child bindings bypass `formatters.log` entirely (the
 * formatter is handed only the per-call object), and pino's `formatters.bindings`
 * fires for the root bindings, not for a `.child()` call. So
 * `logger.child({ token })` printed the token on every line the child ever
 * wrote, silently, for the lifetime of that child.
 *
 * Wrapping is recursive because a child of a hardened child must stay hardened:
 * the one place this could rot is the second level, which nobody looks at.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the constraint
// must stay loose enough to keep T as pino's own Logger type; narrowing it to a
// hand-written interface would erase every level method from the return type.
export function hardenChild<T extends { child: (...args: any[]) => any }>(logger: T): T {
  const original = logger.child.bind(logger) as (...args: unknown[]) => T
  ;(logger as { child: unknown }).child = (bindings: Record<string, unknown>, options?: unknown) => {
    const safe = redactLogObject(bindings ?? {})
    return hardenChild(original(safe, options))
  }
  return logger
}
