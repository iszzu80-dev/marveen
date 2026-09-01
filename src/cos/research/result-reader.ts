// PHASE 3 (P3-B2) -- THE RESEARCH LEDGER GETS A READER.
//
// Owner ruling 2026-09-01: "A research ledger ne legyen dead-end. Kapjon
// read-only consumert, amely a research eredmenyt be tudja emelni a Phase 2
// projectionba, de tovabbra sem canonical case state-kent."
//
// WHY IT MATTERS THAT THIS EXISTS. In the B1 pilot one of the two queries
// returned a genuinely useful answer -- a vendor's published support channels --
// and `changedSurface` was still 0, because nothing read `case_research_queries`.
// A metric that can only ever be zero is not a metric, so the acceptance
// criterion the owner cares about most could not be evaluated at all. This makes
// it evaluable.
//
// WHAT IT MAY DO: enrich evidence, modify a recommendation, improve the WORDING
// of an attention reason, add to decision support.
//
// WHAT IT MAY NOT DO, and none of it is possible from here rather than merely
// forbidden: there is no UPDATE against a case table in this file, no status is
// written, no case is completed, nothing is authorized, nothing external is
// called. The projection is rebuilt from canonical rows on every run and this
// returns a DERIVED overlay -- delete every research row and the next projection
// is exactly what it was before.
//
// THE TRACE IS THE POINT. Every change carries the full chain the owner asked
// for -- research result -> evidence -> projection item -> changed surface -- so
// `changedSurface` is computed from what actually attached rather than asserted
// by whoever ran the pilot.
import type Database from 'better-sqlite3'
import type { AttentionItem } from '../intelligence/attention.js'
import type { IntelligenceProjection } from '../intelligence/project.js'

export interface ResearchFinding {
  ticketId: string
  caseId: string
  namespace: string
  query: string
  resultKind: string
  provenance: string[]
  falsePositive: boolean
  note: string | null
  executedAt: number
}

export type EnrichmentChange =
  | 'EVIDENCE_ADDED'
  | 'ATTENTION_REASON_IMPROVED'
  | 'RECOMMENDATION_MODIFIED'

export interface EnrichmentTrace {
  ticketId: string
  caseId: string
  namespace: string
  /** research result -> evidence */
  evidenceSources: string[]
  /** evidence -> projection item */
  elementId: string
  surface: 'ATTENTION' | 'COMMITMENT' | 'OPPORTUNITY'
  change: EnrichmentChange
  before: string
  after: string
}

/**
 * Executed findings that are worth reading.
 *
 * A false positive is EXCLUDED here rather than filtered by the caller: an
 * answer that confidently addressed the wrong question must not enrich anything,
 * and leaving that decision to each consumer is how one of them forgets.
 * Provenance is required for the same reason `recordResearchResult` downgrades a
 * sourceless answer to NO_RESULT -- an unsourced claim is not evidence.
 */
export function researchFindings(
  db: Database.Database, namespace: string, caseIds?: readonly string[],
): ResearchFinding[] {
  const rows = db.prepare(
    `SELECT ticket_id, case_id, namespace, query, result_kind, result_provenance,
            false_positive, outcome_note, executed_at
       FROM case_research_queries
      WHERE namespace = ? AND status = 'EXECUTED'
        AND result_kind IN ('EVIDENCE','INFERENCE','RECOMMENDATION')
        AND false_positive = 0
      ORDER BY executed_at DESC`,
  ).all(namespace) as Array<Record<string, unknown>>

  const wanted = caseIds ? new Set(caseIds) : null
  const out: ResearchFinding[] = []
  for (const r of rows) {
    const caseId = String(r.case_id)
    if (wanted && !wanted.has(caseId)) continue
    let provenance: string[] = []
    try { provenance = JSON.parse(String(r.result_provenance ?? '[]')) } catch { provenance = [] }
    if (!provenance.length) continue
    out.push({
      ticketId: String(r.ticket_id), caseId, namespace: String(r.namespace),
      query: String(r.query ?? ''), resultKind: String(r.result_kind),
      provenance, falsePositive: false,
      note: (r.outcome_note as string | null) ?? null,
      executedAt: Number(r.executed_at ?? 0),
    })
  }
  return out
}

/** One line, and it names its own source. A reader who has never heard of this
 *  feature must be able to see where the sentence came from. */
export function enrichmentSentence(f: ResearchFinding): string {
  const host = (() => {
    try { return new URL(f.provenance[0]).host } catch { return f.provenance[0] }
  })()
  const what = f.note?.trim() || `public research answered "${f.query}"`
  return `nyilvanos forras (${host}): ${what}`
}

export interface EnrichmentResult {
  /** The projection, with the enriched items REPLACED in place. Same shape, so
   *  every existing consumer keeps working and none of them has to know. */
  projection: IntelligenceProjection
  traces: EnrichmentTrace[]
}

/**
 * Apply the findings to a freshly computed projection.
 *
 * Pure with respect to the store: it reads research rows and returns a new
 * projection object. Nothing is written here -- `markChangedSurface` is a
 * separate, explicit act, so a caller that only wants to LOOK cannot accidentally
 * record that something changed.
 */
export function applyResearchEnrichment(
  db: Database.Database, namespace: string, projection: IntelligenceProjection,
): EnrichmentResult {
  const findings = researchFindings(db, namespace)
  if (!findings.length) return { projection, traces: [] }

  const byCase = new Map<string, ResearchFinding>()
  for (const f of findings) if (!byCase.has(f.caseId)) byCase.set(f.caseId, f)   // newest wins

  const traces: EnrichmentTrace[] = []

  const enrich = (item: AttentionItem, surface: EnrichmentTrace['surface']): AttentionItem => {
    const f = byCase.get(item.element.caseId)
    if (!f) return item
    const before = item.why
    const after = `${before} -- ${enrichmentSentence(f)}`
    traces.push({
      ticketId: f.ticketId, caseId: f.caseId, namespace,
      evidenceSources: f.provenance, elementId: item.element.id, surface,
      change: surface === 'OPPORTUNITY' ? 'RECOMMENDATION_MODIFIED' : 'ATTENTION_REASON_IMPROVED',
      before, after,
    })
    return {
      ...item,
      why: after,
      element: {
        ...item.element,
        provenance: [
          ...item.element.provenance,
          // The research row is named as a source, so the chain is readable from
          // the element alone: element -> WEB_RESEARCH:<ticket> -> the URLs.
          { source: 'WEB_RESEARCH', ref: f.ticketId, observedAt: f.executedAt, field: 'result_provenance' },
        ],
      },
    }
  }

  const interrupt = projection.attention.interrupt.map((i) => enrich(i, i.band === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'ATTENTION'))
  const quiet = projection.attention.quiet.map((i) => enrich(i, i.band === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'ATTENTION'))

  return {
    projection: { ...projection, attention: { ...projection.attention, interrupt, quiet } },
    traces,
  }
}

/**
 * Record that a finding actually reached a surface.
 *
 * Written from the TRACES, never from a judgement: a ticket is marked as having
 * changed something only when an element in the projection carries its
 * provenance. That is what makes `changedSurface` an acceptance metric instead
 * of a claim.
 */
export function markChangedSurface(
  db: Database.Database, traces: readonly EnrichmentTrace[],
): number {
  if (!traces.length) return 0
  const stmt = db.prepare(
    `UPDATE case_research_queries SET changed_surface = 1 WHERE ticket_id = ? AND status = 'EXECUTED'`,
  )
  let n = 0
  const tx = db.transaction(() => {
    for (const id of new Set(traces.map((t) => t.ticketId))) n += stmt.run(id).changes
  })
  tx()
  return n
}
