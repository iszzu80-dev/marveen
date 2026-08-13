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
import { resolveApgPrincipal } from '../apg-principal.js'
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
    // §11.4 human_required: an approval in that category is an owner-decision
    // class and cannot be resolved by an agent principal (§26.2). The mode is
    // the global one -- a generic approval is not scoped to a card or project,
    // so there is no narrower scope to resolve against.
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

    // Self-approval guard: the requesting agent cannot approve its own request.
    // Unchanged in strength and unchanged in honesty -- it tests the CLAIMED
    // name, so a lying client still walks past it (all fleet agents share one
    // bearer token). It catches naive/accidental self-approvals; the real
    // control lives on the main-agent side (approval-request-handling skill).
    // What DID change: this claim can no longer become the stored attribution.
    if (target && claimedBy !== null && claimedBy === target.agent_id) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

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
      { id: idMatch[1], status, resolvedBy: principal.attribution, claimedBy },
      'Approval resolved',
    )
    json(res, {
      ...approval,
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
