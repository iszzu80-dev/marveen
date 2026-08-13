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

describe('an escalation decision is not a last-writer-wins race', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const ready = () => {
    const db = getDb()
    createEscalation(db, {
      escalationId: 'esc-r', sourceWorkspace: 'PRODUCT_LAB', targetWorkspace: 'ZST',
      requestType: 'SIGNIFICANT_COST', summary: 'Új szintre lépés',
    }, T0)
    transitionEscalation(db, 'esc-r', 'ACKNOWLEDGED', 'marveen', T0 + 1)
    transitionEscalation(db, 'esc-r', 'IN_PROGRESS', 'marveen', T0 + 2)
    transitionEscalation(db, 'esc-r', 'RESULT_READY', 'marveen', T0 + 3)
  }

  /** A database handle that lets somebody else write between the legality check
   *  and the UPDATE — the interleaving the old check-then-act could not survive.
   *  Deterministic: the race runs exactly once, at the moment the UPDATE is
   *  prepared. */
  function withRacer(db: ReturnType<typeof getDb>, race: () => void): ReturnType<typeof getDb> {
    let fired = false
    return new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'prepare') {
          return (sql: string) => {
            if (!fired && /^\s*UPDATE zst_product_escalations/.test(sql)) { fired = true; race() }
            return (value as (s: string) => unknown).call(target, sql)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as ReturnType<typeof getDb>
  }

  it('refuses to land on a row somebody else already decided', () => {
    const db = getDb()
    ready()
    const racing = withRacer(db, () => {
      // The other decision-maker gets there first and REJECTS it.
      db.prepare(`UPDATE zst_product_escalations SET status='REJECTED', completed_at=? WHERE escalation_id='esc-r'`).run(T0 + 4)
    })
    expect(() => transitionEscalation(racing, 'esc-r', 'ACCEPTED', 'istvan', T0 + 4))
      .toThrow(/moved to REJECTED/)
    // The first decision stands. Without the compare-and-swap the ACCEPT landed
    // on top of it, and a commitment somebody had refused was live.
    expect(getEscalation(db, 'esc-r')!.status).toBe('REJECTED')
  })

  it('an ordinary transition is unaffected', () => {
    ready()
    expect(transitionEscalation(getDb(), 'esc-r', 'ACCEPTED', 'istvan', T0 + 4).status).toBe('ACCEPTED')
  })
})
