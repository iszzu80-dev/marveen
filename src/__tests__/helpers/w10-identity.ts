// W10 test fixture: the identity a send test acts under.
//
// WHY THIS EXISTS, stated once so the six test files that import it do not each
// have to argue for themselves.
//
// Before 2026-08-25 a dispatch with no identity was ADVISORY: the boundary ran,
// recorded what it would have said, and let the send proceed. That migration
// rule was deliberate and is now spent -- Istvan's decision says LEGACY_UNKNOWN
// may not remain a normal end state at a relevant caller, so a mutating external
// action without an identity is refused.
//
// The existing send tests were written when the rule was advisory, so they
// dispatch as nobody. Giving them an identity is NOT weakening them: what each
// one measures (double-send, quota ceilings, claim contention, ledger audit
// fields) is unchanged, and the refusal path they never covered now has its own
// explicit tests in w10-action-broker.test.ts and cos-telegram.test.ts.
//
// This is a deliberate edit to pre-existing tests and is declared as such in the
// W10 report rather than left for a reader to discover in a diff.

import type { ExecutionIdentity } from '../../identity/execution-identity.js'

/** A human operator at the dashboard, which is who actually clicks "Elkuldom". */
export const TEST_OPERATOR: ExecutionIdentity = Object.freeze({
  actorId: 'test:istvan',
  actorType: 'HUMAN_USER',
  onBehalfOf: null,
  runId: 'test-run',
  capabilityScope: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT']),
}) as ExecutionIdentity

/** A scheduled step acting for Istvan, as the cycle's steps do. */
export const TEST_SCHEDULED: ExecutionIdentity = Object.freeze({
  actorId: 'schedule:test',
  actorType: 'SYSTEM_AUTOMATION',
  onBehalfOf: 'istvan',
  runId: 'test-run',
  capabilityScope: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT']),
}) as ExecutionIdentity

/** Spread into a dispatch input to say who is sending. */
export const AS_OPERATOR = { identity: TEST_OPERATOR } as const
