// Personal Chief of Staff (COS) — the Context Builder (§10.1).
//
// NOT AN AGENT, and that is the design, not a limitation. §10.1 makes this
// deterministic code on purpose: it decides WHAT the Reader is allowed to see,
// and a component that decides the boundary of untrusted input must not itself
// be steerable by that input.
//
// Its whole job is five things:
//   - load the case's current state;
//   - gather the permitted sources for it;
//   - filter by domain/scope;
//   - attach PROVENANCE to every item;
//   - attach a TRUST classification to every item.
//
// The trust field is the one that matters downstream. §10.2 says the Reader may
// read raw external content, and §10.3 says schema validation is not a security
// boundary. Neither is worth anything unless the packet the Reader gets already
// says, item by item, which parts are OUR OWN RECORDS and which are WHAT
// SOMEBODY ELSE WROTE. Deciding that at read time, from a field, is reliable;
// inferring it later from where the text sits is not.
//
// WHAT IT DOES NOT DO YET, said plainly rather than implied by omission: §10.1
// lists Drive, Calendar, Contacts, permitted MCP/API and permitted web research
// as sources. None of those are reachable from this process today. They are
// reported in `unavailable` with a reason instead of being silently absent,
// because "the Reader saw no calendar entries" and "there is no calendar
// connector" lead to very different conclusions and must not look the same.
import type Database from 'better-sqlite3'
import { CASE_SENSITIVITIES, type CaseSensitivity } from './schema.js'
import { escalateSensitivity, coerceSensitivity } from './sensitivity.js'

export type TrustClass =
  /** Written by this system or by Istvan. Instructions here are legitimate. */
  | 'TRUSTED_CASE_FIELD'
  /** Written by someone outside. DATA, never instructions (§10.2). */
  | 'UNTRUSTED_SOURCE_DATA'

export interface Provenance {
  /** Which subsystem produced it: 'case-store', 'case-events', 'documents'. */
  source: string
  /** The identifier that lets a human find the original — and the exact string
   *  the Reader must cite. ATOMIC on purpose: no spaces, no parenthetical
   *  suffix. It is compared by exact match in validateEvidencePacket, so any
   *  decoration inside it becomes something a correct citation can get wrong. */
  reference: string
  /** Where the item came from originally (a connector name, a Drive folder).
   *  Kept OUT of `reference` so it cannot corrupt a citation. */
  sourceRef?: string
  retrievedAt: number
}

export interface ContextItem {
  /** CASE = the fields this system writes. CASE_INTAKE = title/description,
   *  which for an email-born case are the SENDER's words and are therefore
   *  carried separately and untrusted (§10.3, review #3 Ú-1). */
  kind: 'CASE' | 'CASE_INTAKE' | 'CASE_EVENT' | 'EMAIL_THREAD' | 'DOCUMENT'
  provenance: Provenance
  trust: TrustClass
  sensitivity: string
  content: string
}

export interface CaseContext {
  domain: 'personal' | 'zst'
  caseId: string
  caseVersion: number | null
  items: ContextItem[]
  /** Items that EXIST and were deliberately left out, with the reason. The list
   *  is the evidence for §10.1's "excludes cross-domain or non-permitted data":
   *  an exclusion nobody can see is indistinguishable from a source nobody
   *  looked for. */
  excluded: Array<{ reference: string; reason: string }>
  /** Sources §10.1 names that this process cannot reach at all. Separate from
   *  `excluded` on purpose: "not permitted" and "not connected" are different
   *  facts, and only one of them is a policy decision. */
  unavailable: Array<{ source: string; reason: string }>
}

/** A document's tier: its own if it declared a valid one, otherwise the case's.
 *  Exported so the rule is testable rather than inlined in a query loop. */
export function docSensitivity(own: unknown, caseTier: string): string {
  const valid = (CASE_SENSITIVITIES as readonly string[]).includes(String(own))
  if (!valid) return caseTier
  // Both declared: the MORE sensitive wins. A document may be more sensitive
  // than the case it hangs off; it may never make the case less sensitive.
  return escalateSensitivity(own as CaseSensitivity, coerceSensitivity(caseTier))
}

const SOURCES_NOT_WIRED = [
  { source: 'drive', reason: 'no Drive connector in this process (§10.1 source, not reachable)' },
  { source: 'calendar', reason: 'no Calendar connector in this process' },
  { source: 'contacts', reason: 'no Contacts connector in this process' },
  { source: 'mcp', reason: 'no permitted MCP/API source configured for context building' },
  { source: 'web-research', reason: 'web research is not part of the deterministic builder' },
]

/**
 * Build the context for one case.
 *
 * `maxItems` bounds the packet. The bound is reported by TRUNCATING VISIBLY —
 * anything dropped for size lands in `excluded` with that reason — because a
 * silently shortened context is how a Reader concludes "there is no mention of
 * the deposit" about a thread whose second half was cut off.
 */
export function buildCaseContext(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, now: number,
  opts: { maxItems?: number; maxCharsPerItem?: number } = {},
): CaseContext {
  const maxItems = opts.maxItems ?? 40
  // A per-item ceiling as well as an item count. Live 2026-08-11: a case with 13
  // items handed the Reader whole email threads, the model reasoned over all of
  // it and hit its output ceiling before writing a single character of the
  // packet. The item count was never the binding constraint — the length of one
  // thread was. Cut visibly, per the note above: a silently shortened thread is
  // how a Reader concludes there is no mention of the deposit.
  const maxChars = opts.maxCharsPerItem ?? 4000
  const caseTable = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const eventTable = domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
  const namespace = domain === 'zst' ? 'zst' : 'personal'

  const items: ContextItem[] = []
  const excluded: CaseContext['excluded'] = []

  const c = db.prepare(
    `SELECT case_id, version, title, description, status, case_type, scope, sensitivity,
            next_action, waiting_on, blocked_reason
     FROM ${caseTable} WHERE case_id = ?`
  ).get(caseId) as Record<string, unknown> | undefined

  if (!c) {
    return { domain, caseId, caseVersion: null, items: [], excluded: [], unavailable: SOURCES_NOT_WIRED }
  }

  const sensitivity = String(c.sensitivity ?? 'UNKNOWN')

  // 1. The case's OWN fields — the ones this system and Istvan write. TRUSTED.
  //
  // `title` and `description` are deliberately NOT here. For a case born from an
  // incoming email they are the SENDER's text: intake.ts writes
  // `title: input.title ?? input.subject` and `description: From: ${input.from}`.
  // Leaving them in this item put attacker-authored text inside the block whose
  // trust label tells the model that instructions here are legitimate — unfenced.
  // Found by review #3 (Ú-1, 2026-08-10) and reproduced with this module's own
  // buildReaderPrompt before the fix.
  //
  // The module already made exactly this argument one item further down, about
  // an event's `reason` text. It was true here too, and it was not applied.
  items.push({
    kind: 'CASE',
    provenance: { source: 'case-store', reference: caseId, retrievedAt: now },
    trust: 'TRUSTED_CASE_FIELD',
    sensitivity,
    content: [
      `status: ${String(c.status ?? '')}`,
      `type: ${String(c.case_type ?? '')}`,
      c.next_action ? `next_action: ${String(c.next_action)}` : '',
      c.waiting_on ? `waiting_on: ${String(c.waiting_on)}` : '',
      c.blocked_reason ? `blocked_reason: ${String(c.blocked_reason)}` : '',
    ].filter(Boolean).join('\n'),
  })

  // 1b. The intake-authored fields, as their own UNTRUSTED item, so the Reader
  // sees them fenced and labelled as data.
  //
  // A manually created case has a title Istvan wrote, and marking that untrusted
  // costs a little caution. An email-born case has a title a stranger wrote, and
  // NOT marking it costs the boundary. The builder cannot tell the two apart
  // from the row — the origin is not stored on the field — so it takes the cost
  // it can afford.
  const intake = [
    `title: ${String(c.title ?? '')}`,
    c.description ? `description: ${String(c.description)}` : '',
  ].filter(Boolean).join('\n')
  items.push({
    kind: 'CASE_INTAKE',
    // A ref of its own: a fact about the subject line must be citable, and must
    // not be attributable to the case's own trusted fields.
    provenance: { source: 'case-store', reference: `${caseId}#intake`, retrievedAt: now },
    trust: 'UNTRUSTED_SOURCE_DATA',
    sensitivity,
    content: intake,
  })

  // 2. The case history. Also ours — but the `reason` text on an event can
  // ORIGINATE outside (an intake writes what the sender wrote), so events are
  // marked untrusted. Over-marking costs a little caution; under-marking costs
  // the boundary.
  const events = db.prepare(
    `SELECT event_id, event_type, previous_status, new_status, reason, actor, source_system, created_at
     FROM ${eventTable} WHERE case_id = ? ORDER BY event_id DESC LIMIT 20`
  ).all(caseId) as Array<Record<string, unknown>>
  for (const e of events) {
    items.push({
      kind: 'CASE_EVENT',
      provenance: { source: 'case-events', reference: `event:${String(e.event_id)}`, retrievedAt: now },
      trust: 'UNTRUSTED_SOURCE_DATA',
      sensitivity,
      content: `${String(e.event_type ?? '')} ${String(e.previous_status ?? '')}→${String(e.new_status ?? '')} `
        + `by ${String(e.actor ?? '')}${e.reason ? `: ${String(e.reason)}` : ''}`,
    })
  }

  // 3. Documents and stored email threads, from the shared document store.
  //
  // The namespace filter is the cross-domain boundary §10.1 asks for, and it is
  // applied in SQL rather than by filtering afterwards: a row that never leaves
  // the database cannot be leaked by a later bug. The `excluded` list below is
  // built by a SECOND query that deliberately looks at the other namespace, so
  // the exclusion is demonstrable rather than merely intended.
  const docs = db.prepare(
    `SELECT document_id, doc_kind, filename, source, source_ref, sensitivity, content_purged_at,
            extracted_text
     FROM cos_documents WHERE namespace = ? AND case_id = ? ORDER BY created_at DESC LIMIT 20`
  ).all(namespace, caseId) as Array<Record<string, unknown>>
  for (const d of docs) {
    if (d.content_purged_at) {
      excluded.push({ reference: String(d.document_id), reason: 'content purged by retention policy' })
      continue
    }
    items.push({
      kind: String(d.doc_kind) === 'email_thread' ? 'EMAIL_THREAD' : 'DOCUMENT',
      provenance: {
        source: 'documents',
        // ATOMIC. The reference used to be `doc-abc123 (chatgpt-cos-drive)` and
        // the provenance check is an exact string match, so a Reader that cited
        // `doc-abc123` — the obvious thing to write, and a CORRECT citation —
        // had its whole packet refused. Live case PRI-HOME-2026-002, 2026-08-11.
        //
        // The fix is the format, not the check. Loosening provenance matching to
        // accept a prefix would weaken the one guard that stops a packet citing a
        // document nobody supplied, in order to accommodate a model that was
        // right. So the ref is now the identifier alone, and the origin travels
        // beside it in its own field.
        reference: String(d.document_id),
        sourceRef: d.source_ref ? String(d.source_ref) : undefined,
        retrievedAt: now,
      },
      // Everything here came from outside. This is the class §10.2's Reader must
      // treat as data and never as instruction.
      trust: 'UNTRUSTED_SOURCE_DATA',
      // A document attached to a case inherits the CASE's declared tier unless
      // it carries a valid one of its own. Measured 2026-08-11: all 92 rows in
      // the live document store carry the literal 'UNKNOWN' — the store never
      // classified anything — and a fail-closed reader gate coerces 'UNKNOWN' to
      // HIGHLY_SENSITIVE, which would have blocked 36 of 40 cases on a data gap
      // rather than on their actual content.
      //
      // This is not a relaxation: 'UNKNOWN' means NOT DECLARED, and the case row
      // holds the real declaration made at intake. A document with its own valid
      // tier still escalates (the max of the two wins), and the content
      // classifier escalates on top of both.
      sensitivity: docSensitivity(d.sensitivity, sensitivity),
      // The extracted TEXT when we have it. A filename is a label, not content,
      // and a Reader handed only labels would confidently report that a thread
      // says nothing — the failure mode that looks like an answer.
      content: d.extracted_text
        ? `${String(d.doc_kind ?? 'document')} (${String(d.filename ?? d.document_id)}):\n${String(d.extracted_text)}`
        : `${String(d.doc_kind ?? 'document')}: ${String(d.filename ?? d.document_id)} [no extracted text]`,
    })
  }

  // The provable half of the cross-domain rule: anything carrying this case id in
  // the OTHER namespace is named and refused, rather than simply not fetched.
  const foreign = db.prepare(
    `SELECT document_id FROM cos_documents WHERE namespace <> ? AND case_id = ?`
  ).all(namespace, caseId) as Array<{ document_id: string }>
  for (const f of foreign) {
    excluded.push({ reference: f.document_id, reason: `cross-domain: belongs to another namespace, not ${namespace}` })
  }

  // 4a. Bound each item's LENGTH, visibly and in the Reader's own language, so
  // the cut is something the model can report in unreadableSources rather than
  // something it cannot see.
  for (const item of items) {
    if (item.content.length > maxChars) {
      const dropped = item.content.length - maxChars
      item.content = `${item.content.slice(0, maxChars)}\n[...LEVÁGVA: további ${dropped} karakter nem fért a kontextusba — ez a forrás CSONKA]`
    }
  }

  // 4b. Bound the packet, visibly.
  if (items.length > maxItems) {
    for (const dropped of items.slice(maxItems)) {
      excluded.push({ reference: dropped.provenance.reference, reason: `over the ${maxItems}-item context bound` })
    }
    items.length = maxItems
  }

  return {
    domain, caseId, caseVersion: Number(c.version ?? 0),
    items, excluded, unavailable: SOURCES_NOT_WIRED,
  }
}

/** Every item carries provenance and a trust class, or this returns the ones
 *  that do not. §10.1's own acceptance condition, as a function, so it can be
 *  asserted in a test rather than reviewed by eye. */
export function contextIntegrityViolations(ctx: CaseContext): string[] {
  const bad: string[] = []
  for (const i of ctx.items) {
    if (!i.provenance?.source || !i.provenance?.reference) bad.push(`${i.kind}: missing provenance`)
    if (i.trust !== 'TRUSTED_CASE_FIELD' && i.trust !== 'UNTRUSTED_SOURCE_DATA') bad.push(`${i.kind}: missing trust class`)
    if (!i.sensitivity) bad.push(`${i.kind}: missing sensitivity`)
  }
  return bad
}
