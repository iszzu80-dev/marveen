// Proof that a deterministic gate ran (§22.2, review #3 Ú-4).
//
// THE REQUIREMENT. §22.2 says only the trusted deterministic gate may issue an
// authorization ticket — "a caller nem állíthatja elő saját maga". Until now
// that was a code-review rule: `issueAuthorization` was an ordinary export, and
// the module comment admitted the type system did not enforce it. The opaque
// random id defends against GUESSING a ticket; it never defended against
// MINTING one.
//
// WHAT THIS CAN AND CANNOT DO. In a single-process TypeScript codebase there is
// no capability boundary that a determined caller cannot cross — anything
// importable is callable. So this module does not pretend to make forging
// impossible. It makes it take three deliberate, reviewable steps instead of
// one: import this module, mint a permit, and fabricate an `allowed` decision.
// Each of those is visible in a diff, and the standing check test below fails
// the moment a third module starts minting.
//
// The WeakSet is the part that is genuinely enforced: a permit cannot be
// hand-written as an object literal, because membership is granted only here.

/** The shape both gates return: any object that says whether it allowed the
 *  action. Kept structural so the two gate modules (personal, ZST) can keep
 *  their own richer decision types. */
export interface GateDecisionLike {
  allowed: boolean
  reasons: string[]
}

// Module-private. Not exported, not reachable, not enumerable from outside.
const MINTED = new WeakSet<object>()

/**
 * Mark a decision as produced by a real gate evaluation.
 *
 * ONLY the deterministic gates may call this — `evaluateDispatch` (personal) and
 * `evaluateZstSendGate` (ZST). The standing check in
 * `src/__tests__/cos-gate-permit.test.ts` enumerates the call sites and fails on
 * a new one, so adding a third minter is a decision somebody has to defend
 * rather than a line that slips through.
 */
export function mintGatePermit<T extends GateDecisionLike>(decision: T): T {
  MINTED.add(decision)
  return decision
}

/** Was this object minted by a gate in this process? */
export function isGatePermit(x: unknown): x is GateDecisionLike {
  return typeof x === 'object' && x !== null && MINTED.has(x as object)
}

/**
 * The check `issueAuthorization` runs before it writes a ticket.
 *
 * Two conditions, not one: the decision must come from a gate AND the gate must
 * have said yes. A minted-but-refused decision is exactly what a caller who
 * "ran the gate and ignored the answer" would be holding.
 */
export function gatePermitRefusal(permit: unknown): string | null {
  if (!isGatePermit(permit)) {
    return 'authorization requires a decision minted by a deterministic gate (§22.2)'
  }
  if (!permit.allowed) {
    return `the gate refused this action: ${permit.reasons.join('; ') || '(no reason given)'}`
  }
  return null
}
