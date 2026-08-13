// Personal Chief of Staff (COS) — the approval envelope, as a SHARED core.
//
// Why a core and not another copy: `case-engine-core.ts` and `executor-core.ts`
// were factored so Personal and ZST share one implementation. The approval layer
// was not — it was copied. By 2026-08-09 the two had already drifted: the ZST
// table carried `allowed_recipients` and the Personal one did not, so the
// recipient allowlist (AC-4, "nothing goes to an address outside the list") was
// enforced for the company mailbox and absent for the personal one, which is the
// side whose spec actually demands it. Twenty-one further envelope fields were
// missing from both. Building them twice would have re-created the drift on a
// larger surface.
//
// What the envelope is FOR: approving a template is not approving a message.
// §3.2 says an approval carries the whole frame — who may receive, on what
// channel, how many times, until when, with what money ceiling, and what makes
// the campaign stop. authorizeSend() checks all of it at once and fails closed:
// a missing or unparseable field is a refusal, never a pass.
//
// Pure DB logic. No send capability, no network — the executor and connector own
// that. This module only ever answers "may this exact payload go out right now".

import type Database from 'better-sqlite3'

/** Which table pair this engine governs (personal vs zst namespace). */
export interface ApprovalTables {
  campaigns: string
  approvals: string
  /** Ledger used for quota counting. */
  ledger: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED'
export type FinalGate = 'SELECTION' | 'PAYMENT' | 'BOTH' | 'NONE'

/** §3.2 — the fields an approval carries beyond the two hashes.
 *  Every list-shaped field is stored as a JSON array of strings. */
export interface ApprovalEnvelope {
  allowedRecipients: string[]
  allowedChannels: string[]
  templateId?: string
  templateVersion?: number
  allowedVariableSchema?: string[]
  allowedVariableSources?: string[]
  forbiddenVariables?: string[]
  shareableData?: string[]
  quoteTargetBudget?: number
  quoteHardLimit?: number
  /** §3.2 is explicit: a campaign NEVER spends on its own. Always 0. */
  autonomousSpendLimit?: 0
  currency?: string
  maxInitialOutbound?: number
  maxFollowUpOutbound?: number
  maxAutonomousReplies?: number
  maxTotalOutbound?: number
  followUpPolicy?: string
  allowedReplyClasses?: string[]
  allowedAttachmentTypes?: string[]
  stopConditions?: string[]
  escalationConditions?: string[]
  finalGate?: FinalGate
  /** Unix seconds. An approval that has expired authorizes nothing. */
  validUntil?: number
}

export interface RecordApprovalInput extends ApprovalEnvelope {
  approvalId: string
  campaignId: string
  approvedBy: string
  templateHash: string
  renderedPayloadHash: string
}

export interface SendAuthQuery {
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
  /** The actual recipient of THIS send. Required: an unnamed recipient cannot be
   *  checked against the allowlist, and unchecked means refused. */
  recipient: string
  channel?: string
  /** Which kind of send this is, for the per-kind quotas. */
  outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY'
  /** Variable names actually interpolated into the rendered payload. */
  usedVariables?: string[]
}

export interface SendAuthResult {
  authorized: boolean
  /** Machine-readable refusal, one of REFUSAL_CODES. 'ok' when authorized. */
  code: string
  reason: string
  /** F-2 / AC-21: present only when authorized — the versions and approval this
   *  authorisation was granted at, for the ledger row. Read here rather than
   *  recomputed at the call site, where a second read could disagree. */
  campaignVersion?: number
  approvalVersion?: number
  approvalId?: string
  /** N-2 (second review): the envelope's ceilings, handed to the caller so the
   *  DECIDING count can happen inside the same transaction as the SENDING write.
   *  The COUNT(*) here stays as a cheap pre-filter; A.4 forbids it being the
   *  only check, because a pre-filter outside the write is check-then-act. */
  limits?: { maxTotal: number | null; maxPerKind: number | null; kind: string | null }
}

export const REFUSAL_CODES = [
  'ok', 'campaign_missing', 'campaign_not_approved', 'free_text_campaign',
  'no_matching_approval', 'approval_expired', 'recipient_not_allowed',
  'channel_not_allowed', 'forbidden_variable', 'variable_not_in_schema',
  'quota_exhausted', 'stop_condition_active', 'envelope_unreadable',
] as const

interface CampaignRow {
  campaign_id: string
  status: string
  version: number
  allows_free_text: number
}

interface ApprovalRow extends Record<string, unknown> {
  approval_id: string
  campaign_version: number
  status: string
  valid_until: number | null
  allowed_recipients: string | null
  allowed_channels: string | null
  forbidden_variables: string | null
  allowed_variable_schema: string | null
  stop_conditions: string | null
  max_initial_outbound: number | null
  max_follow_up_outbound: number | null
  max_autonomous_replies: number | null
  max_total_outbound: number | null
  stopped_reason: string | null
}

/** Parse a stored JSON array. A field that exists but cannot be parsed is NOT
 *  treated as absent — an unreadable constraint is a refusal, because "I could
 *  not read the rule" must never resolve to "the rule does not apply". */
function parseList(raw: string | null | undefined): { ok: true; value: string[] | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return { ok: false }
    return { ok: true, value: v.map(String) }
  } catch {
    return { ok: false }
  }
}

function normaliseAddress(a: string): string {
  // "Név <cim@pelda.hu>" → "cim@pelda.hu"; case-insensitive.
  const m = a.match(/<([^>]+)>/)
  return (m ? m[1] : a).trim().toLowerCase()
}

export function makeApprovalEngine(T: ApprovalTables) {
  function getCampaign(db: Database.Database, campaignId: string): CampaignRow | undefined {
    return db.prepare(
      `SELECT campaign_id, status, version, allows_free_text FROM ${T.campaigns} WHERE campaign_id = ?`
    ).get(campaignId) as CampaignRow | undefined
  }

  /** Record an approval for a SPECIFIC rendered payload, bound to the campaign's
   *  current version, carrying the whole §3.2 envelope. */
  function recordApproval(db: Database.Database, a: RecordApprovalInput, now: number): void {
    const c = getCampaign(db, a.campaignId)
    if (!c) throw new Error(`campaign not found: ${a.campaignId}`)
    if (a.autonomousSpendLimit !== undefined && a.autonomousSpendLimit !== 0) {
      // §3.2 is not a default here, it is an invariant: a campaign never spends.
      throw new Error('autonomousSpendLimit must be 0 — a campaign never spends autonomously')
    }
    if (!a.allowedRecipients?.length) {
      // An empty allowlist would authorize nothing, which is safe, but it is far
      // more likely a caller that forgot the field — fail loudly at write time
      // rather than produce a campaign that silently refuses every send.
      throw new Error('allowedRecipients must list at least one address')
    }
    const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
    db.prepare(
      `INSERT INTO ${T.approvals} (approval_id, campaign_id, campaign_version, approved_by,
         template_hash, rendered_payload_hash, status,
         allowed_recipients, allowed_channels, template_id, template_version,
         allowed_variable_schema, allowed_variable_sources, forbidden_variables, shareable_data,
         quote_target_budget, quote_hard_limit, autonomous_spend_limit, currency,
         max_initial_outbound, max_follow_up_outbound, max_autonomous_replies, max_total_outbound,
         follow_up_policy, allowed_reply_classes, allowed_attachment_types,
         stop_conditions, escalation_conditions, final_gate, valid_until,
         created_at, updated_at)
       VALUES (@approvalId, @campaignId, @version, @approvedBy,
         @templateHash, @renderedPayloadHash, 'APPROVED',
         @allowedRecipients, @allowedChannels, @templateId, @templateVersion,
         @allowedVariableSchema, @allowedVariableSources, @forbiddenVariables, @shareableData,
         @quoteTargetBudget, @quoteHardLimit, 0, @currency,
         @maxInitialOutbound, @maxFollowUpOutbound, @maxAutonomousReplies, @maxTotalOutbound,
         @followUpPolicy, @allowedReplyClasses, @allowedAttachmentTypes,
         @stopConditions, @escalationConditions, @finalGate, @validUntil,
         @now, @now)`
    ).run({
      approvalId: a.approvalId, campaignId: a.campaignId, version: c.version, approvedBy: a.approvedBy,
      templateHash: a.templateHash, renderedPayloadHash: a.renderedPayloadHash,
      allowedRecipients: j(a.allowedRecipients), allowedChannels: j(a.allowedChannels ?? ['EMAIL']),
      templateId: a.templateId ?? null, templateVersion: a.templateVersion ?? null,
      allowedVariableSchema: j(a.allowedVariableSchema), allowedVariableSources: j(a.allowedVariableSources),
      forbiddenVariables: j(a.forbiddenVariables), shareableData: j(a.shareableData),
      quoteTargetBudget: a.quoteTargetBudget ?? null, quoteHardLimit: a.quoteHardLimit ?? null,
      currency: a.currency ?? null,
      maxInitialOutbound: a.maxInitialOutbound ?? null, maxFollowUpOutbound: a.maxFollowUpOutbound ?? null,
      maxAutonomousReplies: a.maxAutonomousReplies ?? null, maxTotalOutbound: a.maxTotalOutbound ?? null,
      followUpPolicy: a.followUpPolicy ?? null, allowedReplyClasses: j(a.allowedReplyClasses),
      allowedAttachmentTypes: j(a.allowedAttachmentTypes),
      stopConditions: j(a.stopConditions), escalationConditions: j(a.escalationConditions),
      finalGate: a.finalGate ?? 'NONE', validUntil: a.validUntil ?? null,
      now,
    })
  }

  /** Trip a stop condition (§3.4). Recorded on the approval, so the next
   *  authorizeSend refuses with stop_condition_active. */
  function tripStopCondition(db: Database.Database, approvalId: string, reason: string, now: number): void {
    db.prepare(
      `UPDATE ${T.approvals} SET stopped_reason=@reason, updated_at=@now WHERE approval_id=@id`
    ).run({ reason, now, id: approvalId })
  }

  /** Count what this campaign has already sent, for the quota checks. */
  function outboundCount(db: Database.Database, campaignId: string, kind?: string): number {
    try {
      // F-16: PLANNED is excluded. It used to be counted, which meant the row
      // being authorised RIGHT NOW counted against its own ceiling — so
      // maxTotalOutbound:1 refused the first send with "1/1 exhausted" and no
      // campaign with a ceiling could ever send anything. Invisible until F-16
      // started writing the field: a limit nothing sets is a limit nothing
      // tests. A draft is not outbound traffic; everything from SENDING onward
      // is, because it either went out or may have.
      // FAILED_RETRYABLE is excluded for the same reason as PLANNED: the
      // adapter PROVED it never reached the provider, so it is not outbound
      // traffic and must not consume a ceiling it never used. Found by writing
      // the N-2 door test — the retry was refused by its own failed attempt.
      const LIVE = `status NOT IN ('CANCELLED','FAILED_TERMINAL','PLANNED','FAILED_RETRYABLE')`
      const sql = kind
        ? `SELECT COUNT(*) AS n FROM ${T.ledger} WHERE campaign_id=? AND outbound_kind=? AND ${LIVE}`
        : `SELECT COUNT(*) AS n FROM ${T.ledger} WHERE campaign_id=? AND ${LIVE}`
      const row = kind
        ? db.prepare(sql).get(campaignId, kind) as { n: number }
        : db.prepare(sql).get(campaignId) as { n: number }
      return row?.n ?? 0
    } catch {
      // The ledger predates campaign_id/outbound_kind on some installs. Counting
      // 0 would silently disable the quota, so treat it as unreadable instead:
      // the caller turns that into a refusal.
      return -1
    }
  }

  /**
   * The §3.2/§3.4 gate: may this EXACT payload go to THIS recipient right now?
   *
   * Every check below can independently refuse, and each has its own code so a
   * refusal is diagnosable rather than a shrug. Fail-closed throughout: absent
   * campaign, stale version, expired approval, unreadable envelope and exhausted
   * quota all refuse.
   *
   * Note what is deliberately NOT checked here: whether the connector can write.
   * That is the dispatch gate's job, and mixing them would let a healthy
   * connector paper over a missing approval.
   */
  function authorizeSend(db: Database.Database, q: SendAuthQuery, now: number): SendAuthResult {
    const refuse = (code: string, reason: string): SendAuthResult => ({ authorized: false, code, reason })

    const c = getCampaign(db, q.campaignId)
    if (!c) return refuse('campaign_missing', `campaign not found: ${q.campaignId}`)
    if (c.status !== 'APPROVED') return refuse('campaign_not_approved', `campaign status ${c.status} (not APPROVED)`)
    if (c.allows_free_text) {
      return refuse('free_text_campaign', 'free-text campaign → PREPARE only, never autonomous send')
    }

    const appr = db.prepare(
      `SELECT * FROM ${T.approvals}
       WHERE campaign_id=@id AND status='APPROVED' AND campaign_version=@version
         AND template_hash=@th AND rendered_payload_hash=@rh
       LIMIT 1`
    ).get({ id: q.campaignId, version: c.version, th: q.templateHash, rh: q.renderedPayloadHash }) as ApprovalRow | undefined
    if (!appr) {
      return refuse('no_matching_approval',
        'no APPROVED approval for this template + rendered payload at the campaign current version')
    }

    if (appr.stopped_reason) {
      return refuse('stop_condition_active', `stop condition tripped: ${appr.stopped_reason}`)
    }
    if (appr.valid_until !== null && appr.valid_until < now) {
      return refuse('approval_expired', `approval expired at ${appr.valid_until}`)
    }

    const recipients = parseList(appr.allowed_recipients)
    if (!recipients.ok) return refuse('envelope_unreadable', 'allowed_recipients is not a readable list')
    if (recipients.value === null) {
      // The whole point of AC-4. No list means no authority, not "anyone".
      return refuse('recipient_not_allowed', 'approval carries no recipient allowlist')
    }
    const want = normaliseAddress(q.recipient)
    if (!recipients.value.some((r) => normaliseAddress(r) === want)) {
      return refuse('recipient_not_allowed', `recipient ${want} is not on the approved list`)
    }

    if (q.channel) {
      const channels = parseList(appr.allowed_channels)
      if (!channels.ok) return refuse('envelope_unreadable', 'allowed_channels is not a readable list')
      if (channels.value && !channels.value.includes(q.channel)) {
        return refuse('channel_not_allowed', `channel ${q.channel} is not approved`)
      }
    }

    if (q.usedVariables?.length) {
      const forbidden = parseList(appr.forbidden_variables)
      if (!forbidden.ok) return refuse('envelope_unreadable', 'forbidden_variables is not a readable list')
      const hit = forbidden.value?.find((f) => q.usedVariables!.includes(f))
      if (hit) return refuse('forbidden_variable', `rendered payload uses forbidden variable: ${hit}`)

      const schema = parseList(appr.allowed_variable_schema)
      if (!schema.ok) return refuse('envelope_unreadable', 'allowed_variable_schema is not a readable list')
      if (schema.value) {
        const extra = q.usedVariables.find((v) => !schema.value!.includes(v))
        if (extra) return refuse('variable_not_in_schema', `variable ${extra} is outside the approved schema`)
      }
    }

    const perKind: Record<string, number | null> = {
      INITIAL: appr.max_initial_outbound,
      FOLLOW_UP: appr.max_follow_up_outbound,
      REPLY: appr.max_autonomous_replies,
    }
    const kindCap = q.outboundKind ? perKind[q.outboundKind] : null
    if (kindCap !== null && kindCap !== undefined && q.outboundKind) {
      const used = outboundCount(db, q.campaignId, q.outboundKind)
      if (used < 0) return refuse('envelope_unreadable', 'ledger cannot be read for the per-kind quota')
      if (used >= kindCap) {
        return refuse('quota_exhausted', `${q.outboundKind} quota exhausted (${used}/${kindCap})`)
      }
    }
    if (appr.max_total_outbound !== null) {
      const used = outboundCount(db, q.campaignId)
      if (used < 0) return refuse('envelope_unreadable', 'ledger cannot be read for the total quota')
      if (used >= appr.max_total_outbound) {
        return refuse('quota_exhausted', `total quota exhausted (${used}/${appr.max_total_outbound})`)
      }
    }

    // F-2 / AC-21: hand back the versions this authorisation was granted at, so
    // the caller can record them on the ledger row. Recomputing them at the
    // call site would be a second read that could disagree with this one.
    return {
      authorized: true, code: 'ok', reason: 'ok',
      campaignVersion: c.version,
      // E20 (review 2026-08-13). NAMING, deliberately left alone. There is no
      // "approval version" concept in this system: `campaign_approvals.
      // campaign_version` records the campaign version the approval was granted
      // AT, and `outbound_ledger.approval_version` stores a second copy of that
      // same number under a name that suggests otherwise. Renaming a stored
      // column that AC-21 queries and two ledgers carry is a migration with no
      // behavioural payoff, so what it gets is a label: this value is the
      // CAMPAIGN VERSION THE APPROVAL WAS GRANTED AT, not a version of the
      // approval. Read it that way in every audit query.
      approvalVersion: appr.campaign_version,
      approvalId: appr.approval_id,
      limits: {
        maxTotal: appr.max_total_outbound,
        // E14 (review 2026-08-13): REPLY was mapped to null here while the
        // pre-filter above counted it from `perKind`. So `max_autonomous_replies`
        // was checked by the check-then-act read and NOT by the count that runs
        // inside the SENDING transaction — the one place the ceiling is
        // race-safe. Two concurrent autonomous replies could both pass.
        maxPerKind: q.outboundKind ? perKind[q.outboundKind] ?? null : null,
        kind: q.outboundKind ?? null,
      },
    }
  }

  return { getCampaign, recordApproval, tripStopCondition, authorizeSend, tables: T }
}

export type ApprovalEngine = ReturnType<typeof makeApprovalEngine>

/** The two namespaces. One implementation, two table sets — the drift that
 *  produced the 2026-08-09 asymmetry cannot recur without editing this line. */
export const personalApprovals = makeApprovalEngine({
  campaigns: 'campaigns', approvals: 'campaign_approvals', ledger: 'outbound_ledger',
})
export const zstApprovals = makeApprovalEngine({
  campaigns: 'zst_campaigns', approvals: 'zst_campaign_approvals', ledger: 'zst_outbound_ledger',
})
