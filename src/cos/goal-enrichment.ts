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
import { effectiveSensitivity } from './sensitivity.js'
import { coerceZstSensitivity } from './zst-sensitivity.js'
import { isProviderAllowedForSensitivity, providersAllowedFor } from './provider-data-policy.js'
import type { CaseSensitivity } from './schema.js'

export interface GoalEnrichmentResult {
  /** Cases the LLM interpreted on this sweep. */
  enriched: number
  /** §10: cases whose content no configured provider is cleared to receive.
   *  Counted, never silent — "enriched: 2" and "enriched: 2, sensitivityBlocked: 1"
   *  must not look the same. */
  sensitivityBlocked: number
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

/** The tier the case itself claims. Unknown/missing coerces to the strictest
 *  class inside effectiveSensitivity, so a case with no tier is not a case that
 *  may go anywhere. */
function declaredSensitivity(db: Database.Database, domain: 'personal' | 'zst', caseId: string): unknown {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const row = db.prepare(`SELECT sensitivity FROM ${table} WHERE case_id = ?`).get(caseId) as
      { sensitivity?: unknown } | undefined
    return row?.sensitivity
  } catch { return undefined }
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
/** A provider-labelled client, the same shape resolveReaderInterpreters returns. */
export interface EnrichRoute { client: LlmClient; provider: string }

/** The routes available to the sweep. Mirrors the Reader's pair so both paths
 *  make the same decision from the same table. */
export interface EnrichRoutes { general?: EnrichRoute | null; contracted?: EnrichRoute | null }

/** The two namespaces use DIFFERENT sensitivity vocabularies, and reading one
 *  with the other's coercer is not a small mistake: personal `coerceSensitivity`
 *  does not know 'ZST_INTERNAL', so it fail-closes to HIGHLY_SENSITIVE and every
 *  corporate case is refused. My first version of this gate did exactly that and
 *  would have silently stopped all corporate enrichment; a pre-existing test
 *  ("covers the corporate namespace too") caught it.
 *
 *  The corporate mapping is NOT invented here. zst-sensitivity.ts already states
 *  the owner-sanctioned policy per tier, and its shape maps cleanly onto the
 *  personal scale: ZST_INTERNAL is the everyday tier and is the only one that
 *  admits the cheap `analysis_efficient` profile, exactly as PERSONAL does; every
 *  class above it is restricted to the strong profiles, as SENSITIVE_PERSONAL is.
 *  PUBLIC is PUBLIC in both. Anything unrecognised lands on the strict side
 *  through coerceZstSensitivity's own fail-closed default. */
function tierFor(domain: 'personal' | 'zst', declared: unknown, content: string): CaseSensitivity {
  if (domain !== 'zst') return effectiveSensitivity(declared, content)
  const z = coerceZstSensitivity(declared)
  if (z === 'PUBLIC') return 'PUBLIC'
  if (z === 'ZST_INTERNAL') return 'PERSONAL'
  return 'SENSITIVE_PERSONAL'
}

/** §10: pick the cheapest provider CLEARED for this content, or null.
 *  Byte-for-byte the Reader's rule (reader-cycle routeFor): try the general
 *  route first, fall back to the contracted one, and refuse rather than
 *  downgrade. */
function routeFor(routes: EnrichRoutes, tier: CaseSensitivity): EnrichRoute | null {
  const { general, contracted } = routes
  if (general && isProviderAllowedForSensitivity(general.provider, tier)) return general
  if (contracted && isProviderAllowedForSensitivity(contracted.provider, tier)) return contracted
  return null
}

/** Accepts the route pair, or a bare client for callers that have only one.
 *  A bare client is labelled 'unknown', which provider-data-policy classes as
 *  THIRD_PARTY — so an unlabelled client can carry PUBLIC/PERSONAL content and
 *  nothing above it. Fail-closed by omission, not by remembering. */
function toRoutes(llm: LlmClient | EnrichRoutes): EnrichRoutes {
  if (llm && typeof llm === 'object' && ('general' in llm || 'contracted' in llm)) return llm as EnrichRoutes
  return { general: { client: llm as LlmClient, provider: 'unknown' } }
}

export async function enrichPendingGoals(
  db: Database.Database,
  llm: LlmClient | EnrichRoutes,
  limit = 5,
): Promise<GoalEnrichmentResult> {
  const candidates = casesNeedingGoal(db, limit)
  const routes = toRoutes(llm)
  const result: GoalEnrichmentResult = { enriched: 0, skipped: 0, sensitivityBlocked: 0, failures: [], remaining: 0 }

  for (const c of candidates) {
    try {
      const content = bestContentFor(db, c.domain, c.caseId)
      // §10 SENSITIVITY GATE. The Reader has had this since N4-1; this path,
      // thirty lines above it in the same runner and reading the SAME email
      // thread, did not. Review #5 (Ö-2) measured the consequence: when the
      // Anthropic vault key expires, resolveInterpreter silently falls through
      // to DeepSeek, and a thread the Reader would have refused in the same
      // cycle goes out here instead.
      //
      // The tier comes from the case's declared sensitivity ESCALATED by what
      // the content actually looks like — the declared value alone is a claim,
      // and effectiveSensitivity is what the Reader trusts too.
      const declared = declaredSensitivity(db, c.domain, c.caseId)
      const tier = tierFor(c.domain, declared, content ?? '')
      const route = routeFor(routes, tier)
      if (!route) {
        result.sensitivityBlocked++
        continue
      }
      const r = await enrichCaseGoal(db, c.domain, c.caseId, route.client, content)
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
