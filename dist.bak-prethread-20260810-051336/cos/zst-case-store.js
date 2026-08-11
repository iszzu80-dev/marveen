// ZST Radio Kft. Corporate Case Engine (Slice 0). Binds the SHARED case engine
// (case-engine-core.ts) to the ZST table namespace + the ZST status set + ZST
// defaults. Same three invariants as Personal (optimistic concurrency,
// append-only audit, claim fencing) — the logic is not duplicated, it is the
// same core over different tables (arch option A). Slice 0 = case engine only:
// no external writers, no send. `workspace` (OPERATIONS | PRODUCT_LAB) is the
// thin routing tag; it routes work, it does not enforce isolation (the separate
// ZST Google account already does that).
import { getDb } from '../db.js';
import { makeCaseEngine, } from './case-engine-core.js';
import { guardCaseCompletion, completionActor } from './progression-completion.js';
const ZST_TABLES = {
    cases: 'zst_cases',
    events: 'zst_case_events',
    claims: 'zst_case_claims',
};
const ZST_DEFAULTS = {
    status: 'NEW', priority: 'P2', owner: 'marveen', sensitivity: 'ZST_INTERNAL', actor: 'marveen',
};
// ZST status semantics (spec §8.3): FAILED_TERMINAL is closed; INFORMATION_REQUIRED
// / REVIEW_REQUIRED / AWAITING_INTERNAL_INPUT want attention (note the different
// spelling from Personal's INFO_REQUIRED — this is why the read-view sets are
// per-namespace).
const ZST_STATUS_SETS = {
    terminal: ['COMPLETED', 'CANCELLED', 'ARCHIVED', 'FAILED_TERMINAL'],
    attention: ['INFORMATION_REQUIRED', 'FOLLOW_UP_DUE', 'CALL_REQUIRED', 'AWAITING_SELECTION',
        'RECOVERY_REQUIRED', 'REVIEW_REQUIRED', 'AWAITING_INTERNAL_INPUT'],
};
const engine = makeCaseEngine(ZST_TABLES, ZST_DEFAULTS, ZST_STATUS_SETS);
/** Create a ZST case (core create) and set its routing tag / product link. The
 *  routing columns default safely (workspace=OPERATIONS) so a create without
 *  them is a valid Operations case. */
export function createZstCase(db, input, now) {
    const row = engine.createCase(db, input, now);
    if (input.workspace || input.productId) {
        db.prepare(`UPDATE zst_cases SET workspace = COALESCE(@w, workspace), product_id = COALESCE(@p, product_id)
       WHERE case_id = @id`).run({ w: input.workspace ?? null, p: input.productId ?? null, id: input.caseId });
        return engine.getCase(db, input.caseId);
    }
    return row;
}
export function appendZstCaseEvent(db, ev, now) {
    return engine.appendCaseEvent(db, ev, now);
}
export function getZstCase(db, caseId) {
    return engine.getCase(db, caseId);
}
export function listActiveZstCases(db) {
    return engine.listActiveCases(db);
}
export function listTodayZstCases(db, horizonSec) {
    return engine.listTodayCases(db, horizonSec);
}
export function transitionZstCase(db, input, now) {
    // Checkpoint E.4 completion guard: for progression-enabled ZST cases,
    // DoD must be met before the case can transition to COMPLETED.
    if (input.newStatus === 'COMPLETED') {
        guardCaseCompletion(db, 'zst', input.caseId, completionActor(input.actor));
    }
    return engine.transitionCase(db, input, now);
}
export function acquireZstClaim(db, args, now) {
    return engine.acquireClaim(db, args, now);
}
export function releaseZstClaim(db, args) {
    return engine.releaseClaim(db, args);
}
/** Convenience wrappers over the live DB for non-test callers. */
export const zstCaseStore = {
    create: (input, now = Math.floor(Date.now() / 1000)) => createZstCase(getDb(), input, now),
    get: (caseId) => getZstCase(getDb(), caseId),
    listActive: () => listActiveZstCases(getDb()),
    listToday: (horizonSec) => listTodayZstCases(getDb(), horizonSec),
    transition: (input, now = Math.floor(Date.now() / 1000)) => transitionZstCase(getDb(), input, now),
    appendEvent: (ev, now = Math.floor(Date.now() / 1000)) => appendZstCaseEvent(getDb(), ev, now),
    acquireClaim: (args, now = Math.floor(Date.now() / 1000)) => acquireZstClaim(getDb(), args, now),
    releaseClaim: (args) => releaseZstClaim(getDb(), args),
};
