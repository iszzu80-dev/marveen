import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { draftZstSend, approveZstSend } from '../cos/zst-send.js'
import { buildPlannedDigest } from '../cos/outbound-alert.js'
import { OutboundModeRefusal } from '../cos/outbound-mode-gate.js'
import type { ProgressionMode } from '../cos/outbound-mode-gate.js'

// 2026-08-15, found by the review peer within an hour of the personal-path work
// landing: all three of that night's protections existed on the personal send path
// and NONE on the corporate one. That is the fourth time the same thing happened,
// so it is not four bugs — it is what having two send paths does.
//
// These pin the corporate path to the same behaviour. They are effect tests: a
// refusal that stops an approval, a digest that names a ZST row, an event row that
// exists.

const NOW = 1_800_000_000
const DAY = 86400
const EMAIL = { to: 'partner@example.com', subject: 'Ajanlatkeres', body: 'TITKOS LEVELTORZS' }

function seedZstCase(caseId = 'z1') {
  const db = getDb()
  db.prepare(
    `INSERT INTO zst_cases (case_id, title, case_type, status, workspace, sensitivity,
       version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(caseId, 'Beszallitoi ajanlat', 'PROCUREMENT', 'NEW', 'OPERATIONS', 'ZST_INTERNAL', 1, NOW, NOW)
}

function setZstMode(caseId: string, mode: ProgressionMode) {
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
       case_version, created_at, updated_at) VALUES ('zst',?,1,?,1,?,?)`
  ).run(caseId, mode, NOW, NOW)
}

function draftZst(caseId = 'z1', at = NOW) {
  return draftZstSend(getDb(), { origin: 'owner', caseId, templateId: 'zst-freeform-v1', email: EMAIL }, at)
}

describe('the corporate send path gets the same protections as the personal one', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    seedZstCase()
  })

  describe('the mode gate reaches the ZST approval too', () => {
    it('refuses automatic approval on external_shadow', () => {
      setZstMode('z1', 'external_shadow')
      const d = draftZst()
      expect(() => approveZstSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'robot',
        allowedRecipients: [EMAIL.to], initiatedBy: 'automation',
      }, NOW + 1)).toThrow(OutboundModeRefusal)
    })

    it('allows automatic approval on live', () => {
      setZstMode('z1', 'live')
      const d = draftZst()
      expect(() => approveZstSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'robot',
        allowedRecipients: [EMAIL.to], initiatedBy: 'automation',
      }, NOW + 1)).not.toThrow()
    })

    it('still lets a human approve on internal, which is what every ZST case is', () => {
      setZstMode('z1', 'internal')
      const d = draftZst()
      expect(() => approveZstSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'istvan',
        allowedRecipients: [EMAIL.to], initiatedBy: 'human',
      }, NOW + 1)).not.toThrow()
    })

    // The personal gate reads the personal row. Without a domain-correct lookup a
    // ZST case would be judged by whatever personal case shares its id.
    it('reads the ZST row, not a personal row with the same case id', () => {
      setZstMode('z1', 'external_shadow')
      getDb().prepare(
        `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
           case_version, created_at, updated_at) VALUES ('personal','z1',1,'live',1,?,?)`
      ).run(NOW, NOW)
      const d = draftZst()
      expect(() => approveZstSend(getDb(), {
        campaignId: d.campaignId, templateHash: d.templateHash,
        renderedPayloadHash: d.renderedPayloadHash, approvedBy: 'robot',
        allowedRecipients: [EMAIL.to], initiatedBy: 'automation',
      }, NOW + 1)).toThrow(OutboundModeRefusal)
    })
  })

  describe('the PLANNED digest is not blind to the corporate ledger', () => {
    it('counts and names a ZST PLANNED row', () => {
      const d = draftZst('z1', NOW - 3 * DAY)
      const digest = buildPlannedDigest(getDb(), NOW)
      expect(digest.count).toBe(1)
      expect(digest.text).toContain(d.ledgerId)
      expect(digest.text).toContain('[ZST]')
      expect(digest.text).toContain('Ajanlatkeres')
    })

    it('never carries the corporate letter body either', () => {
      draftZst()
      expect(buildPlannedDigest(getDb(), NOW).text).not.toContain('TITKOS LEVELTORZS')
    })

    it('orders oldest-first across BOTH namespaces, so neither can starve the other', () => {
      // A personal row younger than the ZST one must still sort after it.
      const db = getDb()
      db.prepare(
        `INSERT INTO personal_cases (case_id, title, case_type, status, version, created_at, updated_at)
         VALUES ('p1','Szemelyes','CLAIM','NEW',1,?,?)`
      ).run(NOW, NOW)
      const zst = draftZst('z1', NOW - 5 * DAY)
      db.prepare(
        `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
           internal_idempotency_key, status, payload, attempt, created_at, updated_at)
         VALUES ('ob-p1','p1','EMAIL_SEND',1,'k-p1','PLANNED',?,0,?,?)`
      ).run(JSON.stringify({ to: 'x@y.z', subject: 'Ujabb', body: 'b' }), NOW - 1 * DAY, NOW)
      const digest = buildPlannedDigest(getDb(), NOW)
      expect(digest.count).toBe(2)
      expect(digest.text.indexOf(zst.ledgerId)).toBeLessThan(digest.text.indexOf('ob-p1'))
      expect(digest.oldestAgeDays).toBe(5)
    })

    // Rounding down turned a 46-hour-old letter into "1 napja" on a signal whose
    // whole point is urgency.
    it('states an age under two days in hours, not rounded-down days', () => {
      draftZst('z1', NOW - 46 * 3600)
      expect(buildPlannedDigest(getDb(), NOW).text).toContain('46 oraja')
    })

    it('switches to days once past two', () => {
      draftZst('z1', NOW - 3 * DAY)
      expect(buildPlannedDigest(getDb(), NOW).text).toContain('3 napja')
    })
  })

  describe('the corporate case timeline learns about the drafted letter', () => {
    it('appends OUTBOUND_DRAFTED pointing at the ZST ledger row', () => {
      const d = draftZst()
      const ev = getDb().prepare(
        `SELECT source_reference, source_system, reason, payload FROM zst_case_events
          WHERE event_type='OUTBOUND_DRAFTED'`
      ).all() as Array<{ source_reference: string; source_system: string; reason: string; payload: string }>
      expect(ev).toHaveLength(1)
      expect(ev[0]!.source_reference).toBe(d.ledgerId)
      expect(ev[0]!.source_system).toBe('cos:zst-send')
      expect(ev[0]!.reason).toContain('Ajanlatkeres')
      expect(ev[0]!.payload).not.toContain('TITKOS LEVELTORZS')
    })
  })
})
