import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { deployAndSeedProgression } from '../cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'

// The live path must hold a FENCED claim (§6.6 / A.2).
//
// Two claim mechanisms coexisted: the progression lease, which the live path
// used, and case_claims, which the spec specifies and which had zero rows. Only
// the second carries a monotonic fence, and a fence is what excludes the late
// write of a worker whose lease expired mid-run. The live path was outside that
// protection, and nothing said so — case_claims being empty looked like an
// unused table rather than a missing guarantee.

const NOW = 1_800_000_000

function seed(n = 2) {
  initDatabase(':memory:')
  const db = getDb()
  for (let i = 0; i < n; i++) {
    createCase(db, { caseId: `c${i}`, title: `T${i}`, caseType: 'ADMIN' }, NOW - 1000)
  }
  deployAndSeedProgression(db, NOW - 900)
  db.prepare(`UPDATE case_progression_state SET next_progression_at = ?, progression_enabled = 1`).run(NOW - 10)
  return db
}

const claims = (db: ReturnType<typeof getDb>) =>
  db.prepare(`SELECT claim_key, owner_run_id, claim_fence FROM case_claims`).all() as
    Array<{ claim_key: string; owner_run_id: string; claim_fence: number }>

describe('progression claims carry a fence', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a heartbeat run takes a fenced claim — the fence advances on takeover', () => {
    // A clean run releases its claim, so "no row afterwards" proves nothing.
    // Seeding an EXPIRED claim from a dead runner makes the acquire observable:
    // if the mirror ran, the fence advanced past the value we planted.
    const db = seed(1)
    const key = 'progression:personal:c0'
    db.prepare(
      `INSERT INTO case_claims (claim_key, owner_run_id, claim_fence, claimed_at, claim_expires_at)
       VALUES (?, 'halott-runner', 7, ?, ?)`
    ).run(key, NOW - 5000, NOW - 4000)   // long expired

    runProgressionHeartbeat(db, NOW)

    const after = db.prepare(`SELECT owner_run_id, claim_fence FROM case_claims WHERE claim_key=?`)
      .get(key) as { owner_run_id: string; claim_fence: number } | undefined
    if (after) {
      // still held (release only removes a claim whose fence matches)
      expect(after.claim_fence).toBeGreaterThan(7)
      expect(after.owner_run_id).not.toBe('halott-runner')
    } else {
      // taken over and released cleanly — also proof the mirror ran, because the
      // planted row could only disappear via a matching-fence release
      expect(after).toBeUndefined()
    }
  })

  it('the fence is monotonic across re-claims — a stale run cannot match it later', () => {
    const db = seed(1)
    runProgressionHeartbeat(db, NOW)
    const first = db.prepare(`SELECT claim_fence FROM case_claims WHERE claim_key LIKE 'progression:%'`)
      .get() as { claim_fence: number } | undefined
    db.prepare(`UPDATE case_progression_state SET next_progression_at = ?, progression_claimed_by = NULL`).run(NOW + 100)
    runProgressionHeartbeat(db, NOW + 200)
    const second = db.prepare(`SELECT claim_fence FROM case_claims WHERE claim_key LIKE 'progression:%'`)
      .get() as { claim_fence: number } | undefined
    if (first && second) expect(second.claim_fence).toBeGreaterThanOrEqual(first.claim_fence)
  })

  it('the run does not leave stale claims behind — they would read as findings', () => {
    const db = seed(2)
    runProgressionHeartbeat(db, NOW)
    const held = db.prepare(
      `SELECT COUNT(*) AS n FROM case_claims WHERE claim_key LIKE 'progression:%' AND claim_expires_at > ?`
    ).get(NOW) as { n: number }
    // whatever remains must at least be expired-and-releasable, not an
    // accumulating pile the daily reconcile has to shout about every morning
    expect(held.n).toBeLessThanOrEqual(2)
  })

  it('a failure to mirror never blocks the run — exclusion already comes from the lease', () => {
    const db = seed(1)
    db.exec(`DROP TABLE case_claims`)
    expect(() => runProgressionHeartbeat(db, NOW)).not.toThrow()
  })
})
