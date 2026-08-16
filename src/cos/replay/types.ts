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

export interface ReplayCaseProjection {
  replayCaseId: string
  domain: CosDomain
  threadId: string
  title: string
  caseType: string
  status: string
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

export type ReconciliationAuthority = 'SOURCE_DERIVED' | 'PRODUCTION_AUTHORITATIVE' | 'CONFLICT_REVIEW'
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
