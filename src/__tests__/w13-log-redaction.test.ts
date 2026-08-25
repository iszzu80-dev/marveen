import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { REDACTED } from '../cos/store-security.js'
import { logger, logRedactionFormatter } from '../logger.js'

// W13 / §7.2 + §7.6 — "secret nem logban" / "log redaction".
//
// The audit found `redactSensitive` written, tested, and called from nowhere,
// with `src/logger.ts` a bare pino instance carrying no `redact` option. The
// claim in its header was true of the function and false of the system.
//
// These tests are about the SYSTEM. They build a pino logger with the same
// formatter src/logger.ts installs, write to a memory sink, and read the bytes
// that would have hit the log file. A test that only calls the helper proves
// the helper — which is exactly the state the audit found.

/** A logger built from THE formatter src/logger.ts installs — imported, not
 *  re-declared. Rebuilding an equivalent formatter here would test a copy, and
 *  a copy passing says nothing about the logger the system actually uses. The
 *  wiring itself is asserted separately, at the bottom of this file. */
function loggerWith(sink: { write: (s: string) => void }) {
  return pino({ level: 'info', formatters: { log: logRedactionFormatter } }, sink as never)
}

function capture(fn: (log: pino.Logger) => void): string {
  let out = ''
  const log = loggerWith({ write: (s: string) => { out += s } })
  fn(log)
  return out
}

describe('W13 §7.2 — a secret cannot reach a log line through the object', () => {
  it('redacts credential-shaped keys at the top level', () => {
    const out = capture(l => l.info({ token: 'tg-invite-abc123', apiKey: 'sk-live-XYZ' }, 'invite approved'))
    expect(out).not.toContain('tg-invite-abc123')
    expect(out).not.toContain('sk-live-XYZ')
    expect(out).toContain(REDACTED)
    expect(out).toContain('invite approved')   // the line still says what happened
  })

  it('reaches ARBITRARY depth, which is why the formatter and not pino\'s redact paths', () => {
    // pino's own `redact` option takes explicit paths with one level of
    // wildcard; this shape is the one such a list quietly misses.
    const out = capture(l => l.info({ req: { headers: { authorization: 'Bearer deadbeef' } } }, 'call'))
    expect(out).not.toContain('deadbeef')
    expect(out).toContain(REDACTED)
  })

  it('redacts through arrays too', () => {
    const out = capture(l => l.info({ items: [{ label: 'x', secret: 'hunter2' }] }, 'batch'))
    expect(out).not.toContain('hunter2')
    expect(out).toContain('"label":"x"')       // the shape survives, the value does not
  })

  it('redacts CASE CONTENT as well as secrets — a mail body is not a debug field', () => {
    const out = capture(l => l.info({ messageId: 'm1', snippet: 'Kérjük a számla rendezését', body: 'IBAN HU42...' }, 'ingest'))
    expect(out).not.toContain('IBAN HU42')
    expect(out).not.toContain('Kérjük a számla')
    expect(out).toContain('m1')                // identifiers stay, so the line is still diagnosable
  })

  it('does NOT eat identifiers — a redactor that blinds the logs gets turned off', () => {
    const out = capture(l => l.info({ key: 'KANBAN_WIP_LIMIT', quotaKey: 'send:daily', sessionId: 's-1' }, 'setting'))
    expect(out).toContain('KANBAN_WIP_LIMIT')
    expect(out).toContain('send:daily')
    expect(out).toContain('s-1')
  })

  it('an Error still carries its message and stack', () => {
    // The redactor walks objects with Object.entries, and an Error's message and
    // stack are non-enumerable: without the preserve hook every logged error
    // would arrive as `{}`. That would be a worse bug than the one being fixed.
    const out = capture(l => l.error({ err: new Error('boom-marker') }, 'failed'))
    expect(out).toContain('boom-marker')
    expect(out).toContain('stack')
  })

  it('the choke point covers a call site nobody edited — that is the whole point', () => {
    // A shape no existing code writes. Nothing had to be added anywhere for this
    // to be redacted, which is the difference between a guard and a convention.
    const out = capture(l => l.warn({ brandNewSubsystem: { nested: { refresh_token: 'rt-9999' } } }, 'new thing'))
    expect(out).not.toContain('rt-9999')
  })
})

describe('W13 §7.2 — a redaction FAILURE must not print the secret', () => {
  it('an object that explodes on enumeration logs a marker, never the raw value', () => {
    // Istvan, 2026-08-25: "a védelem bukása ne eredményezhesse a raw secret
    // kiírását". A redactor that rethrows, or that falls back to the original
    // object, would print exactly what it exists to hide.
    const bomb: Record<string, unknown> = { harmless: 'ok' }
    Object.defineProperty(bomb, 'token', {
      enumerable: true,
      get() { throw new Error('exploding getter') },
    })
    const out = capture(l => l.info(bomb, 'boom'))
    // The WHOLE object is dropped, not just the field that threw: after a
    // failure we do not know which parts were walked, so nothing from it may be
    // trusted onto the line. `harmless` is the witness — if it appears, the
    // original object was passed through and so would the token beside it.
    expect(out).not.toContain('harmless')
    expect(out).toContain('logRedactionFailed')
    expect(out).toContain('boom')     // the line still happened
  })

  it('and the caller is NOT failed: logging never throws', () => {
    const bomb: Record<string, unknown> = {}
    Object.defineProperty(bomb, 'apiKey', {
      enumerable: true,
      get() { throw new Error('nope') },
    })
    expect(() => capture(l => l.warn(bomb, 'still running'))).not.toThrow()
  })
})

describe('W13 §7.2 — the stated limit is real, and stated', () => {
  it('a secret interpolated into the MESSAGE STRING is not covered', () => {
    // Documented in src/logger.ts rather than hidden: key-name redaction cannot
    // see inside free text. This test exists so the limit is a MEASURED fact a
    // reader can find, not a surprise discovered during an incident.
    const out = capture(l => l.info(`token=abc-123-secret`))
    expect(out).toContain('abc-123-secret')
  })
})


describe('W13 §7.2 — and the REAL logger is the one carrying it', () => {
  it('src/logger.ts installs this exact formatter', () => {
    // Without this, every test above could pass while the application logger
    // stayed the bare pino instance the audit found. "The helper works" and
    // "the system uses it" are different claims, and only the second one was
    // ever in doubt.
    const formatters = (logger as unknown as Record<symbol, { log?: unknown }>)[pino.symbols.formattersSym]
    expect(formatters?.log).toBe(logRedactionFormatter)
  })
})
