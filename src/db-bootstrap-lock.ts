import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import { logger } from './logger.js'

/** Cross-process SINGLE-WRITER BOOTSTRAP for the store's DDL.
 *
 *  MIP-v1.0 / Phase 0 closure, FRESH_STORE_CONCURRENT_BOOT_SAFETY (owner gate,
 *  2026-08-26). W12 named this as an open gap and declined to close it by
 *  hardening the bootstrap statement by statement; this closes it at the
 *  infrastructure level instead, which is the only version of the fix that can
 *  be PROVEN rather than merely not-observed-to-fail.
 *
 *  WHY NOT STATEMENT-BY-STATEMENT. `initDatabase` is ~970 lines of DDL and the
 *  failures are all the same shape -- check-then-act between two processes:
 *
 *    duplicate column name: <col>   two boots both read PRAGMA table_info,
 *                                   both see the column missing, both ALTER
 *    no such table: main.memories   an index created against a table the other
 *                                   process has not committed yet
 *    database is locked             the WAL pragma (fixed separately in W12)
 *
 *  Measured on `develop` at 1adf2a23, four processes racing one fresh store,
 *  twelve rounds: 47 boots OK, 1 dead at startup (`duplicate column name:
 *  trace_id`, from the raw check-then-act at db.ts:742). Patching that one site
 *  would move the failure to the next unpatched site, and the ABSENCE of a
 *  failure in the next run would not be evidence that none remains. A flaky
 *  boot cannot be proven safe by re-running it until it is green.
 *
 *  THE MECHANISM. A sidecar SQLite database next to the store, held under
 *  `BEGIN IMMEDIATE` for the whole bootstrap. `BEGIN IMMEDIATE` takes SQLite's
 *  RESERVED lock at once and only one connection on a database may hold it, so
 *  the mutual exclusion is enforced by the OS file lock underneath -- not by a
 *  convention, a lockfile, or a claim in a document. Contenders wait on the
 *  busy timeout and then run their own bootstrap, which by then finds every
 *  table already present and does nothing.
 *
 *  Deliberately NOT a `wx` lockfile: a lockfile survives a killed process and
 *  needs stale-lock heuristics. This lock is held by an open file descriptor,
 *  so a crash releases it and rolls the transaction back with no cleanup.
 *
 *  The sidecar is separate from the store on purpose. Holding the STORE itself
 *  in a transaction for the length of the bootstrap would put ~970 DDL
 *  statements inside one transaction and change the crash semantics of every
 *  install; the sidecar changes nothing about how the store is written. */

/** Recorded so the test can assert MUTUAL EXCLUSION rather than mere absence of
 *  an error: with N racing processes the ledger must hold N rows whose
 *  [started_ms, ended_ms] intervals do not overlap. "Nobody crashed" is a
 *  weaker claim than "they provably did not run at the same time". */
const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS bootstrap_holders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pid        INTEGER NOT NULL,
    started_ms INTEGER NOT NULL,
    ended_ms   INTEGER NOT NULL,
    waited_ms  INTEGER NOT NULL
  )
`

export interface BootstrapLockOutcome {
  /** false when the lock was skipped (`:memory:`, or explicitly disabled). */
  locked: boolean
  /** ms spent blocked on another process's bootstrap. >0 proves contention. */
  waitedMs: number
}

/** Set by the last `withBootstrapLock` call in THIS process. Read by tests and
 *  by the fresh-boot proof; nothing in production branches on it. */
let lastOutcome: BootstrapLockOutcome = { locked: false, waitedMs: 0 }
export function lastBootstrapLockOutcome(): BootstrapLockOutcome { return lastOutcome }

export function bootstrapLockPath(dbPath: string): string { return `${dbPath}.bootlock` }

/** Run `fn` as the only bootstrapper of `dbPath` across all processes.
 *
 *  Fails CLOSED: if the lock cannot be acquired within the busy timeout the
 *  error propagates and the boot dies. A process that could not get the
 *  bootstrap lock must not proceed to race -- that is the exact failure this
 *  exists to prevent, and continuing would reintroduce it silently. */
export function withBootstrapLock<T>(dbPath: string, fn: () => T): T {
  // `:memory:` is private to the process; there is nothing to serialise.
  const disabled = process.env.MARVEEN_BOOTSTRAP_LOCK_DISABLED === '1'
  if (dbPath === ':memory:' || disabled) {
    if (disabled) {
      logger.warn({ dbPath }, 'BOOTSTRAP LOCK DISABLED by MARVEEN_BOOTSTRAP_LOCK_DISABLED=1 -- concurrent first boot is UNSAFE')
    }
    lastOutcome = { locked: false, waitedMs: 0 }
    return fn()
  }

  const lockPath = bootstrapLockPath(dbPath)
  const timeoutMs = Number(process.env.MARVEEN_BOOTSTRAP_LOCK_TIMEOUT_MS ?? 30_000)
  const lock = new Database(lockPath)
  const t0 = Date.now()
  try {
    // Never touch journal_mode here: a fresh sidecar is already in the default
    // rollback mode, and `PRAGMA journal_mode` is itself a statement that can
    // return SQLITE_BUSY without waiting -- the very trap this module closes.
    lock.pragma(`busy_timeout = ${timeoutMs}`)
    // BEGIN IMMEDIATE, not BEGIN: a deferred transaction takes no lock until
    // its first write, which would let every contender past this line at once.
    lock.exec('BEGIN IMMEDIATE')
  } catch (err) {
    try { lock.close() } catch { /* nothing held */ }
    logger.error({ err, lockPath, timeoutMs }, 'could not acquire the bootstrap lock; refusing to boot into a race')
    throw err
  }

  const acquiredMs = Date.now()
  const waitedMs = acquiredMs - t0
  try {
    const result = fn()
    lock.exec(LEDGER_DDL)
    lock.prepare('INSERT INTO bootstrap_holders (pid, started_ms, ended_ms, waited_ms) VALUES (?, ?, ?, ?)')
      .run(process.pid, acquiredMs, Date.now(), waitedMs)
    lock.exec('COMMIT')
    lastOutcome = { locked: true, waitedMs }
    if (waitedMs > 0) logger.info({ dbPath, waitedMs }, 'bootstrap ran after waiting for another process')
    return result
  } catch (err) {
    try { lock.exec('ROLLBACK') } catch { /* transaction already gone */ }
    throw err
  } finally {
    try { lock.close() } catch { /* already closed */ }
    // The sidecar carries no store data, but it sits in STORE_DIR and should
    // not be world-readable either.
    try { chmodSync(lockPath, 0o600) } catch { /* best effort, as for the store */ }
  }
}
