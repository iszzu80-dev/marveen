import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { ownerQuestionCapacity, MAX_OUTSTANDING_QUESTIONS } from '../cos/owner-question.js'
import { buildPlannedDigest } from '../cos/outbound-alert.js'

/**
 * Acceptance criterion 9 of the 2026-08-15 card: a SERVICE_QUOTE question must
 * be deliverable — or its held state visible — even when the channel is FULL.
 *
 * Istvan's decision was that no kind gets an exemption from the ceiling. The
 * ceiling is right: past a handful, one more question does not get answered
 * faster, it gets the channel muted. So the requirement is VISIBILITY, and the
 * measured state on the day the card was written was the opposite —
 *
 *   five questions open, the oldest four days old
 *   nineteen cases wanting to ask and unable to
 *   the only trace: heldBacklogFull, a counter in cycle telemetry
 *
 * A measurement that never reaches the person it concerns is not knowing.
 */

const NOW = 1_000_000

function openQuestion(caseId: string, text: string, askedAt: number): void {
  const db = getDb()
  createCase(db, { caseId, title: caseId, caseType: 'ADMIN' }, NOW)
  db.prepare(
    `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at, channel)
     VALUES (?, 'personal', ?, ?, ?, 'telegram:cos')`,
  ).run(caseId, `h-${caseId}`, text, askedAt)
}

describe('the question channel says when it is full', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('reports capacity from the live rows, not from a re-typed number', () => {
    for (let i = 0; i < MAX_OUTSTANDING_QUESTIONS; i++) {
      openQuestion(`C${i}`, `❓ kerdes ${i}`, NOW + i)
    }
    const cap = ownerQuestionCapacity(getDb())
    expect(cap.open).toBe(MAX_OUTSTANDING_QUESTIONS)
    expect(cap.full).toBe(true)
    // Oldest first: answering the one that has waited longest is the natural move.
    expect(cap.questions[0]!.caseId).toBe('C0')
  })

  it('the daily digest NAMES what is blocking the channel', () => {
    // The whole criterion. Not a count — names, because answering any ONE of
    // them frees the next slot, and a number does not tell him which.
    for (let i = 0; i < MAX_OUTSTANDING_QUESTIONS; i++) {
      openQuestion(`PRI-BLOCK-${i}`, `❓ NAV adozoi rendelkezes ${i}`, NOW + i)
    }
    const text = buildPlannedDigest(getDb(), NOW + 1000).text
    expect(text).toContain('A KERDES-CSATORNA TELE VAN (5/5)')
    expect(text).toContain('UJ kerdes nem tud kimenni')
    expect(text).toContain('PRI-BLOCK-0')
    expect(text).toContain('NAV adozoi rendelkezes')
  })

  it('says it in the ZERO case too — that is when it is easiest to miss', () => {
    // The planned queue can be empty while the question channel is jammed. If
    // the line only appeared alongside drafts, the jam would be invisible on
    // exactly the quiet days.
    for (let i = 0; i < MAX_OUTSTANDING_QUESTIONS; i++) openQuestion(`Z${i}`, `❓ z${i}`, NOW + i)
    const text = buildPlannedDigest(getDb(), NOW + 1000).text
    expect(text).toContain('0 sor')
    expect(text).toContain('A KERDES-CSATORNA TELE VAN')
  })

  it('stays QUIET when the channel is not full — positive control', () => {
    // A line that always appears is a line nobody reads. Below the ceiling
    // nothing is held, so there is nothing to report.
    openQuestion('ONE', '❓ egyetlen kerdes', NOW)
    const cap = ownerQuestionCapacity(getDb())
    expect(cap.full).toBe(false)
    expect(buildPlannedDigest(getDb(), NOW + 1000).text).not.toContain('TELE VAN')
  })

  it('answering one frees a slot, and the digest goes quiet again', () => {
    for (let i = 0; i < MAX_OUTSTANDING_QUESTIONS; i++) openQuestion(`A${i}`, `❓ a${i}`, NOW + i)
    expect(buildPlannedDigest(getDb(), NOW + 1000).text).toContain('TELE VAN')

    getDb().prepare('UPDATE cos_owner_questions SET answered_at=? WHERE case_id=?').run(NOW + 500, 'A0')

    expect(ownerQuestionCapacity(getDb()).full).toBe(false)
    expect(buildPlannedDigest(getDb(), NOW + 1000).text).not.toContain('TELE VAN')
  })
})
