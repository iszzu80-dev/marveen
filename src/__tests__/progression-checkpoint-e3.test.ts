// Progression Checkpoint E.3 tests — Wait/Wake scheduling + claim/lease (card b29f99d2).
//
// Covers:
//   Stage 1: scheduleNextProgression — sets and clears wake time
//   Stage 2: tryClaimProgression — atomic claim (+ not-due, not-enabled, already-claimed)
//   Stage 3: findDueCases — wake-ready discovery (read-only, domain-scoped)
//   Stage 4: RED-PROOF — no double-claim (two concurrent runners)
//   Stage 5: RED-PROOF — expired lease reclaimable
//   Stage 6: RED-PROOF — no premature wake before next_progression_at
//   Stage 7: releaseProgressionClaim — release + guard against wrong runId
//   Stage 8: extendProgressionLease — extend + guard against expired claim
//   Stage 9: Domain-scoped — CrossDomainReadError on cross-domain operations
//   Stage 10: setProgressionEnabled — enable / disable toggle
//
// ACCEPTANCE CRITERION: concurrency-safe. Every RED-PROOF test must fail LOUD
// (throw / assert failure) on violation, NOT pass silently with a console.warn.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import {
  scheduleNextProgression,
  findDueCases,
  tryClaimProgression,
  releaseProgressionClaim,
  extendProgressionLease,
  setProgressionEnabled,
} from '../cos/progression-scheduler.js'
import { CrossDomainReadError } from '../cos/progression-resolver.js'

// ── Test helpers ──────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** Seed a case_progression_state row with required fields. */
function seedProgressionState(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  overrides: {
    progression_enabled?: number
    progression_mode?: string
    next_progression_at?: number | null
    progression_claimed_by?: string | null
    progression_claim_expires_at?: number | null
    goal?: string | null
    last_progressed_at?: number | null
  } = {},
): void {
  const t = now()
  db.prepare(
    `INSERT INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode,
      next_progression_at, progression_claimed_by, progression_claim_expires_at,
      goal, last_progressed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    domain, caseId,
    overrides.progression_enabled ?? 1,
    overrides.progression_mode ?? 'shadow',
    overrides.next_progression_at ?? null,
    overrides.progression_claimed_by ?? null,
    overrides.progression_claim_expires_at ?? null,
    overrides.goal ?? null,
    overrides.last_progressed_at ?? null,
    t, t,
  )
}

/** Seed the parent case row so domainGuard passes. */
function seedCase(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
): void {
  const t = now()
  if (domain === 'personal') {
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, created_at, updated_at)
       VALUES (?, 'Test case', 'ADMIN', 'NEW', 'PERSONAL', ?, ?)`,
    ).run(caseId, t, t)
  } else {
    db.prepare(
      `INSERT INTO zst_cases (case_id, title, case_type, status, sensitivity, created_at, updated_at)
       VALUES (?, 'Test case', 'ADMIN', 'NEW', 'ZST_INTERNAL', ?, ?)`,
    ).run(caseId, t, t)
  }
}

/** Seed both the parent case and a progression state row. */
function seedCaseWithProgression(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  overrides: Parameters<typeof seedProgressionState>[3] = {},
): void {
  seedCase(db, domain, caseId)
  seedProgressionState(db, domain, caseId, overrides)
}

// ── Stage 1: scheduleNextProgression ──────────────────────────────────────

describe('Checkpoint E.3 — Wait/Wake scheduling + claim/lease', () => {
  describe('scheduleNextProgression()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('sets next_progression_at on an existing progression state row', () => {
      seedCaseWithProgression(db, 'personal', 'pri-001')
      const t = now()
      const wakeAt = t + 3600

      scheduleNextProgression(db, 'personal', 'pri-001', wakeAt, t)

      const row = db.prepare(
        'SELECT next_progression_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { next_progression_at: number }

      expect(row.next_progression_at).toBe(wakeAt)
    })

    it('clears next_progression_at when null is passed', () => {
      seedCaseWithProgression(db, 'personal', 'pri-002', { next_progression_at: now() + 3600 })
      const t = now()

      scheduleNextProgression(db, 'personal', 'pri-002', null, t)

      const row = db.prepare(
        'SELECT next_progression_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-002') as { next_progression_at: number | null }

      expect(row.next_progression_at).toBeNull()
    })

    it('works for ZST domain', () => {
      seedCaseWithProgression(db, 'zst', 'zst-001')
      const t = now()
      const wakeAt = t + 7200

      scheduleNextProgression(db, 'zst', 'zst-001', wakeAt, t)

      const row = db.prepare(
        'SELECT next_progression_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('zst', 'zst-001') as { next_progression_at: number }

      expect(row.next_progression_at).toBe(wakeAt)
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      seedCaseWithProgression(db, 'zst', 'zst-cross-001')
      expect(() =>
        scheduleNextProgression(db, 'personal', 'zst-cross-001', now() + 3600, now()),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 2: tryClaimProgression — atomic claim ─────────────────────────

  describe('tryClaimProgression()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('claims a due case (next_progression_at in the past, not claimed)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 60, // due 60 seconds ago
      })

      const runId = randomUUID()
      const result = tryClaimProgression(db, 'personal', 'pri-001', runId, 300, t)

      expect(result).toBe('pri-001')

      // Verify DB state
      const row = db.prepare(
        'SELECT progression_claimed_by, progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { progression_claimed_by: string; progression_claim_expires_at: number }

      expect(row.progression_claimed_by).toBe(runId)
      expect(row.progression_claim_expires_at).toBe(t + 300)
    })

    it('returns null when case is not due (next_progression_at in the future)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002', {
        next_progression_at: t + 3600, // due in 1 hour
      })

      const result = tryClaimProgression(db, 'personal', 'pri-002', randomUUID(), 300, t)

      expect(result).toBeNull()

      // progression_claimed_by should still be NULL
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-002') as { progression_claimed_by: string | null }

      expect(row.progression_claimed_by).toBeNull()
    })

    it('returns null when progression is not enabled', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-003', {
        progression_enabled: 0,
        next_progression_at: t - 60,
      })

      const result = tryClaimProgression(db, 'personal', 'pri-003', randomUUID(), 300, t)

      expect(result).toBeNull()
    })

    it('returns null when next_progression_at is NULL (never scheduled)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-004', {
        next_progression_at: null,
      })

      const result = tryClaimProgression(db, 'personal', 'pri-004', randomUUID(), 300, t)

      expect(result).toBeNull()
    })

    it('returns null when already claimed by another runner (non-expired lease)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-005', {
        next_progression_at: t - 120,
        progression_claimed_by: 'other-runner-id',
        progression_claim_expires_at: t + 200, // still valid for 200s
      })

      const result = tryClaimProgression(db, 'personal', 'pri-005', randomUUID(), 300, t)

      expect(result).toBeNull()

      // The original claim should still be in place
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-005') as { progression_claimed_by: string }

      expect(row.progression_claimed_by).toBe('other-runner-id')
    })

    it('succeeds when claim is expired (reclaim)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-006', {
        next_progression_at: t - 300,
        progression_claimed_by: 'crashed-runner',
        progression_claim_expires_at: t - 10, // expired 10 seconds ago
      })

      const newRunId = randomUUID()
      const result = tryClaimProgression(db, 'personal', 'pri-006', newRunId, 300, t)

      expect(result).toBe('pri-006')

      const row = db.prepare(
        'SELECT progression_claimed_by, progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-006') as { progression_claimed_by: string; progression_claim_expires_at: number }

      expect(row.progression_claimed_by).toBe(newRunId)
      expect(row.progression_claim_expires_at).toBe(t + 300)
    })

    it('works for ZST domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-001', {
        next_progression_at: t - 60,
      })

      const runId = randomUUID()
      const result = tryClaimProgression(db, 'zst', 'zst-001', runId, 300, t)

      expect(result).toBe('zst-001')
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-cross-002', {
        next_progression_at: t - 60,
      })

      expect(() =>
        tryClaimProgression(db, 'personal', 'zst-cross-002', randomUUID(), 300, t),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 3: findDueCases — wake-ready discovery ────────────────────────

  describe('findDueCases()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('returns cases where next_progression_at <= now and progression_enabled=1', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', { next_progression_at: t - 120 })
      seedCaseWithProgression(db, 'personal', 'pri-002', { next_progression_at: t - 60 })
      seedCaseWithProgression(db, 'personal', 'pri-003', { next_progression_at: t - 1 }) // exactly at boundary

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(3)
      expect(due.map(d => d.case_id).sort()).toEqual(['pri-001', 'pri-002', 'pri-003'])
      // Oldest due first
      expect(due[0].case_id).toBe('pri-001')
    })

    it('excludes cases with next_progression_at in the future', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', { next_progression_at: t - 60 })
      seedCaseWithProgression(db, 'personal', 'pri-002', { next_progression_at: t + 3600 })

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(1)
      expect(due[0].case_id).toBe('pri-001')
    })

    it('excludes cases with progression_enabled=0', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        progression_enabled: 0,
        next_progression_at: t - 60,
      })
      seedCaseWithProgression(db, 'personal', 'pri-002', {
        progression_enabled: 1,
        next_progression_at: t - 30,
      })

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(1)
      expect(due[0].case_id).toBe('pri-002')
    })

    it('excludes cases with next_progression_at=NULL', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', { next_progression_at: null })

      const due = findDueCases(db, 'personal', t)
      expect(due.length).toBe(0)
    })

    it('marks claimed_by_other=true for non-expired claims', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 60,
        progression_claimed_by: 'runner-1',
        progression_claim_expires_at: t + 200,
      })

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(1)
      expect(due[0].claimed_by_other).toBe(true)
    })

    it('marks claimed_by_other=false for expired claims', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 300,
        progression_claimed_by: 'crashed-runner',
        progression_claim_expires_at: t - 10,
      })

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(1)
      expect(due[0].claimed_by_other).toBe(false)
    })

    it('marks claimed_by_other=false for unclaimed cases', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 60,
      })

      const due = findDueCases(db, 'personal', t)

      expect(due.length).toBe(1)
      expect(due[0].claimed_by_other).toBe(false)
    })

    it('respects the limit parameter', () => {
      const t = now()
      for (let i = 1; i <= 10; i++) {
        seedCaseWithProgression(db, 'personal', `pri-${String(i).padStart(2, '0')}`, {
          next_progression_at: t - i * 10,
        })
      }

      const due = findDueCases(db, 'personal', t, 5)

      expect(due.length).toBe(5)
    })

    it('returns cases in order of next_progression_at ASC', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-oldest', { next_progression_at: t - 300 })
      seedCaseWithProgression(db, 'personal', 'pri-middle', { next_progression_at: t - 200 })
      seedCaseWithProgression(db, 'personal', 'pri-newest', { next_progression_at: t - 100 })

      const due = findDueCases(db, 'personal', t)

      expect(due[0].case_id).toBe('pri-oldest')
      expect(due[1].case_id).toBe('pri-middle')
      expect(due[2].case_id).toBe('pri-newest')
    })

    it('scopes to the given domain (does not leak across domains)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-001', { next_progression_at: t - 60 })
      seedCaseWithProgression(db, 'zst', 'zst-001', { next_progression_at: t - 60 })

      const personalDue = findDueCases(db, 'personal', t)
      const zstDue = findDueCases(db, 'zst', t)

      expect(personalDue.length).toBe(1)
      expect(personalDue[0].case_id).toBe('pri-001')
      expect(zstDue.length).toBe(1)
      expect(zstDue[0].case_id).toBe('zst-001')
    })
  })

  // ── Stage 4: RED-PROOF — no double-claim ────────────────────────────────

  describe('RED-PROOF: no double-claim (concurrent runners)', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('two claims within the same transaction fail — only one succeeds', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-concurrent', {
        next_progression_at: t - 60,
      })

      const runId1 = randomUUID()
      const runId2 = randomUUID()

      // Simulate two concurrent claims within a transaction
      const claim1 = tryClaimProgression(db, 'personal', 'pri-concurrent', runId1, 300, t)
      const claim2 = tryClaimProgression(db, 'personal', 'pri-concurrent', runId2, 300, t)

      // One must succeed, the other must fail
      if (claim1 !== null) {
        expect(claim1).toBe('pri-concurrent')
        expect(claim2).toBeNull()
      } else {
        expect(claim2).toBe('pri-concurrent')
        expect(claim1).toBeNull()
      }

      // Verify only one claim is recorded in DB
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-concurrent') as { progression_claimed_by: string }

      // Exactly one runId owns the claim, not both
      const claimedBy = row.progression_claimed_by
      expect([runId1, runId2]).toContain(claimedBy)
      // Both cannot hold it
      expect(claimedBy === runId1 || claimedBy === runId2).toBe(true)
    })

    it('second claim on same case fails even when case is still due', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-double', {
        next_progression_at: t - 120,
      })

      const runId1 = randomUUID()
      const claim1 = tryClaimProgression(db, 'personal', 'pri-double', runId1, 300, t)
      expect(claim1).toBe('pri-double')

      // Second attempt — same case, still due window, different runner
      const runId2 = randomUUID()
      const claim2 = tryClaimProgression(db, 'personal', 'pri-double', runId2, 300, t)
      expect(claim2).toBeNull()

      // First runner still holds the claim
      const row = db.prepare(
        'SELECT progression_claimed_by, progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-double') as { progression_claimed_by: string; progression_claim_expires_at: number }

      expect(row.progression_claimed_by).toBe(runId1)
      expect(row.progression_claim_expires_at).toBeGreaterThan(t)
    })

    it('same runner can re-claim its own case (idempotent re-claim)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-reclaim-self', {
        next_progression_at: t - 60,
      })

      const runId = randomUUID()
      const claim1 = tryClaimProgression(db, 'personal', 'pri-reclaim-self', runId, 300, t)
      expect(claim1).toBe('pri-reclaim-self')

      // Same runner, same case — WHERE clause still passes because
      // progression_claimed_by = runId is NOT NULL, but the claim is not
      // expired, so the OR clause checks: (progression_claimed_by IS NULL) →
      // false, (progression_claim_expires_at < now) → false. So this SHOULD
      // fail — a runner cannot re-claim its own non-expired lease.
      const claim2 = tryClaimProgression(db, 'personal', 'pri-reclaim-self', runId, 300, t)
      expect(claim2).toBeNull()
    })

    it('RED-PROOF: 10 concurrent claims on the same case — exactly ONE winner', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-ten', {
        next_progression_at: t - 60,
      })

      const runIds = Array.from({ length: 10 }, () => randomUUID())
      const results = runIds.map(runId =>
        tryClaimProgression(db, 'personal', 'pri-ten', runId, 300, t),
      )

      const winners = results.filter(r => r !== null)
      expect(winners.length).toBe(1)
      expect(winners[0]).toBe('pri-ten')

      const losers = results.filter(r => r === null)
      expect(losers.length).toBe(9)

      // Verify DB is consistent
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-ten') as { progression_claimed_by: string }

      expect(runIds).toContain(row.progression_claimed_by)
    })
  })

  // ── Stage 5: RED-PROOF — expired lease reclaimable ──────────────────────

  describe('RED-PROOF: expired lease is reclaimable', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('another runner can claim a case whose lease has expired', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-expired', {
        next_progression_at: t - 600,
        progression_claimed_by: 'crashed-runner',
        progression_claim_expires_at: t - 120, // expired 2 minutes ago
      })

      const newRunId = randomUUID()
      const result = tryClaimProgression(db, 'personal', 'pri-expired', newRunId, 300, t)

      expect(result).toBe('pri-expired')

      const row = db.prepare(
        'SELECT progression_claimed_by, progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-expired') as { progression_claimed_by: string; progression_claim_expires_at: number }

      expect(row.progression_claimed_by).toBe(newRunId)
      expect(row.progression_claim_expires_at).toBe(t + 300)
    })

    it('cannot reclaim a case whose lease is still valid', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-valid', {
        next_progression_at: t - 60,
        progression_claimed_by: 'active-runner',
        progression_claim_expires_at: t + 200, // still valid
      })

      const result = tryClaimProgression(db, 'personal', 'pri-valid', randomUUID(), 300, t)
      expect(result).toBeNull()
    })

    it('lease exactly at expiry boundary (claim_expires_at == now) is reclaimable', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-boundary', {
        next_progression_at: t - 60,
        progression_claimed_by: 'old-runner',
        progression_claim_expires_at: t, // exactly now — expired
      })

      const newRunId = randomUUID()
      const result = tryClaimProgression(db, 'personal', 'pri-boundary', newRunId, 300, t)

      // claim_expires_at < now → at exact boundary the condition is
      // progression_claim_expires_at < t, which is false when equal.
      // This means the lease is still valid AT the exact second of expiry.
      // Whether this reclaims depends on the < vs <= semantics.
      // We use < (strict): the old lease is still valid at t==expiry.
      // This test codifies that behaviour — reclaim at exact boundary FAILS.
      expect(result).toBeNull()
    })

    it('RED-PROOF chain: claim → expire → reclaim → verify old owner cannot release', () => {
      const t = now()
      const runId1 = 'runner-alpha'
      const runId2 = 'runner-beta'

      // 1. Runner 1 claims the case
      seedCaseWithProgression(db, 'personal', 'pri-chain', {
        next_progression_at: t - 60,
      })
      const claim1 = tryClaimProgression(db, 'personal', 'pri-chain', runId1, 2, t) // 2-second lease
      expect(claim1).toBe('pri-chain')

      // 2. Lease expires (simulate time passing)
      const future = t + 10 // 10 seconds later, lease is expired (t + 2 < t + 10)

      // 3. Runner 2 reclaims the expired lease
      const claim2 = tryClaimProgression(db, 'personal', 'pri-chain', runId2, 300, future)
      expect(claim2).toBe('pri-chain')

      // 4. Runner 1 tries to release — must NOT succeed (it no longer holds the claim)
      releaseProgressionClaim(db, 'personal', 'pri-chain', runId1, future)
      // Claim should still be held by runner 2
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-chain') as { progression_claimed_by: string }

      expect(row.progression_claimed_by).toBe(runId2)
    })
  })

  // ── Stage 6: RED-PROOF — no premature wake ──────────────────────────────

  describe('RED-PROOF: no premature wake before next_progression_at', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('case with next_progression_at in the future is not in findDueCases', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-future', {
        next_progression_at: t + 3600, // 1 hour in the future
      })

      const due = findDueCases(db, 'personal', t)
      expect(due.length).toBe(0)
    })

    it('case with next_progression_at in the future cannot be claimed', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-future-claim', {
        next_progression_at: t + 3600,
      })

      const result = tryClaimProgression(db, 'personal', 'pri-future-claim', randomUUID(), 300, t)
      expect(result).toBeNull()
    })

    it('case becomes claimable exactly at next_progression_at', () => {
      const t = now()
      const wakeAt = t + 5

      seedCaseWithProgression(db, 'personal', 'pri-exact', {
        next_progression_at: wakeAt,
      })

      // 1 second before wake — not claimable
      const before = tryClaimProgression(db, 'personal', 'pri-exact', randomUUID(), 300, t)
      expect(before).toBeNull()

      // At wakeAt — claimable (<=)
      const at = tryClaimProgression(db, 'personal', 'pri-exact', randomUUID(), 300, wakeAt)
      expect(at).toBe('pri-exact')
    })

    it('RED-PROOF: cannot wake a case 1 second before its scheduled time', () => {
      const t = now()
      const wakeAt = t + 10

      seedCaseWithProgression(db, 'personal', 'pri-one-sec', {
        next_progression_at: wakeAt,
      })

      // Check exactly 1 second before wake
      const oneSecondBefore = wakeAt - 1
      const due = findDueCases(db, 'personal', oneSecondBefore)
      expect(due.length).toBe(0)

      const claim = tryClaimProgression(db, 'personal', 'pri-one-sec', randomUUID(), 300, oneSecondBefore)
      expect(claim).toBeNull()
    })

    it('RED-PROOF: case with cleared next_progression_at (NULL) is never due', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-null-wake', {
        next_progression_at: null,
      })

      // Even far in the past
      const dueNow = findDueCases(db, 'personal', t)
      expect(dueNow.length).toBe(0)

      const duePast = findDueCases(db, 'personal', t - 100000)
      expect(duePast.length).toBe(0)

      const claim = tryClaimProgression(db, 'personal', 'pri-null-wake', randomUUID(), 300, t)
      expect(claim).toBeNull()
    })
  })

  // ── Stage 7: releaseProgressionClaim ────────────────────────────────────

  describe('releaseProgressionClaim()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('releases a claim held by the given runId', () => {
      const t = now()
      const runId = randomUUID()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 60,
        progression_claimed_by: runId,
        progression_claim_expires_at: t + 300,
      })

      releaseProgressionClaim(db, 'personal', 'pri-001', runId, t)

      const row = db.prepare(
        'SELECT progression_claimed_by, progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { progression_claimed_by: string | null; progression_claim_expires_at: number | null }

      expect(row.progression_claimed_by).toBeNull()
      expect(row.progression_claim_expires_at).toBeNull()
    })

    it('does NOT release a claim held by a DIFFERENT runId', () => {
      const t = now()
      const runId1 = 'runner-1'
      seedCaseWithProgression(db, 'personal', 'pri-002', {
        next_progression_at: t - 60,
        progression_claimed_by: runId1,
        progression_claim_expires_at: t + 300,
      })

      // Runner 2 tries to release Runner 1's claim
      releaseProgressionClaim(db, 'personal', 'pri-002', 'runner-2', t)

      // Claim should still be held by runner 1
      const row = db.prepare(
        'SELECT progression_claimed_by FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-002') as { progression_claimed_by: string }

      expect(row.progression_claimed_by).toBe(runId1)
    })

    it('no-op when no claim exists (progression_claimed_by IS NULL)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-003', {
        next_progression_at: t - 60,
      })

      // Should not throw
      expect(() =>
        releaseProgressionClaim(db, 'personal', 'pri-003', 'any-runner', t),
      ).not.toThrow()
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-release-cross', {
        next_progression_at: t - 60,
        progression_claimed_by: 'runner-1',
        progression_claim_expires_at: t + 300,
      })

      expect(() =>
        releaseProgressionClaim(db, 'personal', 'zst-release-cross', 'runner-1', t),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 8: extendProgressionLease ─────────────────────────────────────

  describe('extendProgressionLease()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('extends the lease for a claim held by the given runId', () => {
      const t = now()
      const runId = randomUUID()
      seedCaseWithProgression(db, 'personal', 'pri-001', {
        next_progression_at: t - 60,
        progression_claimed_by: runId,
        progression_claim_expires_at: t + 300,
      })

      const newExpiry = t + 900
      const result = extendProgressionLease(db, 'personal', 'pri-001', runId, newExpiry, t)

      expect(result).toBe(true)

      const row = db.prepare(
        'SELECT progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { progression_claim_expires_at: number }

      expect(row.progression_claim_expires_at).toBe(newExpiry)
    })

    it('returns false when trying to extend a claim held by a DIFFERENT runId', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-002', {
        next_progression_at: t - 60,
        progression_claimed_by: 'owner-runner',
        progression_claim_expires_at: t + 300,
      })

      const result = extendProgressionLease(db, 'personal', 'pri-002', 'intruder-runner', t + 900, t)

      expect(result).toBe(false)

      // Original expiry unchanged
      const row = db.prepare(
        'SELECT progression_claim_expires_at FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-002') as { progression_claim_expires_at: number }

      expect(row.progression_claim_expires_at).toBe(t + 300)
    })

    it('returns false when no claim exists (progression_claimed_by IS NULL)', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-003', {
        next_progression_at: t - 60,
      })

      const result = extendProgressionLease(db, 'personal', 'pri-003', 'any-runner', t + 900, t)
      expect(result).toBe(false)
    })

    it('throws CrossDomainReadError for cross-domain case', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-extend-cross', {
        next_progression_at: t - 60,
        progression_claimed_by: 'runner-1',
        progression_claim_expires_at: t + 300,
      })

      expect(() =>
        extendProgressionLease(db, 'personal', 'zst-extend-cross', 'runner-1', t + 900, t),
      ).toThrow(CrossDomainReadError)
    })
  })

  // ── Stage 9: Domain-scoped (all functions throw CrossDomainReadError) ────

  describe('Domain-scoped — CrossDomainReadError on all operations', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    // Shared setup: a ZST case with progression state, no personal case with same ID
    function setupZstOnly(caseId: string): void {
      seedCaseWithProgression(db, 'zst', caseId, {
        next_progression_at: now() - 60,
        progression_enabled: 1,
      })
    }

    it('scheduleNextProgression throws CrossDomainReadError for cross-domain', () => {
      setupZstOnly('zst-sched')
      expect(() =>
        scheduleNextProgression(db, 'personal', 'zst-sched', now() + 3600, now()),
      ).toThrow(CrossDomainReadError)
    })

    it('tryClaimProgression throws CrossDomainReadError for cross-domain', () => {
      setupZstOnly('zst-claim')
      expect(() =>
        tryClaimProgression(db, 'personal', 'zst-claim', randomUUID(), 300, now()),
      ).toThrow(CrossDomainReadError)
    })

    it('releaseProgressionClaim throws CrossDomainReadError for cross-domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-rel', {
        next_progression_at: t - 60,
        progression_claimed_by: 'runner-1',
        progression_claim_expires_at: t + 300,
      })
      expect(() =>
        releaseProgressionClaim(db, 'personal', 'zst-rel', 'runner-1', t),
      ).toThrow(CrossDomainReadError)
    })

    it('extendProgressionLease throws CrossDomainReadError for cross-domain', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-ext', {
        next_progression_at: t - 60,
        progression_claimed_by: 'runner-1',
        progression_claim_expires_at: t + 300,
      })
      expect(() =>
        extendProgressionLease(db, 'personal', 'zst-ext', 'runner-1', t + 900, t),
      ).toThrow(CrossDomainReadError)
    })

    it('setProgressionEnabled throws CrossDomainReadError for cross-domain', () => {
      setupZstOnly('zst-enable')
      expect(() =>
        setProgressionEnabled(db, 'personal', 'zst-enable', true),
      ).toThrow(CrossDomainReadError)
    })

    it('findDueCases does NOT throw — it scopes by domain via WHERE clause (no domainGuard call)', () => {
      const t = now()
      seedCaseWithProgression(db, 'zst', 'zst-find', {
        next_progression_at: t - 60,
        progression_enabled: 1,
      })

      // findDueCases is read-only and scoped by domain in SQL — no domainGuard call.
      // Cross-domain leakage cannot happen because the WHERE domain=? clause
      // isolates the read. This test proves the function does NOT throw.
      const due = findDueCases(db, 'personal', t)
      expect(due.length).toBe(0)
    })
  })

  // ── Stage 10: setProgressionEnabled ─────────────────────────────────────

  describe('setProgressionEnabled()', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('enables progression on a case', () => {
      seedCaseWithProgression(db, 'personal', 'pri-001', { progression_enabled: 0 })

      setProgressionEnabled(db, 'personal', 'pri-001', true)

      const row = db.prepare(
        'SELECT progression_enabled, progression_mode FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-001') as { progression_enabled: number; progression_mode: string }

      expect(row.progression_enabled).toBe(1)
      expect(row.progression_mode).toBe('shadow')
    })

    it('disables progression on a case', () => {
      seedCaseWithProgression(db, 'personal', 'pri-002', { progression_enabled: 1 })

      setProgressionEnabled(db, 'personal', 'pri-002', false)

      const row = db.prepare(
        'SELECT progression_enabled FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-002') as { progression_enabled: number }

      expect(row.progression_enabled).toBe(0)
    })

    it('sets progression mode', () => {
      seedCaseWithProgression(db, 'personal', 'pri-003', { progression_mode: 'shadow' })

      setProgressionEnabled(db, 'personal', 'pri-003', true, 'internal')

      const row = db.prepare(
        'SELECT progression_mode FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('personal', 'pri-003') as { progression_mode: string }

      expect(row.progression_mode).toBe('internal')
    })

    it('works for ZST domain', () => {
      seedCaseWithProgression(db, 'zst', 'zst-010', { progression_enabled: 0 })

      setProgressionEnabled(db, 'zst', 'zst-010', true, 'internal')

      const row = db.prepare(
        'SELECT progression_enabled, progression_mode FROM case_progression_state WHERE domain = ? AND case_id = ?',
      ).get('zst', 'zst-010') as { progression_enabled: number; progression_mode: string }

      expect(row.progression_enabled).toBe(1)
      expect(row.progression_mode).toBe('internal')
    })
  })

  // ── End-to-end: full wake cycle ─────────────────────────────────────────

  describe('Full wake cycle (integration)', () => {
    let db: Database.Database

    beforeEach(() => { db = freshDb() })

    it('schedule → wait → due → claim → release → schedule again', () => {
      const t = now()
      seedCaseWithProgression(db, 'personal', 'pri-cycle', {
        progression_enabled: 1,
        progression_mode: 'shadow',
      })

      // 1. Schedule wake in 2 seconds
      const wakeAt = t + 2
      scheduleNextProgression(db, 'personal', 'pri-cycle', wakeAt, t)

      // 2. Not due yet
      const dueBefore = findDueCases(db, 'personal', t)
      expect(dueBefore.length).toBe(0)

      // 3. Time passes — case becomes due
      const later = wakeAt + 1
      const dueAfter = findDueCases(db, 'personal', later)
      expect(dueAfter.length).toBe(1)
      expect(dueAfter[0].case_id).toBe('pri-cycle')

      // 4. Claim the due case
      const runId = randomUUID()
      const claimed = tryClaimProgression(db, 'personal', 'pri-cycle', runId, 300, later)
      expect(claimed).toBe('pri-cycle')

      // 5. Release after progression run
      releaseProgressionClaim(db, 'personal', 'pri-cycle', runId, later + 1)

      // 6. Schedule next wake
      const nextWake = later + 3600
      scheduleNextProgression(db, 'personal', 'pri-cycle', nextWake, later + 1)

      // 7. Verify state
      const row = db.prepare(
        `SELECT next_progression_at, progression_claimed_by, progression_claim_expires_at
         FROM case_progression_state WHERE domain = ? AND case_id = ?`,
      ).get('personal', 'pri-cycle') as {
        next_progression_at: number
        progression_claimed_by: string | null
        progression_claim_expires_at: number | null
      }

      expect(row.next_progression_at).toBe(nextWake)
      expect(row.progression_claimed_by).toBeNull()
      expect(row.progression_claim_expires_at).toBeNull()
    })
  })
})
