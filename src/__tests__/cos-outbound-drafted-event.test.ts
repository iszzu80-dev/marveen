import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { draftSend } from '../cos/send-flow.js'

// 2026-08-15. draftSend used to write NOTHING to the case timeline: the ledger
// knew a letter had been composed in Istvan's name, the case history did not.
// Reading the case gave no hint an outbound draft existed.
//
// These measure the EFFECT on personal_case_events, not that a function exists.

const NOW = 1_800_000_000

interface EventRow {
  event_type: string; actor: string; reason: string | null
  source_system: string | null; source_reference: string | null
  payload: string | null; case_version: number
}

function draft(subject = 'Re: hol tart az ugy', to = 'them@example.com') {
  return draftSend(getDb(), {
    caseId: 'c1', connectorId: 'gmail', templateId: 'followup-nudge',
    email: { to, subject, body: 'TITKOS LEVELTORZS' },
  }, NOW)
}

function drafted(): EventRow[] {
  return getDb().prepare(
    `SELECT event_type, actor, reason, source_system, source_reference, payload, case_version
       FROM personal_case_events WHERE event_type='OUTBOUND_DRAFTED' ORDER BY event_id`
  ).all() as EventRow[]
}

describe('draftSend leaves a mark on the case timeline', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Csomag visszakuldes', caseType: 'CLAIM' }, NOW)
  })

  it('appends an OUTBOUND_DRAFTED event pointing at the ledger row', () => {
    const r = draft()
    const rows = drafted()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source_reference).toBe(r.ledgerId)
    expect(rows[0]!.source_system).toBe('cos:send-flow')
  })

  it('names the subject in the reason, so the timeline reads without a join', () => {
    draft('Re: hol tart az ugy')
    expect(drafted()[0]!.reason).toContain('Re: hol tart az ugy')
  })

  it('carries recipient, campaign and payload hash, but never the body', () => {
    const r = draft('Re: targy', 'r.mark@example.com')
    const p = JSON.parse(drafted()[0]!.payload!) as Record<string, unknown>
    expect(p['recipient']).toBe('r.mark@example.com')
    expect(p['campaignId']).toBe(r.campaignId)
    expect(p['renderedPayloadHash']).toBe(r.renderedPayloadHash)
    expect(drafted()[0]!.payload).not.toContain('TITKOS LEVELTORZS')
  })

  it('binds the case version the draft was planned against', () => {
    draft()
    const v = (getDb().prepare('SELECT version FROM personal_cases WHERE case_id=?')
      .get('c1') as { version: number }).version
    expect(drafted()[0]!.case_version).toBe(v)
  })

  // The whole point of writing it here rather than behind a future mode flag.
  it('writes one event per draft, so a second follow-up is visible too', () => {
    draft('Re: elso')
    draft('Re: masodik')
    const rows = drafted()
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.reason).join(' ')).toContain('Re: masodik')
  })
})
