// APG 1.9 §15.2 / §15.3-e -- a kanban `done` is a CLAIM, recorded as one.
//
// WHAT THE 1.8 AUDIT FOUND, in its WP6 row: "a done egy ellenőrizetlen curl".
// The dispatch message hands the agent the exact command (see
// kanbanMoveInstructions in src/web/routes/kanban.ts):
//
//     curl -s -X POST .../api/kanban/<id>/move \
//       -H "Authorization: Bearer $(cat store/.dashboard-token)" \
//       -d '{"status":"done"}'
//
// and the handler moved the card and wrote `outcome='accepted'` for every
// dispatch on it. Two separate problems live in that one line, and this module
// is the first half of the answer to both:
//
//   §15.2  done is not acceptance. The claim is now recorded AS a claim, and
//          the cost namespace gets `producer_completed` (costops/dispatch.ts).
//   §15.3-e "nem bízik vakon a busz reply-ban". The claim is CLASSIFIED by the
//          authority the SERVER resolved for it, and the classification follows
//          the kernel's existing excluded-source policy rather than a new one.
//
// THE POLICY IS NOT NEW, AND THAT IS THE POINT. `receipt_chain.LIVE_LINK_POLICY`
// in the kernel already lists `build_test_author_assertion` as an EXCLUDED
// source type for the test and build links: a commit message that says "tests
// pass" forces those links to MISSING rather than raising them to PRESENT,
// because a party reporting on its own work is not evidence about that work. A
// dispatched agent curling its own card to `done` is the same situation in every
// respect that matters, one layer up. `completion_verification.CLAIM_LINK_POLICY`
// on the kernel side is written in that policy's exact shape.
//
// WHAT WE CAN AND CANNOT TELL ABOUT THE CALLER. §11.1 is blunt: the bus is not
// an authority boundary and the shared bearer token identifies "someone inside
// this fleet" and nothing narrower. `resolveApgPrincipal` (web/apg-principal.ts)
// already draws the one real line available -- operator credentials no
// dispatched agent holds, versus the shared fleet token every dispatched agent
// is handed. WP6 adds the one further distinction that matters here, and it is
// available because WP3 stamped the role server-side: is the fleet-token caller
// THE AGENT THIS CARD WAS DISPATCHED TO?
//
//   PRODUCER_SELF_ASSERTED     fleet token, and this card has a producer
//                              dispatch. The agent is reporting on its own work.
//   FLEET_TOKEN_UNATTRIBUTED   fleet token, no producer dispatch to compare
//                              against. We cannot say it is self-assertion and
//                              we certainly cannot say it is not.
//   OPERATOR_ATTESTED          a named session or a device key.
//   UNKNOWN_ORIGIN             no credential resolved at all.
//
// NOTE WHAT THE FIRST CASE DOES NOT CLAIM. It does not claim the request really
// came from that agent -- the token cannot prove that. It claims the WEAKER and
// checkable thing: this request presented the credential every producer on this
// card holds, so it cannot be distinguished from that producer's own assertion,
// and §15.3-e says the honest response to "cannot be distinguished from a
// self-report" is to treat it as one.
//
// DATA SENSITIVITY. The row stores the principal CLASS and the full attribution
// string. The attribution can name a person (`session:istvan`), so the KERNEL
// stores only the class plus a sha256 of it -- see migration 0021's note. Here,
// in Marveen's own database, the attribution is already present throughout the
// audit log, so keeping it is neither new exposure nor useful to strip.

import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { listCardProducerAgents } from '../costops/dispatch.js'
import type { ApgPrincipal } from '../web/apg-principal.js'

/**
 * HOW the claim reached the server. Spelled identically to the kernel's
 * `completion_verification.CLAIM_SOURCES` -- one vocabulary across the two
 * repositories, not two that happen to agree.
 */
export type CompletionClaimSource =
  | 'kanban_done_move' | 'agent_message_completion' | 'operator_attestation'

/** WHO asserted it, as the server resolved it. Kernel `CLAIM_AUTHORITIES`. */
export type CompletionClaimAuthority =
  | 'PRODUCER_SELF_ASSERTED' | 'FLEET_TOKEN_UNATTRIBUTED'
  | 'OPERATOR_ATTESTED' | 'VERIFIER_ATTESTED' | 'UNKNOWN_ORIGIN'

export const COMPLETION_CLAIM_AUTHORITIES: readonly CompletionClaimAuthority[] = [
  'PRODUCER_SELF_ASSERTED', 'FLEET_TOKEN_UNATTRIBUTED',
  'OPERATOR_ATTESTED', 'VERIFIER_ATTESTED', 'UNKNOWN_ORIGIN',
]

/**
 * The authorities whose claim is an AUTHOR ASSERTION -- kept in full, never
 * evidence. Mirrors the kernel's excluded set exactly; the cross-repo contract
 * test asserts the two lists against each other.
 */
export const EXCLUDED_CLAIM_AUTHORITIES: readonly CompletionClaimAuthority[] = [
  'PRODUCER_SELF_ASSERTED', 'FLEET_TOKEN_UNATTRIBUTED', 'UNKNOWN_ORIGIN',
]

/**
 * Create the claim table. Idempotent boot DDL, mounted on the CostOps seam
 * (costops/schema.ts) alongside the dispatch tables it joins to -- one seam,
 * per docs/fork-upstream-policy.md §2a, not a second parallel one.
 *
 * WHY THE CLAIM LIVES IN MARVEEN'S DATABASE AND NOT THE KERNEL'S. The kernel is
 * a separate process that is frequently not running, and the sidecar contract
 * forbids the dashboard writing to it. A card move that had to reach the kernel
 * to be recorded would either block on it or lose the claim when it was down --
 * and a lost claim is a card that is done and will never be verified. So the
 * claim is written here, synchronously, in the same request that moved the
 * card, and the kernel reads it (read-only, mode=ro) on its own schedule.
 */
export function initCompletionClaimSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apg_completion_claims (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id                TEXT NOT NULL,
      change_logical_id      TEXT NOT NULL,
      claim_source           TEXT NOT NULL,
      claim_authority        TEXT NOT NULL,
      claimed_by_class       TEXT NOT NULL,
      claimed_by_attribution TEXT NOT NULL,
      claimed_at             INTEGER NOT NULL,
      detail                 TEXT
    )
  `)
  // "What has been claimed since the kernel's cursor" -- the feed's only read.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_apg_completion_claims_at ON apg_completion_claims(claimed_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_apg_completion_claims_card ON apg_completion_claims(card_id, claimed_at)`)
}

export interface ResolvedClaimAuthority {
  authority: CompletionClaimAuthority
  /** Marveen's `ApgPrincipal.kind`, carried through to the kernel verbatim. */
  claimantClass: ApgPrincipal['kind']
  attribution: string
  /** True when this authority's claim can never be acceptance evidence. */
  excluded: boolean
  /** One sentence naming WHY, for the claim row's detail. */
  reason: string
}

/**
 * Classify a `done` move's claimant. SERVER-SIDE ONLY -- nothing here reads the
 * request body.
 *
 * The move endpoint accepts an `actor` field and always has; it is used for the
 * card's own audit line. It is NOT consulted here, and that is the §11.4 rule
 * the 1.8 audit found broken on two other endpoints: a self-declared name in a
 * request body is not attribution, and treating it as one is how a producer
 * would classify its own claim as an operator's.
 */
export function resolveClaimAuthority(
  db: Database.Database,
  cardId: string,
  principal: ApgPrincipal,
): ResolvedClaimAuthority {
  const base = { claimantClass: principal.kind, attribution: principal.attribution }
  if (principal.class === 'operator') {
    return {
      ...base,
      authority: 'OPERATOR_ATTESTED',
      excluded: false,
      reason:
        'a session or device credential, which no dispatched agent holds (§11.1) -- ' +
        'still not acceptance evidence, because §15.2 acceptance is verification plus a ' +
        'satisfied contract and a human saying done is neither',
    }
  }
  if (principal.class === 'fleet') {
    // WP3's role column is what makes this distinction possible at all: the
    // producer set is stamped server-side at dispatch time, from the origin's
    // own knowledge of which agent the card went to.
    let producers: string[] = []
    try {
      producers = listCardProducerAgents(db, cardId)
    } catch (err) {
      // A database that predates the role column cannot answer, and the honest
      // consequence is the WEAKER classification, never the stronger one.
      logger.warn({ err, cardId }, 'APG §15.3-e: producer lookup failed; claim stays unattributed')
    }
    if (producers.length > 0) {
      return {
        ...base,
        authority: 'PRODUCER_SELF_ASSERTED',
        excluded: true,
        reason:
          `the shared fleet token, which every producer on this card holds (${producers.length} ` +
          'producer dispatch(es) recorded) -- indistinguishable from the producer reporting on ' +
          'its own work, so §15.3-e treats it as an author assertion',
      }
    }
    return {
      ...base,
      authority: 'FLEET_TOKEN_UNATTRIBUTED',
      excluded: true,
      reason:
        'the shared fleet token with no producer dispatch on this card to compare against: ' +
        'we cannot say this is self-assertion and cannot say it is not (§11.1)',
    }
  }
  return {
    ...base,
    authority: 'UNKNOWN_ORIGIN',
    excluded: true,
    reason: 'no credential resolved for this request',
  }
}

/**
 * Record one completion claim. Returns the row id, or null if it was dropped.
 *
 * BEST-EFFORT BY CONSTRUCTION, like every other write on the card-move path: a
 * claim that fails to record must not stop the card from moving. The cost of
 * that choice is a card that is done with no claim behind it, which the feed
 * will never verify -- so the failure is logged loudly rather than swallowed
 * silently, and the log line names the card so it can be replayed by hand.
 */
export function recordCompletionClaimSafe(
  db: Database.Database,
  input: {
    cardId: string
    changeLogicalId?: string | null
    source: CompletionClaimSource
    resolved: ResolvedClaimAuthority
  },
  now: number = Date.now(),
): number | null {
  try {
    const info = db.prepare(`
      INSERT INTO apg_completion_claims
        (card_id, change_logical_id, claim_source, claim_authority,
         claimed_by_class, claimed_by_attribution, claimed_at, detail)
      VALUES (@card_id, @change_logical_id, @claim_source, @claim_authority,
              @claimed_by_class, @claimed_by_attribution, @claimed_at, @detail)
    `).run({
      card_id: input.cardId,
      // The kernel keys its change state by the card id on this deployment
      // (there is no separate change record in Marveen), and the column exists
      // so that stops being an assumption baked into a join the day one appears.
      change_logical_id: input.changeLogicalId ?? input.cardId,
      claim_source: input.source,
      claim_authority: input.resolved.authority,
      claimed_by_class: input.resolved.claimantClass,
      claimed_by_attribution: input.resolved.attribution,
      claimed_at: Math.floor(now / 1000),
      detail: input.resolved.reason,
    })
    return Number(info.lastInsertRowid)
  } catch (err) {
    logger.warn(
      { err, cardId: input.cardId },
      'APG §15.3-e: completion claim NOT recorded; this card is done and the kernel will never verify it (card move unaffected)',
    )
    return null
  }
}

/** Every claim on one card, oldest first. Read path for the UI and for tests. */
export function listCompletionClaims(
  db: Database.Database,
  cardId: string,
): Array<{
  id: number; card_id: string; claim_source: string; claim_authority: string
  claimed_by_class: string; claimed_by_attribution: string; claimed_at: number; detail: string | null
}> {
  return db.prepare(
    `SELECT id, card_id, claim_source, claim_authority, claimed_by_class,
            claimed_by_attribution, claimed_at, detail
     FROM apg_completion_claims WHERE card_id = ? ORDER BY claimed_at ASC, id ASC`,
  ).all(cardId) as never
}
