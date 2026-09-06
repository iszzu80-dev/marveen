// A database snapshot you are allowed to call evidence.
//
// WHY THIS EXISTS, and it is a paid-for lesson rather than a precaution. On
// 2026-09-07 I took a "backup" of the live store with `cp` before a mutation.
// The database runs in WAL mode, so `cp` copied the main file and left 18 MB of
// committed transactions behind in the `-wal`. Measured afterwards: the copy
// held the last CHECKPOINT, not the moment I believed. It happened to sit
// before the run, which made it useful by luck; as a rollback artifact it was
// never valid, and I had been treating it as one.
//
// So: a plain file copy of a live WAL-mode SQLite database is NOT backup
// evidence, and this module will not produce one. `VACUUM INTO` asks SQLite
// itself for a consistent image, which is the supported mechanism -- the
// backup API and `.backup` are the equivalents.
//
// THE VERIFICATION IS PART OF THE ARTIFACT, not a separate courtesy. A file
// that exists is not a snapshot that restores: it has to open, pass
// integrity_check, and carry the rows the source carries. An unverified copy
// named "backup" is worse than no backup, because it stops anyone looking for
// a real one.
import Database from 'better-sqlite3'
import { existsSync, statSync, unlinkSync } from 'node:fs'

export interface SnapshotEvidence {
  /** Where the image was written. */
  path: string
  /** Bytes on disk. */
  bytes: number
  /** SQLite's own verdict. Anything but 'ok' means this is not a restore point. */
  integrity: string
  /** Objects visible in sqlite_master -- proves the image opens and is readable. */
  objects: number
  /** Row counts the caller asked to be compared, source vs snapshot. */
  tables: Array<{ table: string; source: number; snapshot: number; equal: boolean }>
  /** True only when every check above passed. The ONLY field that licenses the
   *  word "backup"; everything else is measurement. */
  verified: boolean
  /** Why it is not verified, when it is not. */
  problems: string[]
}

/**
 * Take a consistent snapshot and prove it, or say why it is not one.
 *
 * `tables` is deliberately required rather than optional: "which rows must
 * survive" is a question the caller has to answer, and a snapshot verified
 * against nothing is verified against nothing.
 */
export function verifiedSnapshot(
  sourcePath: string, outPath: string, tables: readonly string[],
): SnapshotEvidence {
  const problems: string[] = []
  if (tables.length === 0) problems.push('no tables named to verify: a snapshot checked against nothing proves nothing')

  // VACUUM INTO refuses to overwrite, so a stale file at the target would
  // silently become "the backup" while the real one was never written.
  if (existsSync(outPath)) unlinkSync(outPath)

  const src = new Database(sourcePath, { readonly: true })
  const sourceCounts = new Map<string, number>()
  for (const t of tables) {
    try {
      sourceCounts.set(t, (src.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n)
    } catch (e) {
      problems.push(`source table ${t} unreadable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    src.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`)
  } catch (e) {
    src.close()
    return {
      path: outPath, bytes: 0, integrity: 'not-taken', objects: 0, tables: [],
      verified: false,
      problems: [...problems, `VACUUM INTO failed: ${e instanceof Error ? e.message : String(e)}`],
    }
  }
  src.close()

  let integrity = 'unchecked'
  let objects = 0
  const rows: SnapshotEvidence['tables'] = []
  try {
    const snap = new Database(outPath, { readonly: true })
    integrity = (snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    if (integrity !== 'ok') problems.push(`integrity_check returned ${integrity}`)
    objects = (snap.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }).n
    if (objects === 0) problems.push('the snapshot opens but holds no schema objects')
    for (const t of tables) {
      const source = sourceCounts.get(t)
      if (source === undefined) continue
      let snapshot = -1
      try {
        snapshot = (snap.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
      } catch (e) {
        problems.push(`snapshot table ${t} unreadable: ${e instanceof Error ? e.message : String(e)}`)
      }
      const equal = snapshot === source
      if (!equal) problems.push(`${t}: source has ${source} rows, snapshot has ${snapshot}`)
      rows.push({ table: t, source, snapshot, equal })
    }
    snap.close()
  } catch (e) {
    problems.push(`snapshot unreadable: ${e instanceof Error ? e.message : String(e)}`)
  }

  return {
    path: outPath,
    bytes: existsSync(outPath) ? statSync(outPath).size : 0,
    integrity,
    objects,
    tables: rows,
    verified: problems.length === 0,
    problems,
  }
}

/**
 * Whether a path may be presented as backup evidence for a WAL-mode database.
 *
 * A copy taken beside a live `-wal` is the specific thing this refuses: it is
 * the last checkpoint, and the difference is invisible from the file alone.
 */
export function isPlainCopyOfWalDatabase(sourcePath: string): boolean {
  return existsSync(`${sourcePath}-wal`) && statSync(`${sourcePath}-wal`).size > 0
}
