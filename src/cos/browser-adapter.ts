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

/**
 * The full six-method contract an EXECUTE-capable browser adapter must satisfy.
 *   prepare()           — build the action (fill the cart / compose the order)
 *   execute()           — commit it (place the order). The single external write.
 *   readback()          — did the committed action land? MUST be reliable.
 *   verify()            — confirm the readback result against the intent.
 *   dedupeKey()         — a stable idempotency key so a retry cannot double-submit
 *   compensateOrCancel()— undo/abort a partially-applied or unwanted action.
 * Types are intentionally loose (unknown) — this is a capability shape check, not
 * the execution path.
 */
export interface BrowserExecuteAdapter {
  prepare(input: unknown): Promise<unknown> | unknown
  execute(prepared: unknown): Promise<unknown> | unknown
  readback(dedupeKey: string): Promise<{ found: boolean; available?: boolean }>
  verify(prepared: unknown): Promise<unknown> | unknown
  dedupeKey(input: unknown): string
  compensateOrCancel(prepared: unknown): Promise<unknown> | unknown
}

export const REQUIRED_BROWSER_METHODS = [
  'prepare', 'execute', 'readback', 'verify', 'dedupeKey', 'compensateOrCancel',
] as const

export type BrowserMode = 'EXECUTE' | 'PREPARE'

export interface BrowserCapabilityReport {
  mode: BrowserMode
  missing: string[]
  readbackReliable: boolean
  detail: string
}

/**
 * Assess whether a candidate adapter may EXECUTE. It must implement all six
 * methods AND pass a readback reliability probe (readback returns without
 * throwing and reports itself available). Any gap → PREPARE.
 *
 * The probe is optional (some adapters cannot be probed offline); when omitted,
 * a fully-shaped adapter is still capped at PREPARE until a real probe runs, so
 * the default is fail-safe.
 */
export async function assessBrowserAdapter(
  candidate: Partial<BrowserExecuteAdapter> | Record<string, unknown>,
  probe?: { dedupeKey: string },
): Promise<BrowserCapabilityReport> {
  const missing = REQUIRED_BROWSER_METHODS.filter(
    m => typeof (candidate as Record<string, unknown>)[m] !== 'function',
  )
  if (missing.length > 0) {
    return { mode: 'PREPARE', missing, readbackReliable: false, detail: `missing methods: ${missing.join(', ')}` }
  }
  if (!probe) {
    return { mode: 'PREPARE', missing: [], readbackReliable: false, detail: 'fully shaped, but no readback probe run → PREPARE (fail-safe)' }
  }
  let readbackReliable = false
  let detail = ''
  try {
    const rb = await (candidate as BrowserExecuteAdapter).readback(probe.dedupeKey)
    readbackReliable = rb.available !== false
    detail = readbackReliable ? 'all methods present, readback reliable' : 'readback reported unavailable'
  } catch (err) {
    detail = `readback probe threw: ${String((err as Error)?.message ?? err)}`
  }
  return { mode: readbackReliable ? 'EXECUTE' : 'PREPARE', missing: [], readbackReliable, detail }
}
