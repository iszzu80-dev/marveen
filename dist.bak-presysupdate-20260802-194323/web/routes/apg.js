import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../config.js';
import { buildApgWorkItemDetail, buildApgWorkItemSummaries, getCachedApgSummary, invalidateApgCache, } from '../../apg/ui-read-model.js';
import { getApproval, resolveApproval } from '../../db.js';
import { logger } from '../../logger.js';
import { getEffectiveSettingValue } from '../../settings-store.js';
import { deleteScopeOverride, listScopeOverrides, resolveEffectiveApgMode, setScopeOverride, writeApgAuditEvent, } from '../apg-scope-overrides.js';
import { json, readBody } from '../http-helpers.js';
import { atomicWriteFileSync } from '../atomic-write.js';
const APG_MODES = ['off', 'observe', 'assisted', 'enforced'];
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
const IDEMPOTENCY_PATH = join(PROJECT_ROOT, 'store', 'apg-decision-idempotency.json');
function idempotencyKey(approvalId, idempotencyKeyValue) {
    return `${approvalId}::${idempotencyKeyValue}`;
}
function readIdempotencyStore() {
    try {
        if (!existsSync(IDEMPOTENCY_PATH))
            return {};
        const parsed = JSON.parse(readFileSync(IDEMPOTENCY_PATH, 'utf-8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
function recordIdempotentResponse(approvalId, idempotencyKeyValue, status, body) {
    try {
        const store = readIdempotencyStore();
        store[idempotencyKey(approvalId, idempotencyKeyValue)] = { status, body };
        atomicWriteFileSync(IDEMPOTENCY_PATH, JSON.stringify(store, null, 2) + '\n');
    }
    catch (err) {
        logger.warn({ err, approvalId }, 'apg idempotency write failed');
    }
}
const OWNER_ACTIONS = [
    'accept',
    'return_for_fix',
    'request_evidence',
    'block',
];
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requestedMode(url, project, kanbanCardId) {
    const explicitMode = url.searchParams.get('mode');
    if (explicitMode !== null) {
        if (!APG_MODES.includes(explicitMode)) {
            return { error: 'mode must be off, observe, assisted, or enforced' };
        }
        return { mode: explicitMode, source: 'global' };
    }
    return resolveEffectiveApgMode(project, kanbanCardId);
}
function detailError(res, detail) {
    if (detail.notFound) {
        json(res, { error: 'Not found' }, 404);
    }
    else {
        json(res, { error: detail.error });
    }
}
async function readJsonBody(req) {
    try {
        const parsed = JSON.parse((await readBody(req)).toString());
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return null;
    }
}
export async function tryHandleApg(ctx) {
    const { req, res, path, method, url } = ctx;
    if (path === '/api/apg/summary' && method === 'GET') {
        const project = url.searchParams.get('project');
        const kanbanCardId = url.searchParams.get('kanban_card_id');
        const effectiveMode = resolveEffectiveApgMode(project, kanbanCardId);
        const summary = getCachedApgSummary(effectiveMode.mode);
        json(res, {
            ...summary,
            mode_source: effectiveMode.source,
            apg_ui_overview_enabled: String(getEffectiveSettingValue('APG_UI_OVERVIEW')) === '1',
        });
        return true;
    }
    if (path === '/api/apg/work-items' && method === 'GET') {
        const project = url.searchParams.get('project');
        const state = url.searchParams.get('state');
        const kanbanCardId = url.searchParams.get('kanban_card_id');
        const modeResult = requestedMode(url, project, kanbanCardId);
        if ('error' in modeResult) {
            json(res, { error: modeResult.error }, 400);
            return true;
        }
        const limitRaw = url.searchParams.get('limit');
        const parsedLimit = limitRaw === null ? 50 : parseInt(limitRaw, 10);
        if (limitRaw !== null && Number.isNaN(parsedLimit)) {
            json(res, { error: 'limit must be numeric' }, 400);
            return true;
        }
        const limit = Math.min(500, Math.max(1, parsedLimit));
        const offsetRaw = url.searchParams.get('offset');
        const parsedOffset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10);
        if (offsetRaw !== null && Number.isNaN(parsedOffset)) {
            json(res, { error: 'offset must be numeric' }, 400);
            return true;
        }
        const offset = Math.max(0, parsedOffset);
        const attentionRaw = url.searchParams.get('attention');
        const result = buildApgWorkItemSummaries(modeResult.mode, {
            project: project ?? undefined,
            state: state ?? undefined,
            attention: attentionRaw === '1' || attentionRaw === 'true',
            kanbanCardId: kanbanCardId ?? undefined,
            limit,
            offset,
        });
        if ('error' in result) {
            json(res, { items: [], total: 0, limit, offset, error: result.error });
            return true;
        }
        const items = result.items;
        json(res, { items, total: result.total, limit, offset });
        return true;
    }
    const workItemMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)$/);
    if (workItemMatch && method === 'GET') {
        let workItemId;
        try {
            workItemId = decodeURIComponent(workItemMatch[1]);
        }
        catch {
            json(res, { error: 'Invalid work item id' }, 400);
            return true;
        }
        const modeResult = requestedMode(url, null, workItemId);
        if ('error' in modeResult) {
            json(res, { error: modeResult.error }, 400);
            return true;
        }
        const detail = buildApgWorkItemDetail(modeResult.mode, workItemId);
        if ('error' in detail) {
            detailError(res, detail);
            return true;
        }
        const response = detail;
        json(res, response);
        return true;
    }
    const claimsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/claims$/);
    if (claimsMatch && method === 'GET') {
        let workItemId;
        try {
            workItemId = decodeURIComponent(claimsMatch[1]);
        }
        catch {
            json(res, { error: 'Invalid work item id' }, 400);
            return true;
        }
        const modeResult = requestedMode(url, null, workItemId);
        if ('error' in modeResult) {
            json(res, { error: modeResult.error }, 400);
            return true;
        }
        const detail = buildApgWorkItemDetail(modeResult.mode, workItemId);
        if ('error' in detail) {
            detailError(res, detail);
            return true;
        }
        const claims = detail.claims;
        json(res, { claims });
        return true;
    }
    const receiptsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/receipts$/);
    if (receiptsMatch && method === 'GET') {
        let workItemId;
        try {
            workItemId = decodeURIComponent(receiptsMatch[1]);
        }
        catch {
            json(res, { error: 'Invalid work item id' }, 400);
            return true;
        }
        const modeResult = requestedMode(url, null, workItemId);
        if ('error' in modeResult) {
            json(res, { error: modeResult.error }, 400);
            return true;
        }
        const detail = buildApgWorkItemDetail(modeResult.mode, workItemId);
        if ('error' in detail) {
            detailError(res, detail);
            return true;
        }
        const receipts = detail.receipts;
        json(res, { receipts });
        return true;
    }
    const eventsMatch = path.match(/^\/api\/apg\/work-items\/([^/]+)\/events$/);
    if (eventsMatch && method === 'GET') {
        let workItemId;
        try {
            workItemId = decodeURIComponent(eventsMatch[1]);
        }
        catch {
            json(res, { error: 'Invalid work item id' }, 400);
            return true;
        }
        const modeResult = requestedMode(url, null, workItemId);
        if ('error' in modeResult) {
            json(res, { error: modeResult.error }, 400);
            return true;
        }
        const detail = buildApgWorkItemDetail(modeResult.mode, workItemId);
        if ('error' in detail) {
            detailError(res, detail);
            return true;
        }
        const events = detail.events;
        json(res, { events });
        return true;
    }
    if (path === '/api/apg/scope-overrides' && method === 'GET') {
        json(res, { overrides: listScopeOverrides() });
        return true;
    }
    if (path === '/api/apg/scope-overrides' && method === 'PUT') {
        const body = await readJsonBody(req);
        if (body === null) {
            json(res, { error: 'Invalid JSON' }, 400);
            return true;
        }
        if (typeof body.actor !== 'string' || !body.actor.trim()) {
            json(res, { error: 'actor is required' }, 400);
            return true;
        }
        const result = setScopeOverride({
            scope_type: body.scope_type,
            scope_id: typeof body.scope_id === 'string' ? body.scope_id : '',
            mode: typeof body.mode === 'string' ? body.mode : '',
            updated_by: body.actor.trim(),
            reason: typeof body.reason === 'string' ? body.reason : '',
        });
        if (!result.ok) {
            json(res, { error: result.error }, 400);
            return true;
        }
        invalidateApgCache();
        json(res, { override: result.override });
        return true;
    }
    const scopeDeleteMatch = path.match(/^\/api\/apg\/scope-overrides\/([^/]+)\/([^/]+)$/);
    if (scopeDeleteMatch && method === 'DELETE') {
        const body = await readJsonBody(req);
        if (body === null) {
            json(res, { error: 'Invalid JSON' }, 400);
            return true;
        }
        const scopeType = scopeDeleteMatch[1];
        if (scopeType !== 'project' && scopeType !== 'kanban_card') {
            json(res, { error: 'scope_type must be project or kanban_card' }, 400);
            return true;
        }
        let scopeId;
        try {
            scopeId = decodeURIComponent(scopeDeleteMatch[2]);
        }
        catch {
            json(res, { error: 'Invalid scope id' }, 400);
            return true;
        }
        const result = deleteScopeOverride(scopeType, scopeId, typeof body.actor === 'string' ? body.actor : '', typeof body.reason === 'string' ? body.reason : '');
        if (!result.ok) {
            json(res, { error: result.error }, 400);
            return true;
        }
        invalidateApgCache();
        json(res, { ok: true });
        return true;
    }
    const approvalDecisionMatch = path.match(/^\/api\/apg\/approvals\/([^/]+)\/decision$/);
    if (approvalDecisionMatch && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) {
            json(res, { error: 'Invalid JSON' }, 400);
            return true;
        }
        if (typeof body.action !== 'string'
            || !OWNER_ACTIONS.includes(body.action)) {
            json(res, {
                error: 'action must be accept, return_for_fix, request_evidence, or block',
            }, 400);
            return true;
        }
        if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
            json(res, { error: 'idempotency_key is required' }, 400);
            return true;
        }
        const idempotencyKeyValue = body.idempotency_key.trim();
        let approvalId;
        try {
            approvalId = decodeURIComponent(approvalDecisionMatch[1]);
        }
        catch {
            json(res, { error: 'Invalid approval id' }, 400);
            return true;
        }
        const priorReplay = readIdempotencyStore()[idempotencyKey(approvalId, idempotencyKeyValue)];
        if (priorReplay) {
            json(res, priorReplay.body, priorReplay.status);
            return true;
        }
        const approval = getApproval(approvalId);
        if (!approval) {
            json(res, { error: 'Not found' }, 404);
            return true;
        }
        if (approval.status !== 'pending') {
            json(res, {
                error: 'Ezt a kérést már eldöntötték.',
                status: approval.status,
                resolved_by: approval.resolved_by,
                resolved_at: approval.resolved_at,
            }, 409);
            return true;
        }
        const action = body.action;
        const mappedStatus = action === 'accept' ? 'approved' : 'rejected';
        const resolved = resolveApproval(approvalId, mappedStatus, 'dashboard', undefined);
        if (!resolved) {
            const racedApproval = getApproval(approvalId);
            json(res, {
                error: 'Ezt a kérést már eldöntötték.',
                status: racedApproval?.status,
                resolved_by: racedApproval?.resolved_by,
                resolved_at: racedApproval?.resolved_at,
            }, 409);
            return true;
        }
        writeApgAuditEvent('owner_decision', {
            approval_id: approvalId,
            action,
            note: body.note ?? null,
            idempotency_key: idempotencyKeyValue,
            actor: 'dashboard',
        });
        invalidateApgCache();
        const updatedApproval = getApproval(approvalId);
        logger.info({
            event_id: randomUUID(),
            approval_id: approvalId,
            action,
        }, 'apg owner decision recorded');
        const responseBody = { ...updatedApproval, apg_action: action };
        recordIdempotentResponse(approvalId, idempotencyKeyValue, 200, responseBody);
        json(res, responseBody);
        return true;
    }
    return false;
}
