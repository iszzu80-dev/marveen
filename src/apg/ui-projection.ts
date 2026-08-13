// APG sidecar is the authority (owner spec section 1.4/16). This module is READ-ONLY: it must never INSERT/UPDATE/DELETE against the sidecar DB. If a required table is missing, degrade that computation, never throw past this module's public functions.

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ApgAcceptanceStatus,
  ApgAttentionItem,
  ApgClaim,
  ApgClaimStatus,
  ApgDisplayState,
  ApgEvent,
  ApgMode,
  ApgModeSource,
  ApgUiSummary,
  ApgUiWorkItemSummary,
  ApgWorkItemDetail,
} from './ui-types.js'

const DISPLAY_STATES: ReadonlySet<string> = new Set<ApgDisplayState>([
  'clarification',
  'evidence_needed',
  'executing',
  'verifying',
  'decision_needed',
  'blocked',
  'accepted',
  'off',
])

const EMPTY_COUNTS: ApgUiSummary['counts'] = {
  active: 0,
  evidence_needed: 0,
  verifying: 0,
  decision_needed: 0,
  blocked: 0,
  accepted_today: 0,
  done_not_accepted: 0,
}

interface CanonicalRow {
  id: string
  kind: string
  logical_id: string
  version: number
  content_digest: string
  source_ref: string | null
  created_at: number
}

interface RecommendationRow {
  id: string
  candidate_id: string
  replay_run_id: string | null
  evidence_completeness: string
  missing_evidence_json: string
  proposed_status_text: string
  basis_json: string
  draft_marker: string
  created_at: number
}

interface TransitionRow {
  id: string
  change_logical_id: string
  from_state: string
  to_state: string
  checkpoint: string | null
  checkpoint_result: string | null
  replay_run_id: string | null
  created_at: number
}

interface CheckpointRow {
  id: string
  replay_run_id: string
  checkpoint: string
  result: string
  failed_checks: string
  profile_overlay: string
  created_at: number
}

interface ReceiptRow {
  id: string
  replay_run_id: string
  change_logical_id: string
  tested_commit: string | null
  built_commit: string | null
  deployed_artifact: string | null
  commit_chain_status: string
  runtime_status: string
  created_at: number
}

interface EvidenceRow {
  id: string
  receipt_id: string
  link: string
  ref_kind: string
  ref_locator: string
  ref_digest: string
  status: string
  created_at: number
}

interface ProjectionData {
  canonical: CanonicalRow[]
  recommendations: RecommendationRow[]
  transitions: TransitionRow[]
  checkpoints: CheckpointRow[]
  receipts: ReceiptRow[]
  evidence: EvidenceRow[]
}

interface CandidateProjection {
  id: string
  canonical: CanonicalRow | null
  recommendation: RecommendationRow | null
  transition: TransitionRow | null
  checkpoints: CheckpointRow[]
  latestCheckpoint: CheckpointRow | null
  receipts: ReceiptRow[]
  evidence: EvidenceRow[]
  displayState: ApgDisplayState
  updatedAt: number
  earliestActivityAt: number
  hasConflictingEvidence: boolean
}

export interface DeriveDisplayStateInput {
  latestTransitionState: string | null
  latestCheckpointResult: string | null
  latestCheckpoint: string | null
  hasAssistedRecommendation: boolean
  recommendationEvidenceCompleteness: string | null
}

export function deriveDisplayState(input: DeriveDisplayStateInput): ApgDisplayState {
  if (
    input.latestTransitionState !== null
    && DISPLAY_STATES.has(input.latestTransitionState)
  ) {
    return input.latestTransitionState as ApgDisplayState
  }
  if (input.latestCheckpointResult === 'FAIL') return 'blocked'
  // Owner decision 2026-08-09 (Istvan, "legyen B"): only a candidate with NO
  // evidence at all is an attention item. Previously ANY non-COMPLETE value --
  // including PARTIAL -- landed here, so work that was fully gated but
  // deliberately not deployed (e.g. the shadow-mode CoS slices) sat on the
  // "evidence needed" list forever. A list whose entries are mostly non-actionable
  // trains the reader to ignore it, which is worse than a shorter list.
  // PARTIAL (evidence exists but the chain is incomplete) is reported as
  // 'verifying': visible in the counts, but not competing for attention.
  if (input.hasAssistedRecommendation) {
    if (input.recommendationEvidenceCompleteness === 'MISSING') {
      return 'evidence_needed'
    }
    if (input.recommendationEvidenceCompleteness !== 'COMPLETE') {
      return 'verifying'
    }
  }
  if (
    input.latestCheckpointResult === 'PASS'
    && (
      input.latestCheckpoint === 'release_ready'
      || input.latestCheckpoint === 'runtime_acceptance'
    )
  ) {
    return 'accepted'
  }
  // F-8 (APG 0.4 review): the kernel renamed NOT_APPLICABLE to EXCLUDED and
  // added ERROR (kernel b2dafc5, src/checkpoints.py RESULT_VALUES), and this
  // projection still matched the old name. An EXCLUDED gate (not applicable to
  // this profile) and an ERROR gate (the executor returned nothing valid) both
  // fell through to `executing` — so on screen, a gate that never ran and a
  // gate that crashed looked like work in progress.
  //
  // NOT_APPLICABLE stays in the list because old rows carry it: the kernel's
  // migration puts no CHECK on `result`, so history is not rewritten by a
  // rename.
  if (
    input.latestCheckpointResult === 'UNKNOWN'
    || input.latestCheckpointResult === 'NOT_APPLICABLE'
    || input.latestCheckpointResult === 'EXCLUDED'
  ) {
    return 'clarification'
  }
  // An executor that failed is not a process that is running. Surfacing it as
  // blocked is what gets it looked at.
  if (input.latestCheckpointResult === 'ERROR') return 'blocked'
  return 'executing'
}

/**
 * The kernel's checkpoint result vocabulary, mirrored here (F-8).
 *
 * Two repos, one contract. This list is the UI half; the contract test asserts
 * it against the kernel's own RESULT_VALUES so a future rename fails a test
 * instead of silently turning one state into another on screen.
 */
export const APG_CHECKPOINT_RESULTS = [
  'PASS', 'FAIL', 'UNKNOWN', 'ERROR', 'EXCLUDED',
] as const

export function resolveApgKernelDbPath(): string {
  const configured = process.env.APG_KERNEL_DB_PATH
  if (configured) return configured
  return join(homedir(), 'marveen-local', 'apg-kernel', 'store', 'apg-kernel.db')
}

export function openApgKernelReadonly(): import('better-sqlite3').Database | null {
  const dbPath = resolveApgKernelDbPath()
  if (!existsSync(dbPath)) return null
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

// mode is preserved verbatim on both error paths -- an unavailable/broken
// store must never be reported as APG_MODE=off. The caller (API layer, then
// the UI) needs the REAL configured mode to apply the correct degraded
// behaviour per spec section 3's fail-open/fail-closed table: off/observe
// fail-open, assisted must not show a false green, enforced fails closed.
// Collapsing mode to 'off' here would silently defeat enforced's fail-closed
// requirement downstream.
function unavailableSummary(nowIso: string, mode: ApgMode): ApgUiSummary {
  return {
    mode,
    enabled: false,
    as_of: nowIso,
    projection_version: 1,
    counts: { ...EMPTY_COUNTS },
    attention_items: [],
    projection_error: 'sidecar_unavailable',
  }
}

function errorSummary(nowIso: string, mode: ApgMode, error: unknown): ApgUiSummary {
  return {
    mode,
    enabled: false,
    as_of: nowIso,
    projection_version: 1,
    counts: { ...EMPTY_COUNTS },
    attention_items: [],
    projection_error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Read errors that were swallowed, most recent first (F-9, APG 0.4 review).
 *
 * Module-scoped and cleared at the start of each projection build. A projection
 * is built inside one synchronous call, so there is no interleaving to confuse
 * this — but a caller that forgets to clear would only ever see MORE errors,
 * never fewer, which is the safe direction for a defect channel.
 */
let projectionReadErrors: string[] = []

export function beginProjectionErrorCapture(): void { projectionReadErrors = [] }
export function capturedProjectionErrors(): string[] { return [...projectionReadErrors] }

/**
 * A table read that survives a missing/corrupt table — and SAYS SO.
 *
 * F-9: this used to swallow every read error into an empty array. If
 * `assisted_recommendations` became unreadable, every work item silently lost
 * its recommendation, the display state flipped, and the response still came
 * back `enabled: true` with no `projection_error` — the exact shape §6.4 and
 * §8.3 forbid. An empty table and an unreadable table are different facts and
 * must not produce the same answer.
 */
function rowsOrEmpty<T>(db: Database.Database, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[]
  } catch (err) {
    // The first line of the statement is enough to name the table without
    // dumping a whole query into an API response.
    const what = sql.trim().split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').slice(0, 120)
    projectionReadErrors.push(`${(err as Error)?.message ?? String(err)} [${what}]`)
    return []
  }
}

function loadCanonicalRows(db: Database.Database): CanonicalRow[] {
  const withHeads = rowsOrEmpty<CanonicalRow>(db, `
    SELECT
      artifact.id,
      artifact.kind,
      artifact.logical_id,
      artifact.version,
      artifact.content_digest,
      artifact.source_ref,
      artifact.created_at
    FROM canonical_artifact_versions AS artifact
    LEFT JOIN lineage_heads AS head
      ON head.logical_id = artifact.logical_id
    WHERE artifact.kind IN ('work_item', 'change')
      AND (
        head.head_id = artifact.id
        OR (
          head.logical_id IS NULL
          AND artifact.version = (
            SELECT MAX(candidate.version)
            FROM canonical_artifact_versions AS candidate
            WHERE candidate.logical_id = artifact.logical_id
          )
        )
      )
    ORDER BY artifact.logical_id ASC
  `)
  if (withHeads.length > 0) return withHeads

  // A pre-lineage migration copy can still expose its latest canonical rows.
  return rowsOrEmpty<CanonicalRow>(db, `
    SELECT
      artifact.id,
      artifact.kind,
      artifact.logical_id,
      artifact.version,
      artifact.content_digest,
      artifact.source_ref,
      artifact.created_at
    FROM canonical_artifact_versions AS artifact
    WHERE artifact.kind IN ('work_item', 'change')
      AND artifact.version = (
        SELECT MAX(candidate.version)
        FROM canonical_artifact_versions AS candidate
        WHERE candidate.logical_id = artifact.logical_id
      )
    ORDER BY artifact.logical_id ASC
  `)
}

function loadProjectionData(db: Database.Database, includeEvidence: boolean): ProjectionData {
  // Fresh slate per build, so `capturedProjectionErrors()` describes THIS
  // projection and not a previous request's.
  beginProjectionErrorCapture()
  return {
    canonical: loadCanonicalRows(db),
    recommendations: rowsOrEmpty<RecommendationRow>(db, `
      SELECT
        id,
        candidate_id,
        replay_run_id,
        evidence_completeness,
        missing_evidence_json,
        proposed_status_text,
        basis_json,
        draft_marker,
        created_at
      FROM assisted_recommendations
      ORDER BY created_at DESC, id DESC
    `),
    transitions: rowsOrEmpty<TransitionRow>(db, `
      SELECT
        id,
        change_logical_id,
        from_state,
        to_state,
        checkpoint,
        checkpoint_result,
        replay_run_id,
        created_at
      FROM change_delivery_transitions
      ORDER BY created_at ASC, id ASC
    `),
    checkpoints: rowsOrEmpty<CheckpointRow>(db, `
      SELECT
        id,
        replay_run_id,
        checkpoint,
        result,
        failed_checks,
        profile_overlay,
        created_at
      FROM checkpoint_results
      ORDER BY created_at ASC, id ASC
    `),
    receipts: rowsOrEmpty<ReceiptRow>(db, `
      SELECT
        id,
        replay_run_id,
        change_logical_id,
        tested_commit,
        built_commit,
        deployed_artifact,
        commit_chain_status,
        runtime_status,
        created_at
      FROM execution_receipts
      ORDER BY created_at ASC, id ASC
    `),
    evidence: includeEvidence
      ? rowsOrEmpty<EvidenceRow>(db, `
          SELECT
            id,
            receipt_id,
            link,
            ref_kind,
            ref_locator,
            ref_digest,
            status,
            created_at
          FROM evidence_references
          ORDER BY created_at ASC, id ASC
        `)
      : [],
  }
}

function newest<T extends { created_at: number }>(rows: T[]): T | null {
  let result: T | null = null
  for (const row of rows) {
    if (result === null || row.created_at >= result.created_at) result = row
  }
  return result
}

function epochToMilliseconds(value: number): number {
  return Math.abs(value) >= 1_000_000_000_000 ? value : value * 1000
}

// Card 1732a148: a unix-seconds `created_at` this small (2001-09-09 and
// earlier) cannot be a real APG kernel activity timestamp -- this store
// (and the whole APG pilot) did not exist before 2026. A handful of real
// sidecar rows carry a literal `created_at=1` (an early-pilot placeholder/
// sentinel, not a crafted value) instead of a real timestamp; treating "1"
// as a genuine 1970-01-01T00:00:01Z epoch turned an age computation into an
// absolute-epoch-sized number. 1_000_000_000 is a generic, well-known
// unix-seconds sanity floor (not project-specific), matching the existing
// `<= 0` guard's spirit rather than hardcoding this pilot's actual start date.
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000

function isPlausibleEpochSeconds(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_PLAUSIBLE_EPOCH_SECONDS
}

function toIso(value: number): string {
  if (!Number.isFinite(value)) return new Date(0).toISOString()
  return new Date(epochToMilliseconds(value)).toISOString()
}

function extractKanbanCardId(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) continue
    const match = value.match(/(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/)
    if (match?.[1]) return match[1]
  }
  return null
}

function candidateIds(data: ProjectionData, includeWorkItems: boolean): string[] {
  const ids = new Set<string>()
  for (const row of data.canonical) {
    if (row.kind === 'change' || (includeWorkItems && row.kind === 'work_item')) {
      ids.add(row.logical_id)
    }
  }
  for (const row of data.recommendations) ids.add(row.candidate_id)
  return [...ids].sort()
}

function buildCandidateProjection(
  data: ProjectionData,
  candidateId: string,
): CandidateProjection {
  const canonical = newest(data.canonical.filter((row) => row.logical_id === candidateId))
  const candidateRecommendations = data.recommendations.filter(
    (row) => row.candidate_id === candidateId,
  )
  const recommendation = newest(candidateRecommendations)
  const transitions = data.transitions.filter(
    (row) => row.change_logical_id === candidateId,
  )
  const transition = newest(transitions)
  const receipts = data.receipts.filter(
    (row) => row.change_logical_id === candidateId,
  )

  const replayRunIds = new Set<string>()
  for (const receipt of receipts) replayRunIds.add(receipt.replay_run_id)
  for (const row of candidateRecommendations) {
    if (row.replay_run_id) replayRunIds.add(row.replay_run_id)
  }
  for (const row of transitions) {
    if (row.replay_run_id) replayRunIds.add(row.replay_run_id)
  }
  const checkpoints = data.checkpoints.filter(
    (row) => replayRunIds.has(row.replay_run_id),
  )
  const latestCheckpoint = newest(checkpoints)
  const receiptIds = new Set(receipts.map((row) => row.id))
  const evidence = data.evidence.filter((row) => receiptIds.has(row.receipt_id))
  // Card 1732a148: filter out implausible `created_at` values (e.g. the
  // real sidecar's `created_at=1` sentinel rows) BEFORE they can ever reach
  // Math.min/Math.max below -- one poisoned row must not corrupt
  // updatedAt/earliestActivityAt for an otherwise-healthy candidate. This is
  // the data-layer half of the fix; ageSeconds() below carries a matching
  // defensive floor so a value from any future/other call site still can't
  // render as an absolute epoch.
  const activityTimes = [
    canonical?.created_at,
    ...candidateRecommendations.map((row) => row.created_at),
    ...transitions.map((row) => row.created_at),
    ...checkpoints.map((row) => row.created_at),
    ...receipts.map((row) => row.created_at),
  ].filter((value): value is number => value !== undefined && isPlausibleEpochSeconds(value))
  const stateActivityTimes = [
    ...transitions.map((row) => row.created_at),
    ...checkpoints.map((row) => row.created_at),
  ].filter(isPlausibleEpochSeconds)
  const displayState = deriveDisplayState({
    latestTransitionState: transition?.to_state ?? null,
    latestCheckpointResult: latestCheckpoint?.result ?? null,
    latestCheckpoint: latestCheckpoint?.checkpoint ?? null,
    hasAssistedRecommendation: recommendation !== null,
    // Worst-wins across the candidate's recommendations, but preserve WHICH
    // kind of incompleteness it is. The old code collapsed everything to a
    // single 'INCOMPLETE' token, which made MISSING (no evidence at all) and
    // PARTIAL (evidence exists, chain not finished) indistinguishable downstream
    // -- the root cause of the noisy attention list.
    recommendationEvidenceCompleteness: candidateRecommendations.some(
      (row) => row.evidence_completeness === 'MISSING',
    )
      ? 'MISSING'
      : candidateRecommendations.some((row) => row.evidence_completeness !== 'COMPLETE')
        ? 'PARTIAL'
        : recommendation?.evidence_completeness ?? null,
  })

  return {
    id: candidateId,
    canonical,
    recommendation,
    transition,
    checkpoints,
    latestCheckpoint,
    receipts,
    evidence,
    displayState,
    updatedAt: activityTimes.length > 0 ? Math.max(...activityTimes) : 0,
    earliestActivityAt: stateActivityTimes.length > 0
      ? Math.min(...stateActivityTimes)
      : activityTimes.length > 0
        ? Math.min(...activityTimes)
        : 0,
    hasConflictingEvidence: receipts.some(
      (row) => row.commit_chain_status === 'MISMATCH',
    ),
  }
}

function attentionReason(candidate: CandidateProjection): string | null {
  switch (candidate.displayState) {
    case 'blocked':
      return candidate.latestCheckpoint?.checkpoint
        ? `Sikertelen APG kapu: ${candidate.latestCheckpoint.checkpoint}.`
        : 'Az APG folyamat blokkolt.'
    case 'decision_needed':
      return 'A továbblépés tulajdonosi döntésre vár.'
    case 'evidence_needed':
      return 'A javaslathoz szükséges bizonyíték nem teljes.'
    case 'clarification':
      return 'A következő lépéshez tisztázás szükséges.'
    case 'verifying':
      return 'Az eredmény ellenőrzése még folyamatban van.'
    default:
      return null
  }
}

function nextActionFor(state: ApgDisplayState): string {
  switch (state) {
    case 'blocked':
      return 'Oldd fel a sikertelen kaput, majd futtasd újra az ellenőrzést.'
    case 'decision_needed':
      return 'Rögzítsd a szükséges tulajdonosi döntést.'
    case 'evidence_needed':
      return 'Pótold a hiányzó bizonyítékokat.'
    case 'clarification':
      return 'Pontosítsd a célt vagy a szükséges bizonyítékot.'
    case 'verifying':
      return 'Fejezd be az ellenőrzést.'
    case 'accepted':
      return 'Nincs további APG teendő.'
    case 'off':
      return 'Kapcsold be az APG-t, ha kontrollált végrehajtás szükséges.'
    case 'executing':
      return 'Folytasd a végrehajtást és rögzítsd a bizonyítékokat.'
  }
}

/**
 * Acceptance status (F-2, review 2026-08-10, fixed 2026-08-12).
 *
 * TWO CLAIMS USED TO BE MADE HERE THAT NOTHING SUPPORTED.
 *
 * 1. `accepted` came from a PASSING GATE. A green `release_ready` means the
 *    checks ran and agreed; it does not mean a person or an agent accepted the
 *    work. `accepter_agent` was structurally null, so the Kanban wrote
 *    "Independently accepted" over an item nobody had accepted. Spec §9.2:
 *    "NEVER show acceptance from the done status alone."
 * 2. `returned` came from WAITING. An item needing evidence or clarification had
 *    not been returned to anyone — nobody sent it back, there is no return
 *    event, and the word describes an action that did not occur.
 *
 * So acceptance now requires an accepter, and waiting is called waiting. The
 * `accepter` argument is what the sidecar recorded; while the kernel records no
 * accepter identity (WP3 of the 1.8 gap map), it is null and this correctly
 * never returns `accepted` — the state is `gates_passed`, which is true and is
 * also the honest input to the decision about building the missing half.
 */
function acceptanceStatusFor(
  state: ApgDisplayState, accepter: string | null,
): ApgAcceptanceStatus {
  switch (state) {
    case 'accepted':
      // The gate passed. Whether that is ACCEPTANCE depends on there being
      // somebody who accepted, and only the sidecar can answer that.
      return accepter ? 'accepted' : 'gates_passed'
    case 'blocked':
      return 'blocked'
    case 'verifying':
      return 'verifying'
    case 'evidence_needed':
    case 'decision_needed':
    case 'clarification':
      return 'needs_input'
    case 'executing':
      return 'produced'
    case 'off':
      return 'not_started'
  }
}

/** The gates that say something about RUNTIME. A PASS on anything else says the
 *  documents were in order, which is a different claim. */
const RUNTIME_GATES: ReadonlySet<string> = new Set(['runtime_acceptance', 'release_ready'])

/**
 * Claim status (F-1, review 2026-08-10, fixed 2026-08-12).
 *
 * WHAT WAS WRONG. `VERIFIED_CURRENT` renders as "citable as a current, verified
 * fact" — the strongest thing this screen says. It was granted when the evidence
 * row was PRESENT and ANY checkpoint in the same replay run had passed. A PASS
 * on `spec_ready` means the specification was ready; it says nothing about
 * whether the thing runs. §11.1 lists six ways to produce a false green, and two
 * of them — "no runtime verification" and "the file merely exists" — came out of
 * this branch directly.
 *
 * WHAT IT TAKES NOW: a runtime gate that passed IN THE SAME RUN, and a receipt
 * whose own `runtime_status` is OBSERVED. Both, because they answer different
 * halves — the gate says the check ran and agreed, the receipt says the thing
 * was actually seen running. Everything else that has real evidence behind it
 * keeps the honest label that already existed for exactly this case:
 * SUPPORTED_BUT_NOT_RUNTIME_VERIFIED.
 */
function claimStatus(row: EvidenceRow, candidate: CandidateProjection): ApgClaimStatus {
  if (row.status === 'MISSING') return 'BLOCKED_FROM_USE'
  if (row.status !== 'PRESENT') return 'UNKNOWN'
  const receipt = candidate.receipts.find((candidateReceipt) =>
    candidateReceipt.id === row.receipt_id)
  if (!receipt) return 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED'
  const runtimeGatePassed = candidate.checkpoints.some((checkpoint) =>
    checkpoint.replay_run_id === receipt.replay_run_id
    && checkpoint.result === 'PASS'
    && RUNTIME_GATES.has(checkpoint.checkpoint))
  // 'OBSERVED' is the kernel's word for "seen running" (migration 0001:
  // OBSERVED | UNKNOWN | MISSING). Anything else is not a runtime observation.
  if (runtimeGatePassed && receipt.runtime_status === 'OBSERVED') return 'VERIFIED_CURRENT'
  return 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED'
}

function allowedWordingFor(status: ApgClaimStatus): string {
  switch (status) {
    case 'VERIFIED_CURRENT':
      return 'Aktuális, igazolt tényként idézhető.'
    case 'VERIFIED_HISTORICAL':
      return 'Csak történeti tényként idézhető.'
    case 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED':
      return 'Bizonyítékkal támogatott, de futásidőben nem igazolt.'
    case 'CONFLICTING_EVIDENCE':
      return 'Ellentmondásos tényként, fenntartással idézhető.'
    case 'STALE_OR_SUPERSEDED':
      return 'Elavult vagy felülírt tényként jelölendő.'
    case 'UNKNOWN':
      return 'Csak ismeretlen állapotú állításként közölhető.'
    case 'BLOCKED_FROM_USE':
      return 'Nem idézhető tényként.'
  }
}

function claimsFor(candidate: CandidateProjection): ApgClaim[] {
  return candidate.evidence.map((row) => {
    const status = claimStatus(row, candidate)
    return {
      id: row.id,
      text: row.ref_locator
        ? `${row.ref_kind}: ${row.ref_locator}`
        : row.ref_kind,
      status,
      allowed_wording: allowedWordingFor(status),
      source: row.ref_locator || null,
      observed_at: toIso(row.created_at),
      verified_at: status === 'VERIFIED_CURRENT' ? toIso(row.created_at) : null,
      verifier: null,
      receipt_id: row.receipt_id || null,
      superseded_by: null,
    }
  })
}

function summaryFor(
  candidate: CandidateProjection,
  mode: ApgMode,
  claims: ApgClaim[] = claimsFor(candidate),
  // F-7 (review 2026-08-10, fixed 2026-08-12). This was the literal 'global' on
  // every work item ever projected. The resolver already returns which scope
  // decided the mode -- global, project or card -- and the caller already had
  // it; only this field was not told. So a card-level override was invisible on
  // the screen that exists to show whether the override took effect.
  modeSource: ApgModeSource = 'global',
): ApgUiWorkItemSummary {
  const displayState = mode === 'off' ? 'off' : candidate.displayState
  const checkpointByName = new Map<string, CheckpointRow>()
  for (const checkpoint of candidate.checkpoints) {
    const prior = checkpointByName.get(checkpoint.checkpoint)
    if (!prior || checkpoint.created_at >= prior.created_at) {
      checkpointByName.set(checkpoint.checkpoint, checkpoint)
    }
  }
  const latestGates = [...checkpointByName.values()]
  const blockingGate = latestGates
    .filter((checkpoint) => checkpoint.result === 'FAIL')
    .sort((a, b) => b.created_at - a.created_at)[0]?.checkpoint ?? null

  return {
    id: candidate.id,
    kanban_card_id: extractKanbanCardId(
      candidate.canonical?.source_ref,
      candidate.recommendation?.candidate_id,
    ),
    // The sidecar schema has no reliable project field in this stage.
    project: null,
    title: candidate.id,
    effective_mode: mode,
    mode_source: modeSource,
    display_state: displayState,
    internal_state: displayState,
    risk: 'unknown',
    attention_reason: attentionReason({ ...candidate, displayState }),
    next_action: nextActionFor(displayState),
    producer_agent: null,
    // NULL BECAUSE THE SIDECAR RECORDS NO ACCEPTER, and that is a fact worth
    // showing rather than papering over (F-2). The 1.8 gap map calls this WP3:
    // producer/verifier identity separation does not exist yet, so nothing can
    // truthfully be named here. `acceptanceStatusFor` reads this field, so an
    // item with no accepter can never display as accepted.
    accepter_agent: null,
    gate_progress: {
      passed: latestGates.filter((checkpoint) => checkpoint.result === 'PASS').length,
      // F-8: EXCLUDED gates are not applicable to this profile, so counting
      // them in the denominator makes progress read lower than it is —
      // "3 of 8" when three of those eight were never going to run.
      total: latestGates.filter((checkpoint) => checkpoint.result !== 'EXCLUDED').length,
      blocking_gate: blockingGate,
    },
    claim_counts: {
      total: claims.length,
      verified_current: claims.filter((claim) =>
        claim.status === 'VERIFIED_CURRENT').length,
      conflicting: claims.filter((claim) =>
        claim.status === 'CONFLICTING_EVIDENCE').length,
      unknown: claims.filter((claim) => claim.status === 'UNKNOWN').length,
      blocked: claims.filter((claim) => claim.status === 'BLOCKED_FROM_USE').length,
    },
    acceptance_status: acceptanceStatusFor(displayState, null),
    updated_at: toIso(candidate.updatedAt),
  }
}

function attentionPriority(candidate: CandidateProjection): number {
  if (candidate.displayState === 'blocked') return 5
  if (candidate.displayState === 'decision_needed') return 4
  if (candidate.displayState === 'evidence_needed' && candidate.hasConflictingEvidence) {
    return 3
  }
  if (candidate.displayState === 'evidence_needed') return 2
  return 1
}

// Card 1732a148: `createdAt <= 0` alone does not reject an implausibly
// small POSITIVE epoch (e.g. a sentinel `created_at=1`) -- treated as unix
// seconds, epochToMilliseconds(1) resolves to 1970-01-01T00:00:01Z, and the
// "age" then computed is essentially the current unix timestamp itself.
// This is defense-in-depth: buildCandidateProjection now filters implausible
// timestamps out before they can become earliestActivityAt in the first
// place (see isPlausibleEpochSeconds above), but ageSeconds keeps its own
// floor so a value from any other/future call site still can't render as an
// absolute epoch. Same "unknown timestamp" convention as the existing
// `createdAt <= 0` branch: returns 0, not a fabricated age.
export function ageSeconds(nowIso: string, createdAt: number): number {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now) || !isPlausibleEpochSeconds(createdAt)) return 0
  return Math.max(0, Math.floor((now - epochToMilliseconds(createdAt)) / 1000))
}

export function buildApgUiSummary(nowIso: string, mode: ApgMode): ApgUiSummary {
  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      as_of: nowIso,
      projection_version: 1,
      counts: { ...EMPTY_COUNTS },
      attention_items: [],
    }
  }

  const db = openApgKernelReadonly()
  if (!db) return unavailableSummary(nowIso, mode)
  try {
    const data = loadProjectionData(db, false)
    const candidates = candidateIds(data, true).map((id) =>
      buildCandidateProjection(data, id))
    const counts: ApgUiSummary['counts'] = {
      active: candidates.filter((candidate) =>
        candidate.displayState !== 'accepted' && candidate.displayState !== 'off').length,
      evidence_needed: candidates.filter((candidate) =>
        candidate.displayState === 'evidence_needed').length,
      verifying: candidates.filter((candidate) =>
        candidate.displayState === 'verifying').length,
      decision_needed: candidates.filter((candidate) =>
        candidate.displayState === 'decision_needed').length,
      blocked: candidates.filter((candidate) =>
        candidate.displayState === 'blocked').length,
      accepted_today: candidates.filter((candidate) =>
        candidate.displayState === 'accepted'
        && toIso(candidate.updatedAt).slice(0, 10) === nowIso.slice(0, 10)).length,
      done_not_accepted: candidates.filter((candidate) =>
        candidate.transition?.to_state === 'done'
        && candidate.displayState !== 'accepted').length,
    }
    const attentionItems: ApgAttentionItem[] = candidates
      .filter((candidate) =>
        candidate.displayState !== 'accepted' && candidate.displayState !== 'off')
      .sort((a, b) =>
        attentionPriority(b) - attentionPriority(a)
        || ageSeconds(nowIso, b.earliestActivityAt)
          - ageSeconds(nowIso, a.earliestActivityAt)
        || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((candidate) => ({
        work_item_id: candidate.id,
        kanban_card_id: extractKanbanCardId(
          candidate.canonical?.source_ref,
          candidate.recommendation?.candidate_id,
        ),
        // The sidecar schema has no reliable project field in this stage.
        project: null,
        title: candidate.id,
        display_state: candidate.displayState,
        reason: attentionReason(candidate) ?? 'Az APG munkaelem aktív.',
        next_action: nextActionFor(candidate.displayState),
        age_seconds: ageSeconds(nowIso, candidate.earliestActivityAt),
        deep_link: `/apg/work-items/${encodeURIComponent(candidate.id)}`,
      }))

    // F-9: a table that could not be read is reported, not smoothed over. The
    // summary still renders (partial data beats a blank page), but the caller
    // can tell "no rows" from "could not read the rows".
    const readErrors = capturedProjectionErrors()
    return {
      mode,
      enabled: true,
      as_of: nowIso,
      projection_version: 1,
      counts,
      attention_items: attentionItems,
      ...(readErrors.length > 0
        ? { projection_error: `partial projection: ${readErrors.length} table(s) unreadable — ${readErrors[0]}` }
        : {}),
    }
  } catch (error) {
    return errorSummary(nowIso, mode, error)
  } finally {
    try {
      db.close()
    } catch {
      // A failed/closed reader must not escape the read-model boundary.
    }
  }
}

export function buildApgWorkItemSummaries(
  mode: ApgMode,
  filters: {
    /** Which scope decided `mode` (F-7). Passed through to every row so a card
     *  or project override is visible on the screen that exists to show it. */
    modeSource?: ApgModeSource
    project?: string
    state?: string
    attention?: boolean
    kanbanCardId?: string
    limit: number
    offset: number
  },
): { items: ApgUiWorkItemSummary[]; total: number } | { error: string } {
  const db = openApgKernelReadonly()
  if (!db) return { error: 'sidecar_unavailable' }
  try {
    const data = loadProjectionData(db, true)
    // includeWorkItems:true here so this list stays consistent with
    // buildApgUiSummary's counts (which include kind='work_item' rows) and
    // with attention_items' deep_links -- excluding work_item candidates
    // here would let a summary attention item link to a detail id that this
    // list (and buildApgWorkItemDetail's lookup below) reports as not found.
    let items = candidateIds(data, true)
      .map((id) => buildCandidateProjection(data, id))
      .map((candidate) => summaryFor(candidate, mode, undefined, filters.modeSource ?? 'global'))

    // Project is deliberately always null until the sidecar owns a project field.
    if (filters.project !== undefined) items = []
    if (filters.state !== undefined) {
      items = items.filter((item) => item.display_state === filters.state)
    }
    if (filters.attention) {
      items = items.filter((item) => item.attention_reason !== null)
    }
    if (filters.kanbanCardId !== undefined) {
      items = items.filter((item) =>
        item.kanban_card_id === filters.kanbanCardId)
    }

    items.sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    const total = items.length
    const offset = Math.max(0, Math.trunc(filters.offset))
    const limit = Math.max(0, Math.trunc(filters.limit))
    return { items: items.slice(offset, offset + limit), total }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      db.close()
    } catch {
      // A failed/closed reader must not escape the read-model boundary.
    }
  }
}

export function buildApgWorkItemDetail(
  mode: ApgMode,
  workItemId: string,
  modeSource: ApgModeSource = 'global',
): ApgWorkItemDetail | { error: string; notFound?: boolean } {
  const db = openApgKernelReadonly()
  if (!db) return { error: 'sidecar_unavailable' }
  try {
    const data = loadProjectionData(db, true)
    if (!candidateIds(data, true).includes(workItemId)) {
      return { error: 'work_item_not_found', notFound: true }
    }

    const candidate = buildCandidateProjection(data, workItemId)
    const claims = claimsFor(candidate)
    const summary = summaryFor(candidate, mode, claims, modeSource)
    const transitions = data.transitions.filter(
      (row) => row.change_logical_id === workItemId,
    )
    const events: ApgEvent[] = transitions.map((row) => ({
      id: row.id,
      type: 'change_delivery_transition',
      at: toIso(row.created_at),
      agent: null,
      work_item_id: row.change_logical_id,
      receipt_id: null,
      summary: `${row.from_state} → ${row.to_state}`
        + (row.checkpoint ? ` (${row.checkpoint}: ${row.checkpoint_result ?? 'UNKNOWN'})` : ''),
      error: row.checkpoint_result === 'FAIL' || row.to_state === 'blocked',
    }))
    const sourceIds = new Set<string>()
    if (candidate.canonical) sourceIds.add(candidate.canonical.id)
    if (candidate.recommendation) sourceIds.add(candidate.recommendation.id)
    for (const row of candidate.receipts) sourceIds.add(row.id)
    for (const row of candidate.checkpoints) sourceIds.add(row.id)
    for (const row of candidate.evidence) sourceIds.add(row.id)
    for (const row of transitions) sourceIds.add(row.id)

    return {
      ...summary,
      goal: '',
      scope: '',
      claims,
      evidence_summary: {
        present: candidate.evidence.filter((row) => row.status === 'PRESENT').length,
        unknown: candidate.evidence.filter((row) => row.status === 'UNKNOWN').length,
        missing: candidate.evidence.filter((row) => row.status === 'MISSING').length,
      },
      receipts: candidate.evidence.map((row) => ({
        id: row.id,
        link: row.link,
        ref_kind: row.ref_kind,
        status: row.status,
        created_at: toIso(row.created_at),
      })),
      events,
      rollback_info: null,
      side_effect_status: newest(candidate.receipts)?.runtime_status ?? null,
      source_ids: [...sourceIds],
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      db.close()
    } catch {
      // A failed/closed reader must not escape the read-model boundary.
    }
  }
}

export interface ApgEventsResult {
  events: ApgEvent[]
  total: number
  limit: number
  offset: number
}

/**
 * Build a consolidated, paginated event feed across all APG work items.
 * Used by GET /api/apg/events for the Activity page event-log (item 5/5).
 */
export function buildApgEvents(
  limit: number,
  offset: number,
): ApgEventsResult | { error: string } {
  // F-3 (APG 0.4 review): this waited on a `globalThis.BetterSqlite3` that
  // NOTHING in the repo ever sets — not the app, not the tests. So §13's
  // Activity feed answered `{events: [], error: 'BetterSqlite3 binding not
  // available'}` on every production call, while the card-level event list
  // worked because it goes through buildApgWorkItemDetail. An empty feed with
  // an error string nobody surfaces reads as "no activity".
  //
  // The module already imports the driver and already has the read-only opener
  // the rest of the file uses; this now uses it.
  const db = openApgKernelReadonly()
  if (!db) return { error: 'APG sidecar not available' }

  try {
    const rows = rowsOrEmpty<TransitionRow>(db, `
      SELECT id, change_logical_id, from_state, to_state,
             checkpoint, checkpoint_result, replay_run_id, created_at
      FROM change_delivery_transitions
      ORDER BY created_at DESC
    `)
    const allEvents: ApgEvent[] = rows.map((row) => ({
      id: row.id,
      type: 'change_delivery_transition',
      at: toIso(row.created_at),
      agent: null,
      work_item_id: row.change_logical_id,
      receipt_id: null,
      summary: `${row.from_state} → ${row.to_state}`
        + (row.checkpoint ? ` (${row.checkpoint}: ${row.checkpoint_result ?? 'UNKNOWN'})` : ''),
      error: row.checkpoint_result === 'FAIL' || row.to_state === 'blocked',
    }))
    const total = allEvents.length
    const page = allEvents.slice(offset, offset + limit)
    return { events: page, total, limit, offset }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      db.close()
    } catch {
      // A failed/closed reader must not escape the read-model boundary.
    }
  }
}
