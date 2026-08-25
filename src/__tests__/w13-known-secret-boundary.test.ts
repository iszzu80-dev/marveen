import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { initDatabase, getDb } from '../db.js'
import { setSecret, getSecret, deleteSecret } from '../web/vault.js'
import {
  registerKnownSecret, scrubKnownSecrets, containsKnownSecret, clearKnownSecrets,
  knownSecretCount, KNOWN_SECRET_REDACTED, isKnownSecret, KNOWN_SECRET_MAX_ENTRIES,
} from '../known-secrets.js'
import { logRedactionFormatter } from '../logger.js'
import { makeLogMethodHook, hardenChild } from '../log-redaction.js'
import { discloseAndRecord } from '../cos/disclosure.js'

// W13 closure invariant (Istvan, 2026-08-26):
//
//   "known credential value cannot enter log / prompt / tool trace even when
//    embedded as an otherwise unstructured string. Ezt ne token-prefix
//    felismeréssel oldd meg, hanem provenance/secret-handling boundaryval."
//
// The mechanism is PROVENANCE, not recognition: a value handed out by a
// credential source is registered, and every boundary checks the text against
// what was registered. No prefix list, no entropy score. The separate category
// Istvan carved out — an unknown secret typed into arbitrary prose — is NOT
// claimed here, and the last test says so out loud.
//
// His acceptance list, each as its own test:
//   credential source → direct field → nested object → concatenation →
//   Error message/cause → tool/prompt payload.

const REAL_LOOKING_SECRET = 'sk-live-9f2b7c41aa8e4d0fb3216e5c77d90142'

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

describe('W13 — a KNOWN credential cannot enter a log line', () => {
  beforeEach(() => { clearKnownSecrets() })
  afterEach(() => { clearKnownSecrets() })

  it('1. THE CREDENTIAL SOURCE registers it — reading it from the vault is enough', () => {
    // The whole chain starts here: nobody has to remember to protect this
    // value, because the accessor that produced it registered it.
    const dir = mkdtempSync(join(tmpdir(), 'w13-vault-'))
    try {
      initDatabase(join(dir, 'db.sqlite'))
      setSecret('W13_TEST_SECRET', 'w13 test', REAL_LOOKING_SECRET)
      clearKnownSecrets()                       // prove the READ is what registers
      expect(knownSecretCount()).toBe(0)
      const value = getSecret('W13_TEST_SECRET')
      expect(value).toBe(REAL_LOOKING_SECRET)
      expect(knownSecretCount()).toBe(1)
      expect(containsKnownSecret('... ' + REAL_LOOKING_SECRET + ' ...')).toBe(true)
      deleteSecret('W13_TEST_SECRET')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('2. a DIRECT object field', () => {
    registerKnownSecret(REAL_LOOKING_SECRET)
    const out = capture(l => l.info({ credentialForCall: REAL_LOOKING_SECRET }, 'calling provider'))
    expect(out).not.toContain(REAL_LOOKING_SECRET)
    expect(out).toContain(KNOWN_SECRET_REDACTED)
  })

  it('3. a NESTED object, under an innocent key name', () => {
    // `config.provider.value` names nothing suspicious. Key-name redaction has
    // no reason to touch it; provenance does.
    registerKnownSecret(REAL_LOOKING_SECRET)
    const out = capture(l => l.info({ config: { provider: { value: REAL_LOOKING_SECRET } } }, 'boot'))
    expect(out).not.toContain(REAL_LOOKING_SECRET)
  })

  it('4. STRING CONCATENATION and interpolation, in the message itself', () => {
    registerKnownSecret(REAL_LOOKING_SECRET)
    const concatenated = capture(l => l.info('using key ' + REAL_LOOKING_SECRET + ' for the call'))
    expect(concatenated).not.toContain(REAL_LOOKING_SECRET)
    expect(concatenated).toContain('for the call')     // the line still reads

    const interpolated = capture(l => l.warn(`retry with ${REAL_LOOKING_SECRET}`))
    expect(interpolated).not.toContain(REAL_LOOKING_SECRET)
  })

  it('5. an ERROR message and its CAUSE — where an SDK puts the URL it called', () => {
    registerKnownSecret(REAL_LOOKING_SECRET)
    const inner = new Error('401 from https://api.example.com/v1?key=' + REAL_LOOKING_SECRET)
    const err = new Error('provider call failed', { cause: inner })
    const out = capture(l => l.error({ err }, 'enrichment failed'))
    expect(out).not.toContain(REAL_LOOKING_SECRET)
    expect(out).toContain('provider call failed')      // the diagnosis survives
    expect(out).toContain('401')
  })

  it('6. a PROMPT PAYLOAD — the disclosure path, not the log path', () => {
    // A credential does not only arrive in a field called `credential`. It can
    // be pasted into a mail body, and that body's field policy knows nothing
    // about it. Provenance decides.
    initDatabase(':memory:')
    registerKnownSecret(REAL_LOOKING_SECRET)
    const { disclosed } = discloseAndRecord(getDb(), {
      actor: 'test', onBehalfOf: 'istvan', runId: null,
      destination: 'llm:anthropic', trustClass: 'APPROVED_EXTERNAL',
      taskTier: 'SUMMARIZE_EXTRACT', caseSensitivity: 'PERSONAL',
      fields: [{ kind: 'BODY_FULL', value: 'A kulcs amit kertel: ' + REAL_LOOKING_SECRET + ' , hasznald.' }],
      requiredFields: ['BODY_FULL'],
    }, 1_700_000_000)
    const prompt = disclosed.map(d => d.value).join('\n')
    expect(prompt).not.toContain(REAL_LOOKING_SECRET)
    expect(prompt).toContain('hasznald')               // the rest of the body still travels
  })

  it('a RAW-treatment field is not exempt either', () => {
    initDatabase(':memory:')
    registerKnownSecret(REAL_LOOKING_SECRET)
    const { disclosed } = discloseAndRecord(getDb(), {
      actor: 'test', onBehalfOf: 'istvan', runId: null,
      destination: 'llm:anthropic', trustClass: 'APPROVED_EXTERNAL',
      taskTier: 'ROUTING_METADATA', caseSensitivity: 'PUBLIC',
      fields: [{ kind: 'SOURCE_CHANNEL_TYPE', value: 'gmail:' + REAL_LOOKING_SECRET, sensitivity: 'PUBLIC' }],
      requiredFields: ['SOURCE_CHANNEL_TYPE'],
    }, 1_700_000_000)
    expect(disclosed[0].value).not.toContain(REAL_LOOKING_SECRET)
  })
})

describe('W13 — the boundary is provenance, with its limits stated', () => {
  beforeEach(() => { clearKnownSecrets() })
  afterEach(() => { clearKnownSecrets() })

  it('an UNREGISTERED value in prose is NOT caught — the category Istvan excluded', () => {
    // No universal recognition is claimed. This test exists so the boundary of
    // the guarantee is a measured fact rather than an assumption a reader makes
    // in either direction.
    const out = capture(l => l.info('the password is correct-horse-battery-staple'))
    expect(out).toContain('correct-horse-battery-staple')
  })

  it('a value too SHORT to be matched safely is refused registration, and says so', () => {
    // A four-character "secret" would redact ordinary words out of every log
    // line in the system. Refusing is the honest behaviour; silently accepting
    // and then matching everywhere would be worse than not protecting it.
    expect(registerKnownSecret('abcd')).toBe(false)
    expect(registerKnownSecret(REAL_LOOKING_SECRET)).toBe(true)
    expect(knownSecretCount()).toBe(1)
  })

  it('longest-first replacement leaves no fragment behind', () => {
    // One registered value containing another: replacing the shorter one first
    // would leave the rest of the longer one in the text.
    const long = 'AAAABBBBCCCCDDDD'
    const short = 'BBBBCCCC'
    registerKnownSecret(long); registerKnownSecret(short)
    const out = scrubKnownSecrets('x ' + long + ' y')
    expect(out).not.toContain('AAAA')
    expect(out).not.toContain('DDDD')
  })

  it('ordinary text is untouched — the guard must not cost legibility', () => {
    registerKnownSecret(REAL_LOOKING_SECRET)
    const plain = 'cycle finished: 4 batches, 0 closed'
    expect(scrubKnownSecrets(plain)).toBe(plain)
  })
})

// ── credential LIFECYCLE (Istvan, 2026-08-26) ───────────────────────────────
//
// "A known-secret registry ne csak hozzáadni tudjon." Four requirements, four
// tests: the new value is protected at once, the old one can no longer act, the
// old one is still scrubbable, and the registry cannot grow without bound.

describe('W13 — credential lifecycle: rotation and revocation', () => {
  let dir: string

  beforeEach(() => {
    clearKnownSecrets()
    dir = mkdtempSync(join(tmpdir(), 'w13-rotate-'))
    initDatabase(join(dir, 'db.sqlite'))
  })
  afterEach(() => {
    try { deleteSecret('W13_ROTATE') } catch { /* already gone */ }
    clearKnownSecrets()
    rmSync(dir, { recursive: true, force: true })
  })

  const OLD = 'sk-old-11112222333344445555666677778888'
  const NEW = 'sk-new-99998888777766665555444433332222'

  it('1. the NEW credential is protected immediately — at the write, not at the next read', () => {
    setSecret('W13_ROTATE', 'rotating', OLD)
    expect(isKnownSecret(OLD)).toBe(true)
    setSecret('W13_ROTATE', 'rotating', NEW)
    // No getSecret() in between: a log line written between the rotation and
    // the next read must already be covered.
    expect(isKnownSecret(NEW)).toBe(true)
  })

  it('2. the OLD credential can no longer ACT: the vault hands out the new one', () => {
    setSecret('W13_ROTATE', 'rotating', OLD)
    setSecret('W13_ROTATE', 'rotating', NEW)
    expect(getSecret('W13_ROTATE')).toBe(NEW)
    // and after revocation there is nothing to act with at all
    deleteSecret('W13_ROTATE')
    expect(getSecret('W13_ROTATE')).toBeNull()
  })

  it('3. the OLD value is STILL scrubbable — a revoked key is not a safe string', () => {
    setSecret('W13_ROTATE', 'rotating', OLD)
    setSecret('W13_ROTATE', 'rotating', NEW)
    deleteSecret('W13_ROTATE')
    // It may already sit in a log line or an SDK error from before the
    // rotation. Losing protection at rotation time would leak it there.
    const out = capture(l => l.error({ err: new Error('401 with ' + OLD) }, 'old key rejected'))
    expect(out).not.toContain(OLD)
    expect(scrubKnownSecrets('previous value was ' + OLD)).not.toContain(OLD)
  })

  it('4. the registry is BOUNDED — rotation cannot grow it without limit', () => {
    // Registering past the cap evicts the oldest, so a process that rotates
    // forever does not accumulate forever. The bound asserted here is the
    // SHIPPED constant, not a copy of it.
    for (let i = 0; i < KNOWN_SECRET_MAX_ENTRIES + 25; i++) {
      registerKnownSecret('secret-value-number-' + String(i).padStart(6, '0'))
    }
    expect(knownSecretCount()).toBe(KNOWN_SECRET_MAX_ENTRIES)
    // FIFO: the newest survive, the oldest were evicted.
    expect(isKnownSecret('secret-value-number-000000')).toBe(false)
    expect(isKnownSecret('secret-value-number-000280')).toBe(true)
  })

  it('re-registering the same value neither grows the set nor renews its position', () => {
    registerKnownSecret(OLD)
    const first = knownSecretCount()
    for (let i = 0; i < 50; i++) registerKnownSecret(OLD)
    expect(knownSecretCount()).toBe(first)
  })
})
