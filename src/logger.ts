import pino from 'pino'
import { redactLogObject, makeLogMethodHook, hardenChild } from './log-redaction.js'

/**
 * W13 / §7.2 — "secret nem logban", enforced at the CHOKE POINT, on every
 * surface a log line has.
 *
 * `redactSensitive` was written for exactly this, tested, and — measured on
 * 2026-08-26 during the W13 audit — called from NOWHERE in production, while
 * this file was a bare `pino({ level })` with no `redact` option at all. Its own
 * header claimed it "strips those fields before anything is logged". That was
 * true of the function and false of the system: the same shape as W12's
 * RECOVERY_REQUIRED rows, a guard whose reader does not exist.
 *
 * THREE SURFACES, not one. The first version of this fix installed
 * `formatters.log` and stopped there. Istvan's acceptance point ("a végső
 * log-safety proof ne csak a formatters.log objektumútját bizonyítsa") turned
 * out to name two real holes, both measured before being fixed:
 *
 *   - the log OBJECT      → `formatters.log`   (covers arbitrary depth)
 *   - the MESSAGE STRING  → `hooks.logMethod`  (the formatter never sees it)
 *   - CHILD BINDINGS      → `hardenChild`      (they bypass the formatter)
 *
 * WHY `formatters.log` AND NOT pino's `redact` OPTION. `redact` takes explicit
 * paths and supports only one level of wildcard (`*.token`), so it would cover
 * the shapes somebody remembered to list and quietly miss
 * `{ a: { b: { token } } }`. The formatter runs on EVERY log object from EVERY
 * call site, so a log line written next month is covered without anyone
 * remembering this file exists. That is the difference between a guard and a
 * convention.
 *
 * WHAT REMAINS UNCOVERED, stated rather than left to be discovered: a bare
 * secret in prose (`the key is abc123`). Key-name redaction cannot see inside
 * free text, and the text scrubber matches secret-carrying SHAPES (a query
 * parameter, a Bearer header, URL userinfo) rather than a list of prefixes that
 * look secret — such a list would be a blocklist of the leaks we have already
 * seen. There is a test that states this limit as a measured fact.
 */
export const logger = hardenChild(pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: { log: logRedactionFormatter },
  hooks: { logMethod: makeLogMethodHook() },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
}))

/** The object-path formatter, EXPORTED so its test can assert two different
 *  things with one definition: that it redacts, and that THIS logger is the one
 *  carrying it. A test that rebuilds an identical formatter of its own proves
 *  only that a copy works — the shape this whole packet exists to stop. */
export function logRedactionFormatter(obj: Record<string, unknown>): Record<string, unknown> {
  return redactLogObject(obj)
}
