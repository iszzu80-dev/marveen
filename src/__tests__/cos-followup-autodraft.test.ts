import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  followUpEligibility, draftFollowUp, sweepFollowUpCandidates,
  OVERDUE_GRACE_DAYS, MAX_AUTO_FOLLOWUPS,
} from '../cos/followup-autodraft.js'

// Drafting a follow-up unasked — owner option C, 2026-08-10.
//
// C is defined by what it refuses: only an EXISTING conversation, only when the
// ball is with the other side, only after the deadline. So the tests are almost
// all refusals, and the most important one is the first approach to a new
// party, which the system must never compose on its own.
//
// The second theme is volume. The real risk of unprompted drafting is not a bad
// letter — a bad letter is visible. It is an approval box that fills up until
// clicking yes stops being a decision.

const NOW = 1_800_000_000
const DAY = 86400

function mk(over: Record<string, unknown> = {}) {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'Nyílászáró beállítás', caseType: 'HOME_REPAIR' }, NOW - 30 * DAY)
  db.prepare(
    `UPDATE personal_cases SET status=@status, waiting_on=@waiting_on, next_action_owner=@owner,
       follow_up_at=@fu, gmail_thread_ids=@thread WHERE case_id='c1'`
  ).run({
    status: 'WAITING_EXTERNAL', waiting_on: 'valasz tole: volita@pelda.hu',
    owner: 'Volita', fu: NOW - (OVERDUE_GRACE_DAYS + 5) * DAY, thread: '["t1"]',
    ...over,
  })
  return db
}

describe('follow-up auto-draft (option C)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a running conversation past its deadline is eligible', () => {
    const db = mk()
    const e = followUpEligibility(db, 'c1', NOW)
    expect(e.eligible).toBe(true)
    expect(e.code).toBe('ok')
  })

  describe('what C refuses', () => {
    it('NO prior conversation — the defining restriction', () => {
      // A first approach to somebody new is never composed unprompted. This is
      // the line between option C and option B.
      const db = mk({ thread: null })
      const e = followUpEligibility(db, 'c1', NOW)
      expect(e.eligible).toBe(false)
      expect(e.code).toBe('no_prior_conversation')
      expect(e.reason).toMatch(/első megkeresést/)
    })

    it('the ball is with Istvan — nudging them would be embarrassing', () => {
      const db = mk({ owner: 'István' })
      expect(followUpEligibility(db, 'c1', NOW).code).toBe('ball_not_with_them')
    })

    it('the deadline has not passed yet', () => {
      const db = mk({ fu: NOW - 1 * DAY })   // inside the grace period
      expect(followUpEligibility(db, 'c1', NOW).code).toBe('not_overdue')
    })

    it('no follow-up date at all is not an invitation to write', () => {
      const db = mk({ fu: null })
      expect(followUpEligibility(db, 'c1', NOW).code).toBe('not_overdue')
    })

    it('the case is not waiting on anyone', () => {
      const db = mk({ status: 'READY' })
      expect(followUpEligibility(db, 'c1', NOW).code).toBe('case_not_waiting')
    })

    it('a draft is already waiting for approval — never queue a second', () => {
      const db = mk()
      db.prepare(
        `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
           internal_idempotency_key, status, created_at, updated_at)
         VALUES ('l1','c1','EMAIL_SEND',1,'k1','PLANNED',?,?)`
      ).run(NOW, NOW)
      expect(followUpEligibility(db, 'c1', NOW).code).toBe('already_drafted')
    })

    it('stops after two automatic nudges — a third letter is talking to itself', () => {
      const db = mk()
      for (let i = 0; i < MAX_AUTO_FOLLOWUPS; i++) {
        db.prepare(
          `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
             internal_idempotency_key, status, outbound_kind, created_at, updated_at)
           VALUES (?,'c1','EMAIL_SEND',?,?,'VERIFIED','FOLLOW_UP',?,?)`
        ).run(`l${i}`, i + 10, `k${i}`, NOW, NOW)
      }
      const e = followUpEligibility(db, 'c1', NOW)
      expect(e.code).toBe('too_many_followups')
      expect(e.reason).toMatch(/nem egy újabb levél/)
    })
  })

  describe('the draft itself', () => {
    it('is a typed template, not generated prose', () => {
      const d = draftFollowUp({
        caseId: 'c1', title: 'Nyílászáró beállítás', recipient: 'volita@pelda.hu',
        threadId: 't1', waitingSinceDays: 21, lastSubject: 'Nyílászáró beállítás',
      })
      expect(d.body).toContain('Nyílászáró beállítás')
      expect(d.body).toContain('21 nap')
      expect(d.body).toContain('Szabó István')
      // no invented facts about the job, no promises, no numbers we do not have
      expect(d.body).not.toMatch(/\d+\s*(Ft|EUR|HUF)/)
    })

    it('keeps the thread by replying rather than starting a new subject', () => {
      const d = draftFollowUp({
        caseId: 'c1', title: 'x', recipient: 'a@b.hu', threadId: 't1',
        waitingSinceDays: 3, lastSubject: 'Ajánlatkérés',
      })
      expect(d.subject).toBe('Re: Ajánlatkérés')
      const again = draftFollowUp({
        caseId: 'c1', title: 'x', recipient: 'a@b.hu', threadId: 't1',
        waitingSinceDays: 3, lastSubject: 'Re: Ajánlatkérés',
      })
      expect(again.subject).toBe('Re: Ajánlatkérés')   // not "Re: Re:"
    })
  })

  describe('the sweep', () => {
    it('reports what it SKIPPED, with reasons', () => {
      // A sweep that lists only what it did is indistinguishable from one that
      // looked at nothing.
      const db = mk({ thread: null })
      const r = sweepFollowUpCandidates(db, NOW)
      expect(r.eligible).toHaveLength(0)
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0].code).toBe('no_prior_conversation')
    })

    it('refuses a case whose recipient would have to be guessed', () => {
      const db = mk({ waiting_on: 'valamire varunk' })   // no address in it
      const r = sweepFollowUpCandidates(db, NOW)
      expect(r.eligible).toHaveLength(0)
      expect(r.skipped[0].reason).toMatch(/címzett/)
    })

    it('picks up the address from the case, and counts the days', () => {
      const db = mk()
      const r = sweepFollowUpCandidates(db, NOW)
      expect(r.eligible).toHaveLength(1)
      expect(r.eligible[0].recipient).toBe('volita@pelda.hu')
      expect(r.eligible[0].waitingSinceDays).toBeGreaterThanOrEqual(OVERDUE_GRACE_DAYS)
    })
  })
})
