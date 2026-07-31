import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ageSeconds, buildApgUiSummary } from '../apg/ui-projection.js'

// Card 1732a148: GET /api/apg/summary returned age_seconds=1785470343 for
// attention item 9959f705 -- an absolute unix epoch instead of an elapsed
// duration. Root cause confirmed against the REAL live sidecar
// (~/marveen-local/apg-kernel/store/apg-kernel.db): an execution_receipts row
// ('a1-pilot-live:1|9959f705', replay_run_id='a1-pilot-live:1', created_at=1)
// AND 4 checkpoint_results rows sharing that same replay_run_id ALSO carry
// created_at=1 -- both placeholder/sentinel timestamps from an early pilot
// event, not crafted test values. The receipt is what seeds
// buildCandidateProjection's `replayRunIds` set with 'a1-pilot-live:1',
// which is what pulls those 4 checkpoint rows into `checkpoints` (a
// checkpoint only counts for a candidate if SOME receipt/recommendation/
// transition for that candidate references its replay_run_id -- checkpoints
// are never looked up by candidate directly). ui-projection.ts's
// earliestActivityAt = Math.min(...stateActivityTimes) then picks up that 1
// directly; epochToMilliseconds(1) = 1*1000 = 1970-01-01T00:00:01Z;
// ageSeconds computes "now minus 1970" = essentially the current unix
// timestamp in seconds. The existing `createdAt <= 0` guard in ageSeconds
// does NOT catch this -- 1 is not <= 0.

function makeScratchSidecar(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apg-age-bug-'))
  const path = join(dir, 'apg-kernel.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE canonical_artifact_versions (
      id TEXT PRIMARY KEY, kind TEXT, logical_id TEXT, version INTEGER,
      content_digest TEXT, source_ref TEXT, created_at INTEGER
    );
    CREATE TABLE lineage_heads (
      logical_id TEXT PRIMARY KEY, head_version INTEGER, head_id TEXT, updated_at INTEGER
    );
    CREATE TABLE checkpoint_results (
      id TEXT PRIMARY KEY, replay_run_id TEXT, checkpoint TEXT, result TEXT,
      failed_checks TEXT, profile_overlay TEXT, created_at INTEGER
    );
    CREATE TABLE change_delivery_transitions (
      id TEXT PRIMARY KEY, change_logical_id TEXT, from_state TEXT, to_state TEXT,
      checkpoint TEXT, checkpoint_result TEXT, replay_run_id TEXT, created_at INTEGER
    );
    CREATE TABLE assisted_recommendations (
      id TEXT PRIMARY KEY, candidate_id TEXT, replay_run_id TEXT,
      evidence_completeness TEXT, missing_evidence_json TEXT, proposed_status_text TEXT,
      basis_json TEXT, draft_marker TEXT, created_at INTEGER
    );
    CREATE TABLE execution_receipts (
      id TEXT PRIMARY KEY, replay_run_id TEXT, change_logical_id TEXT,
      tested_commit TEXT, built_commit TEXT, deployed_artifact TEXT,
      commit_chain_status TEXT, runtime_status TEXT, created_at INTEGER
    );
    CREATE TABLE evidence_references (
      id TEXT PRIMARY KEY, receipt_id TEXT, link TEXT, ref_kind TEXT,
      ref_locator TEXT, ref_digest TEXT, status TEXT, created_at INTEGER
    );
  `)

  // Poisoned candidate: mirrors the real 9959f705 shape exactly -- a
  // 'change' row, an execution_receipts row at created_at=1 (this is what
  // seeds replayRunIds and pulls the checkpoints in below -- a checkpoint
  // is only associated with a candidate via a receipt/recommendation/
  // transition referencing its replay_run_id, never looked up directly),
  // plus 4 checkpoint_results at the real sidecar's actual poisoned value,
  // created_at=1, all tied to that same replay run.
  db.prepare(`INSERT INTO canonical_artifact_versions
    (id, kind, logical_id, version, content_digest, source_ref, created_at)
    VALUES (?, 'change', 'poisoned-candidate', 1, 'x', 'poisoned-candidate', 1700000000)`)
    .run('poisoned-candidate:change:1')
  db.prepare(`INSERT INTO execution_receipts
    (id, replay_run_id, change_logical_id, tested_commit, built_commit,
     deployed_artifact, commit_chain_status, runtime_status, created_at)
    VALUES ('poisoned-run:1|poisoned-candidate', 'poisoned-run:1', 'poisoned-candidate',
     NULL, NULL, NULL, 'UNKNOWN', 'UNKNOWN', 1)`).run()
  for (const checkpoint of ['spec_ready', 'verification_ready', 'release_ready', 'runtime_acceptance']) {
    db.prepare(`INSERT INTO checkpoint_results
      (id, replay_run_id, checkpoint, result, failed_checks, profile_overlay, created_at)
      VALUES (?, 'poisoned-run:1', ?, 'PASS', '[]', '[]', 1)`)
      .run(`poisoned-run:1|${checkpoint}|poisoned-candidate`, checkpoint)
  }

  // Healthy control candidate: a plausible, real-looking created_at so a
  // regression can't hide behind "everything returns 0 now".
  const plausibleCreatedAt = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
  db.prepare(`INSERT INTO canonical_artifact_versions
    (id, kind, logical_id, version, content_digest, source_ref, created_at)
    VALUES (?, 'change', 'healthy-candidate', 1, 'x', 'healthy-candidate', ?)`)
    .run('healthy-candidate:change:1', plausibleCreatedAt)
  db.prepare(`INSERT INTO checkpoint_results
    (id, replay_run_id, checkpoint, result, failed_checks, profile_overlay, created_at)
    VALUES (?, 'healthy-run:1', 'spec_ready', 'UNKNOWN', '[]', '[]', ?)`)
    .run('healthy-run:1|spec_ready|healthy-candidate', plausibleCreatedAt)

  db.close()
  return { path, dir }
}

describe('card 1732a148: age_seconds must never render as an absolute epoch', () => {
  let scratch: { path: string; dir: string }
  let originalDbPath: string | undefined

  beforeEach(() => {
    scratch = makeScratchSidecar()
    originalDbPath = process.env.APG_KERNEL_DB_PATH
    process.env.APG_KERNEL_DB_PATH = scratch.path
  })

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.APG_KERNEL_DB_PATH
    else process.env.APG_KERNEL_DB_PATH = originalDbPath
    rmSync(scratch.dir, { recursive: true, force: true })
  })

  it('ageSeconds() rejects an implausibly-small positive epoch, not just <= 0 (direct unit test)', () => {
    const nowIso = new Date().toISOString()
    // The exact poisoned value found in the live sidecar.
    expect(ageSeconds(nowIso, 1)).toBe(0)
    // A handful of neighbouring implausible values, not just the one observed.
    expect(ageSeconds(nowIso, 2)).toBe(0)
    expect(ageSeconds(nowIso, 59)).toBe(0)
    // A genuinely old-but-plausible real timestamp must still compute a real age.
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600
    expect(ageSeconds(nowIso, oneHourAgo)).toBeGreaterThan(3000)
    expect(ageSeconds(nowIso, oneHourAgo)).toBeLessThan(3700)
  })

  it('end-to-end: buildApgUiSummary never returns an epoch-sized age_seconds for a candidate poisoned by a created_at=1 row', () => {
    const nowIso = new Date().toISOString()
    const summary = buildApgUiSummary(nowIso, 'enforced')
    expect(summary.projection_error).toBeUndefined()

    const poisoned = summary.attention_items.find((item) => item.work_item_id === 'poisoned-candidate')
    expect(poisoned).toBeTruthy()
    // Before the fix this was ~1.78 billion (an absolute unix timestamp in
    // seconds). A real "age" for anything this system has ever produced
    // cannot exceed a few years in seconds -- generous upper bound below
    // avoids hardcoding an exact number while still catching the epoch bug.
    const TEN_YEARS_SECONDS = 10 * 365 * 24 * 3600
    expect(poisoned!.age_seconds).toBeLessThan(TEN_YEARS_SECONDS)
    // With the poisoned created_at=1 rows correctly excluded, this candidate
    // correctly falls back to its (deliberately plausible) canonical row's
    // created_at=1700000000 -- NOT to 0. Asserting an exact `0` here would
    // be over-strict: 0 only means "no plausible timestamp existed at all",
    // which is not this fixture's shape (the candidate row itself is fine,
    // only its checkpoints/receipt were poisoned). ~2023-11-14 -> ~2.6-2.8
    // years old at test time.
    const expectedAge = Math.floor(Date.now() / 1000) - 1700000000
    expect(poisoned!.age_seconds).toBeGreaterThan(expectedAge - 5)
    expect(poisoned!.age_seconds).toBeLessThan(expectedAge + 5)

    const healthy = summary.attention_items.find((item) => item.work_item_id === 'healthy-candidate')
    expect(healthy).toBeTruthy()
    expect(healthy!.age_seconds).toBeGreaterThan(0)
    expect(healthy!.age_seconds).toBeLessThan(TEN_YEARS_SECONDS)
  })
})
