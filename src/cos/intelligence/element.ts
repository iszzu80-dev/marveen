// PHASE 2 INTELLIGENCE -- the shape every element shares, and the invariants it
// cannot be built without.
//
// THE ARCHITECTURE, from the owner's Phase 2 scope (2026-08-31):
//
//     "A Phase 2 intelligence PROJECTION. NEM lehet második case source of
//      truth. A canonical progression store marad a case truth."
//
// So nothing here is stored as an authority. Every element is DERIVED from the
// canonical rows on each call, which is what makes "új evidence-re
// determinisztikusan frissíthető/reopenolható" true by construction rather than
// by a refresh job somebody has to remember to run. There is no intelligence
// table holding a status that could disagree with the case it describes.
//
// The one thing that IS durable is interaction -- that an attention item was
// shown, that a question was asked -- and even that records only the fact of the
// interaction, never the element's content. See attention.ts.
//
// AND THE HARD ONE: A RECOMMENDATION IS NOT AN AUTHORIZATION.
//
//     "NE legyen action authorization. HUMAN_DECISION továbbra sem egyenlő
//      külső művelet jóváhagyásával."
//
// This is not a comment, it is a type. There is no field on any element that an
// executor could read as permission, and `assertNotAuthorization` exists so a
// future field cannot quietly become one. The gates that DO authorize -- action
// semantics, Invariant E, scoped authorization, capability, credential
// disclosure, idempotency -- are untouched by this layer and must stay that way.

/** What KIND of claim this is. The owner asked for these to be separated and
 *  they are separated at the type level, not by a string somebody sets. */
export type Epistemic =
  | 'FACT'            // observed in the store: a row says so
  | 'INFERENCE'       // derived from facts by a rule stated here
  | 'RECOMMENDATION'  // what a person might choose to do. NEVER permission.

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

export type ProvenanceSource =
  | 'CASE' | 'CASE_EVENT' | 'PROGRESSION' | 'OUTBOUND' | 'DOCUMENT' | 'TRIAGE_RECEIPT'
  /** P3-B2: a public-web research result, named as its own class ON PURPOSE.
   *  Every other source above is something this system observed or wrote; this
   *  one is a page somebody else published, retrieved through the research
   *  ledger. Keeping it distinguishable means a reader can always tell which
   *  part of an element rests on our own records and which part rests on the
   *  open web, and `ref` is the research ticket, so the exact query and its
   *  source URLs are one lookup away. */
  | 'WEB_RESEARCH'

/** Where a claim came from. An element cannot be constructed without at least
 *  one, because an intelligence surface whose items cannot be traced back is a
 *  surface that invents things. */
export interface Provenance {
  source: ProvenanceSource
  /** The row identity: case_id, event_id, ledger_id, receipt_id. */
  ref: string
  /** When the underlying row said this (its own timestamp, not read time). */
  observedAt: number
  /** Optional column/field that carried it, for a reader chasing the value. */
  field?: string
}

export type ContradictionState =
  | { state: 'NONE' }
  | { state: 'UNRESOLVED'; axis: string; detail: string; provenance: Provenance[] }
  | { state: 'RESOLVED'; axis: string; detail: string; resolvedBy: Provenance }

export interface IntelligenceElement {
  /** Deterministic: the same canonical rows always produce the same id, so a
   *  recomputation is recognisable as the same element rather than a new one.
   *  This is what makes dedupe and supersede possible without a stored table. */
  id: string
  kind: Epistemic
  caseId: string
  namespace: 'personal' | 'zst'
  /** Human-readable, and it must say what it claims -- not what to do about it. */
  statement: string
  provenance: Provenance[]
  confidence: Confidence
  /** Age of the FRESHEST provenance, in seconds, at evaluation time. */
  recencySeconds: number
  contradiction: ContradictionState
  /**
   * THE FACTS THAT DECIDE WHETHER THIS IS STILL THE SAME CLAIM.
   *
   * A producer that knows which of its inputs are semantic says so here, and
   * the reader's change digest is taken over this rather than over the rendered
   * sentence. Optional: an element that does not set it is identified by its
   * provenance alone, which is stable but coarser.
   *
   * IT EXISTS BECAUSE BOTH OBVIOUS CHOICES ARE WRONG. Hashing the sentence makes
   * every re-phrasing look like news -- measured twice on the live board, once
   * from a drifting day count and once from the fix for it. Hashing only the
   * provenance is quiet in the other direction: a case whose STATUS moves
   * without its timestamp moving is a real change that nothing would notice, and
   * a missed change is silent where a false one at least argues with you.
   *
   * So: stable, absolute, chosen. Owner's rule, 2026-09-04 -- "CHANGE /
   * IDENTITY: csak stabil, absolute facts. URGENCY / RANKING: olvashatja az
   * aktuális időt." A rendered age, an "N days ago", or anything else computed
   * from the clock at read time must never appear in it.
   */
  changeKey?: string
}

export class IntelligenceInvariantError extends Error {
  constructor(what: string) { super(`intelligence invariant: ${what}`); this.name = 'IntelligenceInvariantError' }
}

/** Fields no intelligence element may ever carry. If one of these appears, some
 *  later change has started to make this layer an authorizer, which is the one
 *  thing the owner's scope forbids outright. Checked at construction so it fails
 *  in a test rather than in production. */
const FORBIDDEN_AUTHORIZATION_FIELDS = [
  'approved', 'authorized', 'authorised', 'permitted', 'allow', 'allowed',
  'mayExecute', 'canExecute', 'execute', 'authorization', 'approval',
  'sideEffectApproved', 'externalActionApproved',
]

/**
 * Refuse anything that could be read as permission.
 *
 * NO RELEVANT CONTRADICTION != ALLOW is the standing invariant, and its failure
 * mode is exactly this: a field that means "nothing objects" gets read by an
 * executor as "go ahead". The two are different claims and this layer only ever
 * makes the first one.
 */
export function assertNotAuthorization(el: Record<string, unknown>, where: string): void {
  for (const f of FORBIDDEN_AUTHORIZATION_FIELDS) {
    if (f in el) {
      throw new IntelligenceInvariantError(
        `${where} carries "${f}". This layer describes; it never authorizes. ` +
        `Action semantics, Invariant E, scoped authorization, capability and the ` +
        `credential gates decide that, and none of them read this.`,
      )
    }
  }
}

/** Every element goes through here. It is the single place the invariants are
 *  enforced, so a new surface cannot accidentally skip them. */
export function makeElement(input: Omit<IntelligenceElement, 'recencySeconds'>, now: number): IntelligenceElement {
  if (!input.provenance.length) {
    throw new IntelligenceInvariantError(`element ${input.id} has no provenance: an untraceable claim is not intelligence`)
  }
  assertNotAuthorization(input as unknown as Record<string, unknown>, `element ${input.id}`)
  const freshest = Math.max(...input.provenance.map((p) => p.observedAt))
  return { ...input, recencySeconds: Math.max(0, now - freshest) }
}

/** A stable id from the parts that identify an element. Deliberately NOT a hash
 *  of the whole element: the statement and confidence change as evidence
 *  arrives, and an id that moved with them would make every refresh look like a
 *  brand-new item to the dedupe. */
export function elementId(surface: string, namespace: string, caseId: string, discriminator = ''): string {
  return [surface, namespace, caseId, discriminator].filter(Boolean).join(':')
}

const CONFIDENCE_RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 }

/** The weakest link. A chain of facts with one LOW step is a LOW conclusion,
 *  and rounding that up is how a guess starts looking like an observation. */
export function combineConfidence(parts: readonly Confidence[]): Confidence {
  if (!parts.length) return 'UNKNOWN'
  return parts.reduce((a, b) => (CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a))
}

/** Staleness relative to a horizon, as a 0..1 figure the priority rules use.
 *  Saturates at 1 rather than growing without bound, so one ancient item cannot
 *  dominate every other signal for ever. */
export function stalenessFactor(recencySeconds: number, horizonSeconds: number): number {
  if (horizonSeconds <= 0) return 0
  return Math.min(1, recencySeconds / horizonSeconds)
}
