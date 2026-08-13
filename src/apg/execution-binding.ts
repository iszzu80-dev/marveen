// APG 1.9 §15.3-b/d, §28.17 -- the dispatch's execution identity, derived HERE.
//
// THE GAP THIS CLOSES. `dispatches` is a CostOps measurement row. It knows which
// agent got which card, which model it was configured with and what the send
// cost -- and nothing joined it to a runner-minted execution principal (§11.2)
// or to the context packet that principal was handed (§12.1). WP3 minted the
// identities in the kernel, WP4 gave the packet an id and a hash here, and the
// 1.8 audit's WP6 row is what you get when the two never meet: "a dispatch
// valódi és receiptelt" -- receipted as a COST row, bound to no execution. So
// §28.17's RED condition ("controlled work execution indulhat runner-mintelt
// execution/dispatch receipt nélkül") was not merely reachable; it was the only
// state that existed.
//
// WHY THE ID IS DERIVED ON THIS SIDE AND NOT REQUESTED FROM THE KERNEL. The
// kernel is a SIDECAR: it is a separate process, a separate language and a
// separate database, and it is frequently not running at all. A dispatch that
// had to wait for it before sending would either block the send or -- far worse
// -- fall back to sending unbound, which is the state we are leaving.
//
// `execution_identity.execution_id_for` derives the id from the identity's own
// CONTENT, so both sides can compute it independently and reach the same answer
// because the content is the same, not because one told the other:
//
//     execution_id = "ex-" + sha256(json([work_item_id, agent_id, role,
//                                         session_id, target_ref,
//                                         context_packet_hash,
//                                         created_at]))[:32]
//
// This module is that expression in TypeScript, and `apg-dispatch-execution-
// binding.test.ts` pins two golden vectors that the kernel's own
// `test_wp6_kanban_dispatch.py` pins identically. A drift in either
// implementation turns a silent mis-join into two failing tests.
//
// THE ONE SUBTLETY, AND IT IS A REAL ONE. Python's `json.dumps` defaults to
// `ensure_ascii=True` and escapes every non-ASCII character as `\uXXXX`;
// `JSON.stringify` emits it literally. An agent name or card id containing a
// single accented character would therefore hash differently on the two sides
// and the join would break for exactly those rows -- silently, and only in
// production, since ASCII test fixtures would never show it. `pythonJson()`
// below reproduces Python's escaping, and the test suite covers it with a
// Hungarian-accented agent name for the obvious local reason.
//
// WHAT A DERIVED ID IS NOT. It is not proof the execution exists. Until the
// kernel mints it, the id names an identity nobody has issued; `dispatch_binding
// .bind()` on the kernel side mints it and REFUSES a value that disagrees with
// its own derivation. That refusal is the point of stamping it: a mismatch is a
// disagreement about what was dispatched, and it surfaces instead of resolving
// itself into whichever side wrote last.

import { createHash } from 'node:crypto'
import { EXECUTION_ROLES, type ExecutionRole } from '../execution-role.js'

/**
 * The kernel's reserved words for the three fields nobody may have supplied
 * (`execution_identity.UNKNOWN_SENTINELS`). They are HASHED, not skipped, so a
 * caller that passed nothing and a caller that passed the word must reach the
 * same digest -- which is why they are spelled here rather than being left to
 * each call site.
 */
export const SESSION_ID_UNKNOWN = 'SESSION_ID_UNKNOWN'
export const TARGET_REF_UNKNOWN = 'TARGET_REF_UNKNOWN'
export const CONTEXT_PACKET_HASH_UNKNOWN = 'CONTEXT_PACKET_HASH_UNKNOWN'

/** `execution_identity.execution_id_for`'s prefix and digest width. */
export const EXECUTION_ID_PREFIX = 'ex-'
export const EXECUTION_ID_HASH_CHARS = 32

export interface ExecutionIdentityFacts {
  workItemId: string
  agentId: string
  role: ExecutionRole
  /** Epoch SECONDS -- the same value stored in `dispatches.created_at`. */
  createdAt: number
  sessionId?: string | null
  targetRef?: string | null
  /** §12.1 packet hash, bare lowercase hex or `sha256:`-prefixed. */
  contextPacketHash?: string | null
}

/**
 * `json.dumps(value, sort_keys=True, separators=(',', ':'))` for a string list.
 *
 * `sort_keys` is a no-op on a list, and the separators match JSON.stringify's
 * own output for arrays. The one genuine difference is `ensure_ascii`: Python
 * escapes every codepoint above U+007F as a lowercase `\uXXXX`, and
 * JSON.stringify emits it literally. See the header note -- this is the
 * difference that would have broken the join for accented names only.
 */
export function pythonJson(values: readonly string[]): string {
  // Matched on UTF-16 CODE UNITS, not codepoints (no /u flag), which is exactly
  // what Python does for astral characters too: it emits the surrogate pair as
  // two \uXXXX escapes, and charCodeAt walks the same two units.
  return JSON.stringify(values).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Normalise a §12.1 hash the way the kernel's `normalize_hash` does, or null. */
function normalizeHash(hash: string | null | undefined): string | null {
  const trimmed = (hash ?? '').trim().replace(/^sha256:/i, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null
}

/**
 * The execution_id the kernel will mint for a dispatch with these facts.
 *
 * Returns null rather than a partial id when a required fact is missing or the
 * role is not one of §11.2's four: an id derived from an incomplete identity
 * would be a stable, plausible-looking value that joins to nothing, which is
 * strictly worse than the honest NULL the column already accepts for a
 * pre-WP6 row.
 */
export function deriveExecutionId(facts: ExecutionIdentityFacts): string | null {
  const workItemId = (facts.workItemId ?? '').trim()
  const agentId = (facts.agentId ?? '').trim()
  const role = facts.role
  if (!workItemId || !agentId || !EXECUTION_ROLES.includes(role)) return null
  if (!Number.isInteger(facts.createdAt)) return null
  const digest = createHash('sha256')
    .update(
      pythonJson([
        workItemId,
        agentId,
        role,
        (facts.sessionId ?? '').trim() || SESSION_ID_UNKNOWN,
        (facts.targetRef ?? '').trim() || TARGET_REF_UNKNOWN,
        normalizeHash(facts.contextPacketHash) ?? CONTEXT_PACKET_HASH_UNKNOWN,
        String(facts.createdAt),
      ]),
      'utf-8',
    )
    .digest('hex')
  return `${EXECUTION_ID_PREFIX}${digest.slice(0, EXECUTION_ID_HASH_CHARS)}`
}
