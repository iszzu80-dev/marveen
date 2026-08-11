// Shared Action Executor core. The crash-safe outbound state machine is the SAME
// for the Personal COS (`outbound_ledger`) and the ZST executor
// (`zst_outbound_ledger`) — only the ledger table name differs.
// `makeExecutor(ledgerTable)` binds it; the state-machine logic below is
// byte-for-byte the proven personal executor (its 15 tests are the safety net).
// The one invariant everything serves: never call adapter.send() twice for the
// same action without a readback first PROVING the prior attempt did not reach
// the provider.
import { reserveQuota } from './quota.js';
export const TERMINAL_STATUSES = ['VERIFIED', 'FAILED_TERMINAL', 'CANCELLED'];
export const NON_RESENDABLE_STATUSES = ['APPLIED_UNVERIFIED', 'RECOVERY_REQUIRED'];
export class SendError extends Error {
    reachedProvider;
    terminal;
    constructor(message, hints = {}) {
        super(message);
        this.name = 'SendError';
        this.reachedProvider = hints.reachedProvider;
        this.terminal = hints.terminal;
    }
}
export function idempotencyKey(caseId, actionType, sequenceNumber) {
    return `mv-${caseId}-${actionType}-${sequenceNumber}`;
}
function toAction(r) {
    return {
        ledgerId: r.ledger_id, caseId: r.case_id, actionType: r.action_type,
        sequenceNumber: r.sequence_number, internalIdempotencyKey: r.internal_idempotency_key,
        externalIdempotencyMarker: r.external_idempotency_marker ?? r.internal_idempotency_key,
        payload: r.payload == null ? null : JSON.parse(r.payload),
        status: r.status, externalRef: r.external_ref, attempt: r.attempt,
    };
}
/** Build an executor bound to one outbound-ledger table. Logic is identical to
 *  the proven personal executor. */
export function makeExecutor(ledgerTable) {
    const T = ledgerTable;
    function loadOrThrow(db, ledgerId) {
        const r = db.prepare(`SELECT * FROM ${T} WHERE ledger_id = ?`).get(ledgerId);
        if (!r)
            throw new Error(`${T} row not found: ${ledgerId}`);
        return toAction(r);
    }
    function setStatus(db, ledgerId, status, fields, now) {
        const cols = ['status = @status', 'updated_at = @now'];
        const params = { ledgerId, status, now };
        for (const [k, v] of Object.entries(fields)) {
            cols.push(`${k} = @${k}`);
            params[k] = v;
        }
        db.prepare(`UPDATE ${T} SET ${cols.join(', ')} WHERE ledger_id = @ledgerId`).run(params);
    }
    function planAction(db, input, now) {
        const key = idempotencyKey(input.caseId, input.actionType, input.sequenceNumber);
        const ledgerId = `ob-${key}`;
        const marker = input.externalMarker ?? key;
        db.prepare(`INSERT INTO ${T}
         (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
          external_idempotency_marker, status, payload, attempt, created_at, updated_at)
       VALUES (@ledgerId, @caseId, @actionType, @sequenceNumber, @key,
          @marker, 'PLANNED', @payload, 0, @now, @now)`).run({
            ledgerId, caseId: input.caseId, actionType: input.actionType, sequenceNumber: input.sequenceNumber,
            key, marker, payload: input.payload === undefined ? null : JSON.stringify(input.payload), now,
        });
        return loadOrThrow(db, ledgerId);
    }
    async function executeAction(db, adapter, ledgerId, now, opts = {}) {
        const a = loadOrThrow(db, ledgerId);
        if (TERMINAL_STATUSES.includes(a.status))
            return a;
        if (a.status === 'APPLIED_UNVERIFIED')
            return verifyAction(db, adapter, ledgerId, now);
        if (a.status === 'RECOVERY_REQUIRED')
            return a;
        if (a.status === 'SENDING' || a.status === 'OUTCOME_UNKNOWN')
            return recoverAction(db, adapter, ledgerId, now);
        if (opts.quota) {
            const rr = reserveQuota(db, opts.quota.key, opts.quota.maxCount, opts.quota.windowSec, now);
            if (!rr.reserved) {
                setStatus(db, ledgerId, 'PLANNED', { last_error: `send quota exceeded for ${opts.quota.key}` }, now);
                return loadOrThrow(db, ledgerId);
            }
        }
        setStatus(db, ledgerId, 'SENDING', { sending_at: now, attempt: a.attempt + 1 }, now);
        let externalRef;
        try {
            const r = await adapter.send(loadOrThrow(db, ledgerId));
            externalRef = r.externalRef;
        }
        catch (err) {
            const hints = err;
            const msg = String(err?.message ?? err);
            if (hints?.reachedProvider === false) {
                setStatus(db, ledgerId, hints.terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE', { last_error: msg }, now);
            }
            else {
                setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: msg }, now);
            }
            return loadOrThrow(db, ledgerId);
        }
        setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { external_ref: externalRef, applied_at: now }, now);
        return verifyAction(db, adapter, ledgerId, now);
    }
    async function verifyAction(db, adapter, ledgerId, now) {
        const a = loadOrThrow(db, ledgerId);
        let rb;
        try {
            rb = await adapter.readback(a.externalIdempotencyMarker);
        }
        catch (err) {
            setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: `readback unavailable: ${String(err?.message ?? err)}` }, now);
            return loadOrThrow(db, ledgerId);
        }
        if (rb.found) {
            setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now);
        }
        else if (rb.available === false) {
            setStatus(db, ledgerId, 'APPLIED_UNVERIFIED', { last_error: 'readback unavailable' }, now);
        }
        else {
            setStatus(db, ledgerId, 'RECOVERY_REQUIRED', { last_error: 'provider reported success but marker absent on readback' }, now);
        }
        return loadOrThrow(db, ledgerId);
    }
    async function recoverAction(db, adapter, ledgerId, now) {
        const a = loadOrThrow(db, ledgerId);
        let rb;
        try {
            rb = await adapter.readback(a.externalIdempotencyMarker);
        }
        catch (err) {
            setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: `readback unavailable: ${String(err?.message ?? err)}` }, now);
            return loadOrThrow(db, ledgerId);
        }
        if (rb.found) {
            setStatus(db, ledgerId, 'VERIFIED', { verified_at: now, external_ref: rb.externalRef ?? a.externalRef }, now);
        }
        else if (rb.available === false) {
            setStatus(db, ledgerId, 'OUTCOME_UNKNOWN', { last_error: 'readback unavailable' }, now);
        }
        else {
            setStatus(db, ledgerId, 'PLANNED', {}, now);
        }
        return loadOrThrow(db, ledgerId);
    }
    function cancelAction(db, ledgerId, reason, now) {
        const a = loadOrThrow(db, ledgerId);
        if (a.status !== 'PLANNED' && a.status !== 'FAILED_RETRYABLE') {
            throw new Error(`cannot cancel ${a.status} action ${ledgerId} (provider may already have it)`);
        }
        setStatus(db, ledgerId, 'CANCELLED', { last_error: reason }, now);
        return loadOrThrow(db, ledgerId);
    }
    return { planAction, executeAction, verifyAction, recoverAction, cancelAction, ledgerTable: T };
}
