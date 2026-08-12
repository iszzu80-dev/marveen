// §21 — the Delegation Envelope.
//
// WHAT THIS IS, IN ONE LINE. The spec's chokepoint reads
//
//     LLM → Action Proposal → deterministic Policy Evaluation
//         → standing delegation OR human approval → Executor → readback
//
// and until now only the right-hand branch existed. `delegation_envelope_id` was
// a column that travelled through the system, counted towards the policy hash,
// and was NULL on every row ever written, because no caller set it. This is the
// left-hand branch: the narrow, named permission that lets a class of mail go
// without asking Istvan each time.
//
// WHOSE DECISION EACH LINE IS. Everything below the "Istvan, 2026-08-12" marks
// is his answer to a direct question, quoted rather than paraphrased. That
// matters more here than anywhere else in the codebase: an envelope is the one
// place where the system acts in his name without asking first, so the record of
// what he actually agreed to has to be readable next to the code that acts on
// it. Where I made a judgement call rather than quoting him, it is marked
// MY READING and says what the alternative was.
//
// WHAT AN ENVELOPE DOES NOT DO. It substitutes for the campaign APPROVAL and for
// nothing else. Connector health, the sensitivity/profile rule and the §22
// autonomy rung are ANDed as before — a standing delegation is permission to
// skip the question, never permission to skip a safety layer. The dispatch gate
// enforces that by construction: the envelope is consulted only after the other
// three have passed.

import type Database from 'better-sqlite3'

// ── The vocabulary ────────────────────────────────────────────────────────

/** §21's five intents, plus the one the spec does not name and the system needs
 *  most: "I could not tell". */
export const INTENTS = [
  'factual_reply',
  'clarification',
  'quote_request',
  'routine_followup',
  'non_binding_scheduling_question',
  /** Not an intent — the absence of one. Everything that is not POSITIVELY
   *  recognised lands here, and nothing here is ever delegated. */
  'UNCLASSIFIED',
] as const
export type Intent = typeof INTENTS[number]

export interface DelegationEnvelope {
  id: string
  domain: 'personal' | 'zst'
  actionType: string
  /** Which intents may go without asking. */
  allowedIntents: Intent[]
  /** Which of those may OPEN a thread rather than continue one. A subset of
   *  allowedIntents, never equal to it by accident — see the note on the
   *  personal envelope. */
  newThreadIntents: Intent[]
  /** null = any recipient the other layers already permit. A list = only these.
   *  Compared case-insensitively on the full address. */
  recipientAllowlist: string[] | null
  /** §21. Zero means the letter may not commit money at all. */
  maxFinancialCommitment: number
  /** A ceiling the spec does not name and a standing delegation cannot go
   *  without. The campaign approval it replaces carried quota limits; dropping
   *  those along with the question would turn "you need not ask me" into "you
   *  need not stop". Per envelope, per day. */
  maxSendsPerDay: number
  /** §21: `requires_readback`. Recorded here so the value is visible next to the
   *  permission it belongs to; the executor already performs the readback. */
  requiresReadback: boolean
}

// ── The envelopes Istvan authorised, 2026-08-12 ───────────────────────────

/**
 * THE PERSONAL ENVELOPE.
 *
 * Istvan, on each of the seven questions:
 *
 *  1. "legyen állandó delegálás, szükségem lenne hogy automatán kezelje az
 *     ügyeimet" — so the envelope exists and is active, rather than being a
 *     mechanism waiting for a later switch-on.
 *  2. "kérhet a nevemben, ez ok, ez még nem elköteleződés" — `quote_request` is
 *     IN. Asking a price commits nothing, which is also why maxFinancial stays
 *     at zero underneath it.
 *  3. "szerintem indíthat új szálat ha nem olyannal kezdi ami komolyabb lépés"
 *  4. "valóban nulla most. később ez emelhető lesz" — hence a field rather than
 *     a hardcoded 0, so raising it is one reviewed line.
 *  7. "rossz küldés vagy panasz kapcsolja ki és utána vissza lehessen
 *     kapcsolni" — see revokeEnvelope / restoreEnvelope, and the automatic
 *     detection in envelopeRefusals.
 *
 * MY READING, ON QUESTION 3, AND WHAT THE ALTERNATIVE WAS. "Not something more
 * serious to start with" splits the intents rather than the threads: continuing
 * a conversation is one thing, opening one is another. So a new thread may carry
 * the four light intents — and NOT `quote_request`, because a cold letter to a
 * supplier asking for a price is a business approach made in his name, which is
 * the most serious thing on this list to open with. Inside a thread that already
 * exists it stays allowed, exactly as he said.
 *
 * The alternative reading is that any allowed intent may open a thread, in which
 * case `newThreadIntents` gains 'quote_request' and nothing else changes. That
 * is a one-line edit, and it is his to make, not mine.
 */
export const PERSONAL_EMAIL_ENVELOPE: DelegationEnvelope = {
  id: 'pri-email-v1',
  domain: 'personal',
  actionType: 'EMAIL_SEND',
  allowedIntents: [
    'factual_reply', 'clarification', 'quote_request',
    'routine_followup', 'non_binding_scheduling_question',
  ],
  newThreadIntents: [
    'factual_reply', 'clarification', 'routine_followup', 'non_binding_scheduling_question',
  ],
  recipientAllowlist: null,
  maxFinancialCommitment: 0,
  maxSendsPerDay: 10,
  requiresReadback: true,
}

/**
 * THE CORPORATE ENVELOPE.
 *
 * Istvan, question 6: "A COS a cég nevében is küldhet majd levelet."
 * Question 5, the allowlist: "A könyvelő a relacio@t-online.hu, Inci."
 *
 * ONE NAME IS THE WHOLE LIST, AND THAT IS DELIBERATE. §21 asks for an
 * "accountant/vendor allowlist"; Istvan named the accountant and no vendors. The
 * honest encoding of that is a list with one entry, not a list with one entry
 * and a permissive default underneath it — an empty or null allowlist here would
 * mean the corporate side delegates to anyone, which is not what he answered.
 * Adding a vendor is a line in this array and an owner decision each time.
 *
 * NARROWER THAN PERSONAL ON TWO MORE AXES, and neither is arbitrary. No new
 * threads at all: an unsolicited letter from the company to an address on the
 * list is a business approach with no case history behind it. And no
 * `quote_request`: asking a supplier for a price on the company's behalf is a
 * procurement signal. Both are reachable through the normal approval path, which
 * is exactly what the approval path is for.
 */
export const ZST_EMAIL_ENVELOPE: DelegationEnvelope = {
  id: 'zst-email-v1',
  domain: 'zst',
  actionType: 'EMAIL_SEND',
  allowedIntents: ['factual_reply', 'clarification', 'routine_followup'],
  newThreadIntents: [],
  recipientAllowlist: ['relacio@t-online.hu'],
  maxFinancialCommitment: 0,
  maxSendsPerDay: 5,
  requiresReadback: true,
}

export const ENVELOPES: DelegationEnvelope[] = [PERSONAL_EMAIL_ENVELOPE, ZST_EMAIL_ENVELOPE]

export function envelopeById(id: string): DelegationEnvelope | null {
  return ENVELOPES.find(e => e.id === id) ?? null
}

// ── Runtime state: revoked / restored ─────────────────────────────────────
//
// SEPARATE FROM THE POLICY ABOVE, ON PURPOSE. Changing what may be delegated is
// a reviewed code change. Switching a delegation OFF after a bad send is an
// operational act that has to work at three in the morning without a deploy —
// Istvan's question 7 is precisely that. Two different things, two different
// places.

export function ensureEnvelopeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_envelope_state (
      envelope_id   TEXT PRIMARY KEY,
      revoked_at    INTEGER,
      revoked_reason TEXT,
      restored_at   INTEGER,
      restored_by   TEXT,
      updated_at    INTEGER NOT NULL
    )
  `)
}

/** Switch a delegation off. Istvan's "panasz" arm — a human says stop, and the
 *  next send on that envelope goes back to needing an approval. */
export function revokeEnvelope(
  db: Database.Database, envelopeId: string, reason: string, now: number,
): void {
  ensureEnvelopeSchema(db)
  db.prepare(
    `INSERT INTO delegation_envelope_state (envelope_id, revoked_at, revoked_reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (envelope_id) DO UPDATE
       SET revoked_at = excluded.revoked_at, revoked_reason = excluded.revoked_reason,
           restored_at = NULL, restored_by = NULL, updated_at = excluded.updated_at`,
  ).run(envelopeId, now, reason.slice(0, 500), now)
}

/** Switch it back on — "utána vissza lehessen kapcsolni".
 *
 *  ALWAYS EXPLICIT, NEVER ON A TIMER. A delegation that comes back by itself
 *  after a bad send is a delegation that was never really withdrawn, and the
 *  owner would have to notice its return to object to it. `restoredBy` is
 *  recorded because "who turned this back on" is the first question anyone asks
 *  about the send after it. */
export function restoreEnvelope(
  db: Database.Database, envelopeId: string, restoredBy: string, now: number,
): void {
  ensureEnvelopeSchema(db)
  db.prepare(
    `INSERT INTO delegation_envelope_state (envelope_id, restored_at, restored_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (envelope_id) DO UPDATE
       SET revoked_at = NULL, revoked_reason = NULL,
           restored_at = excluded.restored_at, restored_by = excluded.restored_by,
           updated_at = excluded.updated_at`,
  ).run(envelopeId, now, restoredBy, now)
}

export interface EnvelopeState {
  envelopeId: string
  revokedAt: number | null
  revokedReason: string | null
  restoredAt: number | null
  restoredBy: string | null
}

export function envelopeState(db: Database.Database, envelopeId: string): EnvelopeState | null {
  try {
    const r = db.prepare(
      `SELECT envelope_id AS envelopeId, revoked_at AS revokedAt, revoked_reason AS revokedReason,
              restored_at AS restoredAt, restored_by AS restoredBy
         FROM delegation_envelope_state WHERE envelope_id = ?`,
    ).get(envelopeId) as EnvelopeState | undefined
    return r ?? null
  } catch { return null }
}

// ── Intent derivation ─────────────────────────────────────────────────────
//
// THE HONEST PART OF THIS FILE, AND THE REASON THE FIRST ENVELOPE IS NARROW.
//
// §21 keys the permission on `allowed_intents`, which presupposes something that
// decides which intent a given draft IS. Today `intent` is the single hardcoded
// constant 'SEND_APPROVED_EMAIL' at both send sites, so that something does not
// exist. The obvious way to build it is to ask a model — and then the permission
// to act in Istvan's name without asking him rests on a judgement that can be
// wrong, silently, in the direction of doing more.
//
// So this is deterministic and it only ever says YES on a positive match. There
// is no path where an ambiguous draft is classified generously: everything that
// is not recognised returns UNCLASSIFIED, which no envelope allows, which means
// the send falls back to exactly today's behaviour — ask Istvan. The classifier
// can therefore only ever cost an unnecessary question, never an unwanted
// letter.
//
// The word lists are Hungarian first because his mail is.

/** Anything that could read as committing him. A single hit anywhere in the
 *  letter is disqualifying — this list is checked BEFORE any positive rule, so
 *  a polite scheduling question that also accepts an offer is not a scheduling
 *  question. */
// STEMS, NOT CONJUGATIONS, AND A TEST IS WHY. My first version enumerated the
// suffixes — `utal(ok|juk|ás|as)` — and Hungarian promptly produced "utalom",
// which is none of them, in a letter that also asked a harmless scheduling
// question. The letter classified as `non_binding_scheduling_question` and would
// have gone out on the standing delegation saying it would transfer the money.
//
// Enumerating Hungarian verb endings is a losing game and the wrong risk to
// take: here, over-matching costs an unnecessary question and under-matching
// sends a letter nobody read. So these match the STEM and whatever follows it.
// "utalvány" and "foglalkozik" will trip them; that is the correct direction to
// be wrong in.
const COMMITMENT_MARKERS: RegExp[] = [
  /\belfogad/i,
  /\bmegrendel/i,
  /\bmegbíz/i, /\bmegbiz/i,
  /\bszerződ/i, /\bszerzod/i,
  /\baláír/i, /\balair/i,
  /\butal/i,
  /\bfizet/i,
  /\bvállal/i, /\bvallal/i,
  /\bkötelez/i, /\bkotelez/i,
  /\bfoglal/i,
  /\bIBAN\b/i, /\bHU\d{2}[\s-]?\d{4}/,
  /\bcommit/i, /\baccept/i, /\border/i, /\bsign(ed|ing|ature)?\b/i,
]

/** A money amount in the letter. Not automatically disqualifying — a quote
 *  REQUEST may name a budget — but combined with maxFinancialCommitment: 0 it
 *  is, which is where the two rules meet. */
const MONEY = /(\d[\d\s.,]{2,})\s*(ft|huf|eur|€|usd|\$)\b/i

const QUOTE_WORDS = /\b(árajánlat|arajanlat|ajánlatot kér|ajanlatot ker|mennyibe kerül|mennyibe kerul|díjszabás|dijszabas|quote|pricing)\b/i
const SCHEDULE_WORDS = /\b(időpont|idopont|mikor (érne|erne|lenne|felel)|egyeztet|naptár|naptar|ráér|raer|alkalmas[- ]e)\b/i
const CLARIFY_WORDS = /\b(pontosít|pontosit|tisztáz|tisztaz|jól értem|jol ertem|mit jelent|melyik(re|et)?\b)/i
const FOLLOWUP_WORDS = /\b(emlékeztet|emlekeztet|visszatérek|visszaterek|érdeklőd|erdeklod|megkaptad|megérkezett|megerkezett|frissítés|frissites|status)\b/i

export interface IntentInput {
  subject: string
  body: string
  /** INITIAL opens a thread; FOLLOW_UP and REPLY continue one. */
  outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | null
}

/**
 * Which of §21's intents this letter is, or UNCLASSIFIED.
 *
 * Order matters and is the safety property: disqualifiers first, then the
 * narrowest positive rules, then the broadest. A letter that matches nothing
 * positive is UNCLASSIFIED even if it is obviously harmless — "harmless" is a
 * judgement, and the whole point of this function is not to make one.
 */
export function deriveIntent(input: IntentInput): Intent {
  const text = `${input.subject}\n${input.body}`

  for (const m of COMMITMENT_MARKERS) if (m.test(text)) return 'UNCLASSIFIED'

  const asksSomething = /\?/.test(text)

  if (QUOTE_WORDS.test(text)) return asksSomething ? 'quote_request' : 'UNCLASSIFIED'
  if (SCHEDULE_WORDS.test(text) && asksSomething) return 'non_binding_scheduling_question'
  if (CLARIFY_WORDS.test(text) && asksSomething) return 'clarification'
  if (FOLLOWUP_WORDS.test(text)) return 'routine_followup'

  // A REPLY that states something, asks nothing, promises nothing and names no
  // amount is the narrowest useful case there is — and it is the bulk of what a
  // chief of staff actually writes.
  const continues = input.outboundKind === 'REPLY' || input.outboundKind === 'FOLLOW_UP'
  if (continues && !asksSomething && !MONEY.test(text)) return 'factual_reply'

  return 'UNCLASSIFIED'
}

// ── Evaluation ────────────────────────────────────────────────────────────

export interface EnvelopeRequest {
  domain: 'personal' | 'zst'
  actionType: string
  recipient: string
  subject: string
  body: string
  outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | null
  now: number
}

export type EnvelopeDecision =
  | { delegated: true; envelopeId: string; intent: Intent }
  | { delegated: false; reasons: string[]; intent: Intent }

/** How many sends this envelope has already made today. Counted from the ledger
 *  rows that name it, which is the only record that cannot drift from what
 *  actually went out. */
function sentToday(db: Database.Database, env: DelegationEnvelope, now: number): number {
  const ledger = env.domain === 'zst' ? 'zst_outbound_ledger' : 'outbound_ledger'
  const since = now - 86_400
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM ${ledger} l
         JOIN action_authorizations a ON a.action_id = l.ledger_id
        WHERE a.delegation_envelope_id = ?
          AND l.status NOT IN ('PLANNED','CANCELLED')
          AND l.created_at >= ?`,
    ).get(env.id, since) as { n: number }).n
  } catch { return 0 }
}

/**
 * Has a send under this envelope already gone wrong?
 *
 * Istvan's question 7 names two triggers: "rossz küldés vagy panasz". A
 * complaint is a human act and arrives through revokeEnvelope. A bad send is
 * something the system can see for itself, and this is that half.
 *
 * CHECKED LAZILY AT EVALUATION TIME rather than pushed from the executor, and
 * the reason is the defect class this review has spent a week on: a hook the
 * executor must remember to call is a hook that stops being called the day
 * somebody adds a second send path. A question asked here cannot be forgotten,
 * because nothing is delegated without asking it.
 */
function badSendUnder(db: Database.Database, env: DelegationEnvelope): string | null {
  const ledger = env.domain === 'zst' ? 'zst_outbound_ledger' : 'outbound_ledger'
  try {
    const row = db.prepare(
      `SELECT l.ledger_id, l.status FROM ${ledger} l
         JOIN action_authorizations a ON a.action_id = l.ledger_id
        WHERE a.delegation_envelope_id = ?
          AND l.status IN ('FAILED_TERMINAL','OUTCOME_UNKNOWN','RECOVERY_REQUIRED')
        LIMIT 1`,
    ).get(env.id) as { ledger_id: string; status: string } | undefined
    return row ? `${row.ledger_id} (${row.status})` : null
  } catch { return null }
}

/**
 * May this send go WITHOUT asking Istvan?
 *
 * Returns the reasons when it may not, because a refusal that does not say why
 * is indistinguishable from a system that is broken — and the fallback is not a
 * failure, it is the approval path doing its job.
 */
export function evaluateEnvelope(db: Database.Database, req: EnvelopeRequest): EnvelopeDecision {
  const intent = deriveIntent({ subject: req.subject, body: req.body, outboundKind: req.outboundKind })
  const reasons: string[] = []

  const env = ENVELOPES.find(e => e.domain === req.domain && e.actionType === req.actionType)
  if (!env) {
    return { delegated: false, intent, reasons: [`nincs delegálás ${req.domain}/${req.actionType} típusra`] }
  }

  const state = envelopeState(db, env.id)
  if (state?.revokedAt) {
    reasons.push(`a delegálás vissza van vonva: ${state.revokedReason ?? 'nincs indok rögzítve'}`)
  }

  const bad = badSendUnder(db, env)
  if (bad) reasons.push(`korábbi hibás küldés a delegálás alatt: ${bad}`)

  if (intent === 'UNCLASSIFIED') {
    reasons.push('a levél szándéka nem azonosítható determinisztikusan')
  } else if (!env.allowedIntents.includes(intent)) {
    reasons.push(`a(z) ${intent} szándék nincs a delegálásban`)
  }

  // §21 existing_thread_only, in the form Istvan actually described it: not a
  // blanket ban on new threads, but a shorter list of things one may open with.
  const opensThread = req.outboundKind === 'INITIAL' || !req.outboundKind
  if (opensThread && !env.newThreadIntents.includes(intent)) {
    reasons.push(`új szálat nem indíthat ${intent === 'UNCLASSIFIED' ? 'azonosítatlan' : intent} szándékkal`)
  }

  if (env.recipientAllowlist) {
    const to = req.recipient.trim().toLowerCase()
    if (!env.recipientAllowlist.some(a => a.trim().toLowerCase() === to)) {
      reasons.push(`a címzett (${req.recipient}) nincs a delegálás listáján`)
    }
  }

  // maxFinancialCommitment: 0 means the letter must name no amount at all. Any
  // amount in a letter that may not commit anything is a letter someone should
  // read — including a quote request, where a stated budget IS a signal.
  if (env.maxFinancialCommitment === 0 && MONEY.test(`${req.subject}\n${req.body}`)) {
    reasons.push('a levél összeget tartalmaz, a delegálás pénzügyi kerete nulla')
  }

  const today = sentToday(db, env, req.now)
  if (today >= env.maxSendsPerDay) {
    reasons.push(`napi keret kimerült (${today}/${env.maxSendsPerDay})`)
  }

  if (reasons.length > 0) return { delegated: false, intent, reasons }
  return { delegated: true, envelopeId: env.id, intent }
}
