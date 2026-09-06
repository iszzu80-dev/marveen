export const PROGRAM_WORKSTREAMS = [
  'COS_P2', 'COS_P3', 'COS_P4', 'COS_P5', 'COS_BROWSER_R', 'COS_BROWSER_S_GATED',
] as const
export type ProgramWorkstream = typeof PROGRAM_WORKSTREAMS[number]

export const REVIEW_KINDS = ['IMPLEMENTATION', 'LIVE_VALIDATION', 'RELEASE_EVIDENCE'] as const
export type ReviewKind = typeof REVIEW_KINDS[number]

export const REVIEW_VERDICTS = ['PASS', 'FINDINGS', 'NEEDS_DECISION', 'ERROR'] as const
export type ReviewVerdict = typeof REVIEW_VERDICTS[number]

export const AUTHORITY_CATEGORIES = [
  'OWNER_DECISION', 'POLICY_DECISION', 'SAFETY_DECISION', 'COST_DECISION',
  'MATERIAL_SCOPE_CHANGE', 'IRREVERSIBLE_EXTERNAL', 'READY_FOR_RELEASE',
] as const
export type AuthorityCategory = typeof AUTHORITY_CATEGORIES[number]

export const OBSERVATION_STATUSES = [
  'READY_FOR_OBSERVATION', 'WAITING_FOR_LIVE_EVIDENCE', 'WAITING_FOR_POPULATION',
  'WAITING_FOR_OBSERVATION_WINDOW', 'WAITING_FOR_EXTERNAL_EVIDENCE',
  'LIVE_VALIDATION_REQUIRED', 'OBSERVATION_IN_PROGRESS', 'OBSERVATION_FAILED',
  'IMPLEMENTATION_VERIFIED', 'LIVE_VALIDATION_PENDING', 'LIVE_POPULATION_NOT_PRESENT',
  'NOT_EVALUATED', 'VERIFIED_DONE',
] as const
export type ObservationStatus = typeof OBSERVATION_STATUSES[number]

export interface ReviewFinding {
  id: string
  severity: 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW'
  summary: string
  evidence_refs: string[]
  proposed_fix: string | null
}

export interface AuthorityConstraints {
  codex_is_read_only: true
  marveen_is_sole_orchestrator: true
  marveen_is_sole_owner_facing: true
  no_canonical_state_writes: true
  no_owner_contact: true
}

export interface ReviewRequest {
  schema_version: 1
  job_id: string
  work_item_id: string
  program_workstream: ProgramWorkstream
  review_kind: ReviewKind
  base_sha: string
  candidate_sha: string
  acceptance_criteria: string[]
  relevant_files: string[]
  relevant_diff_refs: string[]
  evidence_refs: string[]
  test_results: string[]
  requested_checks: string[]
  authority_constraints: AuthorityConstraints
}

export interface ReviewResult {
  schema_version: 1
  job_id: string
  work_item_id: string
  candidate_sha: string
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  evidence_refs: string[]
  requested_authority: AuthorityCategory | null
  summary: string
}

export interface ReviewLease {
  schema_version: 1
  job_id: string
  work_item_id: string
  candidate_sha: string
  holder_id: string
  acquired_at: string
  expires_at: string
  attempt: number
}

export interface ReviewAttemptMetadata {
  schema_version: 1
  job_id: string
  work_item_id: string
  candidate_sha: string
  attempt: number
  started_at: string
  finished_at?: string
  process_exit_code?: number | null
  timed_out: boolean
  result_validation: 'PENDING' | 'VALID' | 'INVALID'
  failure?: string
}

export interface ObservationRequirement {
  type: string
  reason: string
  candidate_sha: string
  minimum_population?: number
  current_population?: number
  start_condition: string
  success_condition: string
  failure_condition: string
  wake_trigger: string
  deadline_or_review_date?: string
  evidence_refs: string[]
}

export interface ObservationEvaluation {
  status: ObservationStatus
  wake_for_live_validation: boolean
  reason: string
}
