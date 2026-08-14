// APG 1.9 §11.2 / §12.1-e -- the execution ROLE vocabulary, in one place.
//
// WHY THIS FILE EXISTS AT ALL, given that WP3 already declared the vocabulary.
// WP3 minted `DispatchRole` inside src/costops/dispatch.ts, which is the right
// home for a column on the dispatches table but the wrong home for a word the
// CONTEXT PACKET also has to carry: §12.1-e puts `execution_role` on the packet
// itself, and src/context-packet.ts is deliberately dependency-free apart from
// node:crypto (its own module docstring commits to that, because the packet
// shape is an upstream candidate). Importing dispatch.ts there would drag
// better-sqlite3 into a format module.
//
// The alternative -- re-spelling the four words in context-packet.ts -- is the
// thing this file exists to prevent. A second copy of a CLOSED vocabulary is a
// vocabulary that drifts, and the kernel's own execution_identity.py says why
// the set must stay closed: "a role that can be spelled freely is a role that
// can be spelled `owner`".
//
// So the vocabulary moved DOWN to a leaf that both layers import. dispatch.ts
// re-exports `DispatchRole` / `DISPATCH_ROLES` under their original names, so
// no existing caller, test or column contract changed.
//
// Zero imports on purpose: this module must be safe to import from the format
// layer, from the store layer, and from anywhere between them.

/**
 * §11.2's four execution roles, exactly.
 *
 * Three spec rules are unstateable without this vocabulary (the kernel's
 * execution_identity.py lists them): §11.3's "delegation confers no
 * authority" needs to know what authority a delegate would have received;
 * §12.3-a's fresh verifier needs a verifier that is provably not the producer;
 * §13.1-f's producer/accepter separation needs both nouns.
 */
export type ExecutionRole = 'producer' | 'verifier' | 'executor' | 'owner'

/** The closed set, in the spec's own order. */
export const EXECUTION_ROLES: readonly ExecutionRole[] = ['producer', 'verifier', 'executor', 'owner']

/**
 * Narrow an untrusted string to a role, or null.
 *
 * `null` -- never a fallback to 'producer'. "We do not know what this
 * execution was acting as" has exactly one spelling everywhere in this
 * codebase (see createDispatch's role column and dispatch-identity.ts's model
 * columns), and a typo'd value silently becoming the most common role would
 * put a fabricated principal into the one field §26's first invariant compares.
 */
export function asExecutionRole(value: unknown): ExecutionRole | null {
  return typeof value === 'string' && (EXECUTION_ROLES as readonly string[]).includes(value)
    ? (value as ExecutionRole)
    : null
}
