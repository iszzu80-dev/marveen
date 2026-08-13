import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector, recordSuccess, recordFailure, setMode, DOWN_THRESHOLD } from '../cos/connector-health.js'
import { createCampaign, approveCampaign, recordApproval } from '../cos/campaigns.js'
import { evaluateDispatch, type DispatchRequest } from '../cos/dispatch-gate.js'
import { setLadder, pauseAll } from '../cos/autonomy-ladder.js'

// COS dispatch gate — the single choke point. Proves each of the three layers
// can independently veto a send, and that a fully-clean request is allowed.

const TH = 'tmpl-A', RH = 'rendered-1'

function seedGreen() {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
  registerConnector(db, 'gmail', 'email', 'READ_WRITE', 1000)
  recordSuccess(db, 'gmail', 1000) // OK
  createCampaign(db, { campaignId: 'k1', caseId: 'c1', campaignType: 'QUOTE_REQUEST', templateHash: TH }, 1000)
  approveCampaign(db, 'k1', 1001)
  recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH, renderedPayloadHash: RH , allowedRecipients: ['teszt@pelda.hu'], allowedChannels: ['EMAIL'] }, 1002)
  // §22: a send also needs a rung that permits it. A new type starts at PREPARE
  // and cannot send, which is why this has to be explicit in the fixture.
  setLadder(db, 'QUOTE_REQUEST', { rung: 'EXECUTE_WITH_APPROVAL' }, 1000)
  return db
}

const REQ: DispatchRequest = {
  connectorId: 'gmail', requireWrite: true,
  declaredSensitivity: 'PERSONAL', content: 'Kérek árajánlatot a peremelemre.',
  targetProfile: 'premium_reasoning', campaignId: 'k1', templateHash: TH, renderedPayloadHash: RH,
  recipient: 'teszt@pelda.hu', caseType: 'QUOTE_REQUEST' }

describe('COS dispatch gate', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('allows a fully-clean request', () => {
    seedGreen()
    const d = evaluateDispatch(getDb(), REQ)
    expect(d.allowed).toBe(true)
    expect(d.reasons).toEqual([])
    expect(d.sensitivityTier).toBe('PERSONAL')
  })

  it('#5a: recommends the sensitivity-appropriate profile (capability strategy default)', () => {
    seedGreen()
    // PERSONAL content, most-capable allowed profile
    expect(evaluateDispatch(getDb(), REQ).recommendedProfile).toBe('premium_reasoning')
    // HIGHLY_SENSITIVE content → only premium is allowed → that is the recommendation
    const hs = evaluateDispatch(getDb(), { ...REQ, content: 'a kártyaszám 4111 1111 1111 1111', targetProfile: 'routine_lowcost' })
    expect(hs.recommendedProfile).toBe('premium_reasoning') // even though the request is vetoed, it tells you what to use
    expect(hs.allowed).toBe(false)
  })

  // E13 (review 2026-08-13). evaluateDispatch never passed `channel` or
  // `usedVariables` to authorizeSend, so three envelope checks the approval
  // engine implements — channel_not_allowed, forbidden_variable,
  // variable_not_in_schema — could not fire on the personal path at all.
  // approveSend stored allowedChannels:['EMAIL'] on every approval and nothing
  // on this side ever read it; the ZST door passed the channel, the personal one
  // did not. Same asymmetry that hid AC-4 from the personal store in August.
  it('E13: the approval envelope CHANNEL is checked on the personal path', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, 900)
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', 1000)
    recordSuccess(db, 'gmail', 1000)
    createCampaign(db, { campaignId: 'k1', caseId: 'c1', campaignType: 'QUOTE_REQUEST', templateHash: TH }, 1000)
    approveCampaign(db, 'k1', 1001)
    setLadder(db, 'QUOTE_REQUEST', { rung: 'EXECUTE_WITH_APPROVAL' }, 1000)
    // Istvan approved this payload for the CHAT channel only.
    recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'istvan', templateHash: TH,
      renderedPayloadHash: RH, allowedRecipients: ['teszt@pelda.hu'], allowedChannels: ['CHAT'] }, 1002)

    const d = evaluateDispatch(db, REQ) // the gate sends EMAIL
    expect(d.allowed).toBe(false)
    expect(d.reasons.join()).toMatch(/channel EMAIL is not approved/)
  })

  it('E13: a forbidden template variable in the rendered payload vetoes the send', () => {
    const db = seedGreen()
    db.prepare(`UPDATE campaign_approvals SET forbidden_variables=? WHERE approval_id='a1'`)
      .run(JSON.stringify(['bank_account']))
    // CONTROL first: with no variables declared there is nothing to check, and the
    // gate must not start refusing hand-composed mail.
    expect(evaluateDispatch(db, REQ).allowed).toBe(true)
    const d = evaluateDispatch(db, { ...REQ, usedVariables: ['greeting', 'bank_account'] })
    expect(d.allowed).toBe(false)
    expect(d.reasons.join()).toMatch(/forbidden variable/)
  })

  it('connector layer vetoes: READ_ONLY connector blocks a write', () => {
    const db = seedGreen()
    setMode(db, 'gmail', 'READ_ONLY', 1100)
    const d = evaluateDispatch(db, REQ)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join()).toMatch(/not write-usable/i)
  })

  it('connector layer vetoes: a DOWN connector blocks', () => {
    const db = seedGreen()
    for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(db, 'gmail', 'e', 1100 + i)
    expect(evaluateDispatch(db, REQ).allowed).toBe(false)
  })

  it('sensitivity layer vetoes: highly-sensitive content to a low profile', () => {
    const db = seedGreen()
    const d = evaluateDispatch(db, { ...REQ, content: 'a kártyaszám 4111 1111 1111 1111', targetProfile: 'routine_lowcost' })
    expect(d.allowed).toBe(false)
    expect(d.sensitivityTier).toBe('HIGHLY_SENSITIVE')
    expect(d.reasons.join()).toMatch(/not allowed for sensitivity/i)
  })

  it('campaign layer vetoes: a rendered payload that was not approved', () => {
    const db = seedGreen()
    const d = evaluateDispatch(db, { ...REQ, renderedPayloadHash: 'rendered-DIFFERENT' , recipient: 'teszt@pelda.hu'})
    expect(d.allowed).toBe(false)
    expect(d.reasons.join()).toMatch(/campaign not authorized/i)
  })

  it('autonomy layer vetoes: a case type still on PREPARE cannot send (§22)', () => {
    const db = seedGreen()
    setLadder(db, 'QUOTE_REQUEST', { rung: 'PREPARE' }, 1100)
    const d = evaluateDispatch(db, REQ)
    expect(d.allowed).toBe(false)
    expect(d.reasons.join()).toMatch(/autonómia-fokozat/)
  })

  it('autonomy layer vetoes: the master switch stops a fully-clean request', () => {
    const db = seedGreen()
    pauseAll(db, true, 'teszt', 1100)
    expect(evaluateDispatch(db, REQ).allowed).toBe(false)
  })

  it('reports ALL failing layers at once (fail-closed, no short-circuit)', () => {
    const db = seedGreen()
    setMode(db, 'gmail', 'READ_ONLY', 1100) // connector veto
    const d = evaluateDispatch(db, {
      ...REQ, content: 'TAJ 123 456 789 egészségügyi ügy', targetProfile: 'routine_lowcost', // sensitivity veto
      renderedPayloadHash: 'nope', // campaign veto
    })
    expect(d.allowed).toBe(false)
    expect(d.reasons.length).toBe(3)   // connector + sensitivity + campaign; the rung permits
  })
})
