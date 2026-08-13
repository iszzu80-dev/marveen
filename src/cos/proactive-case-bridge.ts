// §8 / §14 / §26(11, 12, 19): the bridge between the Proactive Core and the
// existing Case store.
//
// WHY THIS FILE IS NOT IN `src/cos/proactive/`. The release-boundary standing
// check forbids that directory from importing the case store at all — which is
// how §4.1's "a signal coming into existence must not create a Case" is enforced
// rather than promised. The bridge needs both sides, so it lives on THIS side of
// the line: the Proactive Core still cannot reach a Case, and something outside
// it decides when a Case is reached on its behalf.
//
// That is not a workaround. It is the shape the rule asks for: the module that
// detects has no authority to act, and the module with authority does not
// detect.
//
// §8'S ORDERING IS THE POINT: existing Case first, new Case last.
//
//     signal → active Case exact match → active Case semantic/subject match
//            → recently completed Case re-open eligibility → only then a new Case
//
// A proactive layer that opens a Case per signal produces a board nobody can
// read within a week, and every one of those Cases looks like work. §8.2's
// `reused_existing_case_rate` exists to measure exactly this, so it is computed
// here rather than estimated later.

import type Database from 'better-sqlite3'
import { createCase } from './case-store.js'
import { createZstCase } from './zst-case-store.js'
import { foldName } from './reader.js'
import type {
  InitiativeQualificationResult, ProactiveDomain, ProactiveSignal,
} from './proactive/types.js'

// ── §8 Case matching and promotion ──────────────────────────────────────

export type MatchTier =
  | 'ACTIVE_EXACT'
  | 'ACTIVE_SUBJECT'
  | 'RECENTLY_COMPLETED_REOPEN'
  | 'NEW_CASE_JUSTIFIED'
  | 'NO_CASE'

export interface CaseMatch {
  tier: MatchTier
  caseId?: string
  reason: string
}

/** How recently a completed case may be re-opened rather than duplicated. A case
 *  closed last week and a case closed last year are different propositions:
 *  re-opening the first continues a conversation, re-opening the second
 *  resurrects one. */
export const REOPEN_WINDOW_SEC = 30 * 86400

interface CaseRow { case_id: string; title: string; status: string; completed_at: number | null }

function casesFor(db: Database.Database, domain: ProactiveDomain): { active: CaseRow[]; recent: CaseRow[] } {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const active = db.prepare(
      `SELECT case_id, title, status, completed_at FROM ${table}
        WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')`,
    ).all() as CaseRow[]
    const recent = db.prepare(
      `SELECT case_id, title, status, completed_at FROM ${table}
        WHERE archived_at IS NULL AND status = 'COMPLETED' AND completed_at IS NOT NULL`,
    ).all() as CaseRow[]
    return { active, recent }
  } catch { return { active: [], recent: [] } }
}

/**
 * §8: walk the tiers in order and stop at the first hit.
 *
 * The subject tier folds accents before comparing. That is not a nicety in this
 * codebase — `foldName` exists because the model writes "István" with the accent
 * roughly as often as without, and an exact comparison sorted the same case into
 * two different buckets depending on which spelling arrived. A title match has
 * the same exposure.
 */
export function matchCase(
  db: Database.Database,
  signal: ProactiveSignal,
  now: number,
): CaseMatch {
  const { active, recent } = casesFor(db, signal.domain)

  // Tier 1: the signal already names a Case, and that Case is alive.
  if (signal.candidateCaseId) {
    const hit = active.find(c => c.case_id === signal.candidateCaseId)
    if (hit) return { tier: 'ACTIVE_EXACT', caseId: hit.case_id, reason: 'a jel megnevezte, és az ügy él' }
  }

  // Tier 2: subject match against an active case's title.
  if (signal.subjectRef) {
    const subject = foldName(signal.subjectRef)
    const hit = active.find(c => foldName(c.title) === subject)
    if (hit) return { tier: 'ACTIVE_SUBJECT', caseId: hit.case_id, reason: 'a tárgy megegyezik egy élő ügy címével' }
  }

  // Tier 3: a recently completed case about the same subject. Re-opening beats
  // opening a second one — the history is the point.
  if (signal.subjectRef) {
    const subject = foldName(signal.subjectRef)
    const hit = recent.find(c =>
      foldName(c.title) === subject
      && c.completed_at != null
      && now - c.completed_at <= REOPEN_WINDOW_SEC)
    if (hit) {
      return {
        tier: 'RECENTLY_COMPLETED_REOPEN', caseId: hit.case_id,
        reason: 'nemrég lezárt ügy ugyanarról — újranyitás, nem második ügy',
      }
    }
  }
  return { tier: 'NO_CASE', reason: 'nincs megfelelő meglévő ügy' }
}

/** §8.1: the five conditions for a NEW Case, all required.
 *
 *  The last one carries the weight: "the Case would not merely be an FYI
 *  notification". Everything else on the list is satisfiable by a signal that is
 *  simply information, and a board full of FYIs is a board that stops being
 *  read. */
export function newCaseRefusal(
  q: InitiativeQualificationResult,
  desiredOutcomeTargetState: string | undefined,
  nextActionOrBoundary: string | undefined,
  minMateriality = 0.5,
): string | null {
  if (q.decision !== 'PROMOTE') return `a kvalifikáció nem PROMOTE (${q.decision})`
  if (q.matchedCaseId) return 'van megfelelő meglévő ügy — új nem indokolt (§8)'
  if (q.materialityScore < minMateriality) return 'a materialitás nem éri el a küszöböt (§8.1)'
  if (!desiredOutcomeTargetState?.trim()) return 'nincs értelmezhető célállapot (§8.1)'
  if (!nextActionOrBoundary?.trim()) return 'nincs következő cselekvés vagy döntési határ (§8.1)'
  if (q.actionabilityScore < 0.6) return 'ez pusztán tájékoztatás lenne, nem ügy (§8.1)'
  return null
}

export type PromoteToCaseResult =
  | { ok: true; caseId: string; tier: MatchTier; created: boolean }
  | { ok: false; reason: string }

/**
 * §8: attach the Initiative to a Case — reusing one wherever possible.
 *
 * `created` is returned rather than inferred, because §8.2's
 * `reused_existing_case_rate` needs the distinction and reconstructing it later
 * from timestamps is the kind of derivation that is right until the day a case
 * is created by two paths at once.
 */
export function attachToCase(
  db: Database.Database,
  signal: ProactiveSignal,
  qualification: InitiativeQualificationResult,
  input: { title: string; caseType: string; desiredOutcomeTargetState: string; nextAction: string },
  now: number,
): PromoteToCaseResult {
  const match = matchCase(db, signal, now)
  if (match.caseId) {
    return { ok: true, caseId: match.caseId, tier: match.tier, created: false }
  }
  const refusal = newCaseRefusal(
    qualification, input.desiredOutcomeTargetState, input.nextAction,
  )
  if (refusal) return { ok: false, reason: refusal }

  const caseId = `pro-${signal.signalId.slice(0, 16)}`
  if (signal.domain === 'zst') {
    createZstCase(db, { caseId, title: input.title, caseType: input.caseType }, now)
  } else {
    createCase(db, { caseId, title: input.title, caseType: input.caseType }, now)
  }
  return { ok: true, caseId, tier: 'NEW_CASE_JUSTIFIED', created: true }
}

/** §8.2's case-explosion guard, computed rather than estimated. */
export interface CaseExplosionMetrics {
  signalsPerCaseCreated: number | null
  reusedExistingCaseRate: number
  newCaseRate: number
  totalAttachments: number
}

export function caseExplosionMetrics(
  attachments: ReadonlyArray<{ created: boolean }>,
): CaseExplosionMetrics {
  const total = attachments.length
  const created = attachments.filter(a => a.created).length
  return {
    // Null, not Infinity and not zero: with no case created there is no ratio,
    // and reporting one would be inventing a denominator.
    signalsPerCaseCreated: created ? total / created : null,
    reusedExistingCaseRate: total ? (total - created) / total : 0,
    newCaseRate: total ? created / total : 0,
    totalAttachments: total,
  }
}

// ── §14 resolve-before-ask ──────────────────────────────────────────────

/** §14's ordered source list. Order is the contract: cheaper and more certain
 *  sources first, and the owner strictly last. */
export const RESOLVE_SOURCE_ORDER = [
  'case_data',
  'case_events',
  'ingested_gmail_thread',
  'ingested_document_evidence',
  'calendar_contacts_if_permitted',
  'domain_safe_memory',
  'deterministic_derived_facts',
] as const
export type ResolveSource = (typeof RESOLVE_SOURCE_ORDER)[number]

/** §14.1. */
export interface ResolutionAttempt {
  requirementId: string
  attemptedSources: ResolveSource[]
  resolved: boolean
  resolvedValue?: unknown
  evidenceRefs: string[]
  unresolvedReason?: string
}

/** A source probe: given the case and the requirement, can this source answer
 *  it? Injected rather than hard-wired so the resolver can be replayed against a
 *  frozen corpus with the same probes that ran live. */
export type ResolveProbe = (
  db: Database.Database,
  domain: ProactiveDomain,
  caseId: string,
  requirement: string,
) => { resolved: boolean; value?: unknown; evidenceRefs: string[] } | null

/**
 * §14: try every internal source, in order, and STOP at the first that answers.
 *
 * The stop matters as much as the order. Continuing after a source has answered
 * would produce a second answer to a question already settled, and §7.2's
 * "duplicate suppression must not swallow a materially changed state" has an
 * uncomfortable mirror here: two resolutions that disagree are worse than one
 * that is merely incomplete.
 *
 * What this function will NEVER do is reach outside. §14 says so
 * ("new web research or browser execution is not part of v1.4"), and the probes
 * are named after internal sources only — a probe that fetched would be a probe
 * whose name lies.
 */
export function resolveBeforeAsk(
  db: Database.Database,
  domain: ProactiveDomain,
  caseId: string,
  requirement: string,
  probes: Partial<Record<ResolveSource, ResolveProbe>>,
): ResolutionAttempt {
  const attempted: ResolveSource[] = []
  for (const source of RESOLVE_SOURCE_ORDER) {
    const probe = probes[source]
    if (!probe) continue
    attempted.push(source)
    let hit: ReturnType<ResolveProbe> = null
    try { hit = probe(db, domain, caseId, requirement) } catch { hit = null }
    if (hit?.resolved) {
      return {
        requirementId: requirement,
        attemptedSources: attempted,
        resolved: true,
        resolvedValue: hit.value,
        evidenceRefs: hit.evidenceRefs,
      }
    }
  }
  return {
    requirementId: requirement,
    attemptedSources: attempted,
    resolved: false,
    evidenceRefs: [],
    // The reason distinguishes "every source was tried and none knew" from "no
    // source was even configured" — which look identical in a resolved:false and
    // mean completely different things about whether asking is justified.
    unresolvedReason: attempted.length === 0
      ? 'egyetlen belső forrás sincs bekötve — a kérdezés ettől még NEM indokolt'
      : `mind a(z) ${attempted.length} belső forrás megpróbálva, egyik sem tudta`,
  }
}

/**
 * §14's last line, as a function: may we ask the owner about this yet?
 *
 * Only after every configured internal source has been tried and failed. The
 * second condition is the one that gets skipped in a hurry: a resolver with no
 * probes wired resolves nothing, and "nothing resolved it" would otherwise read
 * as permission to ask.
 */
export function mayAskOwner(attempt: ResolutionAttempt): { may: boolean; reason: string } {
  if (attempt.resolved) return { may: false, reason: 'a kérdés belülről megválaszolható volt' }
  if (attempt.attemptedSources.length === 0) {
    return { may: false, reason: 'egyetlen belső forrás sem futott le — előbb azokat kell bekötni' }
  }
  if (attempt.attemptedSources.length < RESOLVE_SOURCE_ORDER.length) {
    return {
      may: false,
      reason: `${RESOLVE_SOURCE_ORDER.length - attempt.attemptedSources.length} belső forrás nincs bekötve — `
        + 'a §14 sorrend nem futott végig',
    }
  }
  return { may: true, reason: 'minden belső forrás megpróbálva, egyik sem tudta' }
}
