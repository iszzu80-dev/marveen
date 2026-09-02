import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { evaluateEvidenceFreshness, type EvidenceWatermark } from '../cos/evidence-freshness.js'

// RESTORE-AWARE FRESHNESS — the owner's negative controls, 2026-09-02.
//
// PRI-HOME-2026-004 could not be delivered for a whole morning and the reason
// was arithmetic, not evidence: the case had been restored after the August
// incident, its version reset from 223 to 2, and the freshness gate compared the
// two numbers for equality. Every progression run the question could point at
// belonged to the pre-restore lineage, so the question was permanently stale and
// eventually reported REPEATED_STALE -- loudly, which was right, but about the
// wrong thing.
//
// The owner's ruling: the CURRENT canonical state is the authority; an old
// lineage's run cannot prove the current one's freshness; and where a reliable
// globally monotonic watermark exists it beats the raw version. `event_id` is
// that watermark -- append-only, and a restore adds events rather than removing
// them.

const NOW = 1_700_000_000

function seedCase(caseId: string, version: number): void {
  const db = getDb()
  createCase(db, { caseId, title: 'T', caseType: 'ADMIN', status: 'NEW' }, NOW)
  db.prepare(`UPDATE personal_cases SET version = ? WHERE case_id = ?`).run(version, caseId)
}

function addEvent(caseId: string, at: number): number {
  const db = getDb()
  db.prepare(
    `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, created_at)
     VALUES (?, 1, 'marveen', 'INFORMATION_ADDED', ?)`).run(caseId, at)
  return (db.prepare(`SELECT MAX(event_id) n FROM personal_case_events WHERE case_id=?`)
    .get(caseId) as { n: number }).n
}

const wm = (caseId: string, caseVersion: number, seq: number): EvidenceWatermark => ({
  domain: 'personal', caseId, caseVersion, evidenceMaxEventSeq: seq, builtAt: NOW,
})

describe('restore-aware freshness', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('CONTROL 1: a restored lower version does NOT make current state stale by itself', () => {
    // The live shape: watermark says 223, the restored case says 2, and the
    // packet still covers every event. Under the old rule this was stale for
    // ever; the number was not comparable, so it must not decide.
    seedCase('C-1', 2)
    const seq = addEvent('C-1', NOW)
    const r = evaluateEvidenceFreshness(getDb(), wm('C-1', 223, seq))
    expect(r.fresh).toBe(true)
    expect(r.reasons.join(' ')).toContain('is a restore, not a move')
  })

  it('CONTROL 2: inside the current lineage, a new event after the packet is still STALE', () => {
    seedCase('C-1', 2)
    const seq = addEvent('C-1', NOW)
    addEvent('C-1', NOW + 10)                 // arrives after the packet
    const r = evaluateEvidenceFreshness(getDb(), wm('C-1', 2, seq))
    expect(r.fresh).toBe(false)
    expect(r.reasons.join(' ')).toContain('new case event after evidence watermark')
  })

  it('CONTROL 3: an OLD-lineage run still cannot certify the current state', () => {
    // Because the restore's own events land after the old packet, the event
    // watermark refuses it -- on evidence, not on a number.
    seedCase('C-1', 2)
    const oldSeq = addEvent('C-1', NOW)       // pre-restore
    addEvent('C-1', NOW + 5)                  // the restore's own event
    const r = evaluateEvidenceFreshness(getDb(), wm('C-1', 223, oldSeq))
    expect(r.fresh).toBe(false)
    expect(r.reasons.join(' ')).toContain('new case event after evidence watermark')
  })

  it('CONTROL 4: a SECOND restore does not break it either', () => {
    seedCase('C-1', 1)                        // restored again, even lower
    const seq = addEvent('C-1', NOW)
    expect(evaluateEvidenceFreshness(getDb(), wm('C-1', 223, seq)).fresh).toBe(true)
    expect(evaluateEvidenceFreshness(getDb(), wm('C-1', 2, seq)).fresh).toBe(true)
  })

  it('a FORWARD version move is unchanged: the case really did move on', () => {
    // The direction that is not a restore must keep failing exactly as before,
    // or this change would be a hole rather than a fix.
    seedCase('C-1', 7)
    const seq = addEvent('C-1', NOW)
    const r = evaluateEvidenceFreshness(getDb(), wm('C-1', 5, seq))
    expect(r.fresh).toBe(false)
    expect(r.reasons.join(' ')).toContain('case version moved 5 -> 7')
  })

  it('a case that is not there is still refused, restore note or not', () => {
    // The events table has a foreign key, so a real case cannot simply be
    // deleted out from under its history -- the branch is reached by asking
    // about a case id that does not exist, which is the same condition the
    // guard actually faces.
    const r = evaluateEvidenceFreshness(getDb(), wm('C-NEVER-EXISTED', 223, 0))
    expect(r.fresh).toBe(false)
    expect(r.reasons.join(' ')).toContain('case no longer exists')
  })

  it('the NOTE explains without excusing: it never turns a real failure fresh', () => {
    seedCase('C-1', 2)
    const seq = addEvent('C-1', NOW)
    addEvent('C-1', NOW + 10)
    const r = evaluateEvidenceFreshness(getDb(), wm('C-1', 223, seq))
    expect(r.fresh).toBe(false)                                  // restored AND moved on
    expect(r.reasons.join(' ')).toContain('is a restore, not a move')
    expect(r.reasons.join(' ')).toContain('new case event after evidence watermark')
  })
})
