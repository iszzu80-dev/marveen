// Personal Chief of Staff (COS) domain-command layer. As of ZST Slice 0 the
// engine logic lives in case-engine-core.ts (shared with the ZST Corporate Case
// Engine, arch option A); this module binds that engine to the PERSONAL table
// namespace (personal_cases / personal_case_events / case_claims) and its
// default column values, and re-exports the same public surface as before so
// every existing caller and test is unchanged. The three invariants (optimistic
// concurrency, append-only audit, claim fencing) are enforced in the core.
import { getDb } from '../db.js';
import { makeCaseEngine, CaseConcurrencyError, } from './case-engine-core.js';
export { CaseConcurrencyError };
const PERSONAL_TABLES = {
    cases: 'personal_cases',
    events: 'personal_case_events',
    claims: 'case_claims',
};
const PERSONAL_DEFAULTS = {
    status: 'NEW', priority: 'P2', owner: 'marveen', sensitivity: 'PERSONAL', actor: 'marveen',
};
const engine = makeCaseEngine(PERSONAL_TABLES, PERSONAL_DEFAULTS);
export function appendCaseEvent(db, ev, now) {
    return engine.appendCaseEvent(db, ev, now);
}
export function createCase(db, input, now) {
    return engine.createCase(db, input, now);
}
export function getCase(db, caseId) {
    return engine.getCase(db, caseId);
}
export function listActiveCases(db) {
    return engine.listActiveCases(db);
}
export function listTodayCases(db, horizonSec) {
    return engine.listTodayCases(db, horizonSec);
}
export function transitionCase(db, input, now) {
    return engine.transitionCase(db, input, now);
}
export function acquireClaim(db, args, now) {
    return engine.acquireClaim(db, args, now);
}
export function releaseClaim(db, args) {
    return engine.releaseClaim(db, args);
}
/** Convenience wrappers over the live DB for non-test callers. */
export const caseStore = {
    create: (input, now = Math.floor(Date.now() / 1000)) => createCase(getDb(), input, now),
    get: (caseId) => getCase(getDb(), caseId),
    transition: (input, now = Math.floor(Date.now() / 1000)) => transitionCase(getDb(), input, now),
    appendEvent: (ev, now = Math.floor(Date.now() / 1000)) => appendCaseEvent(getDb(), ev, now),
    acquireClaim: (args, now = Math.floor(Date.now() / 1000)) => acquireClaim(getDb(), args, now),
    releaseClaim: (args) => releaseClaim(getDb(), args),
};
