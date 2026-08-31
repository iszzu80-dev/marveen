// The credential store's LOCATION and its READ FAILURE MODES, in one place.
//
// Two defects the 2026-08-31 twenty-run final-candidate sweep exposed, both on
// the credential path, both fixed here:
//
// 1. LOCATION was a module-level constant (`join(PROJECT_ROOT, 'store', ...)`),
//    captured at import time. Every test in the suite therefore shared ONE
//    mutable vault.json / vault-bindings.json under the checkout. run 10 failed
//    because w13-known-secret-boundary.test.ts (12 setSecret/deleteSecret calls,
//    read-modify-write on the whole file) ran in a different vitest worker,
//    concurrently with w13-egress-and-credential-criteria.test.ts, and clobbered
//    the latter's secret between its write and its read. Resolving the directory
//    on EVERY call is what lets the harness give each worker its own store; a
//    constant would be fixed before the harness could set anything.
//
// 2. READ FAILURE was a bare `catch { return <empty> }`. A missing file (the
//    specified initial state), a corrupted file, a permission error and an
//    unexpected IO error all became "the store is empty" — which downstream
//    became "no bindings", which became "0 updates, no errors", which is
//    indistinguishable from success. On a credential path that is the worst
//    possible direction to fail in: the operator is told nothing is wrong.
//    ABSENT is the ONLY outcome that may be answered with an empty store.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

/** Why a credential store file could not be turned into a value. ABSENT is not
 *  here on purpose: absence is a legal state, not a failure. */
export type CredentialStoreFailureKind =
  | 'CORRUPT'      // the bytes are there and are not a valid store
  | 'PERMISSION'   // EACCES/EPERM — readable in principle, not by us
  | 'IO'           // EISDIR/EIO/EBUSY/EMFILE/... — transient or structural
  | 'UNEXPECTED'   // anything we have not classified; never silently empty

export class CredentialStoreUnreadable extends Error {
  readonly kind: CredentialStoreFailureKind
  readonly path: string
  readonly code?: string

  constructor(kind: CredentialStoreFailureKind, path: string, detail: string, code?: string) {
    super(`credential store ${kind} at ${path}: ${detail}`)
    this.name = 'CredentialStoreUnreadable'
    this.kind = kind
    this.path = path
    this.code = code
  }
}

export function isCredentialStoreUnreadable(err: unknown): err is CredentialStoreUnreadable {
  return err instanceof CredentialStoreUnreadable
}

const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])
const IO_CODES = new Set([
  'EISDIR', 'ENOTDIR', 'EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE',
  'ELOOP', 'ENAMETOOLONG', 'EROFS', 'ENOMEM', 'ETIMEDOUT',
])

export function classifyReadError(code: string | undefined): CredentialStoreFailureKind {
  if (code && PERMISSION_CODES.has(code)) return 'PERMISSION'
  if (code && IO_CODES.has(code)) return 'IO'
  return 'UNEXPECTED'
}

/** Directory holding vault.json, .vault-key and vault-bindings.json.
 *  Resolved per call — see note 1 in the header. */
export function credentialStoreDir(): string {
  return process.env.MARVEEN_CREDENTIAL_STORE_DIR || join(PROJECT_ROOT, 'store')
}

export function credentialStorePath(filename: string): string {
  return join(credentialStoreDir(), filename)
}

/**
 * Read one JSON credential store file.
 *
 * Returns `whenAbsent` ONLY for ENOENT — the file has never been written, which
 * every one of these stores specifies as its initial state. Every other failure
 * throws a typed CredentialStoreUnreadable: the caller may decide what to do
 * about it, but it can no longer mistake it for an empty store.
 */
export function readJsonStore<T>(
  path: string,
  whenAbsent: T,
  validate: (parsed: unknown) => parsed is T,
): T {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return whenAbsent
    throw new CredentialStoreUnreadable(
      classifyReadError(code), path, (err as Error)?.message ?? String(err), code,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CredentialStoreUnreadable('CORRUPT', path, `not valid JSON: ${(err as Error).message}`)
  }

  // A file that parses but is not the shape we store is corruption too. Letting
  // it through would hand the caller `undefined.length` somewhere far from here.
  if (!validate(parsed)) {
    throw new CredentialStoreUnreadable('CORRUPT', path, 'JSON does not match the store shape')
  }
  return parsed
}
