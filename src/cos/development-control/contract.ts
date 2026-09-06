import { AUTHORITY_CATEGORIES, OBSERVATION_STATUSES, PROGRAM_WORKSTREAMS, REVIEW_KINDS, REVIEW_VERDICTS } from './types.js'
import type { ObservationEvaluation, ObservationRequirement, ProgramWorkstream, ReviewRequest, ReviewResult } from './types.js'

const SHA = /^[0-9a-f]{40}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const enumValue = <T extends readonly string[]>(v: unknown, values: T): v is T[number] => typeof v === 'string' && values.includes(v)

export class ContractError extends Error {}

export function parseProgramWorkstream(value: unknown): ProgramWorkstream {
  if (!enumValue(value, PROGRAM_WORKSTREAMS)) throw new ContractError(`program workstream is outside the CoS program: ${String(value)}`)
  return value
}

const requiredAuthority = {
  codex_is_read_only: true,
  marveen_is_sole_orchestrator: true,
  marveen_is_sole_owner_facing: true,
  no_canonical_state_writes: true,
  no_owner_contact: true,
} as const

export function validateReviewRequest(value: unknown): ReviewRequest {
  if (!object(value)) throw new ContractError('review request must be an object')
  const requestKeys = new Set(['schema_version', 'job_id', 'work_item_id', 'program_workstream', 'review_kind', 'base_sha', 'candidate_sha', 'acceptance_criteria', 'relevant_files', 'relevant_diff_refs', 'evidence_refs', 'test_results', 'requested_checks', 'authority_constraints'])
  for (const key of Object.keys(value)) if (!requestKeys.has(key)) throw new ContractError(`unknown request field: ${key}`)
  if (value.schema_version !== 1) throw new ContractError('unsupported request schema')
  if (typeof value.job_id !== 'string' || !ID.test(value.job_id)) throw new ContractError('invalid job_id')
  if (typeof value.work_item_id !== 'string' || !ID.test(value.work_item_id)) throw new ContractError('invalid work_item_id')
  parseProgramWorkstream(value.program_workstream)
  if (!enumValue(value.review_kind, REVIEW_KINDS)) throw new ContractError('invalid review_kind')
  if (typeof value.base_sha !== 'string' || !SHA.test(value.base_sha)) throw new ContractError('invalid base_sha')
  if (typeof value.candidate_sha !== 'string' || !SHA.test(value.candidate_sha)) throw new ContractError('invalid candidate_sha')
  for (const key of ['acceptance_criteria', 'relevant_files', 'relevant_diff_refs', 'evidence_refs', 'test_results', 'requested_checks']) {
    if (!strings(value[key])) throw new ContractError(`${key} must be a string array`)
  }
  if ((value.acceptance_criteria as string[]).length === 0 || (value.requested_checks as string[]).length === 0) {
    throw new ContractError('review packet requires acceptance criteria and requested checks')
  }
  if (!object(value.authority_constraints)) throw new ContractError('authority_constraints missing')
  if (Object.keys(value.authority_constraints).length !== Object.keys(requiredAuthority).length) throw new ContractError('unknown authority constraint')
  for (const [key, expected] of Object.entries(requiredAuthority)) {
    if (value.authority_constraints[key] !== expected) throw new ContractError(`authority constraint ${key} must remain true`)
  }
  return value as unknown as ReviewRequest
}

const prohibitedResultKeys = new Set([
  'owner_approved', 'release_approved', 'go_live_approved', 'business_truth', 'canonical_state_changed',
])

export function validateReviewResult(value: unknown, request: ReviewRequest): ReviewResult {
  if (!object(value)) throw new ContractError('review result must be an object')
  const resultKeys = new Set(['schema_version', 'job_id', 'work_item_id', 'candidate_sha', 'verdict', 'findings', 'evidence_refs', 'requested_authority', 'summary'])
  for (const key of Object.keys(value)) if (prohibitedResultKeys.has(key)) throw new ContractError(`prohibited authority field: ${key}`)
  for (const key of Object.keys(value)) if (!resultKeys.has(key)) throw new ContractError(`unknown result field: ${key}`)
  if (value.schema_version !== 1) throw new ContractError('unsupported result schema')
  if (value.job_id !== request.job_id) throw new ContractError('job_id mismatch')
  if (value.work_item_id !== request.work_item_id) throw new ContractError('work_item_id mismatch')
  if (value.candidate_sha !== request.candidate_sha) throw new ContractError('candidate_sha mismatch; prior reviews never carry forward')
  if (!enumValue(value.verdict, REVIEW_VERDICTS)) throw new ContractError('invalid verdict')
  if (!Array.isArray(value.findings) || !value.findings.every(f => object(f) && Object.keys(f).every(k => ['id', 'severity', 'summary', 'evidence_refs', 'proposed_fix'].includes(k)) && typeof f.id === 'string' && enumValue(f.severity, ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] as const) && typeof f.summary === 'string' && strings(f.evidence_refs) && (f.proposed_fix === null || typeof f.proposed_fix === 'string'))) throw new ContractError('invalid findings')
  if (!strings(value.evidence_refs)) throw new ContractError('invalid evidence_refs')
  if (value.requested_authority !== null && !enumValue(value.requested_authority, AUTHORITY_CATEGORIES)) throw new ContractError('invalid requested authority')
  if (value.verdict === 'NEEDS_DECISION' && value.requested_authority === null) throw new ContractError('NEEDS_DECISION requires exactly one authority category')
  if (value.verdict !== 'NEEDS_DECISION' && value.requested_authority !== null) throw new ContractError('authority may only be requested with NEEDS_DECISION')
  if (value.verdict === 'PASS' && (value.findings as unknown[]).length !== 0) throw new ContractError('PASS cannot contain findings')
  if (value.verdict === 'FINDINGS' && (value.findings as unknown[]).length === 0) throw new ContractError('FINDINGS requires findings')
  if (typeof value.summary !== 'string' || value.summary.trim() === '') throw new ContractError('summary is required')
  return value as unknown as ReviewResult
}

export function parseResultText(text: string, request: ReviewRequest): ReviewResult {
  if (text.trim() === '') throw new ContractError('empty result')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ContractError('malformed result JSON') }
  return validateReviewResult(parsed, request)
}

export function validateObservationRequirement(value: ObservationRequirement): ObservationRequirement {
  if (!value.type.trim() || !value.reason.trim() || !SHA.test(value.candidate_sha)) throw new ContractError('invalid observation identity')
  if (!value.start_condition.trim() || !value.success_condition.trim() || !value.failure_condition.trim() || !value.wake_trigger.trim()) {
    throw new ContractError('observation requires measurable start, success, failure, and wake semantics')
  }
  if (value.minimum_population !== undefined && (!Number.isInteger(value.minimum_population) || value.minimum_population < 1)) throw new ContractError('minimum_population must be positive')
  if (value.current_population !== undefined && (!Number.isInteger(value.current_population) || value.current_population < 0)) throw new ContractError('current_population must be non-negative')
  if (!strings(value.evidence_refs)) throw new ContractError('observation evidence_refs invalid')
  return value
}

export function evaluateObservation(input: {
  requirement: ObservationRequirement
  implementationPass: boolean
  materialFailure: boolean
  successEvidencePresent: boolean
}): ObservationEvaluation {
  const r = validateObservationRequirement(input.requirement)
  if (!input.implementationPass) return { status: 'NOT_EVALUATED', wake_for_live_validation: false, reason: 'implementation is not verified' }
  if (input.materialFailure) return { status: 'OBSERVATION_FAILED', wake_for_live_validation: true, reason: 'material negative evidence wakes immediately' }
  if (r.minimum_population !== undefined && (r.current_population ?? 0) === 0) return { status: 'LIVE_POPULATION_NOT_PRESENT', wake_for_live_validation: false, reason: 'zero live population is not evidence' }
  if (r.minimum_population !== undefined && (r.current_population ?? 0) < r.minimum_population) return { status: 'WAITING_FOR_POPULATION', wake_for_live_validation: false, reason: 'minimum population not reached' }
  if (input.successEvidencePresent) return { status: 'LIVE_VALIDATION_REQUIRED', wake_for_live_validation: true, reason: 'measured conditions are ready for a new exact-SHA review' }
  return { status: 'WAITING_FOR_LIVE_EVIDENCE', wake_for_live_validation: false, reason: 'elapsed time or silence cannot complete observation' }
}

export const REVIEW_RESULT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'job_id', 'work_item_id', 'candidate_sha', 'verdict', 'findings', 'evidence_refs', 'requested_authority', 'summary'],
  properties: {
    schema_version: { const: 1 }, job_id: { type: 'string' }, work_item_id: { type: 'string' },
    candidate_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' }, verdict: { enum: [...REVIEW_VERDICTS] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'severity', 'summary', 'evidence_refs', 'proposed_fix'], properties: { id: { type: 'string' }, severity: { enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] }, summary: { type: 'string' }, evidence_refs: { type: 'array', items: { type: 'string' } }, proposed_fix: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } },
    evidence_refs: { type: 'array', items: { type: 'string' } }, requested_authority: { anyOf: [{ enum: [...AUTHORITY_CATEGORIES] }, { type: 'null' }] }, summary: { type: 'string', minLength: 1 },
  },
} as const

export function isObservationStatus(value: unknown): boolean { return enumValue(value, OBSERVATION_STATUSES) }
