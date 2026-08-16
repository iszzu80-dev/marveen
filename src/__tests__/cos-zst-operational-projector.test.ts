import { describe, it, expect } from 'vitest'
import { projectZstOperationalIntake } from '../cos/zst-operational-projector.js'
import { classifyActionability } from '../cos/actionability.js'

const NOW = Math.floor(Date.UTC(2026, 7, 16, 12, 0, 0) / 1000)

describe('ZST v1.2 operational intake projection', () => {
  it('new invoice is actionable and owned by ACCOUNTANT', () => {
    const p = projectZstOperationalIntake({
      caseType: 'INVOICE_INCOMING', direction: 'INBOUND', subject: 'Invoice', body: 'Payment due 2026-08-20',
      from: 'vendor@example.com', occurredAt: NOW,
    })
    expect(p.status).toBe('NEW')
    expect(p.nextActionOwner).toBe('ACCOUNTANT')
    const a = classifyActionability({ status: p.status, nextAction: p.nextAction, nextActionOwner: p.nextActionOwner })
    expect(a.valid).toBe(true)
    expect(a.classification).toBe('ACTIONABLE')
    expect(p.temporalClaims.some(x => x.kind === 'PAYMENT_DUE')).toBe(true)
  })

  it('outbound item is WAITING_EXTERNAL with a deterministic follow-up', () => {
    const p = projectZstOperationalIntake({
      caseType: 'GENERAL_OPERATION', direction: 'OUTBOUND', subject: 'Follow up', body: 'Please reply',
      from: 'zst@example.com', to: 'vendor@example.com', occurredAt: NOW,
    })
    expect(p.status).toBe('WAITING_EXTERNAL')
    expect(p.followUpAt).toBe(NOW + 3 * 86400)
    const a = classifyActionability({
      status: p.status, nextAction: p.nextAction, nextActionOwner: p.nextActionOwner,
      waitingOn: p.waitingOn, followUpAt: p.followUpAt,
    })
    expect(a.valid).toBe(true)
    expect(a.classification).toBe('WAITING_EXTERNAL')
  })

  it('contract text creates only UNVERIFIED claims at intake layer; no execution instruction', () => {
    const p = projectZstOperationalIntake({
      caseType: 'CONTRACT', direction: 'INBOUND', subject: 'Termination', body: 'Termination deadline 2026-09-01',
      from: 'lawyer@example.com', occurredAt: NOW,
    })
    expect(p.nextActionOwner).toBe('ISTVAN')
    expect(p.temporalClaims.some(x => x.kind === 'TERMINATION_DEADLINE')).toBe(true)
    expect(p.nextAction.toLowerCase()).not.toMatch(/sign|send|pay|transfer/)
  })
})
