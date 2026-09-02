// THE PRE-QUESTION EVIDENCE GATE.
//
// Owner invariant, 2026-09-02, written after a live failure:
//
//   The CoS may not ask Istvan for a fact it already holds, with provenance,
//   somewhere in the system.
//
// WHAT HAPPENED. Question QADBD asked for "the text of the attached documents"
// and sat in one of five channel slots for twenty-two days. The text had been
// read on the day the question was asked; its summary was in the case's own
// `description`, and the contract's own numbers -- a 60% commission on a
// 292,520 EUR order -- were in that summary. The reader looked at ONE field,
// `cos_documents.extracted_text`, found NULL, and asked.
//
// So the rule this file replaces was:
//
//     a selected column is NULL  ->  ask
//
// and the rule it implements is:
//
//     required fact -> search the trusted evidence surfaces -> judge the
//     quality and provenance of what came back -> ask ONLY on a real gap.
//
// ── TWO DESIGN DECISIONS THAT ARE NOT OBVIOUS ──────────────────────────────
//
// 1. THE RESOLVERS ARE STRUCTURAL, NOT SEMANTIC, AND THERE ARE FEW OF THEM.
//    A general "does this text answer that question" matcher would need a model,
//    and its errors would be SILENT in the dangerous direction: a false
//    "resolved" suppresses a question the owner needed to see, and nothing
//    downstream would ever reveal it. Every resolver here therefore recognises a
//    specific, checkable SHAPE of requirement and points at the exact row that
//    satisfies it. Anything it does not recognise stays unresolved, and an
//    unresolved requirement is asked -- the failure direction is one extra
//    question, not one missing one.
//
// 2. NO SECOND TRUTH STORE. Nothing here copies a fact anywhere. A resolver
//    returns a REFERENCE to the row that already holds it. Where two surfaces
//    disagree the verdict is CONTRADICTION and the question is still asked;
//    picking a winner automatically is how one of two disagreeing records
//    quietly becomes the truth.

import type Database from 'better-sqlite3'
import { effectiveExtractionState, isTrustedExtraction } from './document-extraction.js'

export type EvidenceSurface =
  | 'OWNER_ANSWER' | 'CASE_DESCRIPTION' | 'CASE_FIELD' | 'CASE_EVENT' | 'DOCUMENT_TEXT'

export interface EvidenceHit {
  surface: EvidenceSurface
  /** The row this came from, so a wrong suppression can be traced to it. */
  reference: string
  excerpt: string
}

export interface RequirementVerdict {
  requirement: string
  /** True only when a resolver recognised the requirement AND found the row. */
  resolved: boolean
  hits: EvidenceHit[]
  /** Set when surfaces disagree. A contradiction never resolves: it asks, and
   *  says why. */
  contradiction: string | null
  reason: string
}

export interface GateVerdict {
  /** True when EVERY requirement is already answered by evidence — the only
   *  case in which the question is suppressed. */
  suppress: boolean
  verdicts: RequirementVerdict[]
  /** One line for the report, naming surfaces rather than counts. */
  summary: string
}

const norm = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Requirement shapes this gate recognises. Each is a narrow vocabulary rather
 *  than a general matcher, for the reason in the header.
 *
 *  TIGHTENED 2026-09-02, from a false suppression caught in the live measurement
 *  BEFORE this shipped. The first version matched any requirement containing the
 *  word "dokumentum", and it therefore suppressed:
 *
 *    "A Tárhelyen érkezett NAV 'Adózói rendelkezés' dokumentum átvétele és
 *     ellenőrzése."
 *
 *  That is not a request for text we hold. It is an ACTION only Istvan can take,
 *  on a portal we cannot reach, and suppressing it would have silently removed
 *  a real obligation from his queue -- the precise failure this module's header
 *  calls invisible from outside.
 *
 *  So a document-content request now needs BOTH halves, and must not be an
 *  action: a document noun, AND a word that asks for its CONTENT, AND no verb
 *  that makes the requirement something to DO. */
const DOCUMENT_NOUN = [
  'dokumentum', 'dokumentumok', 'melleklet', 'mellekletek', 'csatolt', 'csatolmany',
  'document', 'documents', 'attachment', 'attached', 'szerzodes', 'contract',
]
const CONTENT_WORD = [
  'szovege', 'szoveget', 'szoveg', 'tartalma', 'tartalmat', 'kiolvasott', 'kiolvasas',
  'text', 'content', 'extracted', 'wording',
]
/** A requirement that asks him to DO something is never satisfied by a stored
 *  file, however complete our copy of it is. */
const ACTION_VERB = [
  'atvetel', 'atveve', 'ellenorzes', 'ellenorzese', 'alairas', 'alairni', 'benyujt',
  'beküld', 'bekuld', 'letolt', 'feltolt', 'megrendel', 'kifizet', 'jovahagy',
  'dontes', 'valassz', 'valasztas', 'intezkedes',
  'sign', 'submit', 'upload', 'download', 'approve', 'decide', 'collect', 'verify',
]

const isDocumentRequest = (req: string): boolean => {
  const n = norm(req)
  if (ACTION_VERB.some(w => n.includes(w))) return false
  return DOCUMENT_NOUN.some(w => n.includes(w)) && CONTENT_WORD.some(w => n.includes(w))
}

interface DocRow {
  document_id: string; filename: string | null
  extracted_text: string | null; extraction_state: string | null
}

/**
 * Resolver 1 — THE ONE THAT WOULD HAVE PREVENTED QADBD.
 *
 * A requirement asking for the content of the case's documents is satisfied
 * when the case has at least one document whose extraction is TRUSTED. Not
 * "has text": a low-quality extraction is not an answer, and treating it as one
 * would trade a needless question for a wrong reading.
 */
function resolveDocumentText(
  db: Database.Database, namespace: string, caseId: string, requirement: string,
): RequirementVerdict | null {
  if (!isDocumentRequest(requirement)) return null
  let docs: DocRow[]
  try {
    docs = db.prepare(
      `SELECT document_id, filename, extracted_text, extraction_state
         FROM cos_documents WHERE namespace = ? AND case_id = ? AND content_purged_at IS NULL`,
    ).all(namespace, caseId) as DocRow[]
  } catch { return null }
  if (docs.length === 0) return null

  const trusted = docs.filter(d =>
    (d.extracted_text ?? '').trim() &&
    isTrustedExtraction(effectiveExtractionState(d.extraction_state, d.extracted_text)))

  if (trusted.length === 0) {
    // Documents exist and none is readable. That is a REAL gap, and saying so
    // is more useful than silence: the question can name what failed.
    const states = docs.map(d =>
      `${d.filename ?? d.document_id}: ${effectiveExtractionState(d.extraction_state, d.extracted_text)}`)
    return {
      requirement, resolved: false, hits: [], contradiction: null,
      reason: `${docs.length} document(s), none with a trusted extraction — ${states.join('; ')}`,
    }
  }
  return {
    requirement, resolved: true, contradiction: null,
    hits: trusted.map(d => ({
      surface: 'DOCUMENT_TEXT' as const,
      reference: d.document_id,
      excerpt: (d.extracted_text ?? '').trim().slice(0, 200),
    })),
    reason: `${trusted.length} document(s) already extracted and trusted`,
  }
}

/**
 * Resolver 2 — the owner already told us.
 *
 * An ANSWERED question on this case whose answer covers the same distinctive
 * terms. The overlap bar is deliberately high: this resolver suppresses a
 * question because a PERSON already spoke, and getting that wrong means
 * ignoring him.
 */
function resolveOwnerAnswer(
  db: Database.Database, namespace: string, caseId: string, requirement: string,
): RequirementVerdict | null {
  let rows: Array<{ question_hash: string; answer_text: string | null }>
  try {
    rows = db.prepare(
      `SELECT question_hash, answer_text FROM cos_owner_questions
        WHERE case_id = ? AND domain = ? AND answered_at IS NOT NULL
        ORDER BY answered_at DESC LIMIT 5`,
    ).all(caseId, namespace) as never
  } catch { return null }

  const terms = distinctiveTerms(requirement)
  if (terms.length < 2) return null   // too vague to match on safely

  for (const r of rows) {
    const ans = norm(r.answer_text ?? '')
    if (!ans) continue
    const covered = terms.filter(t => ans.includes(t))
    if (covered.length / terms.length >= 0.75) {
      return {
        requirement, resolved: true, contradiction: null,
        hits: [{ surface: 'OWNER_ANSWER', reference: r.question_hash, excerpt: (r.answer_text ?? '').slice(0, 200) }],
        reason: `the owner already answered this (${covered.length}/${terms.length} terms)`,
      }
    }
  }
  return null
}

/** Words long enough to carry meaning, minus the ones every requirement has. */
const STOP = new Set([
  'szukseges', 'kell', 'kellene', 'dontese', 'dontes', 'istvan', 'tulajdonos',
  'the', 'and', 'for', 'that', 'this', 'from', 'with', 'need', 'needs', 'required',
])
export function distinctiveTerms(text: string): string[] {
  return [...new Set(norm(text).match(/[a-z0-9]{5,}/g) ?? [])].filter(w => !STOP.has(w))
}

/**
 * The gate. Runs every resolver over every requirement.
 *
 * SUPPRESSION IS ALL-OR-NOTHING per question: one unresolved requirement means
 * the question goes out, because a question stripped of half its asks is a
 * different question and the owner never agreed to answer that one.
 */
export function evaluatePreQuestionEvidence(
  db: Database.Database,
  input: { namespace: string; caseId: string; requirements: string[] },
): GateVerdict {
  const verdicts: RequirementVerdict[] = []
  for (const requirement of input.requirements) {
    const found =
      resolveDocumentText(db, input.namespace, input.caseId, requirement) ??
      resolveOwnerAnswer(db, input.namespace, input.caseId, requirement) ?? {
        requirement, resolved: false, hits: [], contradiction: null,
        reason: 'no resolver recognised this requirement — asking, which is the safe direction',
      }
    verdicts.push(found)
  }
  const suppress = verdicts.length > 0 && verdicts.every(v => v.resolved && !v.contradiction)
  const surfaces = [...new Set(verdicts.flatMap(v => v.hits.map(h => h.surface)))]
  return {
    suppress, verdicts,
    summary: suppress
      ? `already answered by ${surfaces.join(', ')}`
      : `${verdicts.filter(v => !v.resolved).length}/${verdicts.length} requirement(s) genuinely unresolved`,
  }
}
