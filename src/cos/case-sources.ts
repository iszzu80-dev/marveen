// THE CASE DOSSIER -- write and read side.
//
// See initCaseSourceSchema() in schema.ts for why this exists instead of a
// wider `gmail_thread_ids` column. This file holds the part a schema cannot
// state: WHICH claims are allowed to become canonical.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export type CaseNamespace = 'personal' | 'zst'

export type CaseSourceType =
  | 'GMAIL_THREAD' | 'GMAIL_MESSAGE' | 'DOCUMENT' | 'CALENDAR_EVENT'
  | 'OWNER_ASSERTION' | 'DECISION' | 'RESEARCH_RESULT' | 'EXTERNAL_URL'
  | 'STRUCTURED_EXTRACTION' | 'CASE'

export type LinkMethod =
  | 'EXPLICIT_RELATION' | 'MESSAGE_REFERENCE' | 'DETERMINISTIC_IDENTIFIER'
  | 'SEMANTIC_CANDIDATE' | 'OWNER_CONFIRMED'

export type LinkState = 'CANONICAL' | 'CANDIDATE' | 'REJECTED'

/** Whether the thing on the other end can still be fetched.
 *
 *  A SEPARATE AXIS FROM `LinkState`, and the separation is the point. The state
 *  says whether the case IS about this source; this says whether the source can
 *  still be read. A deleted thread does not stop being what the case was about,
 *  so marking it REJECTED would be a lie about the relation in order to record a
 *  fact about the content.
 *
 *  Found 2026-09-04: three threads had been abandoned after three 404s each,
 *  and their links still read as ordinary healthy CANONICAL rows. The dossier
 *  said the case was about eleven conversations; one of them could no longer be
 *  opened, and nothing anywhere said so. */
export type ContentState = 'AVAILABLE' | 'CONTENT_UNAVAILABLE'

/** The methods that may put a link straight into CANONICAL.
 *
 *  Each one is a FACT already recorded somewhere else: a stored relation, a
 *  reply/reference relation between messages, or an identifier that matched
 *  exactly. SEMANTIC_CANDIDATE is deliberately absent -- "these two read like
 *  the same matter" is the one judgement in this list that can be wrong while
 *  looking right, and the owner's ruling was that it must never canonicalise
 *  itself. OWNER_CONFIRMED is canonical because a person decided. */
const DETERMINISTIC: ReadonlySet<LinkMethod> = new Set<LinkMethod>([
  'EXPLICIT_RELATION', 'MESSAGE_REFERENCE', 'DETERMINISTIC_IDENTIFIER', 'OWNER_CONFIRMED',
])

export interface CaseSourceLink {
  /** Whether the source can still be fetched. Defaults to AVAILABLE; only a
   *  fetch that came back gone may set it otherwise. */
  contentState: ContentState
  /** When the source was last found missing. Null while AVAILABLE. */
  contentCheckedAt: number | null
  /** What said it was gone, in words a human can check. */
  contentNote: string | null
  linkId: string
  namespace: CaseNamespace
  caseId: string
  sourceType: CaseSourceType
  sourceRef: string
  linkState: LinkState
  linkMethod: LinkMethod
  confidence: number | null
  evidence: string
  discoveredBy: string
  firstSeenAt: number
  updatedAt: number
  decidedAt: number | null
  decidedBy: string | null
  decisionNote: string | null
}

export interface LinkCaseSourceInput {
  namespace: CaseNamespace
  caseId: string
  sourceType: CaseSourceType
  sourceRef: string
  linkMethod: LinkMethod
  /** Why this claim exists, checkable by a human. Required, non-empty. */
  evidence: string
  discoveredBy: string
  confidence?: number
}

export interface LinkCaseSourceResult {
  linkId: string
  state: LinkState
  /** What the call actually DID, so a backfill reports real numbers rather
   *  than counting attempts. */
  outcome: 'CREATED' | 'UNCHANGED' | 'UPGRADED' | 'HELD_BY_REJECTION'
}

/** Deterministic id, so the same discovery run twice produces the same row and
 *  a backfill is safe to re-run. */
export function caseSourceLinkId(
  namespace: string, caseId: string, sourceType: string, sourceRef: string,
): string {
  return 'csl-' + createHash('sha256')
    .update([namespace, caseId, sourceType, sourceRef].join(' '))
    .digest('hex').slice(0, 24)
}

interface Row {
  link_id: string; namespace: string; case_id: string; source_type: string
  source_ref: string; link_state: string; link_method: string
  confidence: number | null; evidence: string; discovered_by: string
  first_seen_at: number; updated_at: number
  decided_at: number | null; decided_by: string | null; decision_note: string | null
  /* Optional in the type because a store created before these columns existed
     still returns rows without them; `toLink` supplies the default. */
  content_state?: string | null
  content_checked_at?: number | null
  content_note?: string | null
}

const toLink = (r: Row): CaseSourceLink => ({
  linkId: r.link_id, namespace: r.namespace as CaseNamespace, caseId: r.case_id,
  sourceType: r.source_type as CaseSourceType, sourceRef: r.source_ref,
  linkState: r.link_state as LinkState, linkMethod: r.link_method as LinkMethod,
  confidence: r.confidence, evidence: r.evidence, discoveredBy: r.discovered_by,
  firstSeenAt: r.first_seen_at, updatedAt: r.updated_at,
  decidedAt: r.decided_at, decidedBy: r.decided_by, decisionNote: r.decision_note,
  // A store predating the column reads as AVAILABLE rather than undefined: the
  // absence of a "this is gone" record is exactly the claim that it is not.
  contentState: (r.content_state as ContentState | null) ?? 'AVAILABLE',
  contentCheckedAt: r.content_checked_at ?? null,
  contentNote: r.content_note ?? null,
})

/**
 * Record that a source can no longer be fetched — WITHOUT touching the relation.
 *
 * The link stays exactly as it was: same state, same method, same evidence. All
 * that changes is the answer to "can this still be read", because those are two
 * different questions and a vanished thread does not stop being what the case
 * was about.
 *
 * Requires a note. A source marked gone with no statement of what said so is the
 * same shape the `evidence` requirement exists to prevent one level up: a
 * durable claim nobody can check.
 *
 * Idempotent, and deliberately does not re-stamp `content_checked_at` on a
 * repeat: the interesting timestamp is when it was FIRST found missing, not
 * when the latest sweep confirmed it again.
 */
export function markSourceContentUnavailable(
  db: Database.Database,
  input: { namespace: CaseNamespace; caseId: string; sourceType: CaseSourceType; sourceRef: string; note: string },
  now: number,
): { linkId: string; changed: boolean } {
  const note = input.note?.trim()
  if (!note) {
    throw new Error(
      `markSourceContentUnavailable: note is required (${input.caseId} -> ${input.sourceType}:${input.sourceRef})`)
  }
  const linkId = caseSourceLinkId(input.namespace, input.caseId, input.sourceType, input.sourceRef)
  const existing = db.prepare(`SELECT content_state FROM case_sources WHERE link_id = ?`).get(linkId) as
    { content_state: string | null } | undefined
  if (!existing) return { linkId, changed: false }
  if (existing.content_state === 'CONTENT_UNAVAILABLE') return { linkId, changed: false }
  db.prepare(
    `UPDATE case_sources SET content_state='CONTENT_UNAVAILABLE', content_checked_at=@now,
       content_note=@note, updated_at=@now WHERE link_id=@id`,
  ).run({ id: linkId, now, note })
  return { linkId, changed: true }
}

/** The source can be read again — a mailbox restore, a re-share, a fixed token.
 *  Clears the note as well: a stale "gone since March" on a living source is
 *  worse than no note at all. */
export function markSourceContentAvailable(
  db: Database.Database,
  input: { namespace: CaseNamespace; caseId: string; sourceType: CaseSourceType; sourceRef: string },
  now: number,
): { linkId: string; changed: boolean } {
  const linkId = caseSourceLinkId(input.namespace, input.caseId, input.sourceType, input.sourceRef)
  const existing = db.prepare(`SELECT content_state FROM case_sources WHERE link_id = ?`).get(linkId) as
    { content_state: string | null } | undefined
  if (!existing || (existing.content_state ?? 'AVAILABLE') === 'AVAILABLE') return { linkId, changed: false }
  db.prepare(
    `UPDATE case_sources SET content_state='AVAILABLE', content_checked_at=@now,
       content_note=NULL, updated_at=@now WHERE link_id=@id`,
  ).run({ id: linkId, now })
  return { linkId, changed: true }
}

/**
 * Record one claim that a source belongs to a case.
 *
 * The state is DERIVED from the method and never taken from the caller. That is
 * the enforcement point: a discovery pass cannot pass `state: 'CANONICAL'`
 * alongside a semantic guess, because there is no such parameter.
 *
 * Re-running is safe and is the normal case. What a second call does:
 *   - same or weaker method    -> UNCHANGED (the evidence line is refreshed)
 *   - a candidate, now proven  -> UPGRADED to CANONICAL, method replaced
 *   - a REJECTED row + a guess -> HELD_BY_REJECTION, nothing changes
 *   - a REJECTED row + a fact  -> UPGRADED, and the note says it overrode a
 *     rejection, because a decision overturned by evidence is exactly the
 *     event a person needs to see rather than have quietly applied.
 */
export function linkCaseSource(
  db: Database.Database, input: LinkCaseSourceInput, now: number,
): LinkCaseSourceResult {
  const evidence = input.evidence?.trim()
  if (!evidence) {
    // A link with no evidence is a link nobody can check, which is the shape
    // this whole table exists to replace.
    throw new Error(
      `linkCaseSource: evidence is required (${input.caseId} -> ${input.sourceType}:${input.sourceRef})`)
  }
  if (!input.sourceRef?.trim()) {
    throw new Error(`linkCaseSource: sourceRef is required (${input.caseId} ${input.sourceType})`)
  }
  const deterministic = DETERMINISTIC.has(input.linkMethod)
  const state: LinkState = deterministic ? 'CANONICAL' : 'CANDIDATE'
  const linkId = caseSourceLinkId(input.namespace, input.caseId, input.sourceType, input.sourceRef)
  const existing = db.prepare(`SELECT * FROM case_sources WHERE link_id = ?`).get(linkId) as Row | undefined

  if (!existing) {
    db.prepare(
      `INSERT INTO case_sources
        (link_id, namespace, case_id, source_type, source_ref, link_state, link_method,
         confidence, evidence, discovered_by, first_seen_at, updated_at)
       VALUES (@link_id, @namespace, @case_id, @source_type, @source_ref, @link_state, @link_method,
         @confidence, @evidence, @discovered_by, @now, @now)`,
    ).run({
      link_id: linkId, namespace: input.namespace, case_id: input.caseId,
      source_type: input.sourceType, source_ref: input.sourceRef,
      link_state: state, link_method: input.linkMethod,
      confidence: input.confidence ?? (deterministic ? 1 : null),
      evidence, discovered_by: input.discoveredBy, now,
    })
    return { linkId, state, outcome: 'CREATED' }
  }

  if (existing.link_state === 'REJECTED') {
    if (!deterministic) return { linkId, state: 'REJECTED', outcome: 'HELD_BY_REJECTION' }
    db.prepare(
      `UPDATE case_sources SET link_state='CANONICAL', link_method=@m, confidence=@c,
         evidence=@e, discovered_by=@by, updated_at=@now,
         decision_note = COALESCE(decision_note, '') || @note
       WHERE link_id=@id`,
    ).run({
      id: linkId, m: input.linkMethod, c: input.confidence ?? 1, e: evidence,
      by: input.discoveredBy, now,
      note: ` [${new Date(now * 1000).toISOString()}] overrode an earlier REJECTED decision: ` +
        `${input.linkMethod} evidence arrived`,
    })
    return { linkId, state: 'CANONICAL', outcome: 'UPGRADED' }
  }

  if (existing.link_state === 'CANDIDATE' && deterministic) {
    db.prepare(
      `UPDATE case_sources SET link_state='CANONICAL', link_method=@m, confidence=@c,
         evidence=@e, discovered_by=@by, updated_at=@now WHERE link_id=@id`,
    ).run({ id: linkId, m: input.linkMethod, c: input.confidence ?? 1, e: evidence, by: input.discoveredBy, now })
    return { linkId, state: 'CANONICAL', outcome: 'UPGRADED' }
  }

  // Same standing, refreshed. `first_seen_at` is deliberately NOT touched: it
  // dates the link, not the last time a pass happened to look at it.
  db.prepare(`UPDATE case_sources SET evidence=@e, updated_at=@now WHERE link_id=@id`)
    .run({ id: linkId, e: evidence, now })
  return { linkId, state: existing.link_state as LinkState, outcome: 'UNCHANGED' }
}

/** Promote a candidate after review. `decidedBy` is required and stored: a
 *  promotion with no author is indistinguishable from an automatic one, which
 *  is the thing the CANDIDATE state exists to prevent. */
export function promoteCaseSource(
  db: Database.Database, linkId: string, decidedBy: string, now: number, note?: string,
): CaseSourceLink {
  if (!decidedBy?.trim()) throw new Error('promoteCaseSource: decidedBy is required')
  const info = db.prepare(
    `UPDATE case_sources
        SET link_state='CANONICAL', link_method='OWNER_CONFIRMED', confidence=1,
            decided_at=@now, decided_by=@by, decision_note=@note, updated_at=@now
      WHERE link_id=@id AND link_state='CANDIDATE'`,
  ).run({ id: linkId, by: decidedBy, note: note ?? null, now })
  if (info.changes === 0) throw new Error(`promoteCaseSource: no CANDIDATE link ${linkId}`)
  return getCaseSourceLink(db, linkId)!
}

/** Turn a candidate down. Kept as a row so the same guess is not re-proposed
 *  on every run, and so a false-link rate has a denominator. */
export function rejectCaseSource(
  db: Database.Database, linkId: string, decidedBy: string, now: number, note?: string,
): CaseSourceLink {
  if (!decidedBy?.trim()) throw new Error('rejectCaseSource: decidedBy is required')
  const info = db.prepare(
    `UPDATE case_sources
        SET link_state='REJECTED', decided_at=@now, decided_by=@by,
            decision_note=@note, updated_at=@now
      WHERE link_id=@id AND link_state IN ('CANDIDATE','CANONICAL')`,
  ).run({ id: linkId, by: decidedBy, note: note ?? null, now })
  if (info.changes === 0) throw new Error(`rejectCaseSource: no live link ${linkId}`)
  return getCaseSourceLink(db, linkId)!
}

export function getCaseSourceLink(db: Database.Database, linkId: string): CaseSourceLink | undefined {
  const r = db.prepare(`SELECT * FROM case_sources WHERE link_id = ?`).get(linkId) as Row | undefined
  return r ? toLink(r) : undefined
}

export interface CaseDossier {
  namespace: CaseNamespace
  caseId: string
  /** Established links, safe for a consumer to act on. */
  canonical: CaseSourceLink[]
  /** Proposed and undecided. Returned SEPARATELY and never merged into
   *  `canonical`: a consumer that wants to act on a guess has to say so. */
  candidates: CaseSourceLink[]
  /** Turned down. Present so a reviewer can see what was already answered. */
  rejected: CaseSourceLink[]
  /** Canonical only, grouped -- the shape a dossier reader actually wants. */
  byType: Record<CaseSourceType, string[]>
  /** Canonical links whose source can no longer be fetched.
   *
   *  A SEPARATE LIST, not a filter applied to the others. These are still the
   *  case's sources and still appear in `canonical` and `byType`, because the
   *  relation is intact; what this list adds is the one thing a reader could
   *  not otherwise learn — that opening them will fail. Hiding them would swap
   *  a visible gap for an invisible one, which is the trade this whole field
   *  exists to refuse. */
  unavailable: CaseSourceLink[]
}

const EMPTY_BY_TYPE = (): Record<CaseSourceType, string[]> => ({
  GMAIL_THREAD: [], GMAIL_MESSAGE: [], DOCUMENT: [], CALENDAR_EVENT: [],
  OWNER_ASSERTION: [], DECISION: [], RESEARCH_RESULT: [], EXTERNAL_URL: [],
  STRUCTURED_EXTRACTION: [], CASE: [],
})

/** Everything one case is made of, in one read. */
export function getCaseDossier(
  db: Database.Database, namespace: CaseNamespace, caseId: string,
): CaseDossier {
  const rows = db.prepare(
    `SELECT * FROM case_sources WHERE namespace=? AND case_id=?
      ORDER BY source_type, first_seen_at`,
  ).all(namespace, caseId) as Row[]
  const links = rows.map(toLink)
  const byType = EMPTY_BY_TYPE()
  for (const l of links) if (l.linkState === 'CANONICAL') byType[l.sourceType].push(l.sourceRef)
  return {
    namespace, caseId,
    canonical: links.filter((l) => l.linkState === 'CANONICAL'),
    candidates: links.filter((l) => l.linkState === 'CANDIDATE'),
    rejected: links.filter((l) => l.linkState === 'REJECTED'),
    byType,
    unavailable: links.filter((l) => l.linkState === 'CANONICAL' && l.contentState === 'CONTENT_UNAVAILABLE'),
  }
}

/** THE REVERSE DIRECTION: which cases claim this source.
 *
 *  Returns canonical claims by default. A thread with more than one canonical
 *  case is NOT an error here -- it is the situation the single-column model
 *  could not express, and the caller is the one that has to decide what to do
 *  about it. */
export function findCasesForSource(
  db: Database.Database, namespace: CaseNamespace,
  sourceType: CaseSourceType, sourceRef: string,
  opts: { includeCandidates?: boolean } = {},
): CaseSourceLink[] {
  const states = opts.includeCandidates ? ['CANONICAL', 'CANDIDATE'] : ['CANONICAL']
  const rows = db.prepare(
    `SELECT * FROM case_sources
      WHERE namespace=? AND source_type=? AND source_ref=?
        AND link_state IN (${states.map(() => '?').join(',')})
      ORDER BY link_state, first_seen_at`,
  ).all(namespace, sourceType, sourceRef, ...states) as Row[]
  return rows.map(toLink)
}

/** Every thread this case is about, canonical only. The multi-thread answer
 *  the `$[0]` readers could not give. */
export function threadsForCase(
  db: Database.Database, namespace: CaseNamespace, caseId: string,
): string[] {
  return (db.prepare(
    `SELECT source_ref FROM case_sources
      WHERE namespace=? AND case_id=? AND source_type='GMAIL_THREAD' AND link_state='CANONICAL'
      ORDER BY first_seen_at`,
  ).all(namespace, caseId) as { source_ref: string }[]).map((r) => r.source_ref)
}

export interface CaseThreadSet {
  /** Every thread the case is about: the graph's canonical links, plus any
   *  legacy column entry the graph has not caught up with. Deduped, ordered
   *  graph-first. THIS is what a consumer should iterate. */
  threadIds: string[]
  /** From the graph. */
  fromGraph: string[]
  /** In the legacy `gmail_thread_ids` column and NOT in the graph. Non-empty
   *  means something wrote the column without writing a link -- worth knowing,
   *  and worth counting, rather than silently absorbing. */
  legacyOnly: string[]
}

/**
 * THE THREAD SET A CONSUMER MUST USE, replacing `json_extract(...,'$[0]')`.
 *
 * The graph is the read source of truth. The legacy column is still unioned in
 * so that a case created by a writer that has not been migrated yet cannot
 * silently lose its thread -- but it is reported separately, so "the graph is
 * behind" stays visible instead of being papered over.
 */
export function caseThreadIds(
  db: Database.Database, namespace: CaseNamespace, caseId: string,
): CaseThreadSet {
  const fromGraph = threadsForCase(db, namespace, caseId)
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  let legacy: string[] = []
  try {
    const row = db.prepare(`SELECT gmail_thread_ids FROM ${table} WHERE case_id = ?`)
      .get(caseId) as { gmail_thread_ids: string | null } | undefined
    if (row?.gmail_thread_ids) {
      const parsed = JSON.parse(row.gmail_thread_ids)
      legacy = Array.isArray(parsed) ? parsed.map(String) : []
    }
  } catch {
    // A malformed legacy column is not a reason to lose the graph's answer.
    legacy = []
  }
  const legacyOnly = legacy.filter((t) => !fromGraph.includes(t))
  return { threadIds: [...fromGraph, ...legacyOnly], fromGraph, legacyOnly }
}
