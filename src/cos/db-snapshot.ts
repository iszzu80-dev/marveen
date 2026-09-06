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
import { createHash } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'

/**
 * A content digest of one table: sha256 over every row, in a deterministic
 * order.
 *
 * Codex review DBSNAP-001: comparing COUNT(*) is not row-for-row verification.
 * A snapshot with different VALUES, or with different rows that happen to add
 * up to the same total, would pass a count check and be stamped "verified" --
 * which is the failure this module exists to make impossible, reintroduced one
 * level up.
 *
 * Ordering is by rowid where the table has one, and by every column otherwise,
 * because a digest over an undefined order is a digest of nothing.
 */
function tableDigest(db: Database.Database, table: string): { rows: number; digest: string } {
  const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((c) => `"${c.name}"`)
  let stmt
  try {
    stmt = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
  } catch {
    // WITHOUT ROWID: order by the whole row instead.
    stmt = db.prepare(`SELECT * FROM "${table}" ORDER BY ${cols.join(', ')}`)
  }
  const h = createHash('sha256')
  let rows = 0
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    rows += 1
    // Typed separators so 1 and '1', and null versus empty string, cannot
    // collide into the same digest.
    for (const v of Object.values(row)) {
      h.update(v === null ? '\u0000N' : typeof v === 'number' ? `\u0000#${v}` : Buffer.isBuffer(v) ? Buffer.concat([Buffer.from('\u0000B'), v]) : `\u0000S${String(v)}`)
    }
    h.update('\u0000R')
  }
  return { rows, digest: h.digest('hex') }
}

export interface SnapshotEvidence {
  /** Where the image was written. */
  path: string
  /** Bytes on disk. */
  bytes: number
  /** SQLite's own verdict. Anything but 'ok' means this is not a restore point. */
  integrity: string
  /** Objects visible in sqlite_master -- proves the image opens and is readable. */
  objects: number
  /** The caller's required tables, compared by CONTENT and not merely by count.
   *  `digest` is a sha256 over every row in a deterministic order, so a
   *  snapshot holding different values -- or different rows adding up to the
   *  same total -- cannot pass. */
  tables: Array<{
    table: string; source: number; snapshot: number
    sourceDigest: string; snapshotDigest: string; equal: boolean
  }>
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
  const sourceSide = new Map<string, { rows: number; digest: string }>()
  for (const t of tables) {
    try {
      sourceSide.set(t, tableDigest(src, t))
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
      const from = sourceSide.get(t)
      if (from === undefined) continue
      let to = { rows: -1, digest: '' }
      try {
        to = tableDigest(snap, t)
      } catch (e) {
        problems.push(`snapshot table ${t} unreadable: ${e instanceof Error ? e.message : String(e)}`)
      }
      // CONTENT equality, not count equality.
      const equal = to.digest === from.digest && to.rows === from.rows
      if (!equal) {
        problems.push(to.rows !== from.rows
          ? `${t}: source has ${from.rows} rows, snapshot has ${to.rows}`
          : `${t}: same row count (${from.rows}) but the content digest differs`)
      }
      rows.push({
        table: t, source: from.rows, snapshot: to.rows,
        sourceDigest: from.digest, snapshotDigest: to.digest, equal,
      })
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
