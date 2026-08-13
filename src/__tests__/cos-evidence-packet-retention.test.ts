// §C retention for Reader evidence packets (review #4, N4-2).
//
// `packet_json` holds the facts the Reader extracted from the mail — the same
// class of personal data as an attachment, only structured. The table was born
// after the retention module was written, so the policy did not know about it
// and the packets accumulated at three per cycle with no expiry.
//
// The shape of the fix matters: the ROW survives with its §13.1 arbitration
// audit, the CONTENT goes. Keeping the record that a decision happened, and why,
// costs nothing; keeping what it was about costs the retention promise.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { purgeExpiredEvidencePackets, RETENTION } from '../cos/retention.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NOW = 1_800_000_000
const DAY = 86_400

function packet(id: string, ageDays: number): void {
  getDb().prepare(
    `INSERT INTO case_evidence_packets
       (packet_id, domain, case_id, created_at, packet_json, plan_json,
        reader_candidate, policy_result, final_decision, conflict_reason, decided_by, refusal_reason)
     VALUES (@id, 'personal', 'c1', @at, @packet, '{"steps":[]}',
        'WAIT_EXTERNAL', 'CONTINUE_AUTONOMOUSLY', 'CONTINUE_AUTONOMOUSLY', 'policy wins', 'POLICY', NULL)`,
  ).run({ id, at: NOW - ageDays * DAY, packet: '{"facts":[{"statement":"IBAN HU42..."}]}' })
}

describe('evidence packet retention', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  it('HEADLINE: expired packet CONTENT is purged, the arbitration audit is not', () => {
    packet('old', RETENTION.evidencePacketDays + 1)
    const r = purgeExpiredEvidencePackets(getDb(), NOW)
    expect(r.purged).toBe(1)

    const row = getDb().prepare(
      `SELECT packet_json, plan_json, reader_candidate, policy_result, conflict_reason, decided_by
       FROM case_evidence_packets WHERE packet_id = 'old'`,
    ).get() as Record<string, string | null>
    expect(row.packet_json).toBeNull()
    expect(row.plan_json).toBeNull()
    // The four §13.1 fields survive: what was proposed, what policy decided, why
    // they differed, and which rung decided it.
    expect(row.reader_candidate).toBe('WAIT_EXTERNAL')
    expect(row.policy_result).toBe('CONTINUE_AUTONOMOUSLY')
    expect(row.conflict_reason).toBe('policy wins')
    expect(row.decided_by).toBe('POLICY')
  })

  it('a packet inside the window is untouched', () => {
    // The counter-case: a purge that takes everything is a delete, not a policy.
    packet('fresh', RETENTION.evidencePacketDays - 1)
    const r = purgeExpiredEvidencePackets(getDb(), NOW)
    expect(r.purged).toBe(0)
    expect(r.kept).toBe(1)
    const row = getDb().prepare(`SELECT packet_json FROM case_evidence_packets WHERE packet_id='fresh'`)
      .get() as { packet_json: string | null }
    expect(row.packet_json).toContain('IBAN')
  })

  it('is idempotent — a second run purges nothing more', () => {
    packet('old', RETENTION.evidencePacketDays + 5)
    expect(purgeExpiredEvidencePackets(getDb(), NOW).purged).toBe(1)
    expect(purgeExpiredEvidencePackets(getDb(), NOW).purged).toBe(0)
  })

  it('a missing table is not an error', () => {
    initDatabase(':memory:') // no progression schema deployed
    expect(purgeExpiredEvidencePackets(getDb(), NOW)).toEqual({ purged: 0, kept: 0 })
  })

  // E17 (review 2026-08-13). The catch above absorbed EVERY error and returned a
  // clean {purged:0, kept:0}, so a corrupt store, a locked database or a disk
  // failure reported a successful retention run — and cos-maintenance.ts, which
  // fails loud on purpose, was handed a success to print. Only the error it was
  // written for (no such table, on a store without the progression schema) may
  // be absorbed.
  it('E17: a REAL failure is not laundered into a clean retention run', () => {
    const db = getDb()
    // A table that exists but cannot answer the query — the shape of a
    // half-applied migration, which is exactly the case the old catch hid.
    db.exec('DROP TABLE case_evidence_packets')
    db.exec('CREATE TABLE case_evidence_packets (packet_id TEXT PRIMARY KEY)')
    expect(() => purgeExpiredEvidencePackets(db, NOW)).toThrow(/no such column/i)
  })

  it('STANDING CHECK: the maintenance cycle actually calls it', () => {
    // The whole point of N4-2 was a policy that did not know about a table. A
    // purge function nothing runs is the same hole with more code in it.
    const src = readFileSync(resolve(process.cwd(), 'scripts/cos-maintenance.ts'), 'utf8')
    expect(src).toMatch(/purgeExpiredEvidencePackets\(db, now\)/)
    expect(src).toMatch(/evidencePackets/)
  })
})
