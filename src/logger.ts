import pino from 'pino'
import { redactSensitive, LOG_REDACTED_FIELD_NAMES } from './cos/store-security.js'

/**
 * W13 / §7.2 — "secret nem logban", enforced at the CHOKE POINT.
 *
 * `redactSensitive` was written for exactly this, tested, and — measured on
 * 2026-08-26 during the W13 audit — called from NOWHERE in production, while
 * this file was a bare `pino({ level })` with no `redact` option at all. Its own
 * header claimed it "strips those fields before anything is logged". That was
 * true of the function and false of the system: the same shape as W12's
 * RECOVERY_REQUIRED rows, a guard whose reader does not exist.
 *
 * WHY `formatters.log` AND NOT pino's `redact` OPTION. `redact` takes explicit
 * paths and supports only one level of wildcard (`*.token`), so it would cover
 * the shapes somebody remembered to list and quietly miss `{ a: { b: { token } } }`.
 * `formatters.log` runs on EVERY log object from EVERY call site, so a log line
 * written next month is covered without anyone remembering this file exists.
 * That is the difference between a guard and a convention.
 *
 * WHAT THIS DOES NOT COVER, stated rather than left to be discovered: the
 * message STRING. `logger.info(\`token=\${t}\`)` still prints the token, because
 * key-name redaction cannot see inside free text, and a value-shaped detector
 * (a list of prefixes that look secret) would be a blocklist of the leaks we
 * happen to have seen. Secrets belong in the object, where the choke point can
 * reach them.
 */
/** The redaction formatter, EXPORTED so its test can assert two different
 *  things with one definition: that it redacts, and that THIS logger is the one
 *  carrying it. A test that rebuilds an identical formatter of its own proves
 *  only that a copy works — the shape this whole packet exists to stop. */
export function logRedactionFormatter(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return redactSensitive(obj, LOG_REDACTED_FIELD_NAMES, {
      // Errors pass through whole: their message and stack are non-enumerable,
      // so walking one would empty it.
      preserve: (v) => v instanceof Error,
    }) as Record<string, unknown>
  } catch (err) {
    // FAIL-SAFE, not fail-open (Istvan, 2026-08-25): "a védelem bukása ne
    // eredményezhesse a raw secret kiírását". If the redactor throws — an exotic
    // getter, a proxy, a value that explodes on enumeration — returning the
    // original object would print exactly what the redactor exists to hide.
    //
    // And not fail-closed either, in the sense of stopping the caller: a log
    // line is never worth failing an action for. The line survives, minus its
    // payload, and says why it is empty so nobody hunts a phantom bug.
    return {
      logRedactionFailed: true,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: { log: logRedactionFormatter },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
