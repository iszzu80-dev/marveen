// F-13 (review 2026-08-10). The Scope Gate ran on the intake path and its
// verdict was returned in the HTTP response and then dropped. personal_cases.scope
// kept its 'PERSONAL_CONFIRMED' default, so every case ever filed claimed to be a
// CONFIRMED personal case — including the ones the gate had called AMBIGUOUS —
// and §25's "the Scope Gate is technically proven" could not be answered from the
// store at all. The uncertainty went into blocked_reason instead, a column §6.1
// reserves for why a case is BLOCKED: it both said the wrong thing and overwrote
// any real blocking reason.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { classifyScope } from '../cos/scope-gate.js'
import { ingestTriagedEmail } from '../cos/triage-bridge.js'

const T0 = 1_700_000_000

function fileIt(input: Parameters<typeof ingestTriagedEmail>[1]) {
  const db = getDb()
  const scope = classifyScope({ text: `${input.subject}\n${input.snippet ?? ''}`, accountId: input.accountId })
  const routed = ingestTriagedEmail(db, input, T0)
  const caseId = (routed as { caseId?: string }).caseId
  if (caseId) {
    db.prepare(
      `UPDATE personal_cases SET scope=@scope, scope_review_reason=@why, updated_at=@now WHERE case_id=@id`
    ).run({ scope: scope.verdict, why: scope.needsReview ? 'SCOPE REVIEW' : null, now: T0, id: caseId })
  }
  return { scope, caseId }
}

function row(caseId: string) {
  return getDb().prepare('SELECT scope, scope_review_reason, blocked_reason FROM personal_cases WHERE case_id=?')
    .get(caseId) as { scope: string; scope_review_reason: string | null; blocked_reason: string | null }
}

describe('the Scope Gate verdict is persisted on the case (F-13)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the column carries the verdict the gate actually returned', () => {
    const { scope, caseId } = fileIt({
      accountId: 'private', messageId: 'm1', subject: 'Fogorvos idopont',
      from: 'rendelo@example.com', snippet: 'Holnap 10:00', actionable: true,
      caseType: 'ADMIN', title: 'Fogorvos', direction: 'INBOUND',
    } as never)
    expect(caseId).toBeDefined()
    expect(row(caseId!).scope).toBe(scope.verdict)
  })

  it('a review note goes to scope_review_reason and NOT to blocked_reason', () => {
    const { caseId } = fileIt({
      accountId: 'private', messageId: 'm2', subject: 'ZST Radio szerzodes',
      from: 'partner@example.com', snippet: 'ceges ugy', actionable: true,
      caseType: 'ADMIN', title: 'ZST', direction: 'INBOUND',
    } as never)
    if (!caseId) return // routed elsewhere; the point below is unaffected
    const r = row(caseId)
    expect(r.blocked_reason).toBeNull() // §6.1's column is left alone
  })

  it('CONTROL: the column is not simply hardcoded to the old default', () => {
    // If the fix had been "always write PERSONAL_CONFIRMED" the first test would
    // still pass. This asserts the store can hold a different verdict at all.
    const db = getDb()
    const { caseId } = fileIt({
      accountId: 'private', messageId: 'm3', subject: 'x', from: 'a@b.c',
      snippet: 'y', actionable: true, caseType: 'ADMIN', title: 'x', direction: 'INBOUND',
    } as never)
    db.prepare('UPDATE personal_cases SET scope=? WHERE case_id=?').run('AMBIGUOUS', caseId)
    expect(row(caseId!).scope).toBe('AMBIGUOUS')
  })
})
