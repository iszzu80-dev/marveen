import { describe, it, expect } from 'vitest'
import {
  caseAttentionFor, caseAttentionToAttention, senderOf, isAuthority,
  type CaseAttentionRow,
} from '../cos/intelligence/case-attention.js'

// PHASE 2 -- attention is not commitment. Owner ruling 2026-09-01: a case may be
// high-priority attention with no commitment behind it, and the priority must
// come from the case's own evidence, never from the engine having written a
// next_action on it.
//
// The concrete trigger: the obligation gate correctly removed 17 engine
// templates from the ZST commitment surface, and a NAV enforcement notice was
// one of the cases behind them. Removing the wrong reason must not remove the
// case.

const NOW = 1_800_000_000
const DAY = 86_400

const row = (over: Partial<CaseAttentionRow> = {}): CaseAttentionRow => ({
  case_id: 'z1', title: 'NAV vegrehajtas irat a Cegkapun', status: 'NEW',
  description: 'From: ertesites@tarhely.gov.hu', due_at: null, waiting_on: null,
  related_document_ids: null, created_at: NOW - 7 * DAY, updated_at: NOW - 7 * DAY,
  ...over,
})

describe('the sender is read from the record, and authority is defined not guessed', () => {
  it('pulls the address out of the intake description', () => {
    expect(senderOf('From: ertesites@tarhely.gov.hu')).toBe('ertesites@tarhely.gov.hu')
    expect(senderOf(null)).toBeNull()
    expect(senderOf('no address here')).toBeNull()
  })

  it('a subdomain of an authority is an authority; a lookalike is not', () => {
    expect(isAuthority('x@tarhely.gov.hu')).toBe(true)
    expect(isAuthority('x@nav.gov.hu')).toBe(true)
    expect(isAuthority('x@gov.hu')).toBe(true)
    expect(isAuthority('x@notgov.hu')).toBe(false)
    expect(isAuthority('x@gov.hu.evil.com')).toBe(false)   // suffix, not domain
    expect(isAuthority(null)).toBe(false)
  })
})

describe('THE NAV CASE -- surfaced on its own evidence, with the right reason', () => {
  const a = () => caseAttentionFor(row(), 'zst', NOW)!

  it('an authority notice with no document attached is attention on its own', () => {
    expect(a()).not.toBeNull()
    expect(a().reason).toBe('AUTHORITATIVE_NOTICE_UNREAD')
  })

  it('it reports the content as UNKNOWN -- never collected, never fulfilled', () => {
    expect(a().contentUnknown).toBe(true)
    expect(a().statement).toContain('no evidence it was collected')
  })

  it('no deadline is invented for it', () => {
    // The notice states no date, so the item states none either.
    expect(caseAttentionToAttention(a(), NOW).factors.urgency).toBe(0)
  })

  it('it is HIGH/P0 -- and this is not the generic UNKNOWN alarm', () => {
    // A named authority, a named document, an unread state. The band the owner
    // ruled out was "UNKNOWN therefore unsafe" with nothing named in it.
    expect(caseAttentionToAttention(a(), NOW).band).toBe('SAFETY')
    expect(caseAttentionToAttention(a(), NOW).factors.risk).toBeGreaterThan(0.9)
  })

  it('once the document IS attached, the reason falls away', () => {
    const withDoc = caseAttentionFor(row({ related_document_ids: '["doc-1"]' }), 'zst', NOW)
    expect(withDoc?.reason).not.toBe('AUTHORITATIVE_NOTICE_UNREAD')
  })

  it('an empty document array is not an attachment', () => {
    expect(caseAttentionFor(row({ related_document_ids: '[]' }), 'zst', NOW)!.reason)
      .toBe('AUTHORITATIVE_NOTICE_UNREAD')
  })
})

describe('the other reasons, each naming something in the record', () => {
  const plain = { description: 'From: someone@example.com' }

  it('owner-only states are USER_ACTION_REQUIRED', () => {
    for (const status of ['AWAITING_SELECTION', 'AWAITING_APPROVAL', 'INFO_REQUIRED']) {
      expect(caseAttentionFor(row({ ...plain, status }), 'zst', NOW)!.reason).toBe('USER_ACTION_REQUIRED')
    }
  })

  it('a passed deadline names the DEADLINE, not how long ago', () => {
    // REWRITTEN 2026-09-04 on an owner ruling that overturned what this asserted,
    // and declared rather than quietly changed. It required the statement to
    // contain "3 days ago" -- a rendered age, which grows every night, so the
    // fingerprint drifted and an unchanged overdue case announced itself as
    // CHANGED daily. Standing invariant now: "relative time is presentation, not
    // change evidence"; canonical evidence is the absolute date, and the age is
    // computed at render time from it.
    //
    // The urgency factor still reads the clock, and should: urgency is a
    // ranking input recomputed every pass, not part of the item's identity.
    const a = caseAttentionFor(row({ ...plain, status: 'READY', due_at: NOW - 3 * DAY }), 'zst', NOW)!
    expect(a.reason).toBe('EXPLICIT_DEADLINE_PASSED')
    expect(a.statement).toContain('passed on')
    expect(a.statement, 'no rendered age may appear in the statement').not.toMatch(/\d+ days ago/)
    expect(caseAttentionToAttention(a, NOW).factors.urgency).toBe(1)
  })

  it('waiting on a named party is BLOCKING, not an obligation', () => {
    const a = caseAttentionFor(row({ ...plain, status: 'READY', waiting_on: 'the accountant' }), 'zst', NOW)!
    expect(a.reason).toBe('BLOCKED_EXTERNAL_DEPENDENCY')
    expect(a.statement).toContain('the accountant')
    expect(caseAttentionToAttention(a, NOW).band).toBe('BLOCKING')
  })

  it('long-untouched is the weakest reason, and only INFORMATIONAL', () => {
    const a = caseAttentionFor(row({ ...plain, status: 'READY', updated_at: NOW - 40 * DAY }), 'zst', NOW)!
    expect(a.reason).toBe('STALE_UNRESOLVED')
    expect(a.confidence).toBe('MEDIUM')
    expect(caseAttentionToAttention(a, NOW).band).toBe('INFORMATIONAL')
  })

  it('a fresh, unblocked, undated, non-owner case earns no attention at all', () => {
    expect(caseAttentionFor(row({ ...plain, status: 'READY', updated_at: NOW - DAY }), 'zst', NOW)).toBeNull()
  })

  it('a closed case earns none either, whatever else is true of it', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'ARCHIVED']) {
      expect(caseAttentionFor(row({ status, due_at: NOW - 90 * DAY }), 'zst', NOW)).toBeNull()
    }
  })

  it('the strongest true reason wins, and the reader gets one reason, never a blend', () => {
    // authority + owner-must-act + passed deadline + blocked, all at once
    const a = caseAttentionFor(row({
      status: 'AWAITING_SELECTION', due_at: NOW - DAY, waiting_on: 'someone',
    }), 'zst', NOW)!
    expect(a.reason).toBe('AUTHORITATIVE_NOTICE_UNREAD')
  })
})
