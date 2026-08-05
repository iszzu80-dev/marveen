import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  createCampaign, approveCampaign, recordApproval, authorizeSend,
  revokeCampaign, pauseCampaign, resumeCampaign, getCampaign,
} from '../cos/campaigns.js'

// COS campaigns + approvals — the authorization gate over the executor. Proves
// P0.4 (a template approval does NOT authorize arbitrary rendered content) and
// P0.5 (a revoke/pause bumps the version, so a stale approval stops authorizing).

const TH = 'template-hash-A'
const RH = 'rendered-hash-1'

function setupApproved(free = false) {
  const db = getDb()
  createCampaign(db, { campaignId: 'k1', caseId: 'c1', campaignType: 'QUOTE_REQUEST', templateHash: TH, allowsFreeText: free }, 1000)
  approveCampaign(db, 'k1', 1001)
  return db
}

describe('COS campaigns + approvals', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  })

  it('authorizes a send only with a matching template + rendered payload at the current version', () => {
    const db = setupApproved()
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002)
    expect(authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH })).toEqual({ authorized: true, reason: 'ok' })
  })

  it('P0.4: approving the TEMPLATE does not authorize a DIFFERENT rendered payload', () => {
    const db = setupApproved()
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002)
    const r = authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: 'rendered-hash-DIFFERENT' })
    expect(r.authorized).toBe(false)
    expect(r.reason).toMatch(/rendered payload/i)
  })

  it('a free-text campaign is never authorized for autonomous send (PREPARE only)', () => {
    const db = setupApproved(true)
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002)
    const r = authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH })
    expect(r.authorized).toBe(false)
    expect(r.reason).toMatch(/free text/i)
  })

  it('P0.5: revoke stops authorization', () => {
    const db = setupApproved()
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002)
    const v = revokeCampaign(db, 'k1', 1, 1003)
    expect(v).toBe(2)
    expect(getCampaign(db, 'k1')!.status).toBe('REVOKED')
    expect(authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH }).authorized).toBe(false)
  })

  it('P0.5 version binding: an approval granted before a pause does not authorize after resume; a fresh one does', () => {
    const db = setupApproved()
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002) // bound to v1
    pauseCampaign(db, 'k1', 1, 1003)   // v1 → v2, PAUSED
    resumeCampaign(db, 'k1', 1004)     // → APPROVED, still v2
    // the v1 approval must NOT authorize at v2
    expect(authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH }).authorized).toBe(false)
    // a fresh approval at the current version does
    recordApproval(db, { approvalId: 'a2', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1005)
    expect(authorizeSend(db, { campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH }).authorized).toBe(true)
  })

  it('revoke is optimistic-concurrency guarded (stale version throws)', () => {
    const db = setupApproved()
    expect(() => revokeCampaign(db, 'k1', 99, 1003)).toThrow(/stale|missing/i)
  })

  it('a DRAFT (un-approved) campaign never authorizes', () => {
    const db = getDb()
    createCampaign(db, { campaignId: 'k2', caseId: 'c1', campaignType: 'QUOTE_REQUEST', templateHash: TH }, 1000)
    recordApproval(db, { approvalId: 'a1', campaignId: 'k2', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH }, 1002)
    expect(authorizeSend(db, { campaignId: 'k2', templateHash: TH, renderedPayloadHash: RH }).authorized).toBe(false)
  })
})
