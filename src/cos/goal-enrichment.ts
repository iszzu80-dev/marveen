// Lazy LLM goal enrichment — the sweep that finally calls the interpreter.
//
// Card ca33eb4b. progression-interpreter.ts has been complete since Checkpoint D:
// it asks Claude Haiku to read a case's email thread and return a human title, a
// two-or-three-sentence summary, and ONE concrete outcome statement, with the
// thread isolated in a delimited data block and a system prompt that forbids
// treating it as instructions. It was tested. Nothing ever called it.
//
// The consequence was not cosmetic. Every case's goal came from
// deriveOutcomeContract's per-STATUS template, so the 15-million-forint
// investment decision and the dentist appointment carried the same three
// criteria: triaged, actions identified, owner assigned. An engine that cannot
// say what a case is FOR cannot propose what to do next about it, which is why
// 7653 progression runs produced zero proposed external actions.
//
// This module is deliberately thin: pick the cases the LLM has never seen, give
// each one the best content available, call the existing enricher, and never let
// one failure stop the rest. All the judgement lives in the interpreter; all the
// safety lives in enrichCaseGoal's domain guard and the interpreter's injection
// guard.

import type Database from 'better-sqlite3'
import { enrichCaseGoal } from './progression-pipeline.js'
import type { LlmClient } from './progression-interpreter.js'
import { readDocumentBytes } from './cos-documents.js'

export interface GoalEnrichmentResult {
  /** Cases the LLM interpreted on this sweep. */
  enriched: number
  /** Cases that were already interpreted (should be 0 — they are filtered out). */
  skipped: number
  /** Per-case failures. A failure never blocks the others. */
  failures: Array<{ caseId: string; error: string }>
  /** Still waiting after this sweep — so a caller can tell "done" from "bounded". */
  remaining: number
}

interface Candidate { domain: 'personal' | 'zst'; caseId: string }

/** Cases whose summary is empty: the LLM has never looked at them.
 *
 *  Only progression-enabled, non-terminal cases. Enriching a closed case spends
 *  a model call to describe something nobody will act on. */
export function casesNeedingGoal(db: Database.Database, limit: number): Candidate[] {
  const rows: Candidate[] = []
  for (const domain of ['personal', 'zst'] as const) {
    const table = domain === 'personal' ? 'personal_cases' : 'zst_cases'
    try {
      const found = db.prepare(
        `SELECT s.case_id AS caseId
         FROM case_progression_state s
         JOIN ${table} c ON c.case_id = s.case_id
         WHERE s.domain = ?
           AND (s.summary IS NULL OR TRIM(s.summary) = '')
           AND s.progression_enabled = 1
           AND c.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
           AND c.archived_at IS NULL
         ORDER BY c.updated_at DESC`,
      ).all(domain) as Array<{ caseId: string }>
      for (const r of found) rows.push({ domain, caseId: r.caseId })
    } catch { /* a missing table is not a candidate, and not an error either */ }
  }
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** The best text we have about a case, in descending order of usefulness:
 *  the stored email thread, then the case description. Returns undefined when
 *  there is neither, and the enricher falls back to the description itself.
 *
 *  A thread is worth reaching for because it is what the interpreter was built
 *  to read — a case whose only text is a one-line auto-generated title produces
 *  a goal barely better than the template it replaces. */
function bestContentFor(db: Database.Database, domain: 'personal' | 'zst', caseId: string): string | undefined {
  try {
    const doc = db.prepare(
      `SELECT document_id FROM cos_documents
       WHERE case_id = ? AND namespace = ? AND doc_kind = 'email_thread'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(caseId, domain) as { document_id: string } | undefined
    if (doc) {
      const bytes = readDocumentBytes(db, doc.document_id)
      const text = bytes.toString('utf8')
      // A whole thread can be long; the interpreter only needs enough to say
      // what the case is about. Truncating is honest here -- it costs detail,
      // never correctness -- and it bounds the token spend per case.
      return text.length > 12_000 ? `${text.slice(0, 12_000)}\n[...levágva]` : text
    }
  } catch { /* content purged or missing on disk -- fall through to description */ }
  return undefined
}

/** Interpret up to `limit` un-enriched cases. Safe to call every cycle: cases
 *  drop out of the candidate set permanently once interpreted, so the cost is
 *  one model call per case for the lifetime of the case, not per cycle. */
export async function enrichPendingGoals(
  db: Database.Database,
  llm: LlmClient,
  limit = 5,
): Promise<GoalEnrichmentResult> {
  const candidates = casesNeedingGoal(db, limit)
  const result: GoalEnrichmentResult = { enriched: 0, skipped: 0, failures: [], remaining: 0 }

  for (const c of candidates) {
    try {
      const content = bestContentFor(db, c.domain, c.caseId)
      const r = await enrichCaseGoal(db, c.domain, c.caseId, llm, content)
      if (r.interpreted) result.enriched++
      else result.skipped++
    } catch (e) {
      // One unreadable case, one model timeout, one malformed reply -- none of
      // these may stop the sweep. The failure is reported, not swallowed.
      result.failures.push({ caseId: `${c.domain}/${c.caseId}`, error: String((e as Error)?.message ?? e) })
    }
  }

  result.remaining = casesNeedingGoal(db, 0).length
  return result
}
