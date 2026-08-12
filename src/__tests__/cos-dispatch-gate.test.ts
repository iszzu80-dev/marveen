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

  // ASSERTED BY CONTENT, NOT BY COUNT (2026-08-12). This used to require
  // exactly three reasons, and §21 made it five: when the campaign approval
  // refuses, the gate now also reports why the standing delegation would not
  // have covered the send either. That is the point of the layer — "no
  // approval" and "and no delegation applies" are different facts, and a caller
  // that sees only the first goes looking for an approval when the real answer
  // is that a human has to read this letter.
  //
  // A hardcoded count tests the arithmetic of the reason list rather than the
  // property the test is named for. Naming the layers means a NEW layer that
  // forgets to report itself still fails this, while one that reports itself
  // correctly does not.
  it('reports ALL failing layers at once (fail-closed, no short-circuit)', () => {
    const db = seedGreen()
    setMode(db, 'gmail', 'READ_ONLY', 1100) // connector veto
    const d = evaluateDispatch(db, {
      ...REQ, content: 'TAJ 123 456 789 egészségügyi ügy', targetProfile: 'routine_lowcost', // sensitivity veto
      renderedPayloadHash: 'nope', // campaign veto
    })
    expect(d.allowed).toBe(false)
    const joined = d.reasons.join(' | ')
    expect(joined).toMatch(/connector "gmail" is not write-usable/)
    expect(joined).toMatch(/profile "routine_lowcost" is not allowed/)
    expect(joined).toMatch(/campaign not authorized/)
    // The rung permits here, so it must NOT appear — a test that only checks
    // for presence would pass on a gate that vetoed everything.
    expect(joined).not.toMatch(/autonómia-fokozat/)
  })

  // §21 — the send that the approval path refuses and the delegation covers.
  //
  // This is the only test in this file where `allowed` goes TRUE without an
  // approval, and it is worth stating plainly what it means: Marveen replies in
  // Istvan's name, in an existing thread, without asking him first. Everything
  // else in the gate still had to pass.
  it('a standing delegation can substitute for the approval — and only for it', () => {
    const db = seedGreen()
    const delegable = {
      ...REQ,
      renderedPayloadHash: 'nope',            // no approval matches this payload
      content: 'Megkaptam a tervezetet.',
      subject: 'Visszajelzés', body: 'Megkaptam a tervezetet.',
      outboundKind: 'REPLY' as const,
    }
    const ok = evaluateDispatch(db, delegable)
    expect(ok.allowed).toBe(true)
    expect(ok.delegationEnvelopeId).toBe('pri-email-v1')
    expect(ok.delegatedIntent).toBe('factual_reply')
    // …and it is NOT recorded as an approval, because none happened.
    expect(ok.approvalId).toBeUndefined()

    // The same letter with the connector down still cannot go: a delegation is
    // permission to skip the QUESTION, never a safety layer.
    setMode(db, 'gmail', 'READ_ONLY', 1100)
    expect(evaluateDispatch(db, delegable).allowed).toBe(false)
  })
})
