// PHASE 3 (P3-B) -- CASE-LEVEL WEB RESEARCH, AS A LIMITED PILOT.
//
// Owner ruling 2026-09-01: "Ez az egyetlen valodi uj capability, ezert kulon
// trust boundary. Pilot csak LOW / NORMAL sensitivity ugyeken. A kutato ne a
// case szoveget kuldje ki. Eloszor lokalisan keszitsen deklaralt research query
// payloadot a szukseges mezokbol."
//
// THE SHAPE, AND WHY IT IS THIS SHAPE. Nothing here performs a search. This
// module decides whether a case may be researched at all, builds a SANCTIONED
// QUERY out of the few fields the disclosure gate releases, and writes down
// exactly what left. The search itself is executed elsewhere and its result is
// handed back to `recordResearchResult`. Splitting it that way is not a
// limitation of the runtime -- it is the point: the query that leaves is a
// declared artefact that exists in the ledger BEFORE anything is sent, so
// "what did you send about me" has an answer that does not depend on trusting
// the sender.
//
// IT DOES NOT INVENT ITS OWN POLICY. The egress rules already exist
// (`decideDisclosure`), and a second, parallel set of rules for this one feature
// would be a way around them wearing the clothes of caution. This calls the
// gate, uses only what the gate releases, and stores the gate's record id
// alongside the query.
//
// FAIL-CLOSED, THREE TIMES OVER, AND EACH ONE CAN FIRE ALONE:
//   1. eligibility  -- an unknown or sensitive tier, or a case type outside the
//                      pilot scope, is refused before a query is built;
//   2. the gate     -- only released fields may appear in the query text;
//   3. the sweep    -- the finished string is scanned for secret-shaped content
//                      and refused if any is found, even though (1) and (2)
//                      should have made that impossible.
// Three guards that can only be proven together are one guard with extra steps,
// so each is tested by disabling the other two.
//
// THE RESULT IS EVIDENCE, NEVER PERMISSION. A research answer can become
// evidence, an inference or a recommendation. It cannot authorize an action, it
// cannot start an external mutation, and nothing in this file writes a case
// fact -- there is no UPDATE against a case table anywhere in it.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { egressTierFor } from '../provider-data-policy.js'
import type { CaseSensitivity } from '../schema.js'
import { publicVendorIdentifier } from './public-identifier.js'
import { excludedTopicOf, type TopicExclusion } from './topic-exclusion.js'
import {
  decideDisclosure, recordDisclosure, ensureDisclosureSchema,
  type DisclosureField, type DisclosureRequest, type FieldKind,
} from '../disclosure.js'

/**
 * The owner's "LOW / NORMAL" in this codebase's vocabulary. PUBLIC and PERSONAL
 * may be researched; SENSITIVE_PERSONAL and HIGHLY_SENSITIVE may not, in this
 * pilot, at all. `coerceSensitivity` already fails closed to HIGHLY_SENSITIVE
 * for an unrecognised value, so "UNKNOWN sensitivity -> nincs web research"
 * needs no separate branch: it arrives here as the most sensitive tier.
 */
export const RESEARCHABLE_TIERS: ReadonlySet<CaseSensitivity> = new Set(['PUBLIC', 'PERSONAL'])

/**
 * The pilot scope, as an ALLOWLIST of case types.
 *
 * A blocklist would have been shorter and wrong: it can only exclude the harms
 * somebody already thought of, and the first case type nobody listed is
 * researched by default. The owner named four areas -- product/price/commercial,
 * public company/support, general administrative, and cases blocked only on a
 * public fact -- so those are enumerated and everything else, including every
 * future case type, is out until somebody adds it deliberately.
 */
export const PILOT_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PRODUCT_PRICE_COMMERCIAL: ['SHOPPING', 'QUOTE', 'PROCUREMENT', 'COMMERCIAL_OPPORTUNITY', 'VENDOR'],
  PUBLIC_COMPANY_SUPPORT: ['LICENSE_SUBSCRIPTION', 'PARTNER', 'GENERAL_OPERATION'],
  GENERAL_ADMIN: ['ADMIN', 'COMPANY_ADMIN', 'TRAVEL'],
})

/** Named so a refusal reads as a decision rather than an absence. */
export const OUT_OF_SCOPE_BY_DESIGN = Object.freeze([
  'LEGAL_DATA_PROTECTION', 'CONTRACT', 'FINANCE', 'INVOICE_INCOMING', 'INVOICE_OUTGOING',
  'BANK_RECONCILIATION', 'ACCOUNTING', 'REGULATORY_DEADLINE', 'HEALTH', 'CALL', 'EMAIL',
])

export function scopeOf(caseType: string): string | null {
  for (const [scope, types] of Object.entries(PILOT_SCOPES)) {
    if (types.includes(caseType)) return scope
  }
  return null
}

export interface ResearchCase {
  namespace: 'personal' | 'zst'
  caseId: string
  title: string | null
  description: string | null
  caseType: string
  declaredSensitivity: unknown
  status: string
}

export interface Eligibility {
  eligible: boolean
  /** The NORMALISED tier, in the one canonical vocabulary. */
  sensitivity: CaseSensitivity
  /** What the record itself declared, kept as provenance. The owner asked for
   *  normalisation, not for the original to disappear: `ZST_INTERNAL` becoming
   *  `PERSONAL` is a translation, and a translation that discards the source
   *  cannot be checked. */
  declaredRaw: string
  scope: string | null
  /** The topic class that lifted this case out of the pilot, when one did. */
  excludedTopic: TopicExclusion | null
  /** Always present, including when eligible. */
  reason: string
}

/**
 * GUARD 1. May this case be researched at all, before a single field is
 * assembled.
 *
 * THE TIER IS NORMALISED, NOT COERCED. Owner ruling 2026-09-01: "A ZST_INTERNAL
 * ne essen UNKNOWN/max sensitivity agra csak azert, mert mas vocabularybol jon."
 * Until that ruling every ZST case declared `ZST_INTERNAL`, which is not a
 * `CaseSensitivity` value, so it failed closed to HIGHLY_SENSITIVE and the whole
 * corporate namespace was out of the pilot for a VOCABULARY reason wearing the
 * clothes of a policy one. `egressTierFor` is the existing canonical map -- no
 * second sensitivity system was created for this -- and it runs the corporate
 * content classifier, so the translation can only tighten.
 *
 * AND THE TIER IS NOT PERMISSION. A normalised internal tier says how sensitive
 * the case is; it does not say the subject belongs in a web-research pilot. The
 * owner named the classes that do not, and `excludedTopicOf` is a one-way valve
 * that can lift a case out and can never let one in.
 */
export function researchEligibility(c: ResearchCase): Eligibility {
  const content = [c.title ?? '', c.description ?? ''].join('\n')
  const sensitivity = egressTierFor(c.namespace, c.declaredSensitivity, content)
  const declaredRaw = typeof c.declaredSensitivity === 'string' ? c.declaredSensitivity : 'ABSENT'
  const scope = scopeOf(c.caseType)
  const excludedTopic = excludedTopicOf(content)
  const base = { sensitivity, declaredRaw, scope, excludedTopic }

  if (!RESEARCHABLE_TIERS.has(sensitivity)) {
    return {
      ...base, eligible: false,
      reason: `sensitivity ${sensitivity} (declared ${declaredRaw}) is outside the pilot: only PUBLIC and `
        + `PERSONAL may be researched, and an unrecognised tier normalises to HIGHLY_SENSITIVE by design`,
    }
  }
  if (excludedTopic) {
    return {
      ...base, eligible: false,
      reason: `topic ${excludedTopic.topic} is excluded from the pilot by the owner's list `
        + `(matched "${excludedTopic.evidence}"); the tier permits it and the subject does not`,
    }
  }
  if (!scope) {
    return {
      ...base, eligible: false,
      reason: `case type ${c.caseType} is not in the pilot allowlist; `
        + `the pilot enumerates what may be researched rather than what may not`,
    }
  }
  return { ...base, eligible: true, reason: `${scope} case at ${sensitivity} (declared ${declaredRaw})` }
}

/**
 * THE RESEARCH INTENT IS A CLOSED SET, and that is the point.
 *
 * Owner policy: "Preferalt payload: public root/domain; public product/service
 * name; generic research intent." Free text authored per case would have been
 * the obvious design and it is the leak: an intent written from the case is the
 * case, paraphrased. These five phrasings are fixed, carry no case content, and
 * a caller can only choose between them.
 */
export const RESEARCH_INTENTS = Object.freeze({
  PUBLIC_PRICING: 'current public pricing',
  PUBLIC_SUPPORT_DOCS: 'public support documentation',
  PUBLIC_SERVICE_STATUS: 'public service status page',
  PUBLIC_CONTACT_INFO: 'public contact information',
  PUBLIC_PRODUCT_DOCS: 'public product documentation',
} as const)

export type ResearchIntent = keyof typeof RESEARCH_INTENTS

/** The ONLY field kinds this pilot ever asks for. Minimum necessary, declared
 *  up front rather than trimmed afterwards. Note what is absent: no body, no
 *  amount, no account identifier, no exact sender. */
export const PILOT_REQUIRED_FIELDS: readonly FieldKind[] = Object.freeze([
  'SENDER_ROLE_OR_DOMAIN', 'LANGUAGE',
])

/**
 * GUARD 3. A last sweep over the finished string.
 *
 * Guards 1 and 2 should make this impossible, and that is exactly why it is
 * here: a guard whose only evidence is that another guard works has never been
 * shown to work. It looks for the SHAPE of a secret -- long opaque runs, key
 * prefixes, card and IBAN-like digit groups -- not for a list of strings
 * somebody once saw leak.
 */
export const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  /\b(?:sk|pk|gh[pousr]|xox[baprs]|AIza|ASIA|AKIA|phc|phx)[-_][A-Za-z0-9_-]{8,}/i,
  /\b[A-Za-z0-9_-]{32,}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/,
  /\b(?:jelszo|password|passwd|secret|token|api[_-]?key)\b\s*[:=]/i,
])

export function looksSecretShaped(text: string): string | null {
  for (const re of SECRET_SHAPES) {
    const m = re.exec(text)
    if (m) return m[0].slice(0, 12)
  }
  return null
}

export interface SanctionedQuery {
  ticketId: string
  status: 'SANCTIONED' | 'REFUSED'
  query: string | null
  disclosedFields: FieldKind[]
  disclosureRecordId: string | null
  sensitivity: CaseSensitivity
  scope: string | null
  reason: string
}

export function ticketIdFor(namespace: string, caseId: string, intent: string, now: number): string {
  return 'rq-' + createHash('sha256')
    .update(`${namespace}:${caseId}:${intent}:${now}`).digest('hex').slice(0, 16)
}

/**
 * Build the query, or refuse, and write a ledger row EITHER WAY.
 *
 * `intent` is one of five fixed phrasings, not free text. An intent written per
 * case would have been the obvious design and it is the leak: an intent written
 * from the case is the case, paraphrased.
 */
export function sanctionResearchQuery(
  db: Database.Database,
  c: ResearchCase,
  intent: ResearchIntent,
  now = Math.floor(Date.now() / 1000),
  provider = 'websearch',
  opts: { skipEligibility?: boolean; skipGate?: boolean } = {},
): SanctionedQuery {
  ensureDisclosureSchema(db)
  const ticketId = ticketIdFor(c.namespace, c.caseId, intent, now)
  const elig = researchEligibility(c)

  const refuse = (reason: string, sensitivity: CaseSensitivity, scope: string | null): SanctionedQuery => {
    db.prepare(
      `INSERT OR REPLACE INTO case_research_queries
         (ticket_id, namespace, case_id, sensitivity, scope, status, refused_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'REFUSED', ?, ?)`,
    ).run(ticketId, c.namespace, c.caseId, sensitivity, scope ?? 'NONE', reason, now)
    return {
      ticketId, status: 'REFUSED', query: null, disclosedFields: [],
      disclosureRecordId: null, sensitivity, scope, reason,
    }
  }

  // `skipEligibility` / `skipGate` exist ONLY so a test can disable one guard and
  // show that the next one still refuses. Production never passes them; a guard
  // that is only ever exercised with its neighbours in place has not been shown
  // to work on its own.
  if (!opts.skipEligibility && !elig.eligible) return refuse(elig.reason, elig.sensitivity, elig.scope)

  // THE ONLY CASE-DERIVED THING THAT MAY TRAVEL, and it has to earn it.
  //
  // Owner policy: a vendor's public web domain may go out, and "customer-specific
  // subdomain / portal URL NEM public identifier automatikusan". So the sender
  // host is put through `publicVendorIdentifier`, which returns the registrable
  // root or refuses -- it never sanitises a portal URL down into a root, because
  // reducing would quietly turn a host we were handed into "the vendor's public
  // site" and lose exactly the distinction the policy draws.
  const rawHost = /From:\s*([^\s<>"]+)/i.exec(c.description ?? '')?.[1] ?? null
  const ident = publicVendorIdentifier(rawHost)
  if (!opts.skipGate && !ident.ok) {
    return refuse(
      `no public vendor identifier: ${ident.reason}. The pilot sends a public root domain and a generic `
      + `intent, and it has neither if the sender is not one`,
      elig.sensitivity, elig.scope,
    )
  }
  const domain = ident.ok ? ident.value! : (rawHost ?? '')

  const fields: DisclosureField[] = [
    // TAGGED PUBLIC AS AN EXPLICIT ACT, which the disclosure interface permits
    // for a field the caller knows is genuinely impersonal -- and only AFTER
    // `publicVendorIdentifier` has said so. Without the tag the field inherits
    // the case tier and an untrusted destination gets nothing; with the tag and
    // without the check, the tag would be a way around the gate. The check is
    // what makes the tag honest.
    { kind: 'SENDER_ROLE_OR_DOMAIN', value: domain, sensitivity: 'PUBLIC' },
    { kind: 'LANGUAGE', value: 'hu', sensitivity: 'PUBLIC' },
  ]

  const req: DisclosureRequest = {
    actor: 'cos-case-research', onBehalfOf: 'istvan', runId: null,
    destination: `web:${provider}`,
    // A public search engine is the least trusted destination there is: the
    // query is not merely read by a company, it may be logged and retained.
    trustClass: 'UNKNOWN_UNTRUSTED',
    taskTier: 'ROUTING_METADATA',
    caseSensitivity: elig.sensitivity,
    fields,
    requiredFields: [...PILOT_REQUIRED_FIELDS],
  }
  const decision = decideDisclosure(req)
  const recordId = recordDisclosure(db, req, decision, now)

  const domainReleased = opts.skipGate
    || decision.outcomes.some((o) => o.kind === 'SENDER_ROLE_OR_DOMAIN' && o.disclosed != null)
  if (!domainReleased) {
    return refuse(
      `the disclosure gate did not release the public identifier to ${req.destination}; without it the `
      + `query carries no term from this case and would search for nothing`,
      elig.sensitivity, elig.scope,
    )
  }

  // The query: a public root domain and one of five fixed phrasings. Nothing
  // else is ever appended, so there is no path by which a case sentence, a
  // person, an amount or a ticket id reaches it.
  const query = [domain, RESEARCH_INTENTS[intent]].join(' ').trim()

  const shaped = looksSecretShaped(query)
  if (shaped) {
    return refuse(
      `the assembled query carries secret-shaped content (${shaped}...); refused by the final sweep `
      + `even though eligibility and the disclosure gate had already passed it`,
      elig.sensitivity, elig.scope,
    )
  }
  if (!query) {
    return refuse('the disclosure gate released nothing, so there is no query to send', elig.sensitivity, elig.scope)
  }

  const disclosedFields = decision.disclosedKinds
  db.prepare(
    `INSERT OR REPLACE INTO case_research_queries
       (ticket_id, namespace, case_id, sensitivity, scope, status, disclosure_record_id,
        disclosed_fields, query, provider, created_at)
     VALUES (?, ?, ?, ?, ?, 'SANCTIONED', ?, ?, ?, ?, ?)`,
  ).run(
    ticketId, c.namespace, c.caseId, elig.sensitivity, elig.scope ?? 'NONE',
    recordId, JSON.stringify(disclosedFields), query, provider, now,
  )
  return {
    ticketId, status: 'SANCTIONED', query, disclosedFields,
    disclosureRecordId: recordId, sensitivity: elig.sensitivity, scope: elig.scope,
    reason: elig.reason,
  }
}

export type ResultKind = 'EVIDENCE' | 'INFERENCE' | 'RECOMMENDATION' | 'NO_RESULT'

export interface ResearchResult {
  kind: ResultKind
  /** Where the answer came from: URLs and when they were retrieved. An answer
   *  with no provenance is recorded as NO_RESULT rather than as knowledge. */
  provenance: string[]
  /** NULL when it was not timed cleanly. A sentinel like -1 would sit in the
   *  median pretending to be a measurement; absence is the honest value. */
  latencyMs: number | null
  costUsd?: number | null
  /** Did it actually move an attention, decision or recommendation? The owner
   *  asked for this proportion, so it is a field and not a guess made later. */
  changedSurface: boolean
  /** The search answered, and answered the WRONG question. Recorded apart from
   *  "no result": an empty answer costs a query, a confident wrong one costs a
   *  query and can mislead a reader. */
  falsePositive?: boolean
  note?: string
}

export class ResearchAuthorizationError extends Error {}

/**
 * Record what came back. Evidence only.
 *
 * The guard here is not decorative: a result that arrives claiming to authorize
 * something is refused outright rather than stored with the claim stripped,
 * because a fetched page is untrusted content and the one thing it must never
 * be able to do is grant permission.
 */
export function recordResearchResult(
  db: Database.Database, ticketId: string, result: ResearchResult,
  now = Math.floor(Date.now() / 1000),
): void {
  const row = db.prepare(
    `SELECT status FROM case_research_queries WHERE ticket_id = ?`,
  ).get(ticketId) as { status: string } | undefined
  if (!row) throw new Error(`no research ticket ${ticketId}`)
  if (row.status !== 'SANCTIONED') {
    throw new ResearchAuthorizationError(
      `ticket ${ticketId} is ${row.status}; a result can only be recorded against a sanctioned query`,
    )
  }
  const kind: ResultKind = result.provenance.length ? result.kind : 'NO_RESULT'
  db.prepare(
    `UPDATE case_research_queries
        SET status = 'EXECUTED', executed_at = ?, latency_ms = ?, cost_usd = ?,
            result_kind = ?, result_provenance = ?, changed_surface = ?, false_positive = ?, outcome_note = ?
      WHERE ticket_id = ?`,
  ).run(
    now, result.latencyMs ?? null, result.costUsd ?? null, kind,
    JSON.stringify(result.provenance), result.changedSurface ? 1 : 0,
    result.falsePositive ? 1 : 0, result.note ?? null, ticketId,
  )
}

export interface PilotMetrics {
  cases: number
  sanctioned: number
  refused: number
  executed: number
  refusedByReason: Record<string, number>
  withResult: number
  noResult: number
  falsePositive: number
  changedSurface: number
  medianLatencyMs: number | null
  totalCostUsd: number
}

/** The numbers the owner asked to see before the pilot widens. */
export function pilotMetrics(db: Database.Database): PilotMetrics {
  const rows = db.prepare(`SELECT * FROM case_research_queries`).all() as Array<Record<string, unknown>>
  const refusedByReason: Record<string, number> = {}
  let sanctioned = 0, refused = 0, executed = 0, withResult = 0, noResult = 0, changed = 0, cost = 0, falsePos = 0
  const lat: number[] = []
  for (const r of rows) {
    const status = String(r.status)
    if (status === 'REFUSED') {
      refused++
      const reason = String(r.refused_reason ?? '').split(';')[0].slice(0, 60)
      refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1
    }
    if (status === 'SANCTIONED') sanctioned++
    if (status === 'EXECUTED') {
      executed++
      if (r.result_kind === 'NO_RESULT') noResult++; else withResult++
      if (r.changed_surface === 1) changed++
      if (r.false_positive === 1) falsePos++
      if (typeof r.latency_ms === 'number' && r.latency_ms >= 0) lat.push(r.latency_ms)
      if (typeof r.cost_usd === 'number') cost += r.cost_usd
    }
  }
  lat.sort((a, b) => a - b)
  return {
    cases: new Set(rows.map((r) => `${r.namespace}:${r.case_id}`)).size,
    sanctioned, refused, executed, refusedByReason, withResult, noResult,
    falsePositive: falsePos, changedSurface: changed,
    medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    totalCostUsd: cost,
  }
}
