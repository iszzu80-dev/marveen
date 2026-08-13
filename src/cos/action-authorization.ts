// Personal Chief of Staff (COS) — non-forgeable action authorization (§22.2).
//
// WHY THIS EXISTS. Until now the executor accepted a caller-side boolean:
// `ExecuteOpts.authorizedByDispatchGate = true`, meaning "I ran the gate and it
// passed". The spec names that model and forbids it, correctly:
//
//     caller → "I evaluated the gate and it passed" → executor trusts caller
//
// That is a convention, not enforcement. Any code path that can call
// executeAction can also write `true`, so the gate protects only the callers who
// were already going to behave. I wrote that boolean myself and said in its own
// comment that it was an assertion and not proof — which is honest, and still
// the wrong model.
//
// WHAT REPLACES IT. The gate issues an opaque, single-use authorization record.
// The executor cannot be handed a fabricated one, because the id is random and
// must exist in this table; it cannot be replayed, because consumption is an
// atomic conditional UPDATE; and it cannot be aimed at a different action,
// because consumption re-checks the bound context.
//
// WHY THE OPAQUE SERVER-SIDE VARIANT. The spec offers three implementations
// (HMAC ticket, opaque server-side record, in-process capability object) and
// recommends this one first. It needs no key management, its consumption is a
// row we can audit afterwards, and — decisively — an in-process capability
// object is only unforgeable if the module boundary really prevents
// construction, which in this codebase (one process, shared imports) it does
// not.
//
// TOCTOU. A ticket proves the gate said yes ONCE. Between issuing and executing,
// a campaign can be revoked, an approval can expire, a kill switch can flip, the
// case can move on, or the payload/recipient can be edited. So consumption
// re-checks the bound fields and refuses on any mismatch — the ticket is the
// evidence, not the permission.
import type Database from 'better-sqlite3'
import { gatePermitRefusal } from './gate-permit.js'
import { randomBytes, createHash } from 'node:crypto'

/** Default lifetime. Short on purpose: a ticket is meant to be consumed by the
 *  send that immediately follows its issue, not carried around. */
export const AUTHORIZATION_TTL_SEC = 120

export interface AuthorizationContext {
  domain: 'personal' | 'zst'
  caseId: string | null
  caseVersion: number | null
  goalVersion: number | null
  actionId: string
  actionType: string
  intent: string
  targetReference: string | null
  recipient: string | null
  payloadHash: string | null
  approvalId: string | null
  delegationEnvelopeId?: string | null
}

export interface IssuedAuthorization {
  authorizationId: string
  expiresAt: number
}

export type ConsumeResult =
  | { ok: true; authorizationId: string }
  | { ok: false; reason: string }

/** The hash of everything the gate decided on. Stored at issue and re-derived at
 *  consumption: if any bound field moved, the hashes differ and the ticket dies.
 *  One comparison instead of eleven, and it cannot be partially checked. */
export function policyEvaluationHash(ctx: AuthorizationContext): string {
  const canonical = [
    ctx.domain, ctx.caseId ?? '', String(ctx.caseVersion ?? ''), String(ctx.goalVersion ?? ''),
    ctx.actionId, ctx.actionType, ctx.intent,
    ctx.targetReference ?? '', ctx.recipient ?? '', ctx.payloadHash ?? '',
    ctx.approvalId ?? '', ctx.delegationEnvelopeId ?? '',
  ].join('\0')
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Issue a ticket. ONLY the deterministic gate may call this — that is a code
 * review rule, not something the type system enforces, so the call sites are
 * deliberately few and named in the spec (dispatchApprovedSend, dispatchZstSend).
 *
 * The id is 32 random bytes. Not a counter, not derived from the action: a
 * caller must not be able to compute one.
 */
export function issueAuthorization(
  db: Database.Database, ctx: AuthorizationContext, now: number,
  opts: { ttlSeconds?: number; singleUse?: boolean } = {},
  // §22.2 / review #3 U-4. The ticket may only be issued against a decision the
  // deterministic gate itself produced AND allowed. Positional-last with a
  // default of `undefined` so the refusal is a RUNTIME one with a message,
  // rather than a compile error a caller could satisfy with `null as never`.
  permit?: unknown,
): IssuedAuthorization {
  const refusal = gatePermitRefusal(permit)
  if (refusal) throw new Error(`issueAuthorization refused: ${refusal}`)
  const authorizationId = randomBytes(32).toString('hex')
  const expiresAt = now + (opts.ttlSeconds ?? AUTHORIZATION_TTL_SEC)
  db.prepare(
    `INSERT INTO action_authorizations
       (authorization_id, domain, case_id, case_version, goal_version, action_id,
        action_type, intent, target_reference, recipient, payload_hash,
        policy_evaluation_hash, approval_id, delegation_envelope_id,
        issued_at, expires_at, single_use, nonce)
     VALUES (@authorizationId, @domain, @caseId, @caseVersion, @goalVersion, @actionId,
        @actionType, @intent, @targetReference, @recipient, @payloadHash,
        @policyHash, @approvalId, @envelopeId,
        @now, @expiresAt, @singleUse, @nonce)`
  ).run({
    authorizationId, domain: ctx.domain, caseId: ctx.caseId, caseVersion: ctx.caseVersion,
    goalVersion: ctx.goalVersion, actionId: ctx.actionId, actionType: ctx.actionType,
    intent: ctx.intent, targetReference: ctx.targetReference, recipient: ctx.recipient,
    payloadHash: ctx.payloadHash, policyHash: policyEvaluationHash(ctx),
    approvalId: ctx.approvalId, envelopeId: ctx.delegationEnvelopeId ?? null,
    now, expiresAt, singleUse: (opts.singleUse ?? true) ? 1 : 0,
    nonce: randomBytes(16).toString('hex'),
  })
  return { authorizationId, expiresAt }
}

/**
 * Consume a ticket for THIS action, or refuse and say why.
 *
 * Everything here happens in one transaction, and the consuming UPDATE is
 * conditional on the row still being unconsumed — so two concurrent executions
 * of the same ticket cannot both win. Checking first and updating after would be
 * check-then-act, which is the bug class this whole evening kept finding.
 *
 * `expectedNow` is passed in rather than read from the clock: every other
 * timestamp on the send path comes from the caller, and an expiry compared
 * against wall time while everything else uses fixture time is a bug I already
 * shipped once tonight (F-16).
 */
export function consumeAuthorization(
  db: Database.Database, authorizationId: string | undefined, ctx: AuthorizationContext, now: number,
): ConsumeResult {
  if (!authorizationId) return { ok: false, reason: 'no authorization ticket supplied' }

  return db.transaction((): ConsumeResult => {
    const row = db.prepare(
      `SELECT * FROM action_authorizations WHERE authorization_id = ?`
    ).get(authorizationId) as Record<string, unknown> | undefined

    // A forged or guessed id simply is not here. This is the property the random
    // 32 bytes buy: absence is the answer, not a policy decision.
    if (!row) return { ok: false, reason: 'unknown authorization ticket' }
    // E8 (review 2026-08-13). REVOKED is checked first and UNCONDITIONALLY.
    // Revocation used to be written as consumed_at, and the consumption rule
    // below only blocks on consumed_at for single-use tickets — so a multi-use
    // ticket walked straight through the kill switch that reported it revoked.
    // Withdrawn authority blocks every ticket, whatever its reuse policy: that is
    // the whole of §22.2's revocation clause.
    //
    // `!= null` on purpose (not `!== null`): on a store that predates the column
    // the field is undefined, and a strict comparison would refuse every ticket
    // in the system.
    if (row.revoked_at != null) {
      const why = row.revoked_reason ? `: ${String(row.revoked_reason)}` : ''
      return { ok: false, reason: `authorization revoked at ${String(row.revoked_at)}${why}` }
    }
    if (row.consumed_at !== null && row.single_use === 1) {
      return { ok: false, reason: `authorization already consumed at ${String(row.consumed_at)}` }
    }
    if (Number(row.expires_at) < now) {
      return { ok: false, reason: `authorization expired at ${String(row.expires_at)}` }
    }
    if (String(row.action_id) !== ctx.actionId) {
      return { ok: false, reason: `authorization was issued for action ${String(row.action_id)}, not ${ctx.actionId}` }
    }
    // TOCTOU: one hash covers recipient, payload, target, versions, approval and
    // action type. Any of them edited after issue and the ticket no longer
    // matches what was authorised.
    const expected = policyEvaluationHash(ctx)
    if (String(row.policy_evaluation_hash) !== expected) {
      return { ok: false, reason: 'the action changed after authorization (policy evaluation hash mismatch)' }
    }

    // §22.2 TOCTOU list, sixth field: "approval/envelope validity". The hash
    // above catches an approval whose ID CHANGED. It cannot catch the case the
    // spec actually names — the same approval, REVOKED between issue and
    // execution — because the id is unchanged and so is the hash. Without this
    // block, a withdrawn approval could still send inside the ticket's lifetime.
    //
    // Found by auditing my own work against the spec's list rather than against
    // my own tests: the test I wrote for "approval withdrawn after issuance"
    // modelled it as an id mismatch, so it was green while proving the easier
    // half. The easier half was already covered by the hash.
    const approvalId = row.approval_id as string | null
    if (approvalId) {
      const table = row.domain === 'zst' ? 'zst_campaign_approvals' : 'campaign_approvals'
      let appr: { status: string; stopped_reason: string | null; valid_until: number | null } | undefined
      try {
        appr = db.prepare(
          `SELECT status, stopped_reason, valid_until FROM ${table} WHERE approval_id = ?`
        ).get(approvalId) as typeof appr
      } catch {
        // A store without the envelope columns cannot answer the question. Fail
        // CLOSED: "cannot verify the approval" is not "the approval is fine".
        return { ok: false, reason: `cannot verify approval ${approvalId} is still valid` }
      }
      if (!appr) return { ok: false, reason: `approval ${approvalId} no longer exists` }
      if (appr.status !== 'APPROVED') return { ok: false, reason: `approval ${approvalId} is ${appr.status}` }
      if (appr.stopped_reason) return { ok: false, reason: `approval ${approvalId} stopped: ${appr.stopped_reason}` }
      if (appr.valid_until !== null && appr.valid_until < now) {
        return { ok: false, reason: `approval ${approvalId} expired at ${appr.valid_until}` }
      }
    }

    const info = db.prepare(
      `UPDATE action_authorizations SET consumed_at = @now
       WHERE authorization_id = @id AND revoked_at IS NULL
         AND (consumed_at IS NULL OR single_use = 0)`
    ).run({ id: authorizationId, now })
    // The revocation is re-checked inside the conditional UPDATE as well as
    // above, because a kill switch landing between the two would otherwise be a
    // check-then-act window on the one operation that exists to close windows.
    if (info.changes === 0) return { ok: false, reason: 'authorization was consumed or revoked concurrently' }
    return { ok: true, authorizationId }
  })()
}

/** Invalidate every outstanding ticket for an action — used when the authority
 *  behind it is withdrawn (campaign revoked, approval pulled, kill switch).
 *  Revocation must not wait for expiry.
 *
 *  E8: written to revoked_at, not consumed_at. "Spent by the send it authorised"
 *  and "killed because the authority behind it was withdrawn" are different
 *  facts about a ticket, and until now they were the same column — so the audit
 *  could not tell them apart, and a multi-use ticket survived the second one. */
export function revokeAuthorizationsForAction(
  db: Database.Database, actionId: string, now: number, reason = 'authority withdrawn for this action',
): number {
  return db.prepare(
    `UPDATE action_authorizations SET revoked_at = @now, revoked_reason = @reason
     WHERE action_id = @actionId AND revoked_at IS NULL AND consumed_at IS NULL`
  ).run({ actionId, now, reason }).changes
}
