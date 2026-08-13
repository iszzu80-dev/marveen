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

/** Who is actually making this request, according to the auth gate — not
 *  according to the request body.
 *
 *  WHY THE BODY IS NOT AN ANSWER. Resolution identity used to be `resolved_by`
 *  from the JSON body, guarded by `resolved_by === target.agent_id`. Every fleet
 *  agent holds the same bearer token, so any of them could approve its own
 *  request by writing `resolved_by: "istvan"`. The string compare is not a weak
 *  check, it is a check of a value the caller chooses — the same shape the
 *  codebase already refused once for hard-gated escalations (routes/cos.ts
 *  removed the move entirely rather than trust a claimed actor).
 *
 *  What the gate can prove, in descending strength:
 *    session  — a human logged into the dashboard. Names a person.
 *    device   — an enrolled device key. Names a device.
 *    token    — the SHARED dashboard bearer. Names NOTHING: every fleet agent
 *               has it, so a token request cannot prove it is not the requester.
 *    federation — a peer instance. Never a party to this instance's approvals.
 *
 *  RESIDUAL GAP, stated rather than hidden: with only the shared token there is
 *  no server-side identity to bind to, so the permissive direction (approve) is
 *  refused for token callers and the remedy is named in the response. Closing
 *  the gap properly means per-agent credentials; until then a fail-closed
 *  refusal beats a bypassable string compare. */
function resolutionPrincipal(ctx: RouteContext): { id: string; strong: boolean } | null {
  const auth = ctx.auth
  if (!auth) return null
  if (auth.kind === 'session' && auth.user) return { id: `user:${auth.user}`, strong: true }
  if (auth.kind === 'device' && auth.device) return { id: `device:${auth.device}`, strong: true }
  if (auth.kind === 'token') return { id: 'fleet-token', strong: false }
  return null   // federation, or an auth kind with no identity in it
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
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
      json(res, { error: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    const principal = resolutionPrincipal(ctx)
    if (!principal) {
      json(res, { error: 'Ehhez a művelethez azonosított hívó kell (bejelentkezés vagy eszközkulcs)' }, 403)
      return true
    }

    const target = getApproval(idMatch[1])

    // APPROVING NEEDS A PROVABLE PRINCIPAL. Rejecting and timing out do not.
    //
    // The asymmetry is the point: approve GRANTS authority, and a caller that
    // cannot prove it is not the requesting agent must not be able to grant it
    // to itself. Reject/timeout only take authority away — a self-rejection
    // gains an agent nothing — so the shared token stays usable for the
    // direction that cannot be abused, and the Telegram "NEM" relay keeps
    // working unchanged.
    if (status === 'approved' && !principal.strong) {
      json(res, {
        error: 'Jóváhagyáshoz azonosított hívó kell: jelentkezz be a dashboardon, vagy használj eszközkulcsot. '
          + 'A megosztott flotta-token nem bizonyítja, hogy nem a kérelmező ügynök az.',
        code: 'unattributable_caller',
      }, 403)
      return true
    }

    // Self-approval guard, kept as defence in depth for the strong principals
    // too: a device key named after an agent must not resolve that agent's own
    // request. The claimed body value is checked as well, because a caller that
    // names itself as the requester is telling us something true about intent.
    if (target && (principal.id === target.agent_id || resolved_by.trim() === target.agent_id)) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    // The AUTHENTICATED identity is what goes into the audit column; the
    // self-declared label survives only as an annotation, and only because
    // "telegram_text" vs "dashboard" is genuinely useful provenance. A reader of
    // this column can now tell what was proved from what was claimed.
    const resolvedBy = `${principal.id} (${resolved_by.trim()})`
    const updated = resolveApproval(idMatch[1], status, resolvedBy, msgId)
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
    logger.info({ id: idMatch[1], status, resolved_by: resolvedBy, principal: principal.id }, 'Approval resolved')
    json(res, approval)
    return true
  }

  return false
}
