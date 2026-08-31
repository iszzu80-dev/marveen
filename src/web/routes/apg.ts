import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, storePath } from '../../config.js'
import {
  buildApgEvents,
  buildApgWorkItemDetail,
  buildApgWorkItemSummaries,
  getCachedApgSummary,
  invalidateApgCache,
} from '../../apg/ui-read-model.js'
import type {
  ApgClaim,
  ApgEvent,
  ApgMode,
  ApgModeSource,
  ApgScopeOverride,
  ApgUiSummary,
  ApgUiWorkItemSummary,
  ApgWorkItemDetail,
} from '../../apg/ui-types.js'
import { getApproval, resolveApproval } from '../../db.js'
import { logger } from '../../logger.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import {
  deleteScopeOverride,
  listScopeOverrides,
  resolveEffectiveApgMode,
  setScopeOverride,
  writeApgAuditEvent,
} from '../apg-scope-overrides.js'
import { resolveApgPrincipal } from '../apg-principal.js'
import { dispatchRoleDeps } from '../apg-role-agents.js'
import {
  checkHumanApprovalAuthority,
  recordApprovalAttribution,
} from '../apg-human-approval.js'
import { json, readBody } from '../http-helpers.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import type { RouteContext } from './types.js'

const APG_MODES: readonly ApgMode[] = ['off', 'observe', 'assisted', 'enforced']

/** How much authority each mode carries, least to most. Used to clamp a `?mode=`
 *  preview so it can never ask for MORE than the configuration grants (F-13). */
const APG_MODE_RANK: Record<ApgMode, number> = {
  off: 0, observe: 1, assisted: 2, enforced: 3,
}

// Idempotency replay store for POST /api/apg/approvals/:id/decision (spec
// 7.4: "same idempotency key gives the same result"). Resolving an approval
// is a one-shot state transition (db.ts's resolveApproval only succeeds from
// 'pending'), so a naive retry of an already-applied decision would hit the
// generic "already resolved" 409 path instead of replaying the ORIGINAL
// success response the first call returned -- indistinguishable, from the
// caller's side, from a genuinely conflicting second decision made with a
// different key. This small file closes that gap: recognize the exact same
// (approvalId, idempotency_key) pair and hand back the prior response
// verbatim before ever touching resolveApproval again.
const IDEMPOTENCY_PATH = () => storePath('apg-decision-idempotency.json')

interface IdempotencyRecord {
  status: number
  body: Record<string, unknown>
}

function idempotencyKey(approvalId: string, idempotencyKeyValue: string): string {
  return `${approvalId}::${idempotencyKeyValue}`
}

function readIdempotencyStore(): Record<string, IdempotencyRecord> {
  try {
    if (!existsSync(IDEMPOTENCY_PATH())) return {}
    const parsed = JSON.parse(readFileSync(IDEMPOTENCY_PATH(), 'utf-8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, IdempotencyRecord>
  } catch {
    return {}
  }
}

function recordIdempotentResponse(
  approvalId: string,
  idempotencyKeyValue: string,
  status: number,
  body: Record<string, unknown>,
): void {
  try {
    const store = readIdempotencyStore()
    store[idempotencyKey(approvalId, idempotencyKeyValue)] = { status, body }
    atomicWriteFileSync(IDEMPOTENCY_PATH(), JSON.stringify(store, null, 2) + '\n')
  } catch (err) {
    logger.warn({ err, approvalId }, 'apg idempotency write failed')
  }
}
const OWNER_ACTIONS = [
  'accept',
  'return_for_fix',
  'request_evidence',
  'block',
] as const

type OwnerAction = typeof OWNER_ACTIONS[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Exported for the F-13 test: the clamp is the security-relevant behaviour on
 *  this file, and asserting it through an endpoint that does not echo the mode
 *  would only ever test the endpoint. */
export function requestedMode(
  url: URL,
  project: string | null,
  kanbanCardId: string | null,
): { mode: ApgMode; source: ApgModeSource } | { error: string } {
  const resolved = resolveEffectiveApgMode(project, kanbanCardId)
  const explicitMode = url.searchParams.get('mode')
  if (explicitMode !== null) {
    if (!APG_MODES.includes(explicitMode as ApgMode)) {
      return { error: 'mode must be off, observe, assisted, or enforced' }
    }
    // F-13 (review 2026-08-10, fixed 2026-08-12): `?mode=` is a PREVIEW, and a
    // preview may look at less than the configuration allows, never at more.
    //
    // It used to win outright, so `?mode=enforced` re-enabled the whole feature
    // on a deployment where the owner had switched APG off — a kill switch with
    // a documented bypass in the query string is not a kill switch. It also
    // claimed `source: 'global'` while being neither global nor a resolved
    // scope, which is the same lie F-7 was about.
    //
    // So the request is CLAMPED to the resolved mode: asking for less than the
    // configuration is honoured, asking for more returns what is actually in
    // force, and the source says which one you got.
    if (APG_MODE_RANK[explicitMode as ApgMode] <= APG_MODE_RANK[resolved.mode]) {
      return { mode: explicitMode as ApgMode, source: 'request' }
    }
    return resolved
  }
  return resolved
}

function detailError(
  res: RouteContext['res'],
  detail: { error: string; notFound?: boolean },
): void {
  if (detail.notFound) {
    json(res, { error: 'Not found' }, 404)
  } else {
    json(res, { error: detail.error })
  }
}

async function readJsonBody(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await readBody(req)).toString()) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return null
  }
}

export async function tryHandleApg(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/apg/summary' && method === 'GET') {
    const project = url.searchParams.get('project')
    const kanbanCardId = url.searchParams.get('kanban_card_id')
    const effectiveMode = resolveEffectiveApgMode(project, kanbanCardId)
    const summary: ApgUiSummary = getCachedApgSummary(effectiveMode.mode)
    json(res, {
      ...summary,
      mode_source: effectiveMode.source,
      apg_ui_overview_enabled:
        String(getEffectiveSettingValue('APG_UI_OVERVIEW')) === '1',
      apg_ui_kanban_enabled:
        String(getEffectiveSettingValue('APG_UI_KANBAN')) === '1',
      apg_ui_activity_enabled:
        String(getEffectiveSettingValue('APG_UI_ACTIVITY')) === '1',
      apg_ui_evidence_enabled:
        String(getEffectiveSettingValue('APG_UI_EVIDENCE')) === '1',
      apg_ui_approval_enhancements_enabled:
        String(getEffectiveSettingValue('APG_UI_APPROVAL_ENHANCEMENTS')) === '1',
      apg_require_claim_receipt:
        String(getEffectiveSettingValue('APG_REQUIRE_CLAIM_RECEIPT')) === '1',
      apg_require_independent_acceptance:
        String(getEffectiveSettingValue('APG_REQUIRE_INDEPENDENT_ACCEPTANCE')) === '1',
      apg_require_owner_decision:
        String(getEffectiveSettingValue('APG_REQUIRE_OWNER_DECISION')) === '1',
      apg_block_unaccepted_archive:
        String(getEffectiveSettingValue('APG_BLOCK_UNACCEPTED_ARCHIVE')) === '1',
      // F-6 (APG 0.4 review): which of these toggles ACTUALLY enforces anything.
      //
      // Three of the four had no consumer: flipping "require independent
      // acceptance" set a flag, the UI reported success, and the constraint did
      // not exist. That is worse than the toggle being absent — an operator who
      // switched it on would believe the rule was in force.
      //
      // Rather than invent enforcement semantics under time pressure, this
      // states the truth the UI can render: the switch exists, and it is not
      // wired yet. The list is derived from actual call sites (see the standing
      // check in apg-enforcement-honesty.test.ts), so it cannot drift into a
      // reassuring lie of its own.
      apg_enforcement_wired: {
        require_claim_receipt: false,
        require_independent_acceptance: false,
        require_owner_decision: false,
        block_unaccepted_archive: true,
      },
      // APG 1.9 WP3 / 1.8 audit finding 3.1: `wired: true` was TRUE and still
      // misleading. block_unaccepted_archive had a consumer — in web/apg.js.
      // A control that only the browser runs is bypassed by any curl holding
      // the shared token, which is what the audit found. The boolean above
      // could not express that difference, so this second map does: it names
      // WHERE the refusal happens. 'server' is the only value that means the
      // control cannot be walked around; 'client' would be an admission.
      apg_enforcement_enforced_by: {
        require_claim_receipt: null,
        require_independent_acceptance: null,
        require_owner_decision: null,
        block_unaccepted_archive: 'server',
      },
      // §11.4, published rather than assumed: Marveen has no authenticated
      // human principal. The strongest credential is a named browser session,
      // which no dispatched agent can obtain (so §26.2 holds) but which does
      // not prove a human decided. Every human_required approval resolved on
      // this deployment carries human_principal_proven:false, and this field is
      // how a UI knows that BEFORE it renders an approval as owner-signed.
      apg_human_principal_available: false,
    })
    return true
  }

  if (path === '/api/apg/work-items' && method === 'GET') {
    const project = url.searchParams.get('project')
    const state = url.searchParams.get('state')
    const kanbanCardId = url.searchParams.get('kanban_card_id')
    const modeResult = requestedMode(url, project, kanbanCardId)
    if ('error' in modeResult) {
      json(res, { error: modeResult.error }, 400)
      return true
    }

    const limitRaw = url.searchParams.get('limit')
    const parsedLimit = limitRaw === null ? 50 : parseInt(limitRaw, 10)
    if (limitRaw !== null && Number.isNaN(parsedLimit)) {
      json(res, { error: 'limit must be numeric' }, 400)
      return true
    }
    const limit = Math.min(500, Math.max(1, parsedLimit))

    const offsetRaw = url.searchParams.get('offset')
    const parsedOffset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10)
    if (offsetRaw !== null && Number.isNaN(parsedOffset)) {
      json(res, { error: 'offset must be numeric' }, 400)
      return true
    }
    const offset = Math.max(0, parsedOffset)
    const attentionRaw = url.searchParams.get('attention')
    // §11.2: the producer/accepter columns are resolved from Marveen's own
    // dispatch store, injected here rather than reached for inside the
    // kernel-read-only projection.
    const result = buildApgWorkItemSummaries(modeResult.mode, {
      modeSource: modeResult.source,
      project: project ?? undefined,
      state: state ?? undefined,
      attention: attentionRaw === '1' || attentionRaw === 'true',
      kanbanCardId: kanbanCardId ?? undefined,
      limit,
      offset,
    }, dispatchRoleDeps())
    if ('error' in result) {
      json(res, { items: [], total: 0, limit, offset, error: result.error })
      return true
    }
    const items: ApgUiWorkItemSummary[] = result.items
    json(res, { items, total: result.total, limit, offset })
    return true
  }

  const workItemMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)$/)
  if (workItemMatch && method === 'GET') {
    let workItemId: string
    try {
      workItemId = decodeURIComponent(workItemMatch[1])
    } catch {
      json(res, { error: 'Invalid work item id' }, 400)
      return true
    }
    const modeResult = requestedMode(url, null, workItemId)
    if ('error' in modeResult) {
      json(res, { error: modeResult.error }, 400)
      return true
    }
    // Both arguments are load-bearing and neither replaces the other: F-7 needs
    // `modeResult.source` so a card-level override is visible on the detail
    // screen, and §11.2 needs the dispatch-role reader so producer_agent is a
    // resolved value rather than a hardcoded null.
    const detail = buildApgWorkItemDetail(
      modeResult.mode, workItemId, modeResult.source, dispatchRoleDeps(),
    )
    if ('error' in detail) {
      detailError(res, detail)
      return true
    }
    const response: ApgWorkItemDetail = detail
    json(res, response)
    return true
  }

  const claimsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/claims$/)
  if (claimsMatch && method === 'GET') {
    let workItemId: string
    try {
      workItemId = decodeURIComponent(claimsMatch[1])
    } catch {
      json(res, { error: 'Invalid work item id' }, 400)
      return true
    }
    const modeResult = requestedMode(url, null, workItemId)
    if ('error' in modeResult) {
      json(res, { error: modeResult.error }, 400)
      return true
    }
    const detail = buildApgWorkItemDetail(modeResult.mode, workItemId, modeResult.source)
    if ('error' in detail) {
      detailError(res, detail)
      return true
    }
    const claims: ApgClaim[] = detail.claims
    json(res, { claims })
    return true
  }

  const receiptsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/receipts$/)
  if (receiptsMatch && method === 'GET') {
    let workItemId: string
    try {
      workItemId = decodeURIComponent(receiptsMatch[1])
    } catch {
      json(res, { error: 'Invalid work item id' }, 400)
      return true
    }
    const modeResult = requestedMode(url, null, workItemId)
    if ('error' in modeResult) {
      json(res, { error: modeResult.error }, 400)
      return true
    }
    const detail = buildApgWorkItemDetail(modeResult.mode, workItemId, modeResult.source)
    if ('error' in detail) {
      detailError(res, detail)
      return true
    }
    const receipts: ApgWorkItemDetail['receipts'] = detail.receipts
    json(res, { receipts })
    return true
  }

  const eventsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/events$/)
  if (eventsMatch && method === 'GET') {
    let workItemId: string
    try {
      workItemId = decodeURIComponent(eventsMatch[1])
    } catch {
      json(res, { error: 'Invalid work item id' }, 400)
      return true
    }
    const modeResult = requestedMode(url, null, workItemId)
    if ('error' in modeResult) {
      json(res, { error: modeResult.error }, 400)
      return true
    }
    const detail = buildApgWorkItemDetail(modeResult.mode, workItemId, modeResult.source)
    if ('error' in detail) {
      detailError(res, detail)
      return true
    }
    const events: ApgEvent[] = detail.events
    json(res, { events })
    return true
  }

  if (path === '/api/apg/scope-overrides' && method === 'GET') {
    json(res, { overrides: listScopeOverrides() })
    return true
  }

  if (path === '/api/apg/scope-overrides' && method === 'PUT') {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (typeof body.actor !== 'string' || !body.actor.trim()) {
      json(res, { error: 'actor is required' }, 400)
      return true
    }
    // §24.0.5 (1.8 audit finding 3.2): the body's `actor` stops being the
    // identity and becomes a labelled claim; the authority decision is made
    // against the credential that authenticated this request.
    const result = setScopeOverride({
      scope_type: body.scope_type as ApgScopeOverride['scope_type'],
      scope_id: typeof body.scope_id === 'string' ? body.scope_id : '',
      mode: typeof body.mode === 'string' ? body.mode : '',
      claimed_actor: body.actor.trim(),
      reason: typeof body.reason === 'string' ? body.reason : '',
      ttl_minutes: typeof body.ttl_minutes === 'number' ? body.ttl_minutes : null,
    }, resolveApgPrincipal(ctx.auth))
    if (!result.ok) {
      json(res, { error: result.error }, result.status ?? 400)
      return true
    }
    invalidateApgCache()
    json(res, { override: result.override })
    return true
  }

  const scopeDeleteMatch = path.match(
    /^\/api\/apg\/scope-overrides\/([^/]+)\/([^/]+)$/,
  )
  if (scopeDeleteMatch && method === 'DELETE') {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const scopeType = scopeDeleteMatch[1]
    if (scopeType !== 'project' && scopeType !== 'kanban_card') {
      json(res, { error: 'scope_type must be project or kanban_card' }, 400)
      return true
    }
    let scopeId: string
    try {
      scopeId = decodeURIComponent(scopeDeleteMatch[2])
    } catch {
      json(res, { error: 'Invalid scope id' }, 400)
      return true
    }
    const result = deleteScopeOverride(
      scopeType,
      scopeId,
      typeof body.actor === 'string' ? body.actor : '',
      typeof body.reason === 'string' ? body.reason : '',
      resolveApgPrincipal(ctx.auth),
    )
    if (!result.ok) {
      json(res, { error: result.error }, result.status ?? 400)
      return true
    }
    invalidateApgCache()
    json(res, { ok: true })
    return true
  }

  const approvalDecisionMatch = path.match(
    /^\/api\/apg\/approvals\/([^/]+)\/decision$/,
  )
  if (approvalDecisionMatch && method === 'POST') {
    const body = await readJsonBody(req)
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (
      typeof body.action !== 'string'
      || !OWNER_ACTIONS.includes(body.action as OwnerAction)
    ) {
      json(res, {
        error: 'action must be accept, return_for_fix, request_evidence, or block',
      }, 400)
      return true
    }
    if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
      json(res, { error: 'idempotency_key is required' }, 400)
      return true
    }
    const idempotencyKeyValue = body.idempotency_key.trim()

    let approvalId: string
    try {
      approvalId = decodeURIComponent(approvalDecisionMatch[1])
    } catch {
      json(res, { error: 'Invalid approval id' }, 400)
      return true
    }

    const priorReplay = readIdempotencyStore()[idempotencyKey(approvalId, idempotencyKeyValue)]
    if (priorReplay) {
      json(res, priorReplay.body, priorReplay.status)
      return true
    }

    const approval = getApproval(approvalId)
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    if (approval.status !== 'pending') {
      json(res, {
        error: 'Ezt a kérést már eldöntötték.',
        status: approval.status,
        resolved_by: approval.resolved_by,
        resolved_at: approval.resolved_at,
      }, 409)
      return true
    }

    const action = body.action as OwnerAction
    const mappedStatus = action === 'accept' ? 'approved' : 'rejected'

    // §11.4 (1.8 audit finding 3.3): this route already stamped server-side,
    // but it stamped 'dashboard' -- the SURFACE a click arrived on, not the
    // principal who made the decision. §11.4 asks for an attribution that names
    // the decider. resolveApgPrincipal gives the strongest name the credential
    // supports, and apg-human-approval.ts decides whether that name is allowed
    // to resolve THIS approval's category at all.
    const principal = resolveApgPrincipal(ctx.auth)
    // An approval row carries no card/project link, so the mode is the global
    // one. Resolving it against a scope we do not have would be a guess, and a
    // guessed mode here would decide whether §25 fails open or closed.
    const decisionMode = resolveEffectiveApgMode(null, null).mode
    const verdict = checkHumanApprovalAuthority(principal, approval.category, decisionMode)
    if (!verdict.allowed) {
      recordApprovalAttribution({
        approval_id: approvalId,
        category: approval.category,
        status: `refused:${mappedStatus}`,
        principal,
        claimed_by: typeof body.actor === 'string' ? body.actor : null,
        mode: decisionMode,
        verdict,
        surface: 'apg_decision',
      })
      json(res, { error: verdict.error }, verdict.status ?? 403)
      return true
    }

    // F-5 (APG 0.4 review): the same self-approval guard the generic approvals
    // route has. §27 makes weakening it an explicit stop condition, and this
    // path simply did not have it.
    //
    // What it is and is not, stated plainly: `resolved_by` is self-declared and
    // every fleet agent shares one bearer token, so this cannot stop a lying
    // client — the generic route's own comment calls it best-effort for exactly
    // that reason. What it does catch is the naive/accidental case, which is
    // what the guard was built for, and which went through here unchecked.
    //
    // WP3 update: with `resolved_by` server-stamped, the old form of this check
    // (`agent_id === 'dashboard'`) compared against the surface name this route
    // used to write, and would now never fire. The comparison moves to the
    // CLAIMED actor -- the only place an agent id can still appear -- which is
    // the same best-effort footing the generic route's guard stands on, and is
    // stated as such rather than upgraded by implication.
    const pending = getApproval(approvalId)
    const claimedActor = typeof body.actor === 'string' ? body.actor.trim() : ''
    if (pending?.agent_id && (pending.agent_id === 'dashboard' || pending.agent_id === claimedActor)) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    const resolved = resolveApproval(approvalId, mappedStatus, principal.attribution, undefined)
    if (!resolved) {
      const racedApproval = getApproval(approvalId)
      json(res, {
        error: 'Ezt a kérést már eldöntötték.',
        status: racedApproval?.status,
        resolved_by: racedApproval?.resolved_by,
        resolved_at: racedApproval?.resolved_at,
      }, 409)
      return true
    }

    writeApgAuditEvent('owner_decision', {
      approval_id: approvalId,
      action,
      note: body.note ?? null,
      idempotency_key: idempotencyKeyValue,
      // Was the literal 'dashboard'. §11.4: name the principal, not the surface
      // -- the surface is still recorded, under its own key, because knowing
      // WHERE a decision arrived is useful once it no longer pretends to be WHO.
      actor: principal.attribution,
      principal_class: principal.class,
      surface: 'dashboard',
    })
    recordApprovalAttribution({
      approval_id: approvalId,
      category: approval.category,
      status: mappedStatus,
      principal,
      claimed_by: typeof body.actor === 'string' ? body.actor : null,
      mode: decisionMode,
      verdict,
      surface: 'apg_decision',
    })
    invalidateApgCache()
    const updatedApproval = getApproval(approvalId)
    logger.info({
      event_id: randomUUID(),
      approval_id: approvalId,
      action,
      resolvedBy: principal.attribution,
    }, 'apg owner decision recorded')
    const responseBody = {
      ...updatedApproval,
      apg_action: action,
      // §25: never a false PASS. A human_required decision resolved without a
      // provable human principal says so in the response body itself, so no UI
      // downstream can render it as owner-authenticated by omission.
      human_principal_proven: verdict.humanPrincipalProven,
      human_attestation: principal.humanAttestation,
    }
    recordIdempotentResponse(approvalId, idempotencyKeyValue, 200, responseBody)
    json(res, responseBody)
    return true
  }

  // GET /api/apg/events -- consolidated event feed for the Activity page (spec 13, item 5/5).
  if (path === '/api/apg/events' && method === 'GET') {
    const limitRaw = url.searchParams.get('limit')
    const parsedLimit = limitRaw === null ? 50 : parseInt(limitRaw, 10)
    if (limitRaw !== null && Number.isNaN(parsedLimit)) {
      json(res, { error: 'limit must be numeric' }, 400)
      return true
    }
    const limit = Math.min(500, Math.max(1, parsedLimit))

    const offsetRaw = url.searchParams.get('offset')
    const parsedOffset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10)
    if (offsetRaw !== null && Number.isNaN(parsedOffset)) {
      json(res, { error: 'offset must be numeric' }, 400)
      return true
    }
    const offset = Math.max(0, parsedOffset)

    const result = buildApgEvents(limit, offset)
    if ('error' in result) {
      json(res, { events: [], total: 0, limit, offset, error: result.error })
      return true
    }
    json(res, result)
    return true
  }

  return false
}
