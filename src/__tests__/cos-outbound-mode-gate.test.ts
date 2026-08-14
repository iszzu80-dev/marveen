import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { draftSend, approveSend } from '../cos/send-flow.js'
import {
  mayCompose, mayApprove, progressionModeOf, OutboundModeRefusal,
  type ProgressionMode, type OutboundOrigin, type ApprovalInitiator,
} from '../cos/outbound-mode-gate.js'

// Card fa36dc4b. progression_mode had five values and NO production code branched
// on any of them: the real switch was the progression_enabled boolean. The mode
// LOOKED like the safety switch without being one.
//
// Owner decision (Istvan, 2026-08-14 22:54): automatic approval is possible in
// principle, so build the fifth mode. external_shadow = may compose, the approval
// may never run by itself. live = the approval may run too.
//
// These measure the EFFECT — a refusal that stops a draft or an approval — not
// that a mode column exists. The old tests failed exactly by checking existence.

const NOW = 1_800_000_000
const EMAIL = { to: 'them@example.com', subject: 'Re: ugy', body: 'torzs' }

function setMode(caseId: string, mode: ProgressionMode | null, domain = 'personal') {
  const db = getDb()
  db.prepare('DELETE FROM case_progression_state WHERE domain=? AND case_id=?').run(domain, caseId)
  if (mode === null) return
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
       case_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
  ).run(domain, caseId, 1, mode, 1, NOW, NOW)
}

function draft(origin: OutboundOrigin, caseId = 'c1') {
  return draftSend(getDb(), {
    caseId, connectorId: 'gmail', templateId: 'followup-nudge', email: EMAIL, origin,
  }, NOW)
}

describe('progression_mode actually gates the outbound path', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'CLAIM' }, NOW)
  })

  describe('composing, judged by the mode only for the progression pipeline', () => {
    it.each<[ProgressionMode, boolean]>([
      ['off', false], ['shadow', false], ['internal', false],
      ['external_shadow', true], ['live', true],
    ])('mode %s -> pipeline may compose: %s', (mode, allowed) => {
      setMode('c1', mode)
      expect(mayCompose(getDb(), 'personal', 'c1', 'progression').allowed).toBe(allowed)
    })

    it('an unclassified case is NOT permission for the pipeline', () => {
      setMode('c1', null)
      const d = mayCompose(getDb(), 'personal', 'c1', 'progression')
      expect(d.allowed).toBe(false)
      expect(d.code).toBe('mode_unknown')
      expect(d.mode).toBeNull()
    })

    it('shadow and internal refuse with a code that says which mode did it', () => {
      setMode('c1', 'shadow')
      const d = mayCompose(getDb(), 'personal', 'c1', 'progression')
      expect(d.code).toBe('mode_forbids_compose')
      expect(d.mode).toBe('shadow')
      expect(d.reason).toContain('shadow')
    })

    // THE REGRESSION THIS DESIGN EXISTS TO AVOID. Measured on the live store:
    // all 115 progression rows are `internal`, including the case whose real
    // letter is waiting in the ledger. A gate that read "internal => no compose"
    // and sat unconditionally inside draftSend would have switched off the only
    // outbound behaviour the system has, and looked like a safety improvement.
    it('does NOT block the legacy follow-up sweep, even on internal', () => {
      setMode('c1', 'internal')
      const d = mayCompose(getDb(), 'personal', 'c1', 'followup-sweep')
      expect(d.allowed).toBe(true)
      expect(d.code).toBe('not_governed_by_mode')
      expect(() => draft('followup-sweep')).not.toThrow()
    })

    it('does not block Istvan composing directly', () => {
      setMode('c1', 'shadow')
      expect(() => draft('owner')).not.toThrow()
    })

    // The required `origin` field is enforced by tsc, and tsc covers src/** only.
    // scripts/ is outside the include, so a script could arrive with undefined.
    it('fails CLOSED on an origin nobody declared', () => {
      setMode('c1', 'live')
      const d = mayCompose(getDb(), 'personal', 'c1', undefined as unknown as OutboundOrigin)
      expect(d.allowed).toBe(false)
      expect(d.code).toBe('mode_unknown')
      expect(() => draft(undefined as unknown as OutboundOrigin)).toThrow(OutboundModeRefusal)
    })
  })

  describe('draftSend refuses by throwing, not by returning a polite no', () => {
    it('a shadow case produces NO ledger row for the pipeline', () => {
      setMode('c1', 'shadow')
      expect(() => draft('progression')).toThrow(OutboundModeRefusal)
      const n = getDb().prepare('SELECT COUNT(*) AS n FROM outbound_ledger').get() as { n: number }
      expect(n.n).toBe(0)
    })

    it('and no case-timeline event either, so the refusal leaves nothing half-done', () => {
      setMode('c1', 'shadow')
      expect(() => draft('progression')).toThrow()
      const n = getDb().prepare(
        `SELECT COUNT(*) AS n FROM personal_case_events WHERE event_type='OUTBOUND_DRAFTED'`
      ).get() as { n: number }
      expect(n.n).toBe(0)
    })

    it('an external_shadow case DOES get its PLANNED row', () => {
      setMode('c1', 'external_shadow')
      const d = draft('progression')
      const row = getDb().prepare('SELECT status FROM outbound_ledger WHERE ledger_id=?')
        .get(d.ledgerId) as { status: string }
      expect(row.status).toBe('PLANNED')
    })
  })

  describe('automatic approval: the one place external_shadow and live differ', () => {
    it.each<[ProgressionMode, boolean]>([
      ['off', false], ['shadow', false], ['internal', false],
      ['external_shadow', false], ['live', true],
    ])('mode %s -> automation may approve: %s', (mode, allowed) => {
      setMode('c1', mode)
      expect(mayApprove(getDb(), 'personal', 'c1', 'automation').allowed).toBe(allowed)
    })

    it('a human may always approve, including in external_shadow', () => {
      setMode('c1', 'external_shadow')
      expect(mayApprove(getDb(), 'personal', 'c1', 'human').allowed).toBe(true)
    })

    // The letter waiting tonight is on an `internal` case. If a human approval
    // were mode-gated, nothing in the system could ever be sent.
    it('a human may approve on an internal case, end to end through approveSend', () => {
      setMode('c1', 'internal')
      const d = draft('followup-sweep')
      expect(() => approveSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan',
        recipient: EMAIL.to, initiatedBy: 'human',
      }, NOW + 1)).not.toThrow()
    })

    it('automation is refused on external_shadow, through approveSend', () => {
      setMode('c1', 'external_shadow')
      const d = draft('progression')
      expect(() => approveSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'robot',
        recipient: EMAIL.to, initiatedBy: 'automation',
      }, NOW + 1)).toThrow(OutboundModeRefusal)
      const n = getDb().prepare('SELECT COUNT(*) AS n FROM campaign_approvals').get() as { n: number }
      expect(n.n).toBe(0)
    })

    it('automation is allowed on live, through approveSend', () => {
      setMode('c1', 'live')
      const d = draft('progression')
      expect(() => approveSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'robot',
        recipient: EMAIL.to, initiatedBy: 'automation',
      }, NOW + 1)).not.toThrow()
    })

    it('an unclassified case denies automation, but not a human', () => {
      setMode('c1', null)
      expect(mayApprove(getDb(), 'personal', 'c1', 'automation').allowed).toBe(false)
      expect(mayApprove(getDb(), 'personal', 'c1', 'human').allowed).toBe(true)
    })

    // Same directory-boundary hole as origin, and here the closed side is the
    // one an omitted field must land on.
    it('anything that is not literally "human" counts as automation', () => {
      setMode('c1', 'internal')
      const d = mayApprove(getDb(), 'personal', 'c1', undefined as unknown as ApprovalInitiator)
      expect(d.allowed).toBe(false)
      expect(d.code).toBe('mode_forbids_automatic_approval')
    })
  })

  describe('reading the mode', () => {
    it('returns null for a case with no progression row', () => {
      setMode('c1', null)
      expect(progressionModeOf(getDb(), 'personal', 'c1')).toBeNull()
    })

    // Written first as "a sixth value reads as unknown", and it could not be
    // written: the schema CHECK refuses the write, so the defensive branch in
    // progressionModeOf is UNREACHABLE through the database today. That is the
    // honest thing to pin — the guard against a bogus mode is the CHECK, not the
    // reader. The reader's branch stays as a belt for the day somebody relaxes
    // the constraint, but this test measures the guard that actually fires.
    it('the schema itself refuses a sixth mode value', () => {
      setMode('c1', 'live')
      expect(() => getDb().prepare(
        `UPDATE case_progression_state SET progression_mode='banana' WHERE case_id='c1'`
      ).run()).toThrow(/CHECK constraint failed/)
      expect(progressionModeOf(getDb(), 'personal', 'c1')).toBe('live')
    })

    it('is per domain: the zst row of the same case id does not answer for personal', () => {
      setMode('c1', null)
      setMode('c1', 'live', 'zst')
      expect(progressionModeOf(getDb(), 'personal', 'c1')).toBeNull()
      expect(mayApprove(getDb(), 'personal', 'c1', 'automation').allowed).toBe(false)
    })
  })
})
