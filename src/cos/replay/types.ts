import type { CosDomain, TemporalFactKind } from '../temporal-facts.js'

export type ReplayDirection = 'INBOUND' | 'SENT'

export interface ReplayAttachment {
  filename: string
  mimeType?: string | null
  sha256?: string | null
  sizeBytes?: number | null
}

/** Immutable normalized source event. `occurredAt` is provider time in epoch sec. */
export interface ReplayMessage {
  sourceAccountId: string
  messageId: string
  threadId: string
  direction: ReplayDirection
  occurredAt: number
  subject: string
  bodyText: string
  from?: string | null
  to?: string[]
  attachments?: ReplayAttachment[]
}

export interface ReplayCorpus {
  generatedAt: number
  anchorStart: number
  anchorEnd: number
  messages: ReplayMessage[]
}

/** Stage 2H (Istvan, 2026-08-18). The ONLY way a replay may hold a caseType: a
 *  named production case lends it as an external input. There is no source path
 *  to a caseType — the audit of 2026-08-17 measured that the triage verdict is
 *  persisted nowhere and no production text->type classifier exists — so a
 *  replay that produces one from content is producing a guess, not a replay. */
export interface ProductionAuthorityOverlay {
  threadId: string
  productionCaseId: string
  caseType: string
}

/** Which of the two things a projection is. They are not degrees of the same
 *  measurement: the first re-derives from source, the second borrows the type
 *  and may therefore never be quoted as classification evidence. */
export type ReplayProjectionAuthority =
  | 'HISTORICAL_SOURCE_REPLAY'
  | 'CONDITIONAL_ON_PRODUCTION_TYPE'

export interface ReplayCaseProjection {
  replayCaseId: string
  domain: CosDomain
  threadId: string
  projectionAuthority: ReplayProjectionAuthority
  /** The production case that lent the caseType; null in a historical replay. */
  productionCaseId: string | null
  /** null under HISTORICAL_SOURCE_REPLAY: NOT_REPLAYABLE, never a guessed value.
   *  `title` stays null even under an overlay — production's title is a triage
   *  judgement, and the overlay lends the type only. */
  title: string | null
  caseType: string | null
  status: string | null
  nextAction: string | null
  nextActionOwner: string | null
  waitingOn: string | null
  dueAt: number | null
  followUpAt: number | null
  nextWakeAt: number | null
  scopeNeedsReview: boolean
  sourceMessageIds: string[]
  latestSourceAt: number
}

export interface ReplayTemporalProjection {
  replayCaseId: string
  kind: TemporalFactKind
  occursAt: number
  raw: string
  sourceMessageId: string
  verification: 'UNVERIFIED'
}

/** Stage 2H (Istvan, 2026-08-17). The audit of the same day measured that the
 *  triage judgement behind caseType/title/priority/workspace/sensitivity is
 *  persisted NOWHERE and has no deterministic production classifier to re-run,
 *  so a replay cannot derive those from source. Two authorities exist to stop a
 *  reconciliation from calling that agreement OR disagreement:
 *
 *  - NOT_REPLAYABLE               the field cannot be produced from source at
 *                                 all; it is coverage, never a match or a miss.
 *  - CONDITIONAL_ON_PRODUCTION_TYPE  the field WAS produced, but only because the
 *                                 production caseType was fed in as an external
 *                                 input (PRODUCTION_AUTHORITY_OVERLAY). It may be
 *                                 measured; it may not be called source-derived. */
export type ReconciliationAuthority =
  | 'SOURCE_DERIVED'
  | 'PRODUCTION_AUTHORITATIVE'
  | 'CONFLICT_REVIEW'
  | 'NOT_REPLAYABLE'
  | 'CONDITIONAL_ON_PRODUCTION_TYPE'
export type ReconciliationSeverity = 'P0' | 'P1' | 'P2' | 'P3'

export interface ProductionCaseSnapshot {
  caseId: string
  domain: CosDomain
  threadIds: string[]
  title: string
  caseType?: string | null
  status: string
  nextAction?: string | null
  nextActionOwner?: string | null
  waitingOn?: string | null
  dueAt?: number | null
  followUpAt?: number | null
  nextWakeAt?: number | null
  closureReason?: string | null
  /** The exact production input message (`source_reference`). The extractor
   *  parity feeds THIS message, not a reconstructed thread digest: production
   *  extracted from one mail, so a replay that extracts from another is
   *  measuring a different input and may not report the difference as a
   *  mismatch. Absent => the input is not reproducible for that case. */
  sourceReference?: string | null
  /** True when a human/manual event is the authority for current state. */
  hasHumanAuthorityEvent?: boolean
  /** True when an outbound provider receipt exists and must never be replay-overwritten. */
  hasExternalReceipt?: boolean
}

export interface ReconciliationFinding {
  findingId: string
  domain: CosDomain
  threadId: string | null
  productionCaseId: string | null
  replayCaseId: string | null
  field: string
  productionValue: unknown
  replayValue: unknown
  authority: ReconciliationAuthority
  severity: ReconciliationSeverity
  reason: string
  autoApplyAllowed: false
}

export interface CorrectionManifest {
  generatedAt: number
  replayRunId: string
  autoApplyAllowed: false
  findings: ReconciliationFinding[]
  summary: {
    total: number
    p0: number
    p1: number
    p2: number
    p3: number
    unclassified: number
  }
  /** Stage 2H coverage. Deliberately NOT a single agreement percentage: mixing a
   *  field we re-derived with one we could never derive produces a number whose
   *  own author cannot say what it measured. */
  coverage: {
    /** field comparisons the replay was in a position to attempt at all */
    eligible: number
    /** of those, actually compared (source-derived or conditional) */
    compared: number
    matched: number
    mismatched: number
    /** compared only because production supplied the caseType */
    conditional: number
    /** of the conditional comparisons, the ones that differ */
    conditionalMismatched: number
    /** fields excluded from match/mismatch by construction */
    notReplayable: number
    /** conditional fields left unattempted because no overlay lent the type in
     *  THIS run. Not a match, not a mismatch, and not the same thing as a field
     *  that can never be replayed. */
    conditionalNotAttempted: number
    /** eligible, not compared, and not classifiable as either */
    unknown: number
  }
}

// ── Stage 2H parity surfaces (Istvan, 2026-08-18) ──────────────────────────
// Four separate statuses, because one boolean could go green while the surface
// that matters was never run. NOT_RUN is not PASS and NOT_REPLAYABLE is not PASS.

export type ParitySurfaceStatus =
  | 'PASS'
  | 'FAIL'
  | 'NOT_RUN'
  | 'NOT_REPLAYABLE'
  /** The surface ran and found nothing it is entitled to measure. Retired
   *  2026-08-18 for FULL_BODY: production extracted from the ~200-char provider
   *  snippet in all 15 cases, so a full-body replay has zero historical targets.
   *  Not FAIL (nothing failed) and not NOT_RUN (it ran). */
  | 'NO_ELIGIBLE_HISTORICAL_INPUT'

export interface ReplayReadiness {
  /** connector/thread/message identity, provider time, direction, digests */
  historicalSourceReplayStatus: ParitySurfaceStatus
  /** the real production extractors, under a production type overlay */
  conditionalExtractorParityStatus: ParitySurfaceStatus
  /** document/attachment ingest parity */
  documentParityStatus: ParitySurfaceStatus
  /** structurally fixed: there is no persisted verdict and no classifier */
  historicalTriageReplayStatus: 'NOT_REPLAYABLE'
  /** true only when every mandatory surface PASSed and no conditional
   *  mismatch is left unresolved. An accepted coverage limitation
   *  (historicalTriageReplayStatus) does not make it true and does not block it. */
  stable: boolean
  reasons: string[]
}

export type ExtractorRoute = 'INVOICE' | 'CONTRACT'

/** What input the extractor was fed, and therefore what the result may be called.
 *  Measured by the 2026-08-18 provenance audit, never inferred here. */
export type InputBasis =
  /** the provider snippet plus the real From/Subject: what production received */
  | 'HISTORICAL_PROVIDER_SNIPPET_WITH_HEADERS'
  /** the production input cannot be reproduced for this thread */
  | 'HISTORICAL_INPUT_NOT_EQUIVALENT'
  /** full body: a current-extractor evaluation, NEVER historical parity */
  | 'CURRENT_FULL_BODY'

/** The two outcomes an extractor run can have. "No row" is one of them, and it is
 *  a result, not a silence: it counts only when the extractor demonstrably ran. */
export type ExtractionOutcome = 'STRUCTURED_ROW' | 'NO_EXTRACTION'

export type ExtractorParityVerdict =
  | 'PASS'
  | 'MISMATCH'
  /** the thread's input basis excludes it from the parity denominator */
  | 'NOT_IN_DENOMINATOR'
  /** the replay extracted a row production holds none of. Not a mismatch between
   *  two answers — production has no answer here — and never a pass either. */
  | 'PRODUCTION_HAS_NO_ROW'
  /** the production input shape could not be reproduced; never mixed with PASS */
  | 'RETRIAGE_INPUT_NOT_EQUIVALENT'
  /** the production gate does not route this type to an extractor at all */
  | 'NOT_ROUTED'
  /** the seam cannot be crossed without copying production logic */
  | 'SEAM_BLOCKED'

export type FieldParityVerdict =
  | 'PASS'
  | 'MISMATCH'
  | 'BOTH_ABSENT'
  | 'PRODUCTION_ABSENT'
  | 'REPLAY_ABSENT'
  /** production never persisted this observation, so there is nothing to compare */
  | 'PRODUCTION_NOT_PERSISTED'

export interface FieldParity {
  field: string
  productionValue: unknown
  replayValue: unknown
  verdict: FieldParityVerdict
}

export interface ExtractorParityRow {
  threadId: string
  productionCaseId: string
  /** external input, never a classification result */
  caseType: string
  route: ExtractorRoute | null
  sourceMessageId: string | null
  inputBasis: InputBasis
  /** sha256 over the exact bytes handed to the extractor. Two runs that disagree
   *  here were not comparing the same thing, whatever their verdicts say. */
  inputDigest: string | null
  authority: 'CONDITIONAL_ON_PRODUCTION_TYPE'
  /** always false: an overlay-fed run can never prove the classification */
  classificationProof: false
  /** false when the row was excluded before any extractor was called */
  extractorAttempted: boolean
  /** what production's stored state says the historical outcome was */
  expectedHistorical: ExtractionOutcome | null
  /** what this replay produced */
  replayResult: ExtractionOutcome | null
  /** duplicate fingerprints of both sides, when a row exists */
  productionFingerprint: string | null
  replayFingerprint: string | null
  replayConfidence: string | null
  replayExtractedFields: string[]
  comparisons: FieldParity[]
  verdict: ExtractorParityVerdict
  reasons: string[]
}

export interface ExtractorParityReport {
  generatedAt: number
  authority: 'CONDITIONAL_ON_PRODUCTION_TYPE'
  classificationProof: false
  /** CURRENT_FULL_BODY runs are diagnostics and are marked as such here too. */
  basis: 'HISTORICAL' | 'CURRENT_ONLY'
  rows: ExtractorParityRow[]
  /** sha256 over the deterministic projection of every row: result kinds,
   *  structured output, fingerprints, input digests. Carries no timestamp, so
   *  two runs on the same immutable input must produce the same value. */
  parityDigest: string
  summary: {
    targets: number
    /** targets whose input basis lets them be compared at all */
    eligible: number
    /** of the eligible, the ones actually compared */
    compared: number
    pass: number
    mismatch: number
    productionHasNoRow: number
    inputNotEquivalent: number
    notRouted: number
    seamBlocked: number
    unknown: number
    /** field-level, across every comparable row */
    fieldsCompared: number
    fieldsMatched: number
    fieldsMismatched: number
    fieldsNotPersistedByProduction: number
  }
}

export interface ZstLegacyCaseInput {
  caseId: string
  status: string
  caseType?: string | null
  nextAction?: string | null
  nextActionOwner?: string | null
  waitingOn?: string | null
  dueAt?: number | null
  followUpAt?: number | null
  nextWakeAt?: number | null
  parentCaseId?: string | null
  hasOpenChildren?: boolean
}

export interface ZstMigrationCandidate {
  caseId: string
  currentClassification: string
  proposedNextAction: string | null
  proposedNextActionOwner: string | null
  requiresHumanReview: boolean
  reasons: string[]
}

export interface ZstMigrationBatch {
  phase: 'DRY_RUN' | 'CANARY_2' | 'CANARY_5' | 'CANARY_10' | 'REMAINDER'
  caseIds: string[]
}
