// Personal Chief of Staff (COS) — W13 / §7.4: the DISCLOSURE DECISION.
//
// Istvan's contract (2026-08-25, Telegram), in his own framing:
//
//   "A prompt tier önmagában NEM jogosultság. A disclosure döntés három bemenet
//    metszete: task/prompt tier × destination trust class × field/data
//    sensitivity. Ha bármelyik dimenzió tilt, az eredmény OMIT/DENY."
//
// Everything this system had before was ONE-dimensional: a tier decided WHETHER
// a case could go to a provider, and then the whole payload went. No gate ever
// decided WHICH FIELDS travel. That is the hole this module fills, and the three
// dimensions are separate passes so a reader can see which one refused.
//
// THE FOURTH INPUT, and it is not a dimension: TASK NECESSITY. A field the task
// did not ask for is OMITTED regardless of how harmless it is. "Allowed" and
// "needed" are different questions, and minimum-necessary is the second one.
//
// WHY `DestinationTrustClass` AND NOT `TrustClass`. `TrustClass` already exists
// in context-builder.ts and means something else entirely — whether a piece of
// CONTENT is our own record or somebody else's words. Two different concepts
// under one name in one codebase is how a later reader silently applies the
// wrong table.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { CASE_SENSITIVITIES, type CaseSensitivity } from './schema.js'
import { dataClassOf } from './provider-data-policy.js'
import { scrubKnownSecrets } from '../known-secrets.js'

// ── the three inputs ────────────────────────────────────────────────────────

/** What the prompt is FOR. Not a permission by itself (Istvan's first line). */
export type TaskTier =
  /** Routing, dedupe, priority. Metadata only. */
  | 'ROUTING_METADATA'
  /** Categorisation, intent, urgency. Redacted subject / short summary. */
  | 'CLASSIFICATION_TRIAGE'
  /** Real summarisation or structured extraction. Redacted body permitted. */
  | 'SUMMARIZE_EXTRACT'
  /** Complex reasoning across a case. Still not "everything may go". */
  | 'DEEP_ANALYSIS'

/** WHERE it lands. */
export type DestinationTrustClass =
  | 'TRUSTED_INTERNAL'
  | 'APPROVED_EXTERNAL'
  | 'RESTRICTED_EXTERNAL'
  | 'UNKNOWN_UNTRUSTED'

/** WHAT each field is. Named per Istvan's field-specific rules. */
export type FieldKind =
  | 'CASE_ID' | 'TIMESTAMP' | 'SOURCE_CHANNEL_TYPE' | 'LANGUAGE'
  | 'ATTACHMENT_COUNT' | 'ATTACHMENT_TYPE' | 'ATTACHMENT_FILENAME'
  | 'SENDER_ROLE_OR_DOMAIN' | 'SENDER_EXACT'
  | 'SUBJECT' | 'SUMMARY' | 'BODY_EXCERPT' | 'BODY_FULL'
  | 'AMOUNT' | 'ACCOUNT_IDENTIFIER'
  | 'CREDENTIAL' | 'UNKNOWN_SECRET_LIKE'

/** What happens to a field. */
export type FieldTreatment =
  /** Verbatim. */
  | 'RAW'
  /** Sent with PII patterns scrubbed out of the text. */
  | 'REDACTED'
  /** Replaced by a stable, non-reversible handle. */
  | 'PSEUDONYMIZED'
  /** Partially shown (last 4), for an identifier a human must recognise. */
  | 'MASKED'
  /** Left out because the task did not need it. */
  | 'OMITTED'
  /** Left out because policy forbids it. Not the same fact as OMITTED. */
  | 'DENIED'

export interface DisclosureField {
  kind: FieldKind
  /**
   * The field's own sensitivity.
   *
   * Defaults to the request's case tier, and the default is FAIL-CLOSED on
   * purpose: a field carried by a SENSITIVE_PERSONAL case is treated as
   * sensitive unless the caller says otherwise. A caller that knows a field is
   * genuinely impersonal (a language code, an attachment count) may tag it
   * PUBLIC — an explicit act, recorded in the decision record, rather than a
   * silent assumption that metadata cannot identify anyone.
   */
  sensitivity?: CaseSensitivity
  value: string
}

export interface DisclosureRequest {
  actor: string
  onBehalfOf: string
  runId: string | null
  /** Human-readable destination, e.g. 'llm:anthropic' or 'llm:deepseek'. */
  destination: string
  trustClass: DestinationTrustClass
  taskTier: TaskTier
  /** The case's declared+escalated tier. Every field inherits it as a floor. */
  caseSensitivity: CaseSensitivity
  fields: DisclosureField[]
  /** MINIMUM NECESSARY. Only these kinds may travel at all; anything else is
   *  OMITTED with that reason. The caller states what the task needs, and the
   *  policy then decides whether it may have it. */
  requiredFields: FieldKind[]
  /** The task genuinely concerns money (an invoice, a payment deadline).
   *  Istvan: "amount, kizárólag ha a konkrét feladat pénzügyileg releváns". */
  financiallyRelevant?: boolean
  /** WHO the counterparty is matters to the reasoning itself, not merely as a
   *  label. Istvan: "exact sender identity csak akkor, ha az identitás maga
   *  releváns a reasoninghez, különben pseudonymize". */
  identityRelevant?: boolean
  /** An approval that authorises a wider disclosure than the default. Recorded
   *  either way; absence is recorded as absence. */
  approvalReference?: string | null
}

export interface FieldOutcome {
  kind: FieldKind
  treatment: FieldTreatment
  /** Why, naming the dimension that decided. Never empty. */
  reason: string
  /** The value as it may travel. Absent for OMITTED / DENIED. */
  disclosed?: string
  sensitivity: CaseSensitivity
}

export interface DisclosureDecision {
  outcomes: FieldOutcome[]
  /** The kinds that actually travel, in request order. */
  disclosedKinds: FieldKind[]
  /** True when at least one field was DENIED by policy (not merely omitted). */
  anyDenied: boolean
}

// ── dimension 1: the task tier's ceiling ────────────────────────────────────

/** The MOST a tier may ever ask for, per field. A missing entry means the tier
 *  has no business with that field at all. */
const TIER_CEILING: Record<TaskTier, Partial<Record<FieldKind, FieldTreatment>>> = {
  // "Kimehet: pseudonymous case/message ID, timestamp, source/channel type,
  //  language, attachment count/type, sender role/domain ha szükséges."
  ROUTING_METADATA: {
    CASE_ID: 'PSEUDONYMIZED', TIMESTAMP: 'RAW', SOURCE_CHANNEL_TYPE: 'RAW',
    LANGUAGE: 'RAW', ATTACHMENT_COUNT: 'RAW', ATTACHMENT_TYPE: 'RAW',
    SENDER_ROLE_OR_DOMAIN: 'RAW',
  },
  // "Kimehet minimumként: redacted subject, pseudonymized sender, redacted short
  //  summary vagy szükséges body-részlet, sanitized attachment type/name."
  CLASSIFICATION_TRIAGE: {
    CASE_ID: 'PSEUDONYMIZED', TIMESTAMP: 'RAW', SOURCE_CHANNEL_TYPE: 'RAW',
    LANGUAGE: 'RAW', ATTACHMENT_COUNT: 'RAW', ATTACHMENT_TYPE: 'RAW',
    ATTACHMENT_FILENAME: 'REDACTED',
    SENDER_ROLE_OR_DOMAIN: 'RAW', SENDER_EXACT: 'PSEUDONYMIZED',
    SUBJECT: 'REDACTED', SUMMARY: 'REDACTED', BODY_EXCERPT: 'REDACTED',
  },
  // "taskhoz szükséges body, akár teljes body, DE csak redaction után."
  SUMMARIZE_EXTRACT: {
    CASE_ID: 'PSEUDONYMIZED', TIMESTAMP: 'RAW', SOURCE_CHANNEL_TYPE: 'RAW',
    LANGUAGE: 'RAW', ATTACHMENT_COUNT: 'RAW', ATTACHMENT_TYPE: 'RAW',
    ATTACHMENT_FILENAME: 'REDACTED',
    SENDER_ROLE_OR_DOMAIN: 'RAW', SENDER_EXACT: 'PSEUDONYMIZED',
    SUBJECT: 'REDACTED', SUMMARY: 'REDACTED',
    BODY_EXCERPT: 'REDACTED', BODY_FULL: 'REDACTED',
    AMOUNT: 'RAW', ACCOUNT_IDENTIFIER: 'MASKED',
  },
  // "Itt sem »minden adat mehet«."
  DEEP_ANALYSIS: {
    CASE_ID: 'PSEUDONYMIZED', TIMESTAMP: 'RAW', SOURCE_CHANNEL_TYPE: 'RAW',
    LANGUAGE: 'RAW', ATTACHMENT_COUNT: 'RAW', ATTACHMENT_TYPE: 'RAW',
    ATTACHMENT_FILENAME: 'REDACTED',
    SENDER_ROLE_OR_DOMAIN: 'RAW', SENDER_EXACT: 'RAW',
    SUBJECT: 'REDACTED', SUMMARY: 'REDACTED',
    BODY_EXCERPT: 'REDACTED', BODY_FULL: 'REDACTED',
    AMOUNT: 'RAW', ACCOUNT_IDENTIFIER: 'MASKED',
  },
}

/** Fields no tier and no destination may ever receive. Not a table lookup — a
 *  hard rule, so it cannot be widened by editing a row.
 *
 *  Istvan: "CREDENTIAL/AUTH_TOKEN: minden LLM disclosure = DENY" and
 *  "credential/auth token itt sem kerülhet promptba csak azért, mert a
 *  destination belső". */
const NEVER_DISCLOSED: ReadonlySet<FieldKind> = new Set<FieldKind>([
  'CREDENTIAL', 'UNKNOWN_SECRET_LIKE',
])

// ── dimension 2: the destination's cap ──────────────────────────────────────

/** The most revealing treatment a destination class tolerates, per field. A
 *  missing entry means the tier ceiling stands. */
const TRUST_CAP: Record<DestinationTrustClass, Partial<Record<FieldKind, FieldTreatment>>> = {
  // "task-required adat mehet a sensitivity policy határain belül."
  TRUSTED_INTERNAL: {},
  // "redact/pseudonymize by default; csak task-required field mehet."
  APPROVED_EXTERNAL: {
    SENDER_EXACT: 'PSEUDONYMIZED',
    ACCOUNT_IDENTIFIER: 'MASKED',
  },
  // "csak szűk, előre definiált strukturált disclosure; full body és raw
  //  identity default DENY."
  RESTRICTED_EXTERNAL: {
    SENDER_EXACT: 'DENIED',
    BODY_FULL: 'DENIED',
    BODY_EXCERPT: 'REDACTED',
    SUBJECT: 'REDACTED',
    SUMMARY: 'REDACTED',
    AMOUNT: 'DENIED',
    ACCOUNT_IDENTIFIER: 'DENIED',
    ATTACHMENT_FILENAME: 'DENIED',
  },
  // "PERSONAL / CONFIDENTIAL / SECRET / RESTRICTED adat disclosure = DENY."
  // Enforced in the sensitivity pass, because the rule is about the DATA, not
  // the field name: an unknown destination may still receive something the
  // caller has explicitly tagged PUBLIC.
  UNKNOWN_UNTRUSTED: {},
}

/** Identity may stay exact only when the reasoning is about WHO, and only
 *  inside. Istvan allows exact identity for DEEP analysis "ha az identitás maga
 *  releváns"; the APPROVED_EXTERNAL cap still pseudonymises it, so the exception
 *  is meaningful only for a trusted-internal destination. */
function identityException(req: DisclosureRequest, kind: FieldKind): boolean {
  return kind === 'SENDER_EXACT'
    && req.taskTier === 'DEEP_ANALYSIS'
    && req.identityRelevant === true
    && req.trustClass === 'TRUSTED_INTERNAL'
}

// ── dimension 3: the data's own sensitivity ─────────────────────────────────

/** The rank of a sensitivity tier, derived from CASE_SENSITIVITIES so the order
 *  has ONE definition.
 *
 *  Built lazily rather than at module scope, and the reason is mechanical:
 *  schema.ts imports this module (to create the record table) and this module
 *  imports CASE_SENSITIVITIES from schema.ts. Under that cycle a module-scope
 *  `CASE_SENSITIVITIES.map(...)` runs while the other half is still
 *  initialising and reads `undefined`. Copying the list here would have removed
 *  the cycle and reintroduced the thing this packet keeps closing: two
 *  definitions of one order. */
let rankCache: Record<string, number> | null = null
function rank(tier: CaseSensitivity): number {
  if (!rankCache) {
    rankCache = {}
    CASE_SENSITIVITIES.forEach((s, i) => { (rankCache as Record<string, number>)[s] = i })
  }
  return rankCache[tier] ?? 0
}

/** Everything at PERSONAL or above is what an unknown destination may not see. */
const personalFloor = () => rank('PERSONAL')

// ── the transforms ──────────────────────────────────────────────────────────

/** Patterns a REDACTED text has removed. Deliberately few and structural: an
 *  IBAN, a Hungarian account number, an email address, a phone number. This is
 *  not a language model and must not pretend to recognise "sensitive-sounding"
 *  prose — a redactor that claims more than it does is worse than one that says
 *  exactly what it removes. */
const REDACTIONS: Array<{ re: RegExp; as: string }> = [
  { re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, as: '[IBAN]' },
  { re: /\b\d{8}-\d{8}-\d{8}\b/g, as: '[SZAMLASZAM]' },
  { re: /\b\d{8}-\d{8}\b/g, as: '[SZAMLASZAM]' },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, as: '[EMAIL]' },
  { re: /(?:\+36|\b06)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}\b/g, as: '[TELEFON]' },
]

export function redactText(text: string): string {
  let out = text
  for (const r of REDACTIONS) out = out.replace(r.re, r.as)
  return out
}

/** A stable, non-reversible handle. Salted with the field kind so the same
 *  string in two roles does not produce one linkable identifier. */
export function pseudonymize(value: string, kind: FieldKind): string {
  const digest = createHash('sha256').update(kind + ' ' + value).digest('hex').slice(0, 12)
  return kind.toLowerCase() + ':' + digest
}

/** Last four characters, the rest replaced. For an identifier a human needs to
 *  recognise without it being re-usable. */
export function maskTail(value: string): string {
  const tail = value.replace(/\s/g, '').slice(-4)
  return tail ? '****' + tail : '****'
}

function applyTreatment(value: string, treatment: FieldTreatment, kind: FieldKind): string | undefined {
  switch (treatment) {
    // Even RAW is not raw for a KNOWN credential (W13 closure invariant). The
    // CREDENTIAL field kind is denied outright, but a credential can arrive
    // inside an ordinary field — pasted into a mail body, quoted in a subject —
    // and that field's policy has nothing to do with it. Provenance decides
    // here, not the field name.
    case 'RAW': return scrubKnownSecrets(value)
    case 'REDACTED': return scrubKnownSecrets(redactText(value))
    case 'PSEUDONYMIZED': return pseudonymize(value, kind)
    case 'MASKED': return maskTail(value)
    default: return undefined
  }
}

// ── the decision ────────────────────────────────────────────────────────────

/** Ordered from most revealing to least. Used to intersect the dimensions: each
 *  may only narrow, never widen. */
const RESTRICTIVENESS: FieldTreatment[] = ['RAW', 'MASKED', 'PSEUDONYMIZED', 'REDACTED', 'OMITTED', 'DENIED']
function narrower(a: FieldTreatment, b: FieldTreatment): FieldTreatment {
  return RESTRICTIVENESS.indexOf(a) >= RESTRICTIVENESS.indexOf(b) ? a : b
}

/**
 * Decide, field by field. Pure: no DB, no network, so the policy is testable
 * without a store and cannot be steered by anything it is deciding about.
 */
export function decideDisclosure(req: DisclosureRequest): DisclosureDecision {
  const required = new Set(req.requiredFields)
  const outcomes: FieldOutcome[] = []

  for (const f of req.fields) {
    // An explicit field tag WINS, including downward: tagging a language code
    // PUBLIC on a SENSITIVE_PERSONAL case is the caller stating a fact about
    // that field, and it is recorded in the decision record. Without a tag the
    // field inherits the case tier, which is the fail-closed default.
    const sensitivity = f.sensitivity ?? req.caseSensitivity
    const push = (treatment: FieldTreatment, reason: string) => {
      outcomes.push({
        kind: f.kind, treatment, reason, sensitivity,
        disclosed: applyTreatment(f.value, treatment, f.kind),
      })
    }

    // 0. Never, by any combination of the three dimensions.
    if (NEVER_DISCLOSED.has(f.kind)) {
      push('DENIED', f.kind + ' is never disclosed to any destination, internal included')
      continue
    }

    // 1. MINIMUM NECESSARY, before any policy question. A field the task did
    //    not ask for does not need a policy to keep it out.
    if (!required.has(f.kind)) {
      push('OMITTED', 'not required by the task (minimum necessary)')
      continue
    }

    // 2. The task tier's ceiling.
    const ceiling = TIER_CEILING[req.taskTier][f.kind]
    if (!ceiling) {
      push('DENIED', 'task tier ' + req.taskTier + ' has no disclosure rule for ' + f.kind)
      continue
    }
    let treatment = ceiling
    let reason = 'tier ' + req.taskTier + ' allows ' + treatment

    // 2b. AMOUNT is task-conditional, not tier-conditional.
    if (f.kind === 'AMOUNT' && !req.financiallyRelevant) {
      push('DENIED', 'amount is disclosed only when the task is financially relevant')
      continue
    }

    // 3. The destination's cap.
    const cap = TRUST_CAP[req.trustClass][f.kind]
    if (cap && !identityException(req, f.kind)) {
      const capped = narrower(treatment, cap)
      if (capped !== treatment) reason = 'destination ' + req.trustClass + ' caps ' + f.kind + ' at ' + capped
      treatment = capped
    }
    if (treatment === 'DENIED') { push('DENIED', reason); continue }

    // 4. The data's own sensitivity. An unknown destination gets nothing
    //    personal — whatever the tier says and whatever the field is.
    if (req.trustClass === 'UNKNOWN_UNTRUSTED' && rank(sensitivity) >= personalFloor()) {
      push('DENIED', 'unknown/untrusted destination may not receive ' + sensitivity + ' data')
      continue
    }
    // A raw financial identifier needs BOTH an internal destination and stated
    // necessity; the necessity is `requiredFields`, checked at step 1.
    if (f.kind === 'ACCOUNT_IDENTIFIER' && treatment === 'RAW' && req.trustClass !== 'TRUSTED_INTERNAL') {
      treatment = 'MASKED'
      reason = 'raw account identifier is internal-only; masked outside'
    }

    push(treatment, reason)
  }

  return {
    outcomes,
    disclosedKinds: outcomes.filter(o => o.disclosed !== undefined).map(o => o.kind),
    anyDenied: outcomes.some(o => o.treatment === 'DENIED'),
  }
}

/** Map a provider name to a destination trust class, DERIVED from the existing
 *  data-handling policy rather than restated.
 *
 *  A second hand-maintained list of "which provider do we trust" is how two
 *  answers to one question get into a codebase — the exact defect W12 closed on
 *  the send ceiling. `local` is the only class this adds, because
 *  provider-data-policy has no opinion about a model that never leaves the
 *  machine. */
export function trustClassOfProvider(provider: string): DestinationTrustClass {
  const p = (provider || '').toLowerCase()
  if (p === 'local' || p === 'ollama') return 'TRUSTED_INTERNAL'
  if (p === 'unknown' || p === '') return 'UNKNOWN_UNTRUSTED'
  return dataClassOf(p) === 'CONTRACTED' ? 'APPROVED_EXTERNAL' : 'RESTRICTED_EXTERNAL'
}

// ── the record (§7.4: first-class durable data) ─────────────────────────────

export function ensureDisclosureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_disclosure_records (
      record_id        TEXT PRIMARY KEY,
      at               INTEGER NOT NULL,
      actor            TEXT NOT NULL,
      on_behalf_of     TEXT NOT NULL,
      run_id           TEXT,
      destination      TEXT NOT NULL,
      trust_class      TEXT NOT NULL,
      task_tier        TEXT NOT NULL,
      case_sensitivity TEXT NOT NULL,
      requested_fields TEXT NOT NULL,
      required_fields  TEXT NOT NULL,
      outcomes         TEXT NOT NULL,
      disclosed_fields TEXT NOT NULL,
      approval_reference TEXT,
      any_denied       INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_disclosure_at ON cos_disclosure_records(at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_disclosure_dest ON cos_disclosure_records(destination, at)`)
}

/**
 * Write the decision down. The record carries the REASONING, not the data: no
 * disclosed VALUES are stored, only which field got which treatment and why.
 *
 * That is deliberate, and it is the difference between an audit trail and a
 * second copy of the thing you were protecting. §7.7 asks that it be
 * reconstructible WHY a piece of data went out — not what it said.
 */
export function recordDisclosure(
  db: Database.Database, req: DisclosureRequest, decision: DisclosureDecision, now: number,
): string {
  const seed = now + ' ' + req.destination + ' ' + (req.runId ?? '') + ' '
    + req.fields.map(f => f.kind).join(',')
  const recordId = 'disc-' + createHash('sha256').update(seed).digest('hex').slice(0, 16)
  db.prepare(
    `INSERT OR REPLACE INTO cos_disclosure_records
      (record_id, at, actor, on_behalf_of, run_id, destination, trust_class, task_tier,
       case_sensitivity, requested_fields, required_fields, outcomes, disclosed_fields,
       approval_reference, any_denied)
     VALUES (@recordId, @at, @actor, @onBehalfOf, @runId, @destination, @trustClass, @taskTier,
       @caseSensitivity, @requested, @required, @outcomes, @disclosed, @approval, @anyDenied)`
  ).run({
    recordId, at: now, actor: req.actor, onBehalfOf: req.onBehalfOf, runId: req.runId,
    destination: req.destination, trustClass: req.trustClass, taskTier: req.taskTier,
    caseSensitivity: req.caseSensitivity,
    requested: JSON.stringify(req.fields.map(f => f.kind)),
    required: JSON.stringify(req.requiredFields),
    outcomes: JSON.stringify(decision.outcomes.map(o => ({
      kind: o.kind, treatment: o.treatment, reason: o.reason, sensitivity: o.sensitivity,
    }))),
    disclosed: JSON.stringify(decision.disclosedKinds),
    approval: req.approvalReference ?? null,
    anyDenied: decision.anyDenied ? 1 : 0,
  })
  return recordId
}

/** Decide, record, and hand back what may travel — ONE call, so a caller cannot
 *  disclose without the record being written. The two used to be separable only
 *  in theory; here they are not separable at all. */
export function discloseAndRecord(
  db: Database.Database, req: DisclosureRequest, now: number,
): { decision: DisclosureDecision; recordId: string; disclosed: Array<{ kind: FieldKind; value: string }> } {
  const decision = decideDisclosure(req)
  const recordId = recordDisclosure(db, req, decision, now)
  const disclosed = decision.outcomes
    .filter(o => o.disclosed !== undefined)
    .map(o => ({ kind: o.kind, value: o.disclosed as string }))
  return { decision, recordId, disclosed }
}

/** Read a record back, hydrated. The audit surface for §7.7's "reconstructible
 *  why". */
export function getDisclosureRecord(db: Database.Database, recordId: string): {
  recordId: string; at: number; actor: string; onBehalfOf: string; runId: string | null
  destination: string; trustClass: string; taskTier: string; caseSensitivity: string
  requestedFields: FieldKind[]; requiredFields: FieldKind[]
  outcomes: Array<{ kind: FieldKind; treatment: FieldTreatment; reason: string; sensitivity: CaseSensitivity }>
  disclosedFields: FieldKind[]; approvalReference: string | null; anyDenied: boolean
} | null {
  const r = db.prepare(`SELECT * FROM cos_disclosure_records WHERE record_id = ?`).get(recordId) as
    | Record<string, string | number | null> | undefined
  if (!r) return null
  return {
    recordId: String(r.record_id), at: Number(r.at), actor: String(r.actor),
    onBehalfOf: String(r.on_behalf_of), runId: r.run_id === null ? null : String(r.run_id),
    destination: String(r.destination), trustClass: String(r.trust_class),
    taskTier: String(r.task_tier), caseSensitivity: String(r.case_sensitivity),
    requestedFields: JSON.parse(String(r.requested_fields)),
    requiredFields: JSON.parse(String(r.required_fields)),
    outcomes: JSON.parse(String(r.outcomes)),
    disclosedFields: JSON.parse(String(r.disclosed_fields)),
    approvalReference: r.approval_reference === null ? null : String(r.approval_reference),
    anyDenied: Number(r.any_denied) === 1,
  }
}
