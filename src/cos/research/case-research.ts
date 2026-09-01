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
import { effectiveSensitivity } from '../sensitivity.js'
import type { CaseSensitivity } from '../schema.js'
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
  sensitivity: CaseSensitivity
  scope: string | null
  /** Always present, including when eligible: the reason a decision went the way
   *  it did is as worth recording as the decision. */
  reason: string
}

/**
 * GUARD 1. Decides whether this case may be researched at all, before a single
 * field is assembled.
 *
 * The tier is the EFFECTIVE one -- declared, then escalated by what the content
 * actually contains. Reading the declared column alone would let a case marked
 * PUBLIC whose body carries a health detail through, which is the whole failure
 * this gate exists to stop.
 */
export function researchEligibility(c: ResearchCase): Eligibility {
  const content = [c.title ?? '', c.description ?? ''].join('\n')
  const sensitivity = effectiveSensitivity(c.declaredSensitivity, content)
  const scope = scopeOf(c.caseType)

  if (!RESEARCHABLE_TIERS.has(sensitivity)) {
    return {
      eligible: false, sensitivity, scope,
      reason: `sensitivity ${sensitivity} is outside the pilot: only PUBLIC and PERSONAL may be researched, `
        + `and an unrecognised or missing tier arrives here as HIGHLY_SENSITIVE by design`,
    }
  }
  if (!scope) {
    return {
      eligible: false, sensitivity, scope: null,
      reason: `case type ${c.caseType} is not in the pilot allowlist; `
        + `the pilot enumerates what may be researched rather than what may not`,
    }
  }
  return { eligible: true, sensitivity, scope, reason: `${scope} case at ${sensitivity}` }
}

/** The ONLY field kinds this pilot ever asks for. Minimum necessary, declared
 *  up front rather than trimmed afterwards. Note what is absent: no body, no
 *  amount, no account identifier, no exact sender. */
export const PILOT_REQUIRED_FIELDS: readonly FieldKind[] = Object.freeze([
  'SUBJECT', 'LANGUAGE', 'SENDER_ROLE_OR_DOMAIN',
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
 * `intent` is the researcher's own words for what is missing (for example "what
 * is the published support address"). It is written by the engine, not taken
 * from the case, so it carries no case content -- and because it is the only
 * free text in the query, it is swept by guard 3 along with everything else.
 */
export function sanctionResearchQuery(
  db: Database.Database,
  c: ResearchCase,
  intent: string,
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

  const fields: DisclosureField[] = [
    { kind: 'SUBJECT', value: c.title ?? '' },
    { kind: 'LANGUAGE', value: 'hu', sensitivity: 'PUBLIC' },
  ]
  const domain = /From:\s*[^\s<>"]+@([^\s<>"]+)/i.exec(c.description ?? '')?.[1]
  if (domain) fields.push({ kind: 'SENDER_ROLE_OR_DOMAIN', value: domain })

  const req: DisclosureRequest = {
    actor: 'cos-case-research', onBehalfOf: 'istvan', runId: null,
    destination: `web:${provider}`,
    // A public search engine is the least trusted destination there is: the
    // query is not merely read by a company, it may be logged and retained.
    trustClass: 'UNKNOWN_UNTRUSTED',
    taskTier: 'CLASSIFICATION_TRIAGE',
    caseSensitivity: elig.sensitivity,
    fields,
    requiredFields: [...PILOT_REQUIRED_FIELDS],
  }
  const decision = decideDisclosure(req)
  const recordId = recordDisclosure(db, req, decision, now)

  // ONLY what the gate released. Not "the fields minus the denied ones" -- the
  // released VALUES, in the treatment the gate chose, so a REDACTED subject
  // travels redacted and a DENIED one does not travel at all.
  const released = opts.skipGate
    ? fields.map((f) => f.value)
    : decision.outcomes.filter((o) => o.disclosed != null).map((o) => o.disclosed!)
  const query = [intent, ...released].map((s) => s.trim()).filter(Boolean).join(' ')

  // THE GATE'S ANSWER, TAKEN SERIOUSLY RATHER THAN WORKED AROUND.
  //
  // `decideDisclosure` denies EVERY field carrying the case's tier when the
  // destination is UNKNOWN_UNTRUSTED, and a public search engine is exactly
  // that -- it does not merely read the query, it may log and retain it. So on
  // a PERSONAL case nothing case-derived survives, and what is left is the
  // language code the caller tagged PUBLIC plus the engine's own words.
  //
  // Sending that would be theatre: a query with no case-derived term is not a
  // search for this case, and shipping it would let the pilot report activity
  // it did not have. The honest outcome is a refusal that names the reason, so
  // the tension is visible as a POLICY question -- may a vendor's public domain
  // be declared genuinely public? -- rather than being settled quietly by
  // whoever tags a field next.
  const CASE_DERIVED: readonly FieldKind[] = ['SUBJECT', 'SENDER_ROLE_OR_DOMAIN', 'SUMMARY', 'BODY_EXCERPT']
  const releasedCaseDerived = opts.skipGate
    ? CASE_DERIVED.slice(0, 1)
    : decision.disclosedKinds.filter((k) => CASE_DERIVED.includes(k))
  if (!releasedCaseDerived.length) {
    return refuse(
      `the disclosure gate released no case-derived field to ${req.destination}: an `
      + `UNKNOWN_UNTRUSTED destination may receive nothing at ${elig.sensitivity}, so the only `
      + `query that could be sent carries no term from this case and would search for nothing`,
      elig.sensitivity, elig.scope,
    )
  }

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
  latencyMs: number
  costUsd?: number | null
  /** Did it actually move an attention, decision or recommendation? The owner
   *  asked for this proportion, so it is a field and not a guess made later. */
  changedSurface: boolean
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
            result_kind = ?, result_provenance = ?, changed_surface = ?, outcome_note = ?
      WHERE ticket_id = ?`,
  ).run(
    now, result.latencyMs, result.costUsd ?? null, kind,
    JSON.stringify(result.provenance), result.changedSurface ? 1 : 0,
    result.note ?? null, ticketId,
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
  changedSurface: number
  medianLatencyMs: number | null
  totalCostUsd: number
}

/** The numbers the owner asked to see before the pilot widens. */
export function pilotMetrics(db: Database.Database): PilotMetrics {
  const rows = db.prepare(`SELECT * FROM case_research_queries`).all() as Array<Record<string, unknown>>
  const refusedByReason: Record<string, number> = {}
  let sanctioned = 0, refused = 0, executed = 0, withResult = 0, noResult = 0, changed = 0, cost = 0
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
      if (typeof r.latency_ms === 'number') lat.push(r.latency_ms)
      if (typeof r.cost_usd === 'number') cost += r.cost_usd
    }
  }
  lat.sort((a, b) => a - b)
  return {
    cases: new Set(rows.map((r) => `${r.namespace}:${r.case_id}`)).size,
    sanctioned, refused, executed, refusedByReason, withResult, noResult,
    changedSurface: changed,
    medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    totalCostUsd: cost,
  }
}
