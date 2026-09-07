// May this process WRITE to the database it just opened?
//
// WHY THIS EXISTS. On 2026-09-06 I ran `--apply` against the live
// `store/claudeclaw.db` with uncommitted candidate code and changed 138 rows.
// Istvan's rule afterwards was explicit: no live mutation by unreleased code
// without READY_FOR_RELEASE, an owner GO, a verified snapshot, an exact-SHA
// plan, and a readback -- derived, rebuildable state included.
//
// The rule was unenforceable by construction. Both extraction scripts hardcoded
// `initDatabase('store/claudeclaw.db')`, so there was no other database to run
// against even if I had wanted one. A rule that the tooling gives you no way to
// obey is a rule you will break again, so the seam and the guard land together:
// `MARVEEN_DB` chooses the target (the name `w11-staging-migration-proof.ts`
// and `w14-restore-drill.ts` already use -- one spelling, not a second one),
// and this refuses `--apply` against the live store unless the caller states
// the owner GO on the command line.
//
// IT FAILS CLOSED. If it cannot tell whether the target is the live store, it
// treats it as live. A guard that waves things through when confused is worse
// than none, because it also stops anyone looking for a real one.
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The acknowledgement a caller must put on argv to mutate the live store. */
export const LIVE_APPLY_FLAG = '--live-mutation-approved'

/** Exit code for a refused live mutation. Distinct from the release preflight's
 *  91 and the guard's 90, so a refusal is greppable rather than "it failed". */
export const EXIT_LIVE_MUTATION_REFUSED = 92

/** Canonicalise, resolving symlinks where the file exists. */
function canonical(p: string): string {
  const abs = resolve(p)
  try {
    return existsSync(abs) ? realpathSync(abs) : abs
  } catch {
    return abs   // unreadable -> not provably different from live
  }
}

/**
 * Every path that counts as "the live store".
 *
 * There is more than one, and getting this wrong fails OPEN, which is why it is
 * a list. `store/claudeclaw.db` relative to the working directory is what the
 * scripts have always meant -- but run the same script from a worktree and that
 * resolves to the WORKTREE's store, so a `MARVEEN_DB` pointing at the real
 * install would sail through as "not live". The home install's store is
 * therefore always in the list, spelled the way `w11-staging-migration-proof.ts`
 * already spells it. Any match means live.
 */
export function liveStorePaths(): string[] {
  const home = process.env.HOME ?? ''
  return [
    join(home, 'marveen', 'store', 'claudeclaw.db'),
    resolve('store', 'claudeclaw.db'),
  ]
}

/**
 * Is `dbPath` the live store?
 *
 * `hints` is injectable so a test can name its own "live" file. Anything that
 * cannot be resolved keeps its absolute form and is still compared, so an
 * unreadable or missing target does not quietly become "not live".
 */
export function isLiveStore(dbPath: string, hints: readonly string[] = liveStorePaths()): boolean {
  const target = canonical(dbPath)
  return hints.some((h) => canonical(h) === target)
}

export interface MutationVerdict {
  allowed: boolean
  live: boolean
  target: string
  reason: string
}

/**
 * Decide whether an `--apply` run may proceed against `dbPath`.
 *
 * Read-only runs are always allowed: the point of the seam is to make a dry run
 * against a clone easy, and nothing about reading needs an owner decision.
 */
export function mayMutate(
  dbPath: string, argv: readonly string[], apply: boolean,
  hints: readonly string[] = liveStorePaths(),
): MutationVerdict {
  const live = isLiveStore(dbPath, hints)
  const target = canonical(dbPath)
  if (!apply) return { allowed: true, live, target, reason: 'read-only run' }
  if (!live) return { allowed: true, live, target, reason: 'target is not the live store' }
  if (argv.includes(LIVE_APPLY_FLAG)) {
    return { allowed: true, live, target, reason: `owner GO stated on argv (${LIVE_APPLY_FLAG})` }
  }
  return {
    allowed: false, live, target,
    reason: `refusing --apply against the LIVE store. The owner's release boundary (2026-09-07)`
      + ` requires READY_FOR_RELEASE, an explicit GO, a verified snapshot, an exact-SHA plan and a`
      + ` readback -- derived state included. Run against a clone with MARVEEN_DB=<path>, or pass`
      + ` ${LIVE_APPLY_FLAG} once the GO exists.`,
  }
}
