import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createEscalation, transitionEscalation, getEscalation, listOpenEscalations, isHardGated } from '../cos/zst-productlab.js'

const T0 = 1_700_000_000

describe('ZST Slice 5 Product Lab escalation gateway', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const costEscalation = () => createEscalation(getDb(), {
    escalationId: 'esc-1', sourceWorkspace: 'PRODUCT_LAB', targetWorkspace: 'ZST',
    productId: 'QQ', requestType: 'SIGNIFICANT_COST', summary: 'New SendGrid tier for QuickQuote',
    requiredDecision: 'Approve €99/mo?',
  }, T0)

  it('a cost/contract escalation to ZST is hard-gated', () => {
    const e = costEscalation()
    expect(e.hard_gate).toBe(true)
    expect(isHardGated({ targetWorkspace: 'ZST', requestType: 'CONTRACT' })).toBe(true)
    // a technical question to the Product Lab is NOT hard-gated
    expect(isHardGated({ targetWorkspace: 'PRODUCT_LAB', requestType: 'TECHNICAL_QUESTION' })).toBe(false)
  })

  it('follows the lifecycle OPEN → ACKNOWLEDGED → IN_PROGRESS → RESULT_READY → ACCEPTED', () => {
    costEscalation()
    transitionEscalation(getDb(), 'esc-1', 'ACKNOWLEDGED', 'marveen', T0 + 1)
    transitionEscalation(getDb(), 'esc-1', 'IN_PROGRESS', 'marveen', T0 + 2)
    transitionEscalation(getDb(), 'esc-1', 'RESULT_READY', 'marveen', T0 + 3)
    const done = transitionEscalation(getDb(), 'esc-1', 'ACCEPTED', 'istvan', T0 + 4)
    expect(done.status).toBe('ACCEPTED')
    expect(done.completed_at).toBe(T0 + 4)
  })

  it('a hard-gated escalation cannot be ACCEPTED by anyone but Istvan', () => {
    costEscalation()
    transitionEscalation(getDb(), 'esc-1', 'ACKNOWLEDGED', 'marveen', T0 + 1)
    transitionEscalation(getDb(), 'esc-1', 'IN_PROGRESS', 'marveen', T0 + 2)
    transitionEscalation(getDb(), 'esc-1', 'RESULT_READY', 'marveen', T0 + 3)
    expect(() => transitionEscalation(getDb(), 'esc-1', 'ACCEPTED', 'marveen', T0 + 4))
      .toThrow(/only Istvan/)
  })

  it('rejects an illegal transition', () => {
    costEscalation()
    expect(() => transitionEscalation(getDb(), 'esc-1', 'ACCEPTED', 'istvan', T0 + 1))
      .toThrow(/illegal escalation transition/)
  })

  it('lists open escalations, excluding terminal ones', () => {
    costEscalation()
    createEscalation(getDb(), { escalationId: 'esc-2', sourceWorkspace: 'ZST', targetWorkspace: 'PRODUCT_LAB', requestType: 'TECHNICAL_QUESTION', summary: 'q' }, T0)
    transitionEscalation(getDb(), 'esc-2', 'CANCELLED', 'marveen', T0 + 1)
    const open = listOpenEscalations(getDb())
    expect(open.map(e => e.escalation_id)).toEqual(['esc-1'])
  })
})
