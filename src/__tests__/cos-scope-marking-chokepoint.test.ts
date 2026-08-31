import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'

// The gate belonged to one caller, so a second door walked around it.
//
// classifyScope runs in the Gmail intake route and does its job. The ChatGPT
// Drive baseline import (`scripts/chatgpt-cos-baseline-import.mjs`) is a second
// inbound door that never calls it, and it is how CORP-SEC-2026-001 and
// CORP-CLOUD-2026-001 -- both plainly ZST -- came to sit in personal_cases with
// scope_review_reason NULL. The monitor called them a CRITICAL for a week and
// nothing distinguished them from a case that HAD been gated.
//
// Every door goes through createCase.

const NOW = 1_800_000_000
const reasonOf = (id: string) => (getDb().prepare(
  `SELECT scope_review_reason FROM personal_cases WHERE case_id = ?`).get(id) as { scope_review_reason: string | null }).scope_review_reason

describe('corporate content is marked wherever it enters', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a ZST case created by ANY caller is flagged for scope review', () => {
    const db = getDb()
    // Exactly the shape the baseline import created, gate never consulted.
    createCase(db, {
      caseId: 'CORP-SEC-9999', title: 'ZST Radio Google-fiók – új bejelentkezés',
      caseType: 'ADMIN', sourceSystem: 'CHATGPT_DRIVE_BASELINE',
    }, NOW)
    const r = reasonOf('CORP-SEC-9999')
    expect(r).toBeTruthy()
    expect(r).toContain('SCOPE REVIEW')
    expect(r).toContain('ZST_EXCLUDED')
    // And it says WHY, naming the marker that fired.
    expect(r!.toLowerCase()).toContain('zst radio')
  })

  it('the event trail records the flag, so it can be found later', () => {
    const db = getDb()
    createCase(db, { caseId: 'CORP-X', title: 'ZST Radio szerződés', caseType: 'ADMIN' }, NOW)
    const ev = db.prepare(
      `SELECT event_type, reason FROM personal_case_events WHERE case_id = ? AND event_type = 'SCOPE_REVIEW_FLAGGED'`
    ).get('CORP-X') as { event_type: string; reason: string } | undefined
    expect(ev?.event_type).toBe('SCOPE_REVIEW_FLAGGED')
  })

  it('an ordinary personal case is NOT flagged -- the alarm must stay meaningful', () => {
    const db = getDb()
    createCase(db, { caseId: 'PRI-1', title: 'Fogorvosi időpont', caseType: 'ADMIN' }, NOW)
    expect(reasonOf('PRI-1')).toBeNull()
  })

  it('a caller that already classified the scope keeps ITS verdict', () => {
    const db = getDb()
    // The intake route's own, finer wording must not be overwritten by the
    // coarse fallback.
    createCase(db, {
      caseId: 'PRI-2', title: 'ZST Radio share transfer', caseType: 'ADMIN',
      scopeReviewReason: 'SCOPE REVIEW — a kapu sajat verdiktje',
    }, NOW)
    expect(reasonOf('PRI-2')).toBe('SCOPE REVIEW — a kapu sajat verdiktje')
  })

  it('it MARKS, it does not route: the case stays in the personal store', () => {
    const db = getDb()
    createCase(db, { caseId: 'CORP-Y', title: 'ZST Radio adásvétel', caseType: 'ADMIN' }, NOW)
    // Still here...
    expect(db.prepare(`SELECT COUNT(*) n FROM personal_cases WHERE case_id='CORP-Y'`).get()).toEqual({ n: 1 })
    // ...and NOT silently written into the company's namespace. A private
    // connector may not create ZST state on the strength of a subject line.
    expect(db.prepare(`SELECT COUNT(*) n FROM zst_cases WHERE case_id='CORP-Y'`).get()).toEqual({ n: 0 })
  })

  it('the ZST store is untouched by the fallback -- it is not the contaminated side', () => {
    const db = getDb()
    createZstCase(db, { caseId: 'ZST-1', title: 'ZST Radio szerződés', caseType: 'CONTRACT' }, NOW)
    const r = db.prepare(`SELECT scope_review_reason FROM zst_cases WHERE case_id='ZST-1'`).get() as { scope_review_reason: string | null }
    expect(r.scope_review_reason).toBeNull()
  })
})

describe('the corporate alarm distinguishes classified from undetected', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a classified case clears the CRITICAL and appears as a WARNING instead', async () => {
    const { CHECKS } = await import('../cos/reconcile.js')
    const db = getDb()
    // Marked by the gate: known, audited, waiting on a human decision.
    createCase(db, { caseId: 'CORP-MARKED', title: 'ZST Radio szerződés', caseType: 'ADMIN' }, NOW)
    const ids = CHECKS.map(c => c(db, NOW)).filter(Boolean).map(f => f!.id)
    expect(ids).not.toContain('corporate_content_in_personal_store')
    expect(ids).toContain('scope_flagged_awaiting_human_bridge')
  })

  it('an UNCLASSIFIED one still raises the CRITICAL -- that is the real hole', async () => {
    const { CHECKS } = await import('../cos/reconcile.js')
    const db = getDb()
    createCase(db, { caseId: 'CORP-RAW', title: 'ZST Radio szerződés', caseType: 'ADMIN' }, NOW)
    // Simulate the second door: created without ever meeting the gate.
    db.prepare(`UPDATE personal_cases SET scope_review_reason = NULL WHERE case_id = 'CORP-RAW'`).run()
    const ids = CHECKS.map(c => c(db, NOW)).filter(Boolean).map(f => f!.id)
    expect(ids).toContain('corporate_content_in_personal_store')
  })
})
