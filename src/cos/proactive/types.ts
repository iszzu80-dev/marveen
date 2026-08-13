// Marveen ACP v1.4 Proactive Core — the vocabulary (§4, §5, §6, §9, §15.1–15.2).
//
// WHAT THIS RELEASE IS. v1.4 detects, qualifies and prepares INTERNALLY. It adds
// zero new external execution surface: no browser, no fetch, no new recipient,
// no binding action. Everything in this directory is written to that boundary,
// and two standing checks (`proactive-core-action-boundary.test.ts`,
// `proactive-core-import-boundary.test.ts`) fail if a later change crosses it.
//
// WHAT IT IS NOT, TODAY. Nothing here is wired into a sweep, a heartbeat, a
// notification or a Case transition. §27 Stage 0 is "replay only", and this
// slice is the vocabulary and the deterministic policy that a replay driver will
// call — deliberately inert until the value gate of §1.4 is registered and
// frozen. A detector that runs before its measurement window exists cannot be
// evaluated afterwards.
//
// ON THE DOMAIN NAMES. The spec writes `"PRI" | "ZST"`. This codebase has said
// `'personal' | 'zst'` since the first Case table, in every index, every query
// and every isolation check. §3 forbids a parallel subsystem, and a second
// domain vocabulary IS one: two spellings of the same partition is how a
// cross-domain leak survives review, because each half looks correct in its own
// dialect. The spec's names are the paper names; these are the ones the database
// already enforces.

/**
 * A claim with its citation — the same shape as the Reader's `EvidenceFact`, and
 * deliberately DECLARED here rather than imported from `reader.ts`.
 *
 * The import-boundary standing check found why on its first run. `reader.ts`
 * imports the Anthropic SDK, so `import type { EvidenceFact } from '../reader.js'`
 * put an HTTP client into the v1.4 transitive dependency closure — the precise
 * shape §15.3(2) forbids. TypeScript erases a type-only import, so nothing would
 * have reached the network at runtime; that is an argument about compilation,
 * not about the dependency graph, and the graph is what the release boundary is
 * written against. A boundary that holds "as long as nobody changes `import
 * type` to `import`" is not a boundary.
 *
 * Structurally identical, so a Reader fact can still be handed straight to a
 * signal. One shape, no edge.
 */
export interface EvidenceClaim {
  statement: string
  sourceRef: string
}

/** §4: the eight things the Proactive Core can notice. */
export type ProactiveSignalType =
  | 'OPPORTUNITY'
  | 'RISK'
  | 'OBLIGATION'
  | 'DEADLINE'
  | 'ANOMALY'
  | 'STALL'
  | 'CHANGE'
  | 'GAP'

export const PROACTIVE_SIGNAL_TYPES: readonly ProactiveSignalType[] = [
  'OPPORTUNITY', 'RISK', 'OBLIGATION', 'DEADLINE', 'ANOMALY', 'STALL', 'CHANGE', 'GAP',
] as const

export type ProactiveDomain = 'personal' | 'zst'
export type Materiality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type Actionability = 'LOW' | 'MEDIUM' | 'HIGH'

export type SignalStatus = 'DETECTED' | 'SUPPRESSED' | 'PROMOTED' | 'ANNOTATED'

/** §4. A signal is first-class and is NOT a Case. It carries no authority: its
 *  existence cannot interrupt the owner (§4.1) and cannot open a Case (§8). */
export interface ProactiveSignal {
  signalId: string
  domain: ProactiveDomain
  signalType: ProactiveSignalType

  /** Where this came from, in the same `sourceRef` vocabulary the Reader uses.
   *  §4.1: a signal may exist only on evidence, and at least one reference is
   *  mandatory — a model's hunch with no citation is not a signal. */
  sourceRefs: string[]
  /** The concrete events behind it, for the §7.1 exact-identity dedupe tier. */
  sourceEventIds: string[]
  detectedAt: number

  subjectRef?: string
  candidateCaseId?: string

  summary: string
  /** §4.1: every claim carries its own citation. Same shape as the Reader's
   *  facts on purpose — one evidence vocabulary, not two. */
  evidenceClaims: EvidenceClaim[]

  estimatedMateriality: Materiality
  estimatedUrgency: Urgency
  estimatedActionability: Actionability

  /** Unix seconds. The spec writes an ISO string; every deadline column in this
   *  store is an INTEGER epoch, and mixing the two is how deadline arithmetic
   *  goes wrong silently (V4-F12 is exactly that class of failure). */
  candidateDeadline?: number
  confidence: number

  /** §7.1. `dedupeKey` answers "is this the same situation?"; `noveltyKey`
   *  answers "has anything materially changed about it?". Two keys because
   *  collapsing them makes a materially changed state indistinguishable from a
   *  repeat, which §7.2 forbids by name. */
  dedupeKey: string
  noveltyKey: string

  status: SignalStatus
}

export type InitiativeState =
  | 'QUALIFIED'
  | 'LINKED_TO_CASE'
  | 'PREPARING'
  | 'WAITING_INTERNAL'
  | 'DECISION_READY'
  | 'SUPPRESSED'
  | 'RESOLVED'

/** §9. An Initiative may not sit in "let's have a look" with no outcome. */
export interface DesiredOutcome {
  outcomeType: string
  targetState: string
  completionEvidence: string[]
  authorityBoundary?: string
}

/** §15.1. The complete set of things the v1.4 planner may do. Every one of them
 *  is internal and side-effect-free, or an already-existing safe draft class.
 *
 *  This list is load-bearing, not documentation: `proactive-core-action-boundary`
 *  asserts it verbatim, so widening it is a deliberate act that shows up in a
 *  diff with a failing test attached. */
export type InternalPreparationClass =
  | 'READ_CONTEXT'
  | 'RESOLVE_MISSING_INFORMATION'
  | 'CHECK_DEADLINE'
  | 'VERIFY_STATE'
  | 'CHECK_STALL'
  | 'CHECK_ANOMALY'
  | 'ORGANIZE_EVIDENCE'
  | 'ASSESS_RISK'
  | 'CHECK_DUPLICATE'
  | 'PREPARE_DRAFT'
  | 'PREPARE_DECISION_PACKAGE'
  | 'PREPARE_INTERNAL_SUMMARY'
  | 'SCHEDULE_REVIEW'

export const INTERNAL_PREPARATION_CLASSES: readonly InternalPreparationClass[] = [
  'READ_CONTEXT', 'RESOLVE_MISSING_INFORMATION', 'CHECK_DEADLINE', 'VERIFY_STATE',
  'CHECK_STALL', 'CHECK_ANOMALY', 'ORGANIZE_EVIDENCE', 'ASSESS_RISK', 'CHECK_DUPLICATE',
  'PREPARE_DRAFT', 'PREPARE_DECISION_PACKAGE', 'PREPARE_INTERNAL_SUMMARY', 'SCHEDULE_REVIEW',
] as const

/** §15.2. Named so the boundary can be checked, not only described.
 *
 *  §15.3(5) is the reason this is a list of STRINGS rather than a type: the
 *  failure mode it defends against is an alias or a rename smuggling a forbidden
 *  class past the allowlist, and a type cannot see a string that was renamed. */
export const FORBIDDEN_EXTERNAL_ACTION_CLASSES: readonly string[] = [
  'RESEARCH_WEB', 'BROWSER_NAVIGATE', 'FORM_FILL', 'FORM_SUBMIT',
  'SEND_TO_NEW_EXTERNAL_RECIPIENT', 'DISCLOSE_PERSONAL_DATA', 'CREATE_ACCOUNT',
  'ACCEPT_OFFER', 'BOOK', 'ORDER', 'PAY', 'CANCEL_CONTRACT', 'SIGN', 'LEGAL_COMMITMENT',
] as const

/** §5. The qualified, action-worthy proactive unit. */
export interface ProactiveInitiative {
  initiativeId: string
  domain: ProactiveDomain
  signalIds: string[]

  initiativeType: ProactiveSignalType

  materiality: Materiality
  urgency: Urgency

  caseId?: string
  desiredOutcome: DesiredOutcome
  currentGap: string

  decisionDeadline?: number
  /** §10: the internal date by which preparation must be finished for the
   *  decision deadline still to be meetable. Never presented as the deadline. */
  internalSafeDeadline?: number

  allowedPreparationClasses: InternalPreparationClass[]
  unresolvedRequirements: string[]

  /** §4.1 / §17: computed, and in this release never acted on. Nothing in v1.4
   *  Stage 0 reads this field to interrupt anybody. */
  userInterruptionRequired: boolean
  interruptionReason?: string

  state: InitiativeState
  confidence: number
}

/** §6.2. The qualification verdict, with every score it was based on. Scores are
 *  persisted rather than recomputed at read time: §1.4.3 adjudication compares a
 *  frozen corpus, and a score that moves when the policy is tuned would silently
 *  re-write history the value gate is being measured against. */
export interface InitiativeQualificationResult {
  signalId: string
  decision: 'SUPPRESS' | 'ANNOTATE' | 'PROMOTE'
  /** Machine-readable, ordered by the §6.1 decision sequence. The reason a
   *  signal was dropped has to be measurable (§6.3, V4-F10), which free text
   *  is not. */
  reasonCodes: string[]
  matchedCaseId?: string
  materialityScore: number
  urgencyScore: number
  actionabilityScore: number
  interruptionScore: number
  confidence: number
}
