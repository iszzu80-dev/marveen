// §4.2 — the semantic-quality metrics.
//
// WHAT THE SPEC MEASURED, AND WHY IT BOTHERED. The live report found every case
// had a rolling plan and a next best action, and 101 cases shared 11 distinct
// values between them. The spec's own line about it:
//
//     structurally populated  !=  case-specific semantically useful
//
// That is the whole point of this file. "Is the field filled?" is a question the
// existing dashboards already answer, and it answered YES throughout the period
// the engine was proposing the same three sentences to sixty-four different
// matters. The six metrics below are the ones that would have said NO.
//
// WHY THEY HAD TO BE BUILT EVEN THOUGH THE CAUSE WAS ALREADY FIXED. The lazy LLM
// enrichment (goal-enrichment.ts) attacks the cause: a case now gets a goal read
// from its own email thread instead of a per-status template. But "we fixed it"
// is a claim, and until something measures the result the claim has no evidence
// behind it — which is exactly the position the 2026-08-09 incident started
// from. A fix with no measurement is indistinguishable from a fix that did not
// work, and the difference only shows up in production.
//
// THE DEFINITIONS ARE WRITTEN DOWN, ON PURPOSE. Every one of these could be
// computed three defensible ways, and a metric whose definition lives only in
// its implementation drifts silently into whichever definition flatters the
// current state. Each function below states its definition before it computes
// it, and the tests assert the definition, not the current number.

import type Database from 'better-sqlite3'

export interface SemanticQualityMetrics {
  /** How many cases the numbers are about. Everything else is meaningless
   *  without it — a ratio over four cases is noise wearing a decimal point. */
  sampleSize: number

  /** distinct_value_ratio — distinct next-best-action sentences ÷ cases.
   *  1.0 means every case got its own sentence; the live 11/101 was 0.109. */
  distinctValueRatio: number

  /** template_reuse_rate — the share of cases whose next-best-action sentence is
   *  ALSO some other case's. Not simply 1 − distinctValueRatio: a value used by
   *  two cases and a value used by sixty are one "distinct value" each, and only
   *  this measure tells them apart. */
  templateReuseRate: number

  /** case_specificity_score — the share of cases whose definition-of-done was
   *  derived from the case rather than from its status. Read from the recorded
   *  provenance, not inferred: initializeDoDVerification already stores whether
   *  the criteria are CASE_SPECIFIC or the per-status template, and a number
   *  that re-guesses what the system already knows can disagree with it. */
  caseSpecificityScore: number

  /** next_action_executability — the share of next-best-actions that name
   *  something someone could DO. AWAIT_EXTERNAL is not executable (it is the
   *  absence of an action) and an empty description is not executable whatever
   *  its kind says. */
  nextActionExecutability: number

  /** plan_step_evidence_linkage — the share of plan steps citing at least one
   *  piece of evidence. The planner's own comment about evidenceRefs says
   *  "Empty is a defect, not a default"; this is that sentence as a number. */
  planStepEvidenceLinkage: number

  /** replan_on_new_evidence_rate — of the cases that received new evidence after
   *  their first plan, the share whose plan actually changed. A planner that
   *  never re-plans produces a stable number that describes a world which has
   *  moved on. NaN-free: 0 cases with new evidence reports 0, and `replanDenom`
   *  says so. */
  replanOnNewEvidenceRate: number
  /** How many cases the replan rate is over — usually far fewer than
   *  sampleSize, and reporting 0.5 over two cases without saying "two" is how a
   *  metric misleads honestly. */
  replanDenominator: number
}

interface StateRow {
  case_id: string
  next_best_action_json: string | null
  rolling_plan_json: string | null
  dod_verification_json: string | null
  plan_version: number
}

/** Kinds that describe an ACTION. AWAIT_EXTERNAL is deliberately absent: waiting
 *  is the state of having no next action, and counting it as executable is how a
 *  queue of blocked cases reports as a healthy pipeline. */
const EXECUTABLE_KINDS = new Set(['OBTAIN', 'ASK_OWNER', 'EXECUTE', 'VERIFY', 'CLOSE'])

function parse<T>(json: string | null): T | null {
  if (!json) return null
  try { return JSON.parse(json) as T } catch { return null }
}

/** The sentence a case's next best action proposes, normalised so that trailing
 *  whitespace does not manufacture distinctness. Null when there is none. */
function nbaDescription(row: StateRow): string | null {
  const nba = parse<{ description?: unknown }>(row.next_best_action_json)
  const d = typeof nba?.description === 'string' ? nba.description.trim() : ''
  return d.length > 0 ? d : null
}

/**
 * Measure one domain, or both.
 *
 * Read-only and cheap enough to call from a dashboard route: one query for the
 * state rows, one for the evidence counts, and the rest is arithmetic.
 *
 * Terminal cases are EXCLUDED. A closed case's plan is a historical record, and
 * including it means the score improves every time a case closes — a metric that
 * rewards the passage of time is not measuring quality.
 */
export function semanticQualityMetrics(
  db: Database.Database, domain?: 'personal' | 'zst',
): SemanticQualityMetrics {
  const domains: Array<'personal' | 'zst'> = domain ? [domain] : ['personal', 'zst']
  const rows: StateRow[] = []
  const caseDomain = new Map<string, 'personal' | 'zst'>()

  for (const d of domains) {
    const table = d === 'personal' ? 'personal_cases' : 'zst_cases'
    try {
      const found = db.prepare(
        `SELECT s.case_id, s.next_best_action_json, s.rolling_plan_json,
                s.dod_verification_json, s.plan_version
           FROM case_progression_state s
           JOIN ${table} c ON c.case_id = s.case_id
          WHERE s.domain = ?
            AND c.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
            AND c.archived_at IS NULL`,
      ).all(d) as StateRow[]
      for (const r of found) { rows.push(r); caseDomain.set(r.case_id, d) }
    } catch { /* a missing table contributes no cases, and is not an error */ }
  }

  const empty: SemanticQualityMetrics = {
    sampleSize: 0, distinctValueRatio: 0, templateReuseRate: 0,
    caseSpecificityScore: 0, nextActionExecutability: 0,
    planStepEvidenceLinkage: 0, replanOnNewEvidenceRate: 0, replanDenominator: 0,
  }
  if (rows.length === 0) return empty

  // ── distinct_value_ratio and template_reuse_rate ────────────────────────
  const counts = new Map<string, number>()
  let withNba = 0
  for (const r of rows) {
    const d = nbaDescription(r)
    if (!d) continue
    withNba++
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  // Denominator is cases WITH a next best action, not all cases: a case that has
  // none is a different problem (structurally unpopulated), and folding the two
  // together makes an empty engine look diverse.
  const distinctValueRatio = withNba === 0 ? 0 : counts.size / withNba
  let reused = 0
  for (const [, n] of counts) if (n > 1) reused += n
  const templateReuseRate = withNba === 0 ? 0 : reused / withNba

  // ── case_specificity_score ──────────────────────────────────────────────
  let caseSpecific = 0
  let withProvenance = 0
  for (const r of rows) {
    const v = parse<{ provenance?: unknown }>(r.dod_verification_json)
    if (!v || typeof v.provenance !== 'string') continue
    withProvenance++
    if (v.provenance === 'CASE_SPECIFIC') caseSpecific++
  }
  const caseSpecificityScore = withProvenance === 0 ? 0 : caseSpecific / withProvenance

  // ── next_action_executability ───────────────────────────────────────────
  let executable = 0
  for (const r of rows) {
    const nba = parse<{ kind?: unknown; description?: unknown }>(r.next_best_action_json)
    const hasText = typeof nba?.description === 'string' && nba.description.trim().length > 0
    if (hasText && typeof nba?.kind === 'string' && EXECUTABLE_KINDS.has(nba.kind)) executable++
  }
  const nextActionExecutability = withNba === 0 ? 0 : executable / withNba

  // ── plan_step_evidence_linkage ──────────────────────────────────────────
  //
  // Over STEPS, not over cases. A case with one linked step and a case with six
  // are not equally evidence-grounded, and averaging per case hides it.
  let steps = 0
  let linked = 0
  for (const r of rows) {
    const plan = parse<Array<{ evidenceRefs?: unknown }>>(r.rolling_plan_json)
    if (!Array.isArray(plan)) continue
    for (const s of plan) {
      steps++
      if (Array.isArray(s?.evidenceRefs) && s.evidenceRefs.length > 0) linked++
    }
  }
  const planStepEvidenceLinkage = steps === 0 ? 0 : linked / steps

  // ── replan_on_new_evidence_rate ─────────────────────────────────────────
  //
  // "New evidence" is a SECOND stored reading: the first packet produced the
  // first plan, so only the ones after it could have caused a re-plan. A case
  // with two packets and plan_version 1 read the case again and changed nothing.
  let replanDenominator = 0
  let replanned = 0
  for (const r of rows) {
    let packets = 0
    try {
      packets = (db.prepare(
        `SELECT COUNT(*) AS n FROM case_evidence_packets
          WHERE case_id = ? AND packet_json IS NOT NULL`,
      ).get(r.case_id) as { n: number }).n
    } catch { packets = 0 }
    if (packets < 2) continue
    replanDenominator++
    if (r.plan_version > 1) replanned++
  }
  const replanOnNewEvidenceRate = replanDenominator === 0 ? 0 : replanned / replanDenominator

  return {
    sampleSize: rows.length,
    distinctValueRatio,
    templateReuseRate,
    caseSpecificityScore,
    nextActionExecutability,
    planStepEvidenceLinkage,
    replanOnNewEvidenceRate,
    replanDenominator,
  }
}

/** The metrics as a human reads them, with the thresholds the spec implies.
 *
 *  THRESHOLDS ARE A JUDGEMENT AND ARE MARKED AS ONE. The spec names the metrics
 *  and not the numbers, so these are the lines below which the live measurement
 *  that prompted §4.2 would have been flagged — 11 distinct values over 101
 *  cases is 0.109, so a 0.5 line would have caught it with room to spare. They
 *  are here to make the report readable, not to gate anything: nothing fails a
 *  build on them, because a threshold nobody agreed to should not stop work. */
export const QUALITY_THRESHOLDS = {
  distinctValueRatio: 0.5,
  templateReuseRate: 0.5,      // lower is better — this one is a CEILING
  caseSpecificityScore: 0.8,
  nextActionExecutability: 0.7,
  planStepEvidenceLinkage: 0.9,
  replanOnNewEvidenceRate: 0.3,
} as const

/** Which metrics are currently below the line. Empty is the healthy answer. */
export function qualityConcerns(m: SemanticQualityMetrics): string[] {
  if (m.sampleSize === 0) return []
  const out: string[] = []
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  if (m.distinctValueRatio < QUALITY_THRESHOLDS.distinctValueRatio) {
    out.push(`distinct_value_ratio ${pct(m.distinctValueRatio)} — a next best action ugyanaz a mondat sok ügyön`)
  }
  if (m.templateReuseRate > QUALITY_THRESHOLDS.templateReuseRate) {
    out.push(`template_reuse_rate ${pct(m.templateReuseRate)} — az ügyek többsége osztozik egy javaslaton`)
  }
  if (m.caseSpecificityScore < QUALITY_THRESHOLDS.caseSpecificityScore) {
    out.push(`case_specificity_score ${pct(m.caseSpecificityScore)} — a definition-of-done státusz-sablon, nem az ügyé`)
  }
  if (m.nextActionExecutability < QUALITY_THRESHOLDS.nextActionExecutability) {
    out.push(`next_action_executability ${pct(m.nextActionExecutability)} — a javasolt lépés nem végrehajtható`)
  }
  if (m.planStepEvidenceLinkage < QUALITY_THRESHOLDS.planStepEvidenceLinkage) {
    out.push(`plan_step_evidence_linkage ${pct(m.planStepEvidenceLinkage)} — a terv lépései nem hivatkoznak bizonyítékra`)
  }
  if (m.replanDenominator > 0 && m.replanOnNewEvidenceRate < QUALITY_THRESHOLDS.replanOnNewEvidenceRate) {
    out.push(`replan_on_new_evidence_rate ${pct(m.replanOnNewEvidenceRate)} `
      + `(${m.replanDenominator} ügyön) — új olvasat után sem változik a terv`)
  }
  return out
}
