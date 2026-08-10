// Personal Chief of Staff (COS) — browser/checkout adapter minimum-interface
// (spec P1.4).
//
// A browser-worker adapter (Kifli grocery, or any isolated-browser checkout) may
// only be granted EXECUTE if it implements the FULL contract below AND its
// readback is reliable. Without a reliable readback() an execute() cannot be made
// crash-safe (we could not tell whether a submitted order actually landed), so
// the adapter is capped at PREPARE — it may build/stage the action but never
// commit it.
//
// This is why the COS shopping/rental adapters stay observe-only: they expose NO
// execute()/checkout by construction (isForbiddenMethodName in shopping-adapter),
// so assessBrowserAdapter reports them PREPARE — a machine-checkable statement of
// "no autonomous purchase", not a promise in prose.
export const REQUIRED_BROWSER_METHODS = [
    'prepare', 'execute', 'readback', 'verify', 'dedupeKey', 'compensateOrCancel',
];
/**
 * Assess whether a candidate adapter may EXECUTE. It must implement all six
 * methods AND pass a readback reliability probe (readback returns without
 * throwing and reports itself available). Any gap → PREPARE.
 *
 * The probe is optional (some adapters cannot be probed offline); when omitted,
 * a fully-shaped adapter is still capped at PREPARE until a real probe runs, so
 * the default is fail-safe.
 */
export async function assessBrowserAdapter(candidate, probe) {
    const missing = REQUIRED_BROWSER_METHODS.filter(m => typeof candidate[m] !== 'function');
    if (missing.length > 0) {
        return { mode: 'PREPARE', missing, readbackReliable: false, detail: `missing methods: ${missing.join(', ')}` };
    }
    if (!probe) {
        return { mode: 'PREPARE', missing: [], readbackReliable: false, detail: 'fully shaped, but no readback probe run → PREPARE (fail-safe)' };
    }
    let readbackReliable = false;
    let detail = '';
    try {
        const rb = await candidate.readback(probe.dedupeKey);
        readbackReliable = rb.available !== false;
        detail = readbackReliable ? 'all methods present, readback reliable' : 'readback reported unavailable';
    }
    catch (err) {
        detail = `readback probe threw: ${String(err?.message ?? err)}`;
    }
    return { mode: readbackReliable ? 'EXECUTE' : 'PREPARE', missing: [], readbackReliable, detail };
}
