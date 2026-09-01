import { describe, it, expect } from 'vitest'
import { commitmentsForCase } from '../cos/intelligence/commitments.js'
import {
  commitmentToAttention, selectAttention, DEFAULT_INTERRUPTION_POLICY,
} from '../cos/intelligence/attention.js'

// PHASE 2 OPERATIONAL VALIDATION -- closure evidence, and why an UNKNOWN
// fulfilment is a data-quality finding rather than a safety alarm.
//
// Measured on the live store 2026-09-01: all three personal interruptions were
// COMPLETED cases whose only defect was a thin closure record, and all three
// held a SAFETY slot ahead of genuinely overdue obligations. Owner ruling the
// same day: a closure_reason is weak but REAL evidence and may be
// INFORMATIONAL; completed_at alone is weaker; no closure record at all is the
// real data-quality gap -- and none of the three may be raised to SAFETY on its
// own.

const NOW = 1_800_000_000
const HOUR = 3600

const closedCase = (over: Record<string, unknown> = {}) => ({
  case_id: 'case-1', title: 'Buy the thing', status: 'COMPLETED', owner: 'istvan',
  due_at: NOW - 24 * HOUR, follow_up_at: null, waiting_on: null,
  next_action: 'Buy the thing', next_action_owner: 'istvan',
  completed_at: null, closure_reason: null, created_at: NOW - 100 * HOUR, updated_at: NOW - HOUR,
  ...over,
}) as Parameters<typeof commitmentsForCase>[0]

const one = (over: Record<string, unknown> = {}) =>
  commitmentsForCase(closedCase(over), [], 'personal', NOW)[0]

describe('closure evidence is measured from the record, in three tiers', () => {
  it('a written closure_reason is the strongest of the three', () => {
    const c = one({ closure_reason: 'superseded by the ZST-side case', completed_at: NOW - 2 * HOUR })
    expect(c.status).toBe('UNKNOWN')
    expect(c.closureEvidence).toBe('CLOSURE_REASON')
    // Thin but real evidence, so not the floor confidence.
    expect(c.confidence).toBe('MEDIUM')
  })

  it('a bare completed_at says WHEN and never what or by whom', () => {
    const c = one({ completed_at: NOW - 2 * HOUR })
    expect(c.closureEvidence).toBe('COMPLETED_AT_ONLY')
    expect(c.confidence).toBe('LOW')
  })

  it('no closure record at all is the genuine gap, and is named as such', () => {
    const c = one()
    expect(c.closureEvidence).toBe('NONE')
    expect(c.confidence).toBe('LOW')
    expect(c.fulfillment.why).toContain('closure evidence: NONE')
  })

  it('an empty-string closure_reason is not evidence', () => {
    expect(one({ closure_reason: '   ', completed_at: NOW - HOUR }).closureEvidence)
      .toBe('COMPLETED_AT_ONLY')
  })

  it('the tier is null when it does not apply, so "n/a" cannot read as "no evidence"', () => {
    const open = commitmentsForCase(
      closedCase({ status: 'READY', due_at: NOW + 24 * HOUR }), [], 'personal', NOW)[0]
    expect(open.status).toBe('OPEN')
    expect(open.closureEvidence).toBeNull()
  })
})

describe('an unverified completion informs; it does not interrupt', () => {
  it('NO tier is banded SAFETY -- that is the generic alarm the owner ruled out', () => {
    for (const over of [
      { closure_reason: 'done by hand', completed_at: NOW - HOUR },
      { completed_at: NOW - HOUR },
      {},
    ]) {
      const a = commitmentToAttention(one(over), NOW)
      expect(a.band).toBe('INFORMATIONAL')
      expect(a.band).not.toBe('SAFETY')
    }
  })

  it('the band still names the tier, so a reader can see WHICH gap it is', () => {
    expect(commitmentToAttention(one(), NOW).why).toContain('closure evidence: NONE')
  })

  it('risk still ORDERS the tiers -- no evidence sorts above a written reason', () => {
    const none = commitmentToAttention(one(), NOW).factors.risk
    const stamp = commitmentToAttention(one({ completed_at: NOW - HOUR }), NOW).factors.risk
    const reason = commitmentToAttention(
      one({ closure_reason: 'r', completed_at: NOW - HOUR }), NOW).factors.risk
    expect(none).toBeGreaterThan(stamp)
    expect(stamp).toBeGreaterThan(reason)
  })

  it('THE LIVE SHAPE: a real overdue obligation now outranks three thin closures', () => {
    // This is the baseline that was measured, in miniature. Before the change
    // the three unverified completions took every interrupt slot and the
    // obligation waited in quiet -- an emergency about paperwork ahead of a
    // promise that is actually late.
    const thin = [0, 1, 2].map(i =>
      commitmentToAttention(one({ case_id: `closed-${i}`, completed_at: NOW - HOUR }), NOW))
    const overdue = commitmentToAttention(
      commitmentsForCase(
        closedCase({ case_id: 'live-1', status: 'READY', due_at: NOW - 20 * 86_400, completed_at: null }),
        [], 'personal', NOW)[0], NOW)
    const sel = selectAttention([...thin, overdue], [], [], NOW,
      { ...DEFAULT_INTERRUPTION_POLICY, maxInterruptions: 3 })
    expect(sel.interrupt.map(i => i.element.caseId)).toContain('live-1')
    expect(sel.interrupt.every(i => i.band !== 'SAFETY')).toBe(true)
  })
})
