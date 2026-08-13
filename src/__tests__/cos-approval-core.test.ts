import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createCampaign, approveCampaign, revokeCampaign, pauseCampaign } from '../cos/campaigns.js'
import { personalApprovals, zstApprovals, makeApprovalEngine, type RecordApprovalInput } from '../cos/approval-core.js'

// The §3.2 approval envelope.
//
// Each test below drives ONE refusal path to red and then to green, because a
// gate whose refusals cannot be individually triggered is indistinguishable from
// a gate that always says yes for an unrelated reason. The recipient allowlist
// gets the most attention: it is AC-4, and its absence on the personal side (it
// existed only for ZST) is what prompted this module.

const NOW = 1_800_000_000
const CAMP = 'camp-1'
const TPL = 'tpl-hash'
const PAY = 'payload-hash'

function baseApproval(over: Partial<RecordApprovalInput> = {}): RecordApprovalInput {
  return {
    approvalId: 'appr-1', campaignId: CAMP, approvedBy: 'istvan',
    templateHash: TPL, renderedPayloadHash: PAY,
    allowedRecipients: ['reklamacio@ecipo.hu'],
    allowedChannels: ['EMAIL'],
    ...over,
  }
}

function setup(freeText = false) {
  initDatabase(':memory:')
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'HOFF reklamáció', caseType: 'ADMIN' }, NOW - 1000)
  createCampaign(db, {
    campaignId: CAMP, caseId: 'c1', campaignType: 'EMAIL_SEND',
    templateHash: TPL, allowsFreeText: freeText,
  }, NOW - 1000)
  approveCampaign(db, CAMP, NOW - 900)
  return db
}

const ask = (over: Partial<Parameters<typeof personalApprovals.authorizeSend>[1]> = {}) => ({
  campaignId: CAMP, templateHash: TPL, renderedPayloadHash: PAY,
  recipient: 'reklamacio@ecipo.hu', ...over,
})

describe('COS approval envelope (§3.2)', () => {
  beforeEach(() => { setup() })

  it('authorizes the approved payload to the approved recipient', () => {
    personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
    const r = personalApprovals.authorizeSend(getDb(), ask(), NOW)
    expect(r).toMatchObject({ authorized: true, code: 'ok' })
  })

  describe('recipient allowlist — AC-4', () => {
    it('refuses an address that is not on the list', () => {
      personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
      const r = personalApprovals.authorizeSend(getDb(), ask({ recipient: 'valaki.mas@pelda.hu' }), NOW)
      expect(r.authorized).toBe(false)
      expect(r.code).toBe('recipient_not_allowed')
    })

    it('matches on the address inside a display name, case-insensitively', () => {
      personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
      const r = personalApprovals.authorizeSend(getDb(), ask({ recipient: 'eCipő Ügyfélszolgálat <Reklamacio@ECIPO.hu>' }), NOW)
      expect(r.authorized).toBe(true)
    })

    it('refuses when the approval carries no allowlist at all — no list means no authority', () => {
      const db = getDb()
      personalApprovals.recordApproval(db, baseApproval(), NOW)
      db.prepare(`UPDATE campaign_approvals SET allowed_recipients=NULL WHERE approval_id='appr-1'`).run()
      const r = personalApprovals.authorizeSend(db, ask(), NOW)
      expect(r.code).toBe('recipient_not_allowed')
    })

    it('refuses an unreadable allowlist rather than treating it as absent', () => {
      const db = getDb()
      personalApprovals.recordApproval(db, baseApproval(), NOW)
      db.prepare(`UPDATE campaign_approvals SET allowed_recipients='{ nem json' WHERE approval_id='appr-1'`).run()
      const r = personalApprovals.authorizeSend(db, ask(), NOW)
      expect(r.code).toBe('envelope_unreadable')
    })

    it('rejects an approval written without any recipient — loudly, at write time', () => {
      expect(() => personalApprovals.recordApproval(getDb(), baseApproval({ allowedRecipients: [] }), NOW))
        .toThrow(/allowedRecipients/)
    })
  })

  it('refuses a channel outside the approved set', () => {
    personalApprovals.recordApproval(getDb(), baseApproval({ allowedChannels: ['EMAIL'] }), NOW)
    expect(personalApprovals.authorizeSend(getDb(), ask({ channel: 'EMAIL' }), NOW).authorized).toBe(true)
    expect(personalApprovals.authorizeSend(getDb(), ask({ channel: 'SMS' }), NOW).code).toBe('channel_not_allowed')
  })

  it('expires: the same payload authorized yesterday is refused after valid_until', () => {
    personalApprovals.recordApproval(getDb(), baseApproval({ validUntil: NOW + 3600 }), NOW)
    expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).authorized).toBe(true)
    expect(personalApprovals.authorizeSend(getDb(), ask(), NOW + 7200).code).toBe('approval_expired')
  })

  it('a tripped stop condition refuses everything afterwards (§3.4)', () => {
    personalApprovals.recordApproval(getDb(), baseApproval({ stopConditions: ['előleget kér'] }), NOW)
    expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).authorized).toBe(true)
    personalApprovals.tripStopCondition(getDb(), 'appr-1', 'a partner előleget kért', NOW + 10)
    const r = personalApprovals.authorizeSend(getDb(), ask(), NOW + 20)
    expect(r.code).toBe('stop_condition_active')
    expect(r.reason).toContain('előleget')
  })

  describe('rendered variables (§3.3)', () => {
    it('refuses a forbidden variable', () => {
      personalApprovals.recordApproval(getDb(), baseApproval({ forbiddenVariables: ['bankszamla'] }), NOW)
      const r = personalApprovals.authorizeSend(getDb(), ask({ usedVariables: ['nev', 'bankszamla'] }), NOW)
      expect(r.code).toBe('forbidden_variable')
    })

    it('refuses a variable outside the approved schema', () => {
      personalApprovals.recordApproval(getDb(), baseApproval({ allowedVariableSchema: ['nev', 'rendelesszam'] }), NOW)
      expect(personalApprovals.authorizeSend(getDb(), ask({ usedVariables: ['nev'] }), NOW).authorized).toBe(true)
      const r = personalApprovals.authorizeSend(getDb(), ask({ usedVariables: ['nev', 'lakcim'] }), NOW)
      expect(r.code).toBe('variable_not_in_schema')
    })
  })

  describe('quotas (v4.2.1 A.4)', () => {
    let seq = 0
    function ledgerRow(id: string, kind: string, status = 'VERIFIED') {
      seq += 1
      getDb().prepare(
        `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
           internal_idempotency_key, status, campaign_id, outbound_kind, created_at, updated_at)
         VALUES (?, 'c1', 'EMAIL_SEND', ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, seq, `k-${id}`, status, CAMP, kind, NOW, NOW)
    }
    beforeEach(() => { seq = 0 })

    it('refuses once the per-kind quota is used up', () => {
      personalApprovals.recordApproval(getDb(), baseApproval({ maxFollowUpOutbound: 2 }), NOW)
      ledgerRow('l1', 'FOLLOW_UP'); ledgerRow('l2', 'FOLLOW_UP')
      const r = personalApprovals.authorizeSend(getDb(), ask({ outboundKind: 'FOLLOW_UP' }), NOW)
      expect(r.code).toBe('quota_exhausted')
      // a different kind is unaffected
      expect(personalApprovals.authorizeSend(getDb(), ask({ outboundKind: 'INITIAL' }), NOW).authorized).toBe(true)
    })

    // E14 (review 2026-08-13). `limits.maxPerKind` mapped INITIAL and FOLLOW_UP
    // and returned null for REPLY. The pre-filter above DID count replies, so
    // max_autonomous_replies looked enforced — but the only race-safe count is
    // the one the executor runs inside the SENDING transaction, and it is fed
    // from `limits`. So two concurrent autonomous replies could both pass the
    // check-then-act pre-filter and both send.
    it('E14: the REPLY ceiling reaches limits, not only the pre-filter', () => {
      personalApprovals.recordApproval(getDb(), baseApproval({ maxAutonomousReplies: 2 }), NOW)
      const r = personalApprovals.authorizeSend(getDb(), ask({ outboundKind: 'REPLY' }), NOW)
      expect(r.authorized).toBe(true)
      // This is what dispatchApprovedSend hands to the executor to count inside
      // the same transaction as the SENDING write. null here means "no ceiling".
      expect(r.limits).toMatchObject({ maxPerKind: 2, kind: 'REPLY' })
      // CONTROL: the other kinds still carry theirs, so the mapping was widened
      // rather than replaced.
      getDb().prepare(`UPDATE campaign_approvals SET max_initial_outbound=1 WHERE approval_id='appr-1'`).run()
      expect(personalApprovals.authorizeSend(getDb(), ask({ outboundKind: 'INITIAL' }), NOW).limits)
        .toMatchObject({ maxPerKind: 1, kind: 'INITIAL' })
    })

    it('cancelled and terminally failed sends do not consume quota', () => {
      personalApprovals.recordApproval(getDb(), baseApproval({ maxTotalOutbound: 1 }), NOW)
      ledgerRow('l1', 'INITIAL', 'CANCELLED')
      expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).authorized).toBe(true)
      ledgerRow('l2', 'INITIAL', 'VERIFIED')
      expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).code).toBe('quota_exhausted')
    })
  })

  describe('campaign state and version binding (P0.5)', () => {
    it('a revoke stops the previously valid approval', () => {
      personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
      expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).authorized).toBe(true)
      revokeCampaign(getDb(), CAMP, 1, NOW + 5)
      expect(personalApprovals.authorizeSend(getDb(), ask(), NOW + 6).code).toBe('campaign_not_approved')
    })

    it('a pause+resume leaves the old approval unauthorized (version moved on)', () => {
      personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
      pauseCampaign(getDb(), CAMP, 1, NOW + 5)
      getDb().prepare(`UPDATE campaigns SET status='APPROVED' WHERE campaign_id=?`).run(CAMP)
      const r = personalApprovals.authorizeSend(getDb(), ask(), NOW + 10)
      expect(r.code).toBe('no_matching_approval')
    })

    it('a free-text campaign can never autonomously send', () => {
      setup(true)
      personalApprovals.recordApproval(getDb(), baseApproval(), NOW)
      expect(personalApprovals.authorizeSend(getDb(), ask(), NOW).code).toBe('free_text_campaign')
    })
  })

  it('refuses to record an approval that would allow autonomous spend', () => {
    expect(() => personalApprovals.recordApproval(
      getDb(), { ...baseApproval(), autonomousSpendLimit: 500 as unknown as 0 }, NOW,
    )).toThrow(/never spends/)
  })

  it('the two namespaces are the SAME implementation over different tables', () => {
    // The drift this module exists to prevent: if someone re-implements one
    // side, this assertion is the thing that notices.
    expect(personalApprovals.authorizeSend.toString()).toBe(zstApprovals.authorizeSend.toString())
    expect(personalApprovals.tables.approvals).toBe('campaign_approvals')
    expect(zstApprovals.tables.approvals).toBe('zst_campaign_approvals')
  })

  it('an unreadable ledger refuses rather than silently disabling the quota', () => {
    const engine = makeApprovalEngine({
      campaigns: 'campaigns', approvals: 'campaign_approvals', ledger: 'no_such_ledger',
    })
    engine.recordApproval(getDb(), baseApproval({ maxTotalOutbound: 1 }), NOW)
    const r = engine.authorizeSend(getDb(), ask(), NOW)
    expect(r.code).toBe('envelope_unreadable')
  })
})
