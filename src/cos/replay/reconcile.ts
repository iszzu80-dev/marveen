import { createHash } from 'node:crypto'
import type {
  CorrectionManifest, ExtractorParityReport, ParitySurfaceStatus, ProductionCaseSnapshot,
  ReconciliationAuthority, ReconciliationFinding, ReconciliationSeverity, ReplayCaseProjection,
  ReplayReadiness,
} from './types.js'

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Stage 2H field classification (Istvan, 2026-08-17), measured — not assumed.
 *
 *  NOT_REPLAYABLE: the triage judgement that produced these is persisted nowhere
 *  (CREATED payload NULL, both ledgers carry no verdict, content_hash unwritten)
 *  and there is no production text->type classifier to re-run. A replay that
 *  "agrees" here is agreeing with a value it copied, and one that "differs" is
 *  differing from a guess. Both are meaningless, so neither is counted.
 *
 *  CONDITIONAL: everything downstream of caseType. `projectZstOperationalIntake`
 *  takes caseType as an INPUT, so status/nextAction/owner/waitingOn and the
 *  deadline fields exist in a replay only because production lent us the type.
 *  Measurable, but never source-derived. */
const NOT_REPLAYABLE_FIELDS = new Set([
  'caseType', 'title', 'priority', 'workspace', 'declaredSensitivity', 'actionable',
])
const CONDITIONAL_FIELDS = new Set([
  'status', 'nextAction', 'nextActionOwner', 'waitingOn', 'dueAt', 'followUpAt', 'nextWakeAt',
])
/** Genuinely re-derivable from the corpus alone: connector identity, thread and
 *  message identity, provider time, direction, body and attachment digests. */
const SOURCE_DERIVED_FIELDS = new Set([
  'domain', 'threadId', 'messageId', 'occurredAt', 'direction', 'bodyHash', 'attachmentManifestHash',
])

export function classifyField(field: string, p: ProductionCaseSnapshot): ReconciliationAuthority {
  if (NOT_REPLAYABLE_FIELDS.has(field)) return 'NOT_REPLAYABLE'
  // A human decision or an external receipt outranks a replay projection, and
  // that precedence survives the Stage 2H split.
  if ((p.hasHumanAuthorityEvent || p.hasExternalReceipt) && (field === 'status' || field === 'closureReason')) {
    return 'PRODUCTION_AUTHORITATIVE'
  }
  if (CONDITIONAL_FIELDS.has(field)) return 'CONDITIONAL_ON_PRODUCTION_TYPE'
  if (SOURCE_DERIVED_FIELDS.has(field)) return 'SOURCE_DERIVED'
  return 'CONFLICT_REVIEW'
}

function severity(field: string, a: ReconciliationAuthority): ReconciliationSeverity {
  if (a === 'NOT_REPLAYABLE') return 'P3'
  if (a === 'PRODUCTION_AUTHORITATIVE') return 'P3'
  if (a === 'CONDITIONAL_ON_PRODUCTION_TYPE') return 'P2'
  if (['domain', 'threadId', 'messageId', 'occurredAt', 'direction'].includes(field)) return 'P1'
  return 'P2'
}

const REASONS: Record<ReconciliationAuthority, string> = {
  NOT_REPLAYABLE:
    'the triage judgement behind this field is not persisted and has no deterministic '
    + 'production classifier; it is reported as coverage, never as agreement or mismatch',
  CONDITIONAL_ON_PRODUCTION_TYPE:
    'produced only because the production caseType was supplied as an external input '
    + '(PRODUCTION_AUTHORITY_OVERLAY); measurable, but not source-derived',
  PRODUCTION_AUTHORITATIVE: 'human/receipt-backed current state remains authoritative',
  SOURCE_DERIVED: 'source replay produced a different projection; explicit review is required',
  CONFLICT_REVIEW: 'source alone cannot resolve this difference safely',
}

const NOT_ATTEMPTED_REASON =
  'conditional on a production caseType, and no PRODUCTION_AUTHORITY_OVERLAY lent one to this thread in '
  + 'this run; the replay produced nothing to compare, which is neither a match nor a mismatch'

export function reconcileReplay(
  replayRunId: string,
  replayCases: readonly ReplayCaseProjection[],
  productionCases: readonly ProductionCaseSnapshot[],
  generatedAt = Math.floor(Date.now() / 1000),
): CorrectionManifest {
  const findings: ReconciliationFinding[] = []
  const rs = new Map<string, ReplayCaseProjection[]>()
  const ps = new Map<string, ProductionCaseSnapshot[]>()
  for (const r of replayCases) { const x = rs.get(r.threadId) ?? []; x.push(r); rs.set(r.threadId, x) }
  for (const p of productionCases) for (const t of p.threadIds) { const x = ps.get(t) ?? []; x.push(p); ps.set(t, x) }

  let eligible = 0, compared = 0, matched = 0, mismatched = 0, conditional = 0
  let conditionalMismatched = 0, conditionalNotAttempted = 0
  let notReplayable = 0, unknown = 0

  for (const threadId of new Set([...rs.keys(), ...ps.keys()])) {
    const rr = rs.get(threadId) ?? []
    const pp = ps.get(threadId) ?? []
    if (rr.length !== 1 || pp.length !== 1) {
      unknown += 1
      findings.push({
        findingId: `recon:${h(`${replayRunId}:${threadId}:map`)}`,
        domain: rr[0]?.domain ?? pp[0]?.domain ?? 'personal', threadId,
        productionCaseId: pp[0]?.caseId ?? null, replayCaseId: rr[0]?.replayCaseId ?? null,
        field: 'case_mapping', productionValue: pp.map(x => x.caseId), replayValue: rr.map(x => x.replayCaseId),
        authority: 'CONFLICT_REVIEW', severity: 'P1',
        reason: 'thread identity does not map one-to-one; no repair may be inferred', autoApplyAllowed: false,
      })
      continue
    }
    const r = rr[0]; const p = pp[0]
    const overlaid = r.projectionAuthority === 'CONDITIONAL_ON_PRODUCTION_TYPE'
    const pairs: Array<[string, unknown, unknown]> = [
      ['domain', p.domain, r.domain], ['title', p.title, r.title], ['caseType', p.caseType, r.caseType],
      ['status', p.status, r.status], ['nextAction', p.nextAction, r.nextAction],
      ['nextActionOwner', p.nextActionOwner, r.nextActionOwner], ['waitingOn', p.waitingOn, r.waitingOn],
      ['dueAt', p.dueAt, r.dueAt], ['followUpAt', p.followUpAt, r.followUpAt], ['nextWakeAt', p.nextWakeAt, r.nextWakeAt],
    ]
    for (const [field, pv, rv] of pairs) {
      eligible += 1
      const a = classifyField(field, p)

      if (a === 'NOT_REPLAYABLE') {
        // Counted as coverage and reported once, whether the values happen to
        // coincide or not. A coincidence is not evidence.
        notReplayable += 1
        findings.push({
          findingId: `recon:${h(`${replayRunId}:${p.caseId}:${field}:notreplayable`)}`,
          domain: r.domain, threadId, productionCaseId: p.caseId, replayCaseId: r.replayCaseId,
          field, productionValue: pv, replayValue: null,
          authority: a, severity: severity(field, a), reason: REASONS[a], autoApplyAllowed: false,
        })
        continue
      }

      if (a === 'CONDITIONAL_ON_PRODUCTION_TYPE' && !overlaid) {
        // The replay held no type for this thread, so it produced no operational
        // projection. Comparing production's value against that absence would
        // manufacture a mismatch out of a run that was never asked to try.
        conditionalNotAttempted += 1
        findings.push({
          findingId: `recon:${h(`${replayRunId}:${p.caseId}:${field}:notattempted`)}`,
          domain: r.domain, threadId, productionCaseId: p.caseId, replayCaseId: r.replayCaseId,
          field, productionValue: pv, replayValue: null,
          authority: a, severity: severity(field, a), reason: NOT_ATTEMPTED_REASON, autoApplyAllowed: false,
        })
        continue
      }

      compared += 1
      if (a === 'CONDITIONAL_ON_PRODUCTION_TYPE') conditional += 1
      if (same(pv, rv)) { matched += 1; continue }
      mismatched += 1
      if (a === 'CONDITIONAL_ON_PRODUCTION_TYPE') conditionalMismatched += 1
      findings.push({
        findingId: `recon:${h(`${replayRunId}:${p.caseId}:${r.replayCaseId}:${field}:${JSON.stringify(pv)}:${JSON.stringify(rv)}`)}`,
        domain: r.domain, threadId, productionCaseId: p.caseId, replayCaseId: r.replayCaseId,
        field, productionValue: pv, replayValue: rv, authority: a, severity: severity(field, a),
        reason: REASONS[a], autoApplyAllowed: false,
      })
    }
  }

  const n = (s: ReconciliationSeverity) => findings.filter(f => f.severity === s).length
  return {
    generatedAt, replayRunId, autoApplyAllowed: false, findings,
    summary: { total: findings.length, p0: n('P0'), p1: n('P1'), p2: n('P2'), p3: n('P3'), unclassified: 0 },
    coverage: {
      eligible, compared, matched, mismatched, conditional, conditionalMismatched,
      notReplayable, conditionalNotAttempted, unknown,
    },
  }
}

/** Stage 2H (Istvan, 2026-08-18). This used to return true while a conditional
 *  field disagreed, because a conditional mismatch is P2 and the gate only read
 *  P0/P1. That is the shape of a gate reporting the severity of the finding
 *  instead of the fact that a finding exists: the one surface where the replay
 *  actually produced a comparable value could disagree on every thread and the
 *  gate would stay green. An unresolved conditional mismatch now blocks. */
export function replayReadyForStability(m: CorrectionManifest): boolean {
  return m.summary.unclassified === 0 && m.summary.p0 === 0 && m.summary.p1 === 0
    // Stage 2H: an unresolved mapping is not a quiet zero.
    && m.coverage.unknown === 0
    // Stage 2H: neither is a conditional field the replay compared and lost.
    && m.coverage.conditionalMismatched === 0
}

export interface ReplayReadinessInput {
  manifest: CorrectionManifest
  /** null => the conditional extractor replay has not been run */
  extractorParity: ExtractorParityReport | null
  /** the two digests of the mandatory double run on the same immutable input.
   *  Absent => determinism was not demonstrated, which is not the same as passing. */
  doubleRun?: { digestA: string; digestB: string }
  /** the denominator the run is expected to have, asserted rather than assumed */
  expectedDenominator?: { eligible: number; inputNotEquivalent: number }
  /** null => document/attachment parity has not been run */
  documentParity: { pass: boolean; reasons?: string[] } | null
}

function extractorSurfaceStatus(
  r: ExtractorParityReport | null,
  doubleRun: ReplayReadinessInput['doubleRun'],
  expected: ReplayReadinessInput['expectedDenominator'],
): { status: ParitySurfaceStatus; reasons: string[] } {
  if (!r) return { status: 'NOT_RUN', reasons: ['conditional extractor parity has not been run'] }
  if (r.basis === 'CURRENT_ONLY') {
    return {
      status: 'NOT_RUN',
      reasons: ['this report is a CURRENT_FULL_BODY evaluation; a current-extractor run is never historical parity'],
    }
  }
  // Retired 2026-08-18: production extracted from the provider snippet in every
  // case, so a full-body historical surface has nothing it is entitled to
  // measure. Saying FAIL would blame the code; saying NOT_RUN would hide that it
  // ran. It found no eligible input, and that is its own answer.
  if (r.summary.eligible === 0) {
    return {
      status: 'NO_ELIGIBLE_HISTORICAL_INPUT',
      reasons: ['no thread has a reproducible historical input; nothing was eligible to compare'],
    }
  }
  const reasons: string[] = []
  if (r.summary.compared !== r.summary.eligible) {
    reasons.push(`${r.summary.eligible} eligible target(s) but ${r.summary.compared} compared`)
  }
  if (r.summary.pass !== r.summary.eligible) {
    reasons.push(`${r.summary.pass} of ${r.summary.eligible} eligible target(s) passed`)
  }
  if (r.summary.mismatch > 0) reasons.push(`${r.summary.mismatch} extractor target(s) mismatch production`)
  if (r.summary.productionHasNoRow > 0) {
    reasons.push(`${r.summary.productionHasNoRow} target(s) where the replay extracted a row production holds none of`)
  }
  if (r.summary.seamBlocked > 0) reasons.push(`${r.summary.seamBlocked} target(s) blocked at a production seam`)
  if (r.summary.unknown > 0) reasons.push(`${r.summary.unknown} target(s) with no determined result`)
  if (r.summary.fieldsMismatched > 0) reasons.push(`${r.summary.fieldsMismatched} extractor field(s) mismatch production`)
  // Every eligible row must carry a demonstrated outcome on both sides. A missing
  // row is a pass only as a proven NO_EXTRACTION, never as mutual silence.
  for (const row of r.rows) {
    if (row.inputBasis !== 'HISTORICAL_PROVIDER_SNIPPET_WITH_HEADERS') continue
    if (!row.extractorAttempted) reasons.push(`${row.productionCaseId}: eligible but the extractor was never run`)
    else if (row.replayResult == null) reasons.push(`${row.productionCaseId}: no replay result recorded`)
    else if (row.expectedHistorical == null) reasons.push(`${row.productionCaseId}: no historical expectation recorded`)
    else if (row.replayResult !== row.expectedHistorical) {
      reasons.push(`${row.productionCaseId}: expected ${row.expectedHistorical}, replay produced ${row.replayResult}`)
    }
  }
  if (expected) {
    if (r.summary.eligible !== expected.eligible) {
      reasons.push(`expected ${expected.eligible} eligible target(s), report has ${r.summary.eligible}`)
    }
    if (r.summary.inputNotEquivalent !== expected.inputNotEquivalent) {
      reasons.push(`expected ${expected.inputNotEquivalent} not-equivalent target(s), report has ${r.summary.inputNotEquivalent}`)
    }
  }
  if (!doubleRun) reasons.push('no double run was supplied; determinism on the same immutable input is not demonstrated')
  else if (doubleRun.digestA !== doubleRun.digestB) reasons.push('the two runs produced different parity digests')
  else if (doubleRun.digestA !== r.parityDigest) reasons.push('the reported run does not match the double-run digest')

  return { status: reasons.length ? 'FAIL' : 'PASS', reasons }
}

/** Stage 2H readiness (Istvan, 2026-08-18): four named surfaces, not one boolean.
 *  A single verdict could and did go green while the surface that mattered had
 *  never been run — NOT_RUN and PASS are different words here on purpose. */
export function evaluateReplayReadiness(input: ReplayReadinessInput): ReplayReadiness {
  const reasons: string[] = []

  const historicalOk = replayReadyForStability(input.manifest)
  const historicalSourceReplayStatus: ParitySurfaceStatus = historicalOk ? 'PASS' : 'FAIL'
  if (!historicalOk) {
    if (input.manifest.summary.p0 > 0) reasons.push(`${input.manifest.summary.p0} P0 finding(s)`)
    if (input.manifest.summary.p1 > 0) reasons.push(`${input.manifest.summary.p1} P1 finding(s)`)
    if (input.manifest.coverage.unknown > 0) reasons.push(`${input.manifest.coverage.unknown} unmapped thread(s)`)
    if (input.manifest.coverage.conditionalMismatched > 0) {
      reasons.push(`${input.manifest.coverage.conditionalMismatched} unresolved conditional mismatch(es)`)
    }
    if (input.manifest.summary.unclassified > 0) reasons.push(`${input.manifest.summary.unclassified} unclassified finding(s)`)
  }

  const ext = extractorSurfaceStatus(input.extractorParity, input.doubleRun, input.expectedDenominator)
  reasons.push(...ext.reasons)

  const documentParityStatus: ParitySurfaceStatus = input.documentParity == null
    ? 'NOT_RUN'
    : input.documentParity.pass ? 'PASS' : 'FAIL'
  if (documentParityStatus === 'NOT_RUN') reasons.push('document parity has not been run')
  if (documentParityStatus === 'FAIL') reasons.push(...(input.documentParity?.reasons ?? ['document parity failed']))

  const stable = historicalSourceReplayStatus === 'PASS'
    && ext.status === 'PASS'
    && documentParityStatus === 'PASS'

  return {
    historicalSourceReplayStatus,
    conditionalExtractorParityStatus: ext.status,
    documentParityStatus,
    // Structural, and it never becomes PASS. It is an accepted coverage
    // limitation, which is a different thing from a surface that passed.
    historicalTriageReplayStatus: 'NOT_REPLAYABLE',
    stable,
    reasons,
  }
}
