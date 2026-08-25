import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import {
  ensureFeatureRunSchema, recordFeatureRun, deriveRunStatus, standardFeatureResult,
} from '../cos/consumer-manifest.js'

// W14 / §8.7 — RUN INTEGRITY.
//
// The audit's headline: `cos_feature_runs` existed, `recordFeatureRun` was
// exported and tested, and NOTHING called it. The live store agreed — 0 rows,
// created on every boot, written never. Third instance of the same shape in
// three packets.
//
// So these tests are about two different claims, and both are needed:
//   1. the record now carries what §8.7 asks for, and its central rule
//      ("SUCCESS only after readback/verification") is enforced rather than
//      documented;
//   2. the cycle actually writes it — the part that was missing.

const NOW = 1_800_000_000

function result(over: Partial<ReturnType<typeof standardFeatureResult>> = {}) {
  return standardFeatureResult({ examined: 1, matched: 1, acted: 1, failed: 0, reason: 'test', ...over })
}

describe('W14 §8.7 — SUCCESS requires verification', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an ACTED run that was verified is SUCCESS', () => {
    const status = recordFeatureRun(getDb(), {
      runId: 'r1', featureId: 'cos-channel-send', domain: 'personal',
      result: result(), startedAt: NOW, finishedAt: NOW + 2,
      integrity: { verificationStatus: 'VERIFIED' },
    })
    expect(status).toBe('SUCCESS')
  })

  it('an ACTED run that was NOT verified is PARTIAL, never SUCCESS', () => {
    // The distinction the outbound executor has made since P1.1
    // (APPLIED_UNVERIFIED vs VERIFIED), now inherited by the run record. A send
    // that could not be read back is not a successful run.
    const status = recordFeatureRun(getDb(), {
      runId: 'r2', featureId: 'cos-channel-send', domain: 'personal',
      result: result(), startedAt: NOW, finishedAt: NOW + 2,
      integrity: { verificationStatus: 'UNVERIFIED' },
    })
    expect(status).toBe('PARTIAL')
  })

  it('a run that did nothing is SUCCESS — a quiet cycle is not a half-broken one', () => {
    const status = recordFeatureRun(getDb(), {
      runId: 'r3', featureId: 'cos-deadline-audit', domain: 'personal',
      result: result({ examined: 0, matched: 0, acted: 0 }), startedAt: NOW, finishedAt: NOW + 1,
    })
    expect(status).toBe('SUCCESS')
  })

  it('a partial failure is PARTIAL and a total one is FAILED', () => {
    expect(deriveRunStatus(result({ acted: 2, failed: 1 }), 'VERIFIED')).toBe('PARTIAL')
    expect(deriveRunStatus(result({ acted: 0, failed: 3 }), 'NOT_APPLICABLE')).toBe('FAILED')
  })

  it('THE RULE IS A CONSTRAINT, not a convention: the DB refuses the lie', () => {
    // The helper derives the status, so a caller cannot produce this row through
    // it. This asserts what stands if a future writer skips the helper — an
    // INSERT claiming SUCCESS with UNVERIFIED is rejected by SQLite itself.
    const db = getDb()
    ensureFeatureRunSchema(db)
    expect(() => db.prepare(`
      INSERT INTO cos_feature_runs
        (run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason,
         started_at, finished_at, verification_status, run_status)
      VALUES ('r-lie', 'f', 'personal', 1, 1, 1, 0, 'ACTED', 'hand-written',
         ${NOW}, ${NOW + 1}, 'UNVERIFIED', 'SUCCESS')
    `).run()).toThrow(/CHECK constraint failed/)
  })

  it('records the §8.7 envelope: capability, cursors, pending writes, side effects', () => {
    const db = getDb()
    recordFeatureRun(db, {
      runId: 'r4', featureId: 'cos-close-batches', domain: 'personal',
      result: result(), startedAt: NOW, finishedAt: NOW + 5,
      integrity: {
        capabilityResult: 'READ,WRITE_LOCAL,EXTERNAL_EFFECT',
        inputCursor: '100', finalCursor: '150',
        processedIds: ['m1', 'm2'], pendingWrites: 1,
        sideEffects: { labelled: 2 }, verificationStatus: 'VERIFIED',
      },
    })
    const row = db.prepare(`SELECT * FROM cos_feature_runs WHERE run_id='r4'`).get() as Record<string, unknown>
    expect(row.capability_result).toBe('READ,WRITE_LOCAL,EXTERNAL_EFFECT')
    expect(row.input_cursor).toBe('100')
    expect(row.final_cursor).toBe('150')
    expect(JSON.parse(String(row.processed_ids))).toEqual(['m1', 'm2'])
    expect(row.pending_writes).toBe(1)
    expect(JSON.parse(String(row.side_effects))).toEqual({ labelled: 2 })
    expect(row.run_status).toBe('SUCCESS')
  })
})

describe('W14 §8.7 — the schema rebuild keeps every pre-W14 row', () => {
  it('migrates an old-shape table without losing rows, and refuses to invent a verdict', () => {
    // A store that has been running since before W14 has the narrow table. The
    // rebuild copies rows and marks them UNKNOWN/NOT_APPLICABLE: nothing
    // recorded whether those runs were verified, and inventing a verdict for
    // them is exactly the lie the new column exists to prevent.
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE cos_feature_runs (
        run_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL,
        domain TEXT NOT NULL CHECK(domain IN ('personal','zst')),
        examined INTEGER NOT NULL, matched INTEGER NOT NULL, acted INTEGER NOT NULL, failed INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('NO_DATA','NO_MATCH','NO_ACTION','ACTED','FAILED','UNKNOWN')),
        reason TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
      )`)
    db.prepare(`INSERT INTO cos_feature_runs VALUES ('old-1','f','personal',1,1,1,0,'ACTED','before W14',1,2)`).run()

    ensureFeatureRunSchema(db)

    const rows = db.prepare(`SELECT run_id, run_status, verification_status FROM cos_feature_runs`).all() as
      Array<{ run_id: string; run_status: string; verification_status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].run_id).toBe('old-1')
    expect(rows[0].run_status).toBe('UNKNOWN')
    expect(rows[0].verification_status).toBe('NOT_APPLICABLE')
    // and the new shape is in force
    expect(() => db.prepare(`
      INSERT INTO cos_feature_runs
        (run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason,
         started_at, finished_at, verification_status, run_status)
      VALUES ('r-lie','f','personal',1,1,1,0,'ACTED','x',1,2,'UNVERIFIED','SUCCESS')
    `).run()).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('is idempotent: a second call on the NEW shape rebuilds nothing', () => {
    const db = new Database(':memory:')
    ensureFeatureRunSchema(db)
    recordFeatureRun(db, {
      runId: 'keep-me', featureId: 'f', domain: 'personal',
      result: result(), startedAt: NOW, finishedAt: NOW + 1,
      integrity: { verificationStatus: 'VERIFIED' },
    })
    ensureFeatureRunSchema(db)
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM cos_feature_runs`).get() as { n: number }).n
    expect(n).toBe(1)
    db.close()
  })
})

describe('W14 §8.7 — the cycle is the writer', () => {
  const CYCLE = readFileSync(join(__dirname, '..', '..', 'scripts', 'cos-cycle.ts'), 'utf-8')

  // Source-level, and deliberately so: the cycle spawns ten `npx tsx`
  // subprocesses and cannot be run inside the suite. What CAN be asserted here
  // is that the writer exists at the choke point and that its inputs are not
  // invented — the behaviour of the record itself is covered above.

  it('records a run for every step, on the success path AND the failure path', () => {
    expect(CYCLE).toContain('recordFeatureRun(')
    // Both branches call it: a step that crashed is a run that happened.
    const calls = (CYCLE.match(/recordRun\(/g) ?? []).length
    expect(calls).toBeGreaterThanOrEqual(3)   // definition + success path + failure path
  })

  it('derives verification from the GRANT, so a step cannot claim more than it may do', () => {
    expect(CYCLE).toContain("capabilities.includes('EXTERNAL_EFFECT')")
    expect(CYCLE).toMatch(/return cpp\.acted > 0 \? 'UNVERIFIED' : 'NOT_APPLICABLE'/)
  })

  it('never lets the run ledger take the cycle down', () => {
    // A monitoring surface that can cause the outage it reports is worse than
    // no monitoring surface.
    expect(CYCLE).toMatch(/run ledger write failed/)
  })
})
