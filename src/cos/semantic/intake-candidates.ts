// THE PRODUCTION CALLER, and the reason it exists at all.
//
// Owner ruling 2026-09-04, closing Priority 1: "A semantic candidate élő
// producer/wiring a Priority 1 része. Nem új scope." Before this file the layer
// was reachable only from two replay scripts run by hand -- built, measured
// against the live store, and wired to nothing. The candidate table held zero
// rows, and the readback of the 58b88f13 release said so rather than passing:
// the canonical graph was unchanged because NOTHING WROTE CANDIDATES AT ALL,
// which is not the same statement as "the layer is safe".
//
// WHERE IT SITS. After deterministic resolution, never instead of it. Intake
// tries, in order: a message it has already seen, a reply relation that names
// its parent, a thread a case already owns. Each of those is a stored fact and
// produces a CANONICAL link. Only when all three have failed -- when intake is
// about to open a standalone case with no canonical parent -- is there anything
// for a proposal to be about.
//
//   deterministic relation first
//   no unambiguous deterministic answer  -> SOURCE_CASE_CANDIDATE
//   a new standalone case, no canonical parent -> CASE_PARENT_CANDIDATE
//
// WHAT IT MAY NOT DO, and these are the owner's words: no canonical graph edge,
// no automatic parent assignment, no case merge, no namespace migration, no
// external action. This module therefore writes to exactly one table. It does
// not import `case-sources`, `case-store` or `zst-case-store`, and a test
// asserts that it never starts to.
//
// CROSS-MAILBOX IS NOT CROSS-NAMESPACE, and the distinction is what makes the
// acceptance case work. The Neon billing threads arrive on the ZST account
// while the dossier that wants them lives in the personal store. Which account
// carried a message is EVIDENCE about the message; which store a case lives in
// is AUTHORITY over it. So a source is offered into a namespace and carries its
// mailbox alongside -- `scorePair` refuses a namespace mismatch outright, and
// that refusal stays untouched.
//
// BOUNDED BY CONSTRUCTION. A caller on the intake path runs on every message
// that opens a case, so an unbounded scan here would be a per-message full
// table scan of the case store. Targets are capped and ordered by recency, and
// the cap is a constant in this file rather than a parameter a caller can widen.

import type Database from 'better-sqlite3'
import {
  parentCandidates, sourceCaseCandidates, type CandidateInput,
} from './relation-candidates.js'
import { recordCandidates, type SourceKind } from './candidate-store.js'

/** How many cases, per namespace, a single intake may be scored against.
 *
 *  Ordered by most recently updated, because a proposal is about what is live.
 *  The number is a budget, not a belief about relevance: it bounds the work one
 *  arriving email can cause, which is the property the intake path needs. */
export const MAX_TARGETS_PER_NAMESPACE = 300

/** Proposals kept per relation type, per namespace. Three is what the replay
 *  measured against, and a list an owner can actually read. */
export const CANDIDATES_PER_RELATION = 3

export interface IntakeCandidateSource {
  /** What the proposal is ABOUT: the thread if we have one, else the message. */
  sourceRef: string
  sourceKind: SourceKind
  /** The account it arrived on. Evidence, never a boundary. */
  mailbox: string
  /** Everything the message says about itself. */
  text: string
  /** Day number (epoch days) the message arrived. */
  arrivedAtDay: number
  /** The case intake just opened, when it opened one. Absent means there is no
   *  new case, so there is no parent question to ask -- only a source one. */
  newCase?: { caseId: string; namespace: 'personal' | 'zst' }
}

export interface IntakeCandidateResult {
  /** Rows written or refreshed, by relation type. */
  sourceCandidates: number
  parentCandidates: number
  /** Which stores were scored against, so a zero is legible: no proposal
   *  because nothing matched, or because no store was searched. */
  namespacesEvaluated: string[]
  targetsConsidered: number
  /** Set when the evaluation could not run. NEVER thrown into intake: a
   *  proposal layer that can abort an intake is a proposal layer that can lose
   *  an email, and the canonical routes above have already done their work by
   *  the time this runs. The field exists so the failure is still visible --
   *  a swallowed error that reports "no candidates" is indistinguishable from a
   *  clean run that found none. */
  error?: string
}

interface CaseRow {
  case_id: string
  title: string
  description: string | null
  next_action: string | null
  created_at: number
}

const caseText = (r: CaseRow): string =>
  [r.title, r.description ?? '', r.next_action ?? ''].join('\n')

/** The mailbox a case's own id implies, when it implies one. Evidence only:
 *  it decorates a proposal as cross-mailbox and decides nothing. */
function mailboxOfCase(caseId: string): string | undefined {
  if (caseId.startsWith('case-private-')) return 'private'
  if (caseId.startsWith('case-zst-') || caseId.startsWith('zst-zst-')) return 'zst'
  return undefined
}

function loadTargets(
  db: Database.Database, namespace: 'personal' | 'zst',
): CandidateInput[] {
  const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases'
  let rows: CaseRow[]
  try {
    rows = db.prepare(
      `SELECT case_id, title, description, next_action, created_at
         FROM ${table}
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ${MAX_TARGETS_PER_NAMESPACE}`,
    ).all() as CaseRow[]
  } catch (e) {
    // A store without the other namespace's table is a real condition (a fresh
    // personal-only database), and it is not an error. Anything else is.
    if (!/no such table|no such column/i.test(e instanceof Error ? e.message : String(e))) throw e
    return []
  }
  return rows.map((r) => ({
    id: r.case_id,
    namespace,
    ...(mailboxOfCase(r.case_id) ? { mailbox: mailboxOfCase(r.case_id)! } : {}),
    text: caseText(r),
    createdAtDay: Math.floor(r.created_at / 86_400),
  }))
}

/**
 * Propose, for one arriving message, which existing case it might belong to and
 * which case might be its parent.
 *
 * Returns counts rather than the proposals themselves: the caller is an intake
 * path whose job is to file an email, and reading the proposals is the board's
 * job. Everything written here is queryable from `semantic_relation_candidates`.
 *
 * IDEMPOTENT at two levels, and both are needed. `recordCandidates` upserts on
 * (type, namespace, source, target, algorithm), so re-running the same engine
 * over the same data refreshes rows in place rather than accumulating -- that is
 * what stops a per-cycle caller growing the table without bound. And intake
 * itself never reaches this point twice for one message: a seen message returns
 * ALREADY_PROCESSED long before here.
 */
export function evaluateIntakeCandidates(
  db: Database.Database,
  source: IntakeCandidateSource,
  now: number,
): IntakeCandidateResult {
  const result: IntakeCandidateResult = {
    sourceCandidates: 0, parentCandidates: 0,
    namespacesEvaluated: [], targetsConsidered: 0,
  }
  try {
    const perNamespace: Array<{ ns: 'personal' | 'zst'; targets: CandidateInput[] }> =
      (['personal', 'zst'] as const)
        .map((ns) => ({ ns, targets: loadTargets(db, ns) }))
        .filter((x) => x.targets.length > 0)

    // The corpus spans BOTH stores on purpose. Document frequency is a
    // statement about how ordinary a word is, and "invoice" is not rarer in the
    // personal store because the company store also uses it. Scoring stays
    // per-namespace; only the sense of what counts as a rare term is shared.
    const corpus = perNamespace.flatMap((x) => x.targets.map((t) => t.text))

    for (const { ns, targets } of perNamespace) {
      result.namespacesEvaluated.push(ns)
      result.targetsConsidered += targets.length

      // THE SOURCE QUESTION: does this conversation belong to a case we have?
      // Declared in the namespace being searched, carrying the mailbox it
      // actually arrived on -- that pairing is the cross-mailbox case.
      const asSource: CandidateInput = {
        id: source.sourceRef,
        namespace: ns,
        mailbox: source.mailbox,
        text: source.text,
        createdAtDay: source.arrivedAtDay,
      }
      // THE CASE THIS SOURCE JUST OPENED IS NOT A PROPOSAL. The thread already
      // belongs to it canonically -- that link was written moments ago -- so a
      // candidate row saying it might is noise at best, and at worst a reader
      // seeing a proposal for a relation that already exists.
      //
      // NOT redundant with `scorePair`'s SELF refusal, which compares ids: here
      // the source is a THREAD and the target is a CASE, so those ids differ
      // and that guard never fires. Found in the production rehearsal, where
      // the freshly created case came back as its own thread's best match.
      const sourceProposals = sourceCaseCandidates(
        asSource,
        targets.filter((t) => t.id !== source.newCase?.caseId),
        corpus, CANDIDATES_PER_RELATION,
      )
      if (sourceProposals.length) {
        result.sourceCandidates += recordCandidates(db, sourceProposals, {
          sourceKind: source.sourceKind,
          provenance: `cos-intake:semantic-source:${source.mailbox}`,
        }, now)
      }

      // THE PARENT QUESTION, asked only when intake actually opened a case and
      // only in that case's OWN store. A parent is a canonical relation between
      // two cases in one authority; proposing one across stores would be
      // proposing the namespace migration this layer may not perform.
      if (source.newCase && source.newCase.namespace === ns) {
        const asChild: CandidateInput = {
          id: source.newCase.caseId,
          namespace: ns,
          mailbox: source.mailbox,
          text: source.text,
          createdAtDay: source.arrivedAtDay,
        }
        // NO SELF-FILTER HERE. `scorePair` already refuses a case as its own
        // parent, and an earlier cut of this line filtered the target list as
        // well -- so a mutation could delete either guard and the other kept
        // the test green, which means neither was proven. One definition.
        const parentProposals = parentCandidates(
          asChild, targets, corpus, CANDIDATES_PER_RELATION,
        )
        if (parentProposals.length) {
          result.parentCandidates += recordCandidates(db, parentProposals, {
            sourceKind: 'CASE',
            provenance: `cos-intake:semantic-parent:${source.mailbox}`,
          }, now)
        }
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }
  return result
}
