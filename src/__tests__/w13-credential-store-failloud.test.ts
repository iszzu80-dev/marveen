import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { setSecret, deleteSecret, listSecrets } from '../web/vault.js'
import { addBinding, getBindings, syncSecret, syncAllBindings } from '../web/vault-bindings.js'
import {
  credentialStoreDir, credentialStorePath, classifyReadError,
  CredentialStoreUnreadable, isCredentialStoreUnreadable,
} from '../web/credential-store.js'
import { clearKnownSecrets } from '../known-secrets.js'

// W13, owner instruction 2026-08-31, both halves:
//
//   A) "A W13 tesztek ne használjanak közös repo-szintű vault.json /
//       vault-bindings.json állapotot. Kapjanak per-test/per-worker izolált temp
//       store-t. Ne serializálással rejtsd el a race-et."
//
//   B) "Credential úton egy bindings-read hiba nem válhat 'nincs binding /
//       success' eredménnyé. Különítsd el legalább: valóban nem létező,
//       specifikáció szerint megengedett kezdeti állapot; parse/corruption hiba;
//       permission/IO/transient read hiba; egyéb unexpected failure."
//
// Each of his four classes gets its OWN test here rather than being covered in
// passing by one "it errors" assertion, and each is paired with the CONTROL that
// stops it from passing for the boring reason.

const SECRET_ID = 'W13_FAILLOUD_KEY'
const SECRET_VALUE = 'sk-failloud-4a1b2c3d4e5f60718293a4b5c6d7e8f9'

let dir: string
let storeDir: string
let mcpPath: string
let prevStoreDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w13-failloud-'))
  storeDir = mkdtempSync(join(tmpdir(), 'w13-failloud-store-'))
  prevStoreDir = process.env.MARVEEN_CREDENTIAL_STORE_DIR
  process.env.MARVEEN_CREDENTIAL_STORE_DIR = storeDir
  mcpPath = join(dir, '.mcp.json')
  writeFileSync(mcpPath, JSON.stringify({
    mcpServers: { 'service-a': { command: '/bin/echo', args: ['a'], env: { EXISTING: 'x' } } },
  }, null, 2))
  initDatabase(':memory:')
})

afterEach(() => {
  // chmod back before rm, or the PERMISSION test leaves an undeletable tree.
  try { chmodSync(storeDir, 0o700) } catch { /* already writable */ }
  try { chmodSync(join(storeDir, 'vault-bindings.json'), 0o600) } catch { /* absent */ }
  rmSync(dir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
  if (prevStoreDir === undefined) delete process.env.MARVEEN_CREDENTIAL_STORE_DIR
  else process.env.MARVEEN_CREDENTIAL_STORE_DIR = prevStoreDir
  clearKnownSecrets()
})

function bindingsFile(): string { return credentialStorePath('vault-bindings.json') }

function bindServiceA(): void {
  setSecret(SECRET_ID, 'failloud', SECRET_VALUE)
  addBinding({
    vaultSecretId: SECRET_ID, envVar: 'SERVICE_A_KEY',
    targets: [{ mcpFilePath: mcpPath, serverName: 'service-a' }],
  })
}

describe('A -- the credential store is isolated, not serialised', () => {
  it('the store directory is resolved per CALL, so a test can move it', () => {
    // This is the whole mechanism behind the isolation. A module-level constant
    // -- what this code had until 2026-08-31 -- is captured at import time, and
    // no harness can move it afterwards. If this ever goes back to a constant,
    // this test is the one that notices.
    const first = credentialStoreDir()
    const moved = mkdtempSync(join(tmpdir(), 'w13-moved-'))
    process.env.MARVEEN_CREDENTIAL_STORE_DIR = moved
    try {
      expect(credentialStoreDir()).toBe(moved)
      expect(credentialStoreDir()).not.toBe(first)
    } finally {
      process.env.MARVEEN_CREDENTIAL_STORE_DIR = storeDir
      rmSync(moved, { recursive: true, force: true })
    }
  })

  it('a write in one store is INVISIBLE to another -- the run-10 race has no shared file left', () => {
    // The run-10 failure in the 2026-08-31 sweep was exactly this, across two
    // vitest workers: one file's setSecret/deleteSecret read-modify-write cycle
    // dropped the other file's secret. Two stores, two answers, no interference.
    setSecret(SECRET_ID, 'failloud', SECRET_VALUE)
    expect(listSecrets().map(e => e.id)).toContain(SECRET_ID)

    const other = mkdtempSync(join(tmpdir(), 'w13-other-'))
    process.env.MARVEEN_CREDENTIAL_STORE_DIR = other
    try {
      expect(listSecrets()).toEqual([])          // the other worker's view
      setSecret('OTHER_WORKER_KEY', 'other', 'sk-other-1111')
      deleteSecret('OTHER_WORKER_KEY')           // the read-modify-write that used to clobber
    } finally {
      process.env.MARVEEN_CREDENTIAL_STORE_DIR = storeDir
      rmSync(other, { recursive: true, force: true })
    }
    // Untouched by everything the "other worker" did.
    expect(listSecrets().map(e => e.id)).toContain(SECRET_ID)
  })

  it('the suite NEVER writes the checkout\'s own store/ -- the harness set an override', () => {
    // The per-worker override comes from src/__tests__/setup/isolate-credential-store.ts.
    // Without it this whole file would be writing the repo it is testing.
    expect(process.env.MARVEEN_CREDENTIAL_STORE_DIR).toBeTruthy()
    expect(credentialStoreDir()).toBe(storeDir)

    // NOT "the checkout has no vault.json": it may well have one, left behind by
    // runs from before this fix (the residue is itself the evidence the suite
    // used to write here). The property that matters is that THIS run does not
    // touch it, so the assertion is on non-mutation, not on absence.
    const checkoutVault = join(process.cwd(), 'store', 'vault.json')
    const before = existsSync(checkoutVault)
      ? { mtime: statSync(checkoutVault).mtimeMs, body: readFileSync(checkoutVault, 'utf8') }
      : null

    setSecret(SECRET_ID, 'failloud', SECRET_VALUE)

    expect(existsSync(join(storeDir, 'vault.json'))).toBe(true)
    const after = existsSync(checkoutVault)
      ? { mtime: statSync(checkoutVault).mtimeMs, body: readFileSync(checkoutVault, 'utf8') }
      : null
    expect(after).toEqual(before)
  })
})

describe('B -- ABSENT is the only failure answered with an empty store', () => {
  it('1. ABSENT: no bindings file at all is the specified initial state, and reads empty', () => {
    expect(existsSync(bindingsFile())).toBe(false)
    expect(getBindings()).toEqual([])
    const res = syncSecret(SECRET_ID)
    expect(res.outcome).toBe('COMPLETED')
    expect(res.updated).toBe(0)
    expect(res.errors).toEqual([])
  })

  it('2. CORRUPT (unparseable): throws typed, and does NOT report an empty store', () => {
    writeFileSync(bindingsFile(), '{ this is not json')
    let caught: unknown
    try { getBindings() } catch (err) { caught = err }
    expect(isCredentialStoreUnreadable(caught)).toBe(true)
    expect((caught as CredentialStoreUnreadable).kind).toBe('CORRUPT')
    expect((caught as CredentialStoreUnreadable).path).toBe(bindingsFile())
  })

  it('2b. CORRUPT (parses, wrong shape): valid JSON that is not a store is corruption too', () => {
    // `{"bindings": "all of them"}` would have sailed through a JSON.parse-only
    // check and blown up later, far from the file that is actually broken.
    writeFileSync(bindingsFile(), JSON.stringify({ bindings: 'all of them' }))
    expect(() => getBindings()).toThrow(CredentialStoreUnreadable)
    writeFileSync(bindingsFile(), JSON.stringify({ nope: [] }))
    expect(() => getBindings()).toThrow(CredentialStoreUnreadable)
  })

  it('3. PERMISSION: an unreadable file is a permission failure, never "no bindings"', () => {
    // Root can read anything, so this test cannot say what it means as root --
    // and a silent skip is how a guard stops guarding. The suite is not meant to
    // run as root (see assert-not-live-install.ts for the sibling rule).
    expect(process.getuid?.()).not.toBe(0)
    writeFileSync(bindingsFile(), JSON.stringify({ bindings: [] }))
    chmodSync(bindingsFile(), 0o000)
    let caught: unknown
    try { getBindings() } catch (err) { caught = err }
    expect(isCredentialStoreUnreadable(caught)).toBe(true)
    expect((caught as CredentialStoreUnreadable).kind).toBe('PERMISSION')
  })

  it('4. IO: a structural read error is IO, not corruption and not absence', () => {
    mkdirSync(bindingsFile())                     // EISDIR on read
    let caught: unknown
    try { getBindings() } catch (err) { caught = err }
    expect(isCredentialStoreUnreadable(caught)).toBe(true)
    expect((caught as CredentialStoreUnreadable).kind).toBe('IO')
  })

  it('5. UNEXPECTED is the default, so an unclassified code can never fall through to empty', () => {
    // The classifier's DEFAULT is what decides the direction of an unknown
    // failure. If it ever defaults to something benign, the whole guard leaks.
    expect(classifyReadError('EACCES')).toBe('PERMISSION')
    expect(classifyReadError('EISDIR')).toBe('IO')
    expect(classifyReadError('ESOMETHINGNEW')).toBe('UNEXPECTED')
    expect(classifyReadError(undefined)).toBe('UNEXPECTED')
  })

  it('the vault file gets the SAME treatment -- one fixed store is not a fix', () => {
    writeFileSync(credentialStorePath('vault.json'), '{ broken')
    expect(() => listSecrets()).toThrow(CredentialStoreUnreadable)
  })
})

describe('B -- an unreadable store cannot look like a successful sync', () => {
  it('syncSecret reports STORE_UNREADABLE, not { updated: 0, errors: [] }', () => {
    bindServiceA()
    writeFileSync(bindingsFile(), '{ corrupted after the binding was made')
    const res = syncSecret(SECRET_ID)
    expect(res.outcome).toBe('STORE_UNREADABLE')
    expect(res.updated).toBe(0)
    // The precise shape the old code returned, and the reason it was invisible.
    expect(res.errors).not.toEqual([])
    expect(res.failure?.kind).toBe('CORRUPT')
    expect(res.failure?.path).toBe(bindingsFile())
  })

  it('syncAllBindings does not report "everything is in sync" off a store it could not read', () => {
    writeFileSync(bindingsFile(), '{ corrupted')
    const res = syncAllBindings()
    expect(res.outcome).toBe('STORE_UNREADABLE')
    expect(res.updated).toBe(0)
    expect(res.errors).not.toEqual([])
  })

  it('CONTROL: with the store healthy the SAME call completes and writes the reference', () => {
    // Without this, every assertion above passes on code that fails everything.
    bindServiceA()
    const res = syncSecret(SECRET_ID)
    expect(res.outcome).toBe('COMPLETED')
    expect(res.updated).toBe(1)
    expect(res.errors).toEqual([])
    expect(res.failure).toBeUndefined()
  })

  it('the two outcomes are DISTINGUISHABLE on updated alone being 0', () => {
    // The defect was never "no error was raised". It was that the caller could
    // not tell the two apart, because both were { updated: 0, errors: [] }.
    const legitimate = syncSecret('W13_NO_SUCH_BINDING')
    expect(legitimate.outcome).toBe('COMPLETED')
    expect(legitimate.updated).toBe(0)

    writeFileSync(bindingsFile(), '{ corrupted')
    const broken = syncSecret('W13_NO_SUCH_BINDING')
    expect(broken.updated).toBe(0)
    expect(broken.outcome).not.toBe(legitimate.outcome)
  })
})
