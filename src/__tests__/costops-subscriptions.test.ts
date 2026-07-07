import { describe, it, expect } from 'vitest'
import { validateSubscriptionsConfig, deriveLifecycle, type SubscriptionsConfig } from '../costops/subscriptions.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

describe('costops subscriptions validation', () => {
  it('accepts a valid entry and defaults status/amount_source', () => {
    const r = validateSubscriptionsConfig({ subscriptions: [{ id: 'x', name: 'X', provider: 'anthropic', source: 'anthropic' }] })
    expect(r.errors).toEqual([])
    expect(r.config.subscriptions[0].status).toBe('unknown')
    expect(r.config.subscriptions[0].amount_source).toBe('no_invoice_found')
  })

  it('drops entries with bad dates, keeps valid ones', () => {
    const r = validateSubscriptionsConfig({
      subscriptions: [
        { id: 'ok', name: 'OK', next_renewal: '2026-07-20' },
        { id: 'bad', name: 'Bad', next_renewal: 'not-a-date' },
      ],
    })
    expect(r.config.subscriptions).toHaveLength(1)
    expect(r.config.subscriptions[0].id).toBe('ok')
    expect(r.errors).toHaveLength(1)
  })

  it('rejects a negative amount', () => {
    const r = validateSubscriptionsConfig({ subscriptions: [{ id: 'neg', name: 'Neg', amount: -5 }] })
    expect(r.config.subscriptions).toHaveLength(0)
    expect(r.errors[0]).toContain('non-negative')
  })

  it('never fabricates an amount -- omitted stays omitted', () => {
    const r = validateSubscriptionsConfig({ subscriptions: [{ id: 'noamt', name: 'No Amount', amount_source: 'no_invoice_found' }] })
    expect(r.config.subscriptions[0].amount).toBeUndefined()
  })
})

describe('costops subscriptions lifecycle derivation', () => {
  function cfg(over: Partial<SubscriptionsConfig['subscriptions'][number]>[]): SubscriptionsConfig {
    return { version: 1, subscriptions: over.map(s => ({ id: 'x', name: 'X', provider: 'p', source: 's', status: 'active', amount_source: 'no_invoice_found', ...s })) }
  }

  it('canceled subscription counts down to paid_until, not past_due even after (it is expected to end)', () => {
    const c = cfg([{ id: 'claude-pro', status: 'canceled', paid_until: '2026-07-16' }])
    const lc = deriveLifecycle(c, NOW)
    expect(lc[0].days_until_next_date).toBe(1) // 2026-07-15 -> 2026-07-16
    expect(lc[0].past_due).toBe(false)
  })

  it('active subscription past its next_renewal date is past_due', () => {
    const c = cfg([{ id: 'overdue', status: 'active', next_renewal: '2026-07-01' }])
    const lc = deriveLifecycle(c, NOW)
    expect(lc[0].days_until_next_date).toBe(-14)
    expect(lc[0].past_due).toBe(true)
  })

  it('active subscription with a future next_renewal is not past_due', () => {
    const c = cfg([{ id: 'anthropic-max', status: 'active', next_renewal: '2026-07-20' }])
    const lc = deriveLifecycle(c, NOW)
    expect(lc[0].days_until_next_date).toBe(5)
    expect(lc[0].past_due).toBe(false)
  })

  it('no date at all -> days_until_next_date null, never past_due', () => {
    const c = cfg([{ id: 'chatgpt', status: 'active' }])
    const lc = deriveLifecycle(c, NOW)
    expect(lc[0].days_until_next_date).toBeNull()
    expect(lc[0].past_due).toBe(false)
  })
})
