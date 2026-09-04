// SEMANTIC RELATION CANDIDATES — proposals, and never anything more.
//
// Owner ruling 2026-09-04, and every line of it is a constraint rather than a
// preference: ONE candidate layer with two relation types, LOCAL (no Neon, no
// external embedding, no egress), bounded, reproducible, cost-measurable. Out
// of a candidate there is NO canonical link, NO parent assignment, NO case
// merge, NO namespace migration and NO external action. Cross-mailbox
// candidates yes; cross-namespace canonicalisation no. "Ha candidate
// bizonytalan: marad candidate."
//
// THE RULE THAT MATTERS is not the arithmetic, it is INDEPENDENCE. The owner's
// example was that the word "Valencia" alone must not join two different trips.
// The tempting implementation is a place-name list; it would be wrong narrowly
// (it says nothing about "Sixt alone" or "booking.com alone") and unfixable
// generally. So the engine requires evidence from at least TWO independent
// FAMILIES before anything is proposed, unless a single family is decisive on
// its own — and only a shared reference number is, because a booking reference
// is not a coincidence.
//
// "Ne találj ki thresholdot azért, hogy a történeti 14/14-et visszataláld."
// The weights below were chosen from what the features mean, not fitted to the
// historical set, and the replay reports what they produce rather than what
// anybody hoped they would produce.

import {
  identifiers, dateSpan, dates, domains, rareTerms, documentFrequency, subsumedTerms,
} from './text-features.js'

export type RelationType = 'CASE_PARENT_CANDIDATE' | 'SOURCE_CASE_CANDIDATE'

/** Independent families. Two must fire, or one decisive one. */
export type FeatureFamily = 'IDENTIFIER' | 'TEMPORAL' | 'TERM' | 'VENDOR'

export interface Feature {
  family: FeatureFamily
  /** Machine-readable name, e.g. SHARED_IDENTIFIER. */
  name: string
  /** Contribution before the independence rule is applied. */
  weight: number
  /** What a person would check to agree or disagree. */
  reason: string
  /**
   * CORROBORATION ONLY: this may add confidence but may NOT be one of the two
   * independent families the rule demands.
   *
   * Measured, not assumed. The first replay proposed a parent for 50 of 96
   * parentless cases, and the reasons said why: "the day it was FILED falls
   * inside the target's window" plus "both use the uncommon term 'nincs'".
   * Most of this store was filed in the same fortnight as the trip, so the
   * filing date joins almost anything to it -- and it is a fact about when the
   * intake ran, not about what the case is. Paired with any shared word it
   * manufactured a second family out of nothing.
   */
  corroborationOnly?: boolean
}

export interface NegativeFeature {
  name: string
  /** Why this makes the proposal weaker or impossible. */
  reason: string
  /** true = the proposal is refused outright, not merely reduced. */
  disqualifying: boolean
}

export interface CandidateInput {
  id: string
  /**
   * The STORE this belongs to. A hard boundary: cross-namespace is refused.
   *
   * NOT the mailbox. The owner's rule is "cross-mailbox candidate = YES,
   * cross-namespace canonicalization = NO", and collapsing the two would have
   * refused the very acceptance case for this feature: the Neon billing threads
   * arrive on the ZST account while the dossier that wants them,
   * CORP-CLOUD-2026-001, lives in the personal store. Which account received a
   * message is evidence about the message; which store a case lives in is a
   * boundary about authority. They are different facts and they are stored
   * apart.
   */
  namespace: string
  /** Which account this arrived on, when that is known. Recorded in the
   *  evidence so a cross-mailbox proposal is legible as one, never used as a
   *  boundary. */
  mailbox?: string
  /** Everything the case says about itself: title, description, next action. */
  text: string
  /** When it entered the store. */
  createdAtDay: number
}

export interface RelationCandidate {
  relationType: RelationType
  namespace: string
  /** Present when the source and the target came in on different accounts. */
  crossMailbox?: { sourceMailbox: string; targetMailbox?: string }
  sourceRef: string
  targetCaseId: string
  confidence: number
  features: Feature[]
  negatives: NegativeFeature[]
  /** One sentence per positive feature, in the order they contributed. */
  reasons: string[]
  algorithmFingerprint: string
}

/**
 * Weights, and where each number comes from.
 *
 * A shared reference number is the only decisive one: two texts naming
 * `D014745393` are about the same booking, and there is no innocent reason for
 * that collision. Everything else is corroboration — a date range containing a
 * case, a rare term shared, a vendor domain shared — and none of those is
 * allowed to carry a proposal by itself, however many of its own kind it finds.
 */
export const WEIGHTS = {
  SHARED_IDENTIFIER: 0.60,
  /** The umbrella's evidence is its CHILDREN. See siblingBridge below. */
  SIBLING_IDENTIFIER_BRIDGE: 0.55,
  DATE_WITHIN_SPAN: 0.30,
  DATE_NEAR_SPAN: 0.12,
  /** The case names no dates of its own, so the filing date stands in.
   *  Corroboration only -- it can never be one of the two required families. */
  FILED_WITHIN_SPAN: 0.10,
  SHARED_RARE_TERM: 0.14,
  SHARED_DOMAIN: 0.18,
} as const

/** Corroboration saturates: five shared rare terms are not five times one. */
const TERM_CAP = 0.34
/** How far outside a span still counts as near it. */
export const NEAR_SPAN_DAYS = 7
/**
 * Below this, a proposal is not worth an owner's attention.
 *
 * CHOSEN FROM A SWEEP, and only because the point is strictly dominant. Over
 * the live store, leave-one-out:
 *
 *   threshold   top-1    false candidates   unlabelled proposals
 *      0.35     13/18            3                   19
 *      0.45     13/18            1                   10
 *      0.50     11/18            1                    7
 *      0.65      9/18            0                    3
 *
 * 0.45 costs nothing in recall and removes two thirds of the noise; past it
 * recall starts paying. This is not the tuning the owner ruled out -- that was
 * inventing a threshold to RECOVER the historical set, and moving in this
 * direction cannot do that. The floor was left where it stops being free.
 */
export const CANDIDATE_THRESHOLD = 0.45

export const ALGORITHM_VERSION = 'local-lexical-v1'

export function algorithmFingerprint(): string {
  const params = JSON.stringify({ WEIGHTS, TERM_CAP, NEAR_SPAN_DAYS, CANDIDATE_THRESHOLD })
  let h = 0
  for (let i = 0; i < params.length; i++) { h = (h * 31 + params.charCodeAt(i)) | 0 }
  return `${ALGORITHM_VERSION}:${(h >>> 0).toString(16)}`
}

/** Evidence for one (source, target) pair. Pure: no store, no clock. */
export function scorePair(
  source: CandidateInput,
  target: CandidateInput,
  df: Map<string, number>,
  corpusSize: number,
): { features: Feature[]; negatives: NegativeFeature[]; confidence: number } {
  const features: Feature[] = []
  const negatives: NegativeFeature[] = []

  // Cross-namespace is refused outright, not scored down. A candidate the owner
  // may not act on is not a weaker candidate, it is not a candidate.
  if (source.namespace !== target.namespace) {
    negatives.push({
      name: 'NAMESPACE_MISMATCH',
      reason: `source is in '${source.namespace}', target in '${target.namespace}'`,
      disqualifying: true,
    })
    return { features, negatives, confidence: 0 }
  }
  if (source.id === target.id) {
    negatives.push({ name: 'SELF', reason: 'a case cannot be its own parent', disqualifying: true })
    return { features, negatives, confidence: 0 }
  }

  const sIds = new Set(identifiers(source.text))
  const sharedIds = identifiers(target.text).filter((i) => sIds.has(i))
  for (const id of sharedIds) {
    features.push({
      family: 'IDENTIFIER', name: 'SHARED_IDENTIFIER', weight: WEIGHTS.SHARED_IDENTIFIER,
      reason: `both name the reference ${id}`,
    })
  }

  // TEMPORAL. The target's span is the umbrella's declared window; the source's
  // own dates are preferred over its creation date, because when it was filed
  // is a fact about the intake and what it is about is a fact about the world.
  const span = dateSpan(target.text)
  if (span) {
    const own = dates(source.text).map((d) => d.day)
    const points = own.length ? own : [source.createdAtDay]
    const inside = points.some((p) => p >= span.from && p <= span.to)
    const near = !inside && points.some((p) =>
      p >= span.from - NEAR_SPAN_DAYS && p <= span.to + NEAR_SPAN_DAYS)
    const label = own.length ? 'the dates it names' : 'the day it was filed'
    if (inside && !own.length) {
      features.push({
        family: 'TEMPORAL', name: 'FILED_WITHIN_SPAN', weight: WEIGHTS.FILED_WITHIN_SPAN,
        reason: `${label} falls inside the target's window (weak: when the intake ran, not what the case is about)`,
        corroborationOnly: true,
      })
    } else if (inside) {
      features.push({
        family: 'TEMPORAL', name: 'DATE_WITHIN_SPAN', weight: WEIGHTS.DATE_WITHIN_SPAN,
        reason: `${label} fall inside the target's window`,
      })
    } else if (near && own.length) {
      features.push({
        family: 'TEMPORAL', name: 'DATE_NEAR_SPAN', weight: WEIGHTS.DATE_NEAR_SPAN,
        reason: `${label} fall within ${NEAR_SPAN_DAYS} days of the target's window`,
      })
    } else {
      negatives.push({
        name: 'TEMPORAL_DISJOINT',
        reason: `${label} fall outside the target's window and its ${NEAR_SPAN_DAYS}-day margin`,
        disqualifying: false,
      })
    }
  }

  // Terms that are only the spelling of a domain or a reference number belong
  // to those families, not to this one. Counting them twice would let a single
  // shared vendor satisfy the two-family rule on its own.
  const subsumed = new Set([...subsumedTerms(source.text), ...subsumedTerms(target.text)])
  const sTerms = new Set(rareTerms(source.text, df, corpusSize).filter((t) => !subsumed.has(t)))
  const sharedTerms = rareTerms(target.text, df, corpusSize)
    .filter((t) => !subsumed.has(t) && sTerms.has(t))
  if (sharedTerms.length) {
    const raw = Math.min(TERM_CAP, sharedTerms.length * WEIGHTS.SHARED_RARE_TERM)
    features.push({
      family: 'TERM', name: 'SHARED_RARE_TERM', weight: raw,
      reason: `both use the uncommon term${sharedTerms.length > 1 ? 's' : ''} `
        + sharedTerms.slice(0, 4).map((t) => `"${t}"`).join(', ')
        + (sharedTerms.length > 4 ? ` and ${sharedTerms.length - 4} more` : ''),
    })
  }

  const sDomains = new Set(domains(source.text))
  const sharedDomains = domains(target.text).filter((d) => sDomains.has(d))
  for (const d of sharedDomains) {
    features.push({
      family: 'VENDOR', name: 'SHARED_DOMAIN', weight: WEIGHTS.SHARED_DOMAIN,
      reason: `both involve ${d}`,
    })
  }

  // THE INDEPENDENCE RULE. Corroboration-only features do not count towards it.
  const familiesFiring = new Set(features.filter((f) => !f.corroborationOnly).map((f) => f.family))
  const decisive = features.some((f) => f.name === 'SHARED_IDENTIFIER')
  let confidence = Math.min(1, features.reduce((s, f) => s + f.weight, 0))

  if (!decisive && familiesFiring.size < 2) {
    const only = [...familiesFiring][0] ?? 'none'
    negatives.push({
      name: 'SINGLE_FAMILY_ONLY',
      reason: `all the evidence is of one kind (${only}); a shared term or a shared `
        + 'vendor on its own joins two different matters as readily as the right one',
      disqualifying: false,
    })
    // Held BELOW the threshold rather than zeroed: the evidence is real and
    // stays visible for a later run that finds its second family.
    confidence = Math.min(confidence, CANDIDATE_THRESHOLD - 0.01)
  }

  if (negatives.some((n) => n.name === 'TEMPORAL_DISJOINT') && !decisive) {
    confidence = Math.max(0, confidence - WEIGHTS.DATE_WITHIN_SPAN)
  }

  return { features, negatives, confidence: Number(confidence.toFixed(4)) }
}

/**
 * THE UMBRELLA'S EVIDENCE IS ITS CHILDREN.
 *
 * Measured, and it is the single most useful thing the first replay reported.
 * Six of eighteen positives were missed outright, all of them Spanish-trip
 * bookings, and the reason is structural rather than a matter of weights:
 * `PRI-TRIP-2026-001` is a two-line umbrella that names a window and three
 * cities. It carries no booking reference, so `SHARED_IDENTIFIER` -- the one
 * decisive feature in the engine -- can never fire between a child and it.
 *
 * But it fires beautifully between SIBLINGS. `D014745393` appears in the
 * Centauro case and in the deposit-card case; `D014889443` in two Hertz cases,
 * one of which the human never attached. Matching a case to an umbrella through
 * a sibling that already belongs to it uses the strong signal that actually
 * exists in the data, and it is what the owner asked for in as many words: the
 * engine should give parent candidates FROM the Valencia cluster.
 *
 * Bounded: only the umbrella's own children are consulted, and a bridge is
 * claimed only on a shared identifier -- the one signal with no innocent
 * explanation. A bridge built on shared words would propagate every weak guess
 * across a whole cluster at once.
 */
function siblingBridge(
  source: CandidateInput,
  children: readonly CandidateInput[],
  df: Map<string, number>,
  corpusSize: number,
): Feature | null {
  for (const child of children) {
    // No self-check here on purpose. `scorePair` already refuses a pair with
    // the same id on both sides and returns no features, so a guard here would
    // be a second line that LOOKS load-bearing and can never fire -- a mutation
    // proved exactly that by deleting it with every test still green.
    const { features } = scorePair(source, child, df, corpusSize)
    const shared = features.find((f) => f.name === 'SHARED_IDENTIFIER')
    if (shared) {
      return {
        family: 'IDENTIFIER', name: 'SIBLING_IDENTIFIER_BRIDGE',
        weight: WEIGHTS.SIBLING_IDENTIFIER_BRIDGE,
        reason: `${shared.reason.replace('both name', 'it shares')} with ${child.id}, `
          + 'which already belongs to this case',
      }
    }
  }
  return null
}

/**
 * Parent candidates for one case, best first.
 *
 * Bounded by construction: `topN` limits what is returned, and the caller
 * supplies both the target set and each target's children, so nothing here can
 * widen its own search.
 */
export function parentCandidates(
  source: CandidateInput,
  targets: readonly CandidateInput[],
  corpus: readonly string[],
  topN = 3,
  childrenOf: ReadonlyMap<string, readonly CandidateInput[]> = new Map(),
): RelationCandidate[] {
  const df = documentFrequency(corpus)
  const fp = algorithmFingerprint()
  const out: RelationCandidate[] = []
  for (const t of targets) {
    const direct = scorePair(source, t, df, corpus.length)
    if (direct.negatives.some((n) => n.disqualifying)) continue

    let { features, negatives, confidence } = direct
    const bridge = siblingBridge(source, childrenOf.get(t.id) ?? [], df, corpus.length)
    if (bridge) {
      // A bridge is decisive, so it replaces the independence verdict rather
      // than being added under it: the SINGLE_FAMILY_ONLY cap must not hold
      // down a proposal resting on a shared booking reference.
      features = [bridge, ...features]
      negatives = negatives.filter((n) => n.name !== 'SINGLE_FAMILY_ONLY')
      confidence = Math.min(1, features.reduce((sum, f) => sum + f.weight, 0))
    }
    if (confidence < CANDIDATE_THRESHOLD) continue
    const crossMailbox = source.mailbox && source.mailbox !== t.mailbox
      ? { sourceMailbox: source.mailbox, ...(t.mailbox ? { targetMailbox: t.mailbox } : {}) }
      : undefined
    if (crossMailbox) {
      features.push({
        family: 'VENDOR', name: 'CROSS_MAILBOX', weight: 0,
        reason: `it arrived on the ${crossMailbox.sourceMailbox} account`
          + (crossMailbox.targetMailbox ? `, the case on ${crossMailbox.targetMailbox}` : ''),
        corroborationOnly: true,
      })
    }
    out.push({
      relationType: 'CASE_PARENT_CANDIDATE',
      namespace: source.namespace,
      ...(crossMailbox ? { crossMailbox } : {}),
      sourceRef: source.id,
      targetCaseId: t.id,
      confidence: Number(confidence.toFixed(4)),
      features,
      negatives,
      reasons: features.map((f) => f.reason),
      algorithmFingerprint: fp,
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.targetCaseId.localeCompare(b.targetCaseId))
    .slice(0, topN)
}

/** Case candidates for one SOURCE (a thread, a message). Same engine, same
 *  rules; only the relation type and what `sourceRef` names differ. */
export function sourceCaseCandidates(
  source: CandidateInput,
  targets: readonly CandidateInput[],
  corpus: readonly string[],
  topN = 3,
  childrenOf: ReadonlyMap<string, readonly CandidateInput[]> = new Map(),
): RelationCandidate[] {
  return parentCandidates(source, targets, corpus, topN, childrenOf)
    .map((c) => ({ ...c, relationType: 'SOURCE_CASE_CANDIDATE' as const }))
}
