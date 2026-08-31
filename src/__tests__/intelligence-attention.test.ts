import { describe, it, expect } from 'vitest'
import {
  compareAttention, explainOrder, selectAttention, commitmentToAttention, decisionToAttention,
  DEFAULT_INTERRUPTION_POLICY, type AttentionItem, type AttentionBand,
} from '../cos/intelligence/attention.js'
import { decisionsForCase } from '../cos/intelligence/decisions.js'
import { commitmentsForCase } from '../cos/intelligence/commitments.js'

const NOW = 1_800_000_000
const HOUR = 3600, DAY = 86_400

const item = (
  id: string, band: AttentionBand, f: Partial<AttentionItem['factors']> = {},
): AttentionItem => ({
  element: {
    id, kind: 'FACT', caseId: id, namespace: 'personal', statement: id,
    provenance: [{ source: 'CASE', ref: id, observedAt: NOW }],
    confidence: 'HIGH', recencySeconds: 0, contradiction: { state: 'NONE' },
  },
  band,
  factors: { risk: 0, urgency: 0, staleness: 0, blockedness: 0, unresolvedContradiction: 0, ...f },
  why: id,
})

describe('the priority is deterministic and in the owner\'s order', () => {
  it('risk outranks urgency, urgency outranks staleness, and so on down the list', () => {
    const pairs: Array<[keyof AttentionItem['factors'], keyof AttentionItem['factors']]> = [
      ['risk', 'urgency'], ['urgency', 'staleness'],
      ['staleness', 'blockedness'], ['blockedness', 'unresolvedContradiction'],
    ]
    for (const [higher, lower] of pairs) {
      const a = item('a', 'OBLIGATION', { [higher]: 0.1 })
      const b = item('b', 'OBLIGATION', { [lower]: 1 })
      expect(compareAttention(a, b)).toBeLessThan(0)
      expect(explainOrder(a, b)).toContain(higher)
    }
  })

  it('it is a lexicographic walk, not a weighted sum -- a tiny lead on a higher factor wins', () => {
    // A sum with coefficients would let four maxed lower factors beat a 0.01
    // lead on risk, and nobody could say which factor decided.
    const a = item('a', 'OBLIGATION', { risk: 0.01 })
    const b = item('b', 'OBLIGATION', { urgency: 1, staleness: 1, blockedness: 1, unresolvedContradiction: 1 })
    expect(compareAttention(a, b)).toBeLessThan(0)
    expect(explainOrder(a, b)).toBe('risk: 0.010 vs 0.000')
  })

  it('the sort is TOTAL -- identical items order by id, so a redeploy cannot reshuffle them', () => {
    const a = item('aaa', 'OBLIGATION'), b = item('bbb', 'OBLIGATION')
    expect(compareAttention(a, b)).toBeLessThan(0)
    expect(explainOrder(a, b)).toContain('ordered by id')
    const twice = [b, a].sort(compareAttention).map((x) => x.element.id)
    expect(twice).toEqual(['aaa', 'bbb'])
  })
})

describe('opportunities cannot crowd anything out', () => {
  it('a maxed-out opportunity still ranks below an empty obligation', () => {
    const opp = item('opp', 'OPPORTUNITY', {
      risk: 1, urgency: 1, staleness: 1, blockedness: 1, unresolvedContradiction: 1,
    })
    const dull = item('dull', 'OBLIGATION')
    expect(compareAttention(dull, opp)).toBeLessThan(0)
    expect(explainOrder(dull, opp)).toContain('band')
  })

  it('and it NEVER interrupts, however many slots are free', () => {
    const r = selectAttention([], [item('opp', 'OPPORTUNITY', { risk: 1 })], [], NOW)
    expect(r.interrupt).toEqual([])
    expect(r.quiet.map((i) => i.element.id)).toEqual(['opp'])
  })

  it('an opportunity cannot displace an obligation from the interrupt budget', () => {
    const obligations = [item('o1', 'OBLIGATION', { risk: 0.5 }), item('o2', 'OBLIGATION', { risk: 0.4 })]
    const opps = [item('p1', 'OPPORTUNITY', { risk: 1 })]
    const r = selectAttention(obligations, opps, [], NOW, { maxInterruptions: 2, quietSeconds: HOUR })
    expect(r.interrupt.map((i) => i.element.id)).toEqual(['o1', 'o2'])
    expect(r.quiet.map((i) => i.element.id)).toEqual(['p1'])
  })

  it('the band is FORCED on opportunities -- a caller cannot smuggle one in as an obligation', () => {
    const smuggled = item('sneak', 'SAFETY', { risk: 1 })
    const r = selectAttention([], [smuggled], [], NOW)
    expect(r.interrupt).toEqual([])
    expect(r.quiet[0].band).toBe('OPPORTUNITY')
  })
})

describe('not every change is an interruption', () => {
  it('DEDUPE: the same element id twice is one item', () => {
    const r = selectAttention([item('x', 'OBLIGATION'), item('x', 'OBLIGATION')], [], [], NOW)
    expect(r.interrupt).toHaveLength(1)
  })

  it('ANTI-SPAM: an item whose BAND has not changed stays quiet inside the window', () => {
    const seen = [{ id: 'x', band: 'OBLIGATION' as const, at: NOW - HOUR }]
    const r = selectAttention([item('x', 'OBLIGATION')], [], seen, NOW)
    expect(r.interrupt).toEqual([])
    expect(r.suppressed[0].reason).toContain('does not change the band')
  })

  it('but a BAND CHANGE speaks immediately, window or not', () => {
    // The distinction that matters: an obligation becoming a safety item is news.
    const seen = [{ id: 'x', band: 'OBLIGATION' as const, at: NOW - 60 }]
    const r = selectAttention([item('x', 'SAFETY')], [], seen, NOW)
    expect(r.interrupt.map((i) => i.element.id)).toEqual(['x'])
    expect(r.suppressed).toEqual([])
  })

  it('and after the quiet window it may speak again', () => {
    const seen = [{ id: 'x', band: 'OBLIGATION' as const, at: NOW - 7 * HOUR }]
    const r = selectAttention([item('x', 'OBLIGATION')], [], seen, NOW, DEFAULT_INTERRUPTION_POLICY)
    expect(r.interrupt).toHaveLength(1)
  })

  it('the interruption budget is a CEILING -- the rest stay available, not dropped', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((i) => item(i, 'OBLIGATION', { risk: 1 }))
    const r = selectAttention(many, [], [], NOW, { maxInterruptions: 2, quietSeconds: HOUR })
    expect(r.interrupt).toHaveLength(2)
    expect(r.quiet).toHaveLength(3)
    expect(r.interrupt.length + r.quiet.length).toBe(5)   // nothing is lost
  })

  it('the seen-record carries only id/band/time -- never the item content', () => {
    const seen = [{ id: 'x', band: 'OBLIGATION' as const, at: NOW }]
    expect(Object.keys(seen[0]).sort()).toEqual(['at', 'band', 'id'])
  })
})

describe('the surfaces feed attention with the right band', () => {
  const row = {
    case_id: 'c1', title: 't', status: 'COMPLETED', owner: 'istvan',
    due_at: null, follow_up_at: null, waiting_on: null, next_action: 'do it',
    next_action_owner: 'istvan', completed_at: NOW, closure_reason: null,
    created_at: NOW - DAY, updated_at: NOW - HOUR,
  }

  it('an UNPROVEN completion is a SAFETY item, not an ordinary obligation', () => {
    const c = commitmentsForCase(row as never, [], 'personal', NOW)[0]
    const a = commitmentToAttention(c, NOW)
    expect(c.status).toBe('UNKNOWN')
    expect(a.band).toBe('SAFETY')
    expect(a.factors.risk).toBeGreaterThan(0.5)
    expect(a.why).toContain('nothing evidences it')
  })

  it('an overdue commitment maxes urgency', () => {
    const c = commitmentsForCase({ ...row, status: 'READY', completed_at: null, due_at: NOW - DAY } as never, [], 'personal', NOW)[0]
    expect(commitmentToAttention(c, NOW).factors.urgency).toBe(1)
  })

  it('a blocked case becomes a BLOCKING decision with blockedness 1', () => {
    const d = decisionsForCase({ ...row, status: 'BLOCKED', blocked_reason: 'waiting on legal' } as never, 'personal', NOW)[0]
    const a = decisionToAttention(d, NOW)
    expect(d.axis).toBe('ENGINE_EXECUTION_PERMISSION')
    expect(a.band).toBe('BLOCKING')
    expect(a.factors.blockedness).toBe(1)
  })

  it('a SAFETY commitment outranks a BLOCKING decision', () => {
    const c = commitmentToAttention(commitmentsForCase(row as never, [], 'personal', NOW)[0], NOW)
    const d = decisionToAttention(
      decisionsForCase({ ...row, status: 'BLOCKED', blocked_reason: 'x' } as never, 'personal', NOW)[0], NOW)
    expect(compareAttention(c, d)).toBeLessThan(0)
  })
})
