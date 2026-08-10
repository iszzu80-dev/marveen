// CostOps Phase 0 -- source lifecycle and provenance, kept as two SEPARATE
// fields (gap-analysis GAP-03). Pure derivation, no I/O, no DB, no LLM --
// callers (inventory.ts) gather the input facts from the DB/Vault and pass
// them in here as plain booleans/strings.
//
// The headline example this fixes: the OpenAI API source has a WORKING
// credential and a WORKING collector, but currently ~$0 of actual usage --
// that is 'inactive', not a credential/auth problem. Lifecycle answers "is
// this source usable and in what state"; provenance answers "where did THIS
// number come from". Mixing them (e.g. treating "no data yet" as an error
// state) is exactly the GAP-03 bug this module exists to prevent.
/**
 * Derive a single, unambiguous lifecycle state. Order matters: an explicit
 * override always wins, then missing configuration, then a genuine collector
 * failure, then "configured and working but idle", then active.
 */
export function deriveSourceLifecycle(input) {
    if (input.explicitlyUnsupported)
        return 'unsupported';
    if (input.explicitlyDeprecated)
        return 'deprecated';
    if (input.credentialRequired && !input.credentialPresent)
        return 'not_configured';
    if (input.lastRunStatus != null && input.lastRunStatus !== 'ok')
        return 'blocked';
    if (!input.hasEverHadActivity)
        return 'inactive';
    return 'active';
}
// Existing `CostConfidence` values (config.ts) mixed the authoritativeness
// axis with a de-facto provenance one. `actualSource` (already written per
// row since v0.8, see ledger.ts) is the closer match to "where did this
// number come from" -- this function normalizes both into the Phase 0
// enum without touching either underlying column.
const ESTIMATE_CONFIDENCE = new Set(['estimate', 'local_usage', 'provider_plan_estimate']);
/**
 * Map an existing (confidence, actual_source) pair to the Phase 0 provenance
 * enum. Never guesses: unrecognized/absent input maps to 'unknown', not a
 * fabricated default. `imported_actual` is reserved for a future bulk-import
 * path -- no current collector produces it (every provider_api collector in
 * this codebase writes actual_source='provider_api', not a distinct bulk
 * import), so it never comes out of this function today; it exists so a
 * future collector class has a home without another enum change.
 */
export function deriveProvenance(confidence, actualSource) {
    if (actualSource === 'provider_api')
        return 'provider_api_actual';
    if (actualSource === 'email_invoice')
        return 'invoice_actual';
    if (actualSource === 'pending_permission')
        return 'unknown'; // genuinely not observable yet, never guessed
    if (actualSource === 'manual_entry') {
        return confidence && ESTIMATE_CONFIDENCE.has(confidence) ? 'calculated_estimate' : 'manual_actual';
    }
    if (confidence && ESTIMATE_CONFIDENCE.has(confidence))
        return 'calculated_estimate';
    if (confidence === 'manual')
        return 'manual_actual';
    return 'unknown';
}
