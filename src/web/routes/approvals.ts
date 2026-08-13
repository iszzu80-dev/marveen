import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { resolveApgPrincipal, isOperatorPrincipal } from '../apg-principal.js'
import {
  checkHumanApprovalAuthority,
  recordApprovalAttribution,
} from '../apg-human-approval.js'
import { resolveEffectiveApgMode } from '../apg-scope-overrides.js'
import type { RouteContext } from './types.js'

const AUTONOMY_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

interface AutonomyCategory {
  key: string
  timeout_minutes?: number | null
}

interface AutonomyConfig {
  categories: AutonomyCategory[]
}

function getTimeoutAt(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as AutonomyConfig
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return Math.floor(Date.now() / 1000) + cat.timeout_minutes * 60
  } catch {
    return null
  }
}

function notifyMainAgent(approval: Approval): void {
  try {
    const content = [
      `[APPROVAL_REQUEST]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

/*  develop's `resolutionPrincipal()` used to live here.
 *
 *  WHY THE BODY IS NOT AN ANSWER -- the reasoning is kept because it is the
 *  reason both branches converged on this route in the same month. Resolution
 *  identity used to be `resolved_by` from the JSON body, guarded by
 *  `resolved_by === target.agent_id`. Every fleet agent holds the same bearer
 *  token, so any of them could approve its own request by writing
 *  `resolved_by: "istvan"`. The string compare is not a weak check, it is a
 *  check of a value the caller chooses -- the same shape the codebase already
 *  refused once for hard-gated escalations (routes/cos.ts removed the move
 *  entirely rather than trust a claimed actor).
 *
 *  What the gate can prove, in descending strength:
 *    session  -- a human logged into the dashboard. Names a person.
 *    device   -- an enrolled device key. Names a device.
 *    token    -- the SHARED dashboard bearer. Names NOTHING: every fleet agent
 *                has it, so a token request cannot prove it is not the requester.
 *    federation -- a peer instance. Never a party to this instance's approvals.
 *
 *  The function is gone, not the rule: `resolveApgPrincipal()` in
 *  web/apg-principal.ts computes exactly this classification and carries the
 *  extra facts §11.4 needs (credential class, attestation level, and the
 *  server-stamped attribution string). `strong` is now
 *  `isOperatorPrincipal(principal)`; the `user:` prefix is `session:`, which
 *  names the credential rather than re-deriving a word for it. One resolver,
 *  used by this route, the APG decision route and the scope-override route
 *  alike -- three places that must not disagree about who is asking. */

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'category is required' }, 400)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }

    const id = randomUUID()
    const timeout_at = getTimeoutAt(category)
    const approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
    })

    notifyMainAgent(approval)
    logger.info({ id, agent_id, category }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    const items = listApprovals({ agent_id, category, status, limit })
    json(res, items)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    json(res, approval)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; claimed_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, claimed_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    // APG 1.9 §11.4 (1.8 audit finding 3.3): `resolved_by` in the request body
    // was stored verbatim as the approver -- the anti-pattern §11.4 names
    // outright ("Nem elég: resolved_by: 'owner' a request bodyban"). It is now
    // SERVER-STAMPED from the credential that authenticated this request, and
    // the body field is renamed to what it always actually was: a claim.
    //
    // The body's `resolved_by` is still ACCEPTED, as `claimed_by`'s fallback,
    // for one narrow reason: every fleet agent's scaffolded curl and the
    // Telegram approval flow send it, and silently dropping it would break the
    // self-approval guard below (which needs to know who the caller SAYS it
    // is). It no longer reaches the stored attribution.
    const claimedBy = (
      typeof claimed_by === 'string' && claimed_by.trim() ? claimed_by.trim()
      : typeof resolved_by === 'string' && resolved_by.trim() ? resolved_by.trim()
      : null
    )
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    const target = getApproval(idMatch[1])
    const principal = resolveApgPrincipal(ctx.auth)

    // -----------------------------------------------------------------------
    // TWO AUTHORITY RULES MEET ON THIS ROUTE, and both are kept. They were
    // written independently, against the same audit month, and they gate
    // DIFFERENT things -- neither one implies the other:
    //
    //   (A) APG 1.9 §11.4 / §26.2, the CATEGORY gate. Some approvals are owner
    //       decisions (`human_required`) and an agent principal must never
    //       resolve one, in any mode; under `enforced` even an operator
    //       credential that names only a device is refused, because the control
    //       that cannot be satisfied is "name the human".
    //
    //   (B) develop's 2026-08-13 review, the DIRECTION gate. Approving GRANTS
    //       authority; rejecting and timing out only take it away. A caller
    //       holding the fleet-shared bearer cannot prove it is not the very
    //       agent that asked, so it may travel the safe direction and not the
    //       permissive one.
    //
    // (A) is category-scoped and mode-aware; (B) is direction-scoped and
    // applies to every category. Dropping either one reopens a hole the other
    // does not cover: without (A) a fleet token could resolve an owner decision
    // by rejecting it; without (B) any dispatched agent could still approve its
    // own ordinary request by lying in `claimed_by`.
    //
    // Everything below shares ONE principal, resolved by apg-principal.ts from
    // the credential the auth gate accepted. develop's local `resolutionPrincipal`
    // helper computed the same two-class distinction with a narrower vocabulary
    // (`user:`/`device:`/`fleet-token`, plus a boolean `strong`); it is gone in
    // favour of the shared resolver, which adds the credential class and the
    // attestation level §11.4 needs and yields the same verdicts.
    // -----------------------------------------------------------------------

    // (B, first half) A caller the server cannot name at all is not a party to
    // this instance's approvals in EITHER direction -- a federation peer is
    // another instance, and an unauthenticated context has nothing to bind to.
    if (principal.class === 'peer' || principal.class === 'anonymous') {
      json(res, { error: 'Ehhez a művelethez azonosított hívó kell (bejelentkezés vagy eszközkulcs)' }, 403)
      return true
    }

    // (A) §11.4 human_required: an approval in that category is an owner-decision
    // class and cannot be resolved by an agent principal (§26.2). The mode is
    // the global one -- a generic approval is not scoped to a card or project,
    // so there is no narrower scope to resolve against. Checked BEFORE (B) so a
    // refusal on an owner decision reports the specific §26.2/§25 reason rather
    // than the generic one.
    const mode = resolveEffectiveApgMode(null, null).mode
    const verdict = checkHumanApprovalAuthority(principal, target?.category ?? null, mode)
    if (!verdict.allowed) {
      recordApprovalAttribution({
        approval_id: idMatch[1],
        category: target?.category ?? null,
        status: `refused:${status}`,
        principal,
        claimed_by: claimedBy,
        mode,
        verdict,
        surface: 'approvals_patch',
      })
      json(res, { error: verdict.error }, verdict.status ?? 403)
      return true
    }

    // (B, second half) APPROVING NEEDS A PROVABLE PRINCIPAL. Rejecting and
    // timing out do not.
    //
    // The asymmetry is the point: approve GRANTS authority, and a caller that
    // cannot prove it is not the requesting agent must not be able to grant it
    // to itself. Reject/timeout only take authority away -- a self-rejection
    // gains an agent nothing -- so the shared token stays usable for the
    // direction that cannot be abused, and the Telegram "NEM" relay keeps
    // working unchanged.
    //
    // RESIDUAL GAP, stated rather than hidden: with only the shared token there
    // is no server-side identity to bind to, so the permissive direction is
    // refused and the remedy is named in the response. Closing the gap properly
    // means per-agent credentials; until then a fail-closed refusal beats a
    // bypassable string compare.
    if (status === 'approved' && !isOperatorPrincipal(principal)) {
      recordApprovalAttribution({
        approval_id: idMatch[1],
        category: target?.category ?? null,
        status: `refused:${status}`,
        principal,
        claimed_by: claimedBy,
        mode,
        verdict,
        surface: 'approvals_patch',
      })
      json(res, {
        error: 'Jóváhagyáshoz azonosított hívó kell: jelentkezz be a dashboardon, vagy használj eszközkulcsot. '
          + 'A megosztott flotta-token nem bizonyítja, hogy nem a kérelmező ügynök az.',
        code: 'unattributable_caller',
      }, 403)
      return true
    }

    // Self-approval guard, in both the proved and the claimed direction.
    // Unchanged in strength and unchanged in honesty on the CLAIMED side -- a
    // lying client still walks past that half, which is precisely why (B)
    // exists above it. The proved side is develop's defence in depth: a device
    // key named after an agent must not resolve that agent's own request.
    // What DID change under §11.4: the claim can no longer become the stored
    // attribution.
    if (target && (
      (claimedBy !== null && claimedBy === target.agent_id)
      || principal.attribution === target.agent_id
    )) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    // The AUTHENTICATED identity, and ONLY that, is what goes into the audit
    // column. develop wrote `${principal.id} (${resolved_by})` here so that
    // "telegram_text" vs "dashboard" -- genuinely useful provenance -- was not
    // lost; §11.4 refuses to let any part of a request body into the attribution
    // field, precisely so a reader never has to parse proved from claimed. Both
    // are satisfied by giving the claim its own field instead of a suffix: the
    // column is `principal.attribution` alone, and `claimed_by` carries the
    // caller's label in the response and in the §26.10 receipt below.
    const updated = resolveApproval(idMatch[1], status, principal.attribution, msgId)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'Not found' }, 404)
      } else {
        json(res, { error: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    recordApprovalAttribution({
      approval_id: idMatch[1],
      category: target?.category ?? null,
      status,
      principal,
      claimed_by: claimedBy,
      mode,
      verdict,
      surface: 'approvals_patch',
    })
    logger.info(
      { id: idMatch[1], status, resolvedBy: principal.attribution, claimedBy, principalClass: principal.class },
      'Approval resolved',
    )
    json(res, {
      ...approval,
      // The provenance develop wanted to keep, in its own field rather than
      // smuggled into `resolved_by`: what the caller SAID it was, next to the
      // attribution the server PROVED. A reader can tell them apart without
      // parsing a string.
      claimed_by: claimedBy,
      // §25 (assisted must not show a false PASS): the response never lets a
      // human_required decision read as owner-authenticated when no human
      // principal could be named.
      human_principal_proven: verdict.humanPrincipalProven,
      human_attestation: principal.humanAttestation,
    })
    return true
  }

  return false
}
