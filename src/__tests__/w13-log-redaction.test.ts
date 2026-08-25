import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import { REDACTED } from '../cos/store-security.js'
import { logger, logRedactionFormatter } from '../logger.js'
import { makeLogMethodHook, hardenChild, scrubSecretText } from '../log-redaction.js'

// W13 / §7.2 + §7.6 — "secret nem logban" / "log redaction".
//
// The audit found `redactSensitive` written, tested, and called from nowhere,
// with `src/logger.ts` a bare pino instance carrying no `redact` option. The
// claim in its header was true of the function and false of the system.
//
// Istvan's acceptance point (2026-08-25): "a végső log-safety proof ne csak a
// formatters.log objektumútját bizonyítsa. Negatív teszttel ellenőrizd az összes
// tényleges logging surface-t ... Ha valamelyik nem releváns az aktuális
// Pino-konfigurációban, azt runtime/repo evidence-szel zárd ki, ne
// feltételezéssel."
//
// He was right that one surface is not the logger. Two REAL holes turned up when
// the others were probed, and both are pinned below by a test that fails without
// the fix:
//
//   - CHILD BINDINGS bypassed `formatters.log` entirely. `logger.child({ token })`
//     printed the token on every line that child ever wrote.
//   - An Error's MESSAGE and STACK went out verbatim, because the first fix
//     deliberately passed Errors through so the stack would survive — and the
//     stack is exactly where a credential-bearing URL ends up.
//
// Every describe below is one surface. The last one asserts that the REAL
// application logger carries all three mechanisms, because "the helper works"
// and "the system uses it" are different claims and only the second was ever in
// doubt.

/** A logger built from THE pieces src/logger.ts installs — imported, not
 *  re-declared. Rebuilding equivalents here would test copies. */
function loggerWith(sink: { write: (s: string) => void }) {
  return hardenChild(pino({
    level: 'info',
    formatters: { log: logRedactionFormatter },
    hooks: { logMethod: makeLogMethodHook() },
  }, sink as never))
}

function capture(fn: (log: ReturnType<typeof loggerWith>) => void): string {
  let out = ''
  const log = loggerWith({ write: (s: string) => { out += s } })
  fn(log)
  return out
}

// ── surface 1: the log object ───────────────────────────────────────────────

describe('W13 §7.2 surface 1 — the log OBJECT', () => {
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
})

// ── surface 2: the message string ───────────────────────────────────────────

describe('W13 §7.2 surface 2 — the MESSAGE STRING', () => {
  it('a token in a URL inside the message is scrubbed', () => {
    const out = capture(l => l.info('calling https://api.example.com/v1/x?access_token=abc123XYZ&page=2'))
    expect(out).not.toContain('abc123XYZ')
    expect(out).toContain('page=2')            // the diagnostic part survives
  })

  it('an Authorization header quoted into the message is scrubbed', () => {
    const out = capture(l => l.warn('retrying with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'))
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).toContain('Bearer')            // the SHAPE is still legible
  })

  it('URL userinfo credentials are scrubbed', () => {
    const out = capture(l => l.info('connecting to postgres://app:s3cr3tpass@db.internal:5432/marveen'))
    expect(out).not.toContain('s3cr3tpass')
    expect(out).toContain('db.internal')
  })

  it('THE STATED LIMIT: a bare secret in prose is NOT covered', () => {
    // Documented in log-redaction.ts rather than hidden. The scrubber matches
    // secret-carrying SHAPES; a list of prefixes that "look like" keys would be
    // a blocklist of the leaks we happen to have seen. This test exists so the
    // limit is a MEASURED fact a reader can find, not a surprise discovered
    // during an incident.
    const out = capture(l => l.info('the key is abc-123-secret'))
    expect(out).toContain('abc-123-secret')
  })
})

// ── surface 3: child bindings ───────────────────────────────────────────────

describe('W13 §7.2 surface 3 — CHILD BINDINGS (a real hole, measured)', () => {
  it('a secret in child bindings never reaches the line', () => {
    // WITHOUT hardenChild this printed `"token":"CHILDTOK"` on every line the
    // child wrote, and the formatter never saw it: pino applies child bindings
    // outside the per-call object the formatter receives.
    const out = capture(l => l.child({ token: 'CHILDTOK', component: 'poller' }).info({ a: 1 }, 'from child'))
    expect(out).not.toContain('CHILDTOK')
    expect(out).toContain('poller')            // ordinary bindings still work
    expect(out).toContain('"a":1')
  })

  it('a GRANDCHILD stays hardened — the level nobody looks at', () => {
    const out = capture(l => l.child({ component: 'a' }).child({ apiKey: 'GRANDKEY' }).info('deep'))
    expect(out).not.toContain('GRANDKEY')
    expect(out).toContain('deep')
  })

  it('secret-shaped TEXT in a binding is scrubbed too, not only secret-named keys', () => {
    const out = capture(l => l.child({ endpoint: 'https://h/api?api_key=BINDINGKEY' }).info('call'))
    expect(out).not.toContain('BINDINGKEY')
  })
})

// ── surface 4: errors, stacks, causes ───────────────────────────────────────

describe('W13 §7.2 surface 4 — Error, stack and cause', () => {
  it('a secret in the error MESSAGE is scrubbed, and the error is still an error', () => {
    const err = new Error('GET https://api.example.com/x?token=ERRTOKEN failed with 401')
    const out = capture(l => l.error({ err }, 'call failed'))
    expect(out).not.toContain('ERRTOKEN')
    expect(out).toContain('401')               // the diagnosis survives
    expect(out).toContain('Error')             // the type survives
    expect(out).toContain('stack')             // and so does the stack
  })

  it('a secret in the STACK is scrubbed', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at fetch (https://svc/x?access_token=STACKTOKEN)'
    const out = capture(l => l.error({ err }, 'failed'))
    expect(out).not.toContain('STACKTOKEN')
    expect(out).toContain('at fetch')
  })

  it('a nested CAUSE is walked, not trusted', () => {
    const inner = new Error('inner https://svc/x?api_key=CAUSEKEY')
    const err = new Error('outer', { cause: inner })
    const out = capture(l => l.error({ err }, 'failed'))
    expect(out).not.toContain('CAUSEKEY')
    expect(out).toContain('outer')
    expect(out).toContain('inner')
  })

  it('the error still carries its message — redaction is not deletion', () => {
    const out = capture(l => l.error({ err: new Error('boom-marker') }, 'failed'))
    expect(out).toContain('boom-marker')
  })
})

// ── surface 5: serializers ──────────────────────────────────────────────────

describe('W13 §7.2 surface 5 — serializers, excluded by evidence not assumption', () => {
  it('REPO EVIDENCE: the application logger configures no custom serializers', () => {
    // Istvan: exclude an irrelevant surface with evidence, not assumption. The
    // only serializer that can run is pino's built-in error serializer, and
    // surface 4 above shows it receives an ALREADY-RENDERED plain object,
    // because the formatter converts Errors before it is reached.
    const src = readFileSync(join(__dirname, '..', 'logger.ts'), 'utf-8')
    expect(src).not.toMatch(/serializers\s*:/)
  })

  it('RUNTIME EVIDENCE: a custom serializer would run AFTER the formatter, so it cannot un-redact', () => {
    // Measured rather than reasoned: install a serializer that would leak, and
    // observe what it is handed. It receives the redacted value, not the
    // original — the formatter has already run.
    let sawByCustomSerializer: unknown
    let out = ''
    const log = pino({
      level: 'info',
      formatters: { log: logRedactionFormatter },
      serializers: { payload: (v: unknown) => { sawByCustomSerializer = v; return v } },
    }, { write: (s: string) => { out += s } } as never)
    log.info({ payload: { token: 'SERIALIZERTOKEN' } }, 'x')
    expect(JSON.stringify(sawByCustomSerializer)).not.toContain('SERIALIZERTOKEN')
    expect(out).not.toContain('SERIALIZERTOKEN')
  })
})

// ── failure behaviour ───────────────────────────────────────────────────────

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

  it('a scrubber applied to ordinary text changes nothing', () => {
    const plain = 'cycle finished: 4 batches, 0 closed'
    expect(scrubSecretText(plain)).toBe(plain)
  })
})

// ── the wiring ──────────────────────────────────────────────────────────────

describe('W13 §7.2 — and the REAL logger carries all three mechanisms', () => {
  it('installs the object formatter', () => {
    const formatters = (logger as unknown as Record<symbol, { log?: unknown }>)[pino.symbols.formattersSym]
    expect(formatters?.log).toBe(logRedactionFormatter)
  })

  it('installs the message hook', () => {
    const hooks = (logger as unknown as Record<symbol, { logMethod?: unknown }>)[pino.symbols.hooksSym]
    expect(typeof hooks?.logMethod).toBe('function')
  })

  it('hardens .child() — asked of the REAL logger, at runtime', () => {
    // Not a source check: the actual application logger is asked for a child
    // with a secret binding, and the child is asked what bindings it kept.
    const child = logger.child({ token: 'REALTOKEN', component: 'w13-test' })
    const bindings = child.bindings()
    expect(JSON.stringify(bindings)).not.toContain('REALTOKEN')
    expect(bindings.component).toBe('w13-test')
    // and the hardening survives one more level down
    const grandchild = child.child({ apiKey: 'REALGRANDKEY' })
    expect(JSON.stringify(grandchild.bindings())).not.toContain('REALGRANDKEY')
  })
})
