// Personal Chief of Staff (COS) — linking cases across threads.
//
// The intake links a message to a case by Gmail thread id. That covers a reply
// arriving on a conversation we already know, and nothing else. On 2026-08-09 a
// GLS pickup notice opened its own case beside the open eCipő/Modivo claim it
// belonged to, because a courier writes from its own address on its own thread —
// so the step that actually advanced the claim landed next to it instead of in
// it. The claim's next action still read "pack the shoe" hours after the parcel
// had been collected.
//
// What links them is neither the thread nor the sender: it is a shared entity —
// an order number, a parcel number, a merchant. This module extracts those and
// proposes links.
//
// PROPOSES. Nothing here writes a link on its own. Two cases that mention "GLS"
// are not the same matter, and an automatic link on a weak signal produces a
// case graph nobody trusts, which is worse than no graph. Strong evidence (a
// shared long identifier) is offered as a confident suggestion; weak evidence
// (a merchant name alone) is offered as a question. linkCases() is the explicit
// write, and it records WHY, so a wrong link can be traced back and undone.

import type Database from 'better-sqlite3'
import { CaseConcurrencyError } from './case-engine-core.js'

export type LinkStrength = 'STRONG' | 'WEAK'

export interface Entities {
  /** Order / claim / booking numbers: 6+ digits, the shape that identifies a
   *  transaction rather than a date, a phone number or an amount. */
  identifiers: string[]
  /** Merchant / brand names recognised from a known list. */
  merchants: string[]
}

export interface LinkCandidate {
  caseId: string
  title: string
  strength: LinkStrength
  /** The exact shared value, so a human can check the match rather than trust it. */
  evidence: string
  /**
   * May this link be written WITHOUT a human?
   *
   * A STRONG identifier match is not by itself permission. The text being
   * scanned is a STRANGER'S EMAIL: a sender who knows (or guesses) another
   * case's order number can put it in their own message and have the two cases
   * wired together — deterministically, with no human in the loop. "Reversible"
   * is only a comfort if somebody notices, and nobody is watching a link that
   * looks plausible.
   *
   * So auto-linking additionally requires the shared identifier to appear in a
   * TRUSTED field on at least one side: text the owner or this system wrote,
   * never text a correspondent supplied. Everything else is a SUGGESTION.
   */
  autoLinkable: boolean
}

/** Merchants worth matching on. Couriers are deliberately EXCLUDED: half the
 *  shopping cases in the store mention GLS or Foxpost, so matching on a carrier
 *  would connect unrelated purchases to each other. A carrier tells you how a
 *  parcel moved, never whose it was. */
export const MERCHANTS = [
  'modivo', 'ecipo', 'ecipő', 'emag', 'alza', 'ikea', 'decathlon', 'temu',
  'zalando', 'notino', 'euronics', 'mediamarkt', 'hervis', 'intersport',
  'discovercars', 'centauro', 'hertz', 'booking.com', 'wizz', 'ryanair',
]

/** Carriers and other words that look like merchants but identify a channel. */
export const CARRIERS = ['gls', 'foxpost', 'dpd', 'ups', 'fedex', 'mpl', 'posta', 'packeta']

// Candidate identifiers, with one character of context on each side so the
// disqualifiers below can see a leading '+' or a trailing ' Ft'.
const ID_RE = /\b\d{6,}\b/g

/** Digit runs that LOOK like an identifier and are not one.
 *
 *  `\b\d{6,}\b` on its own matches a phone number in a signature footer, a date
 *  written 20260809, a tracking code and an invoice total. Two unrelated
 *  merchants that print the same courier hotline in their footers were enough to
 *  auto-link their cases to each other, which is not a hypothetical: a hotline
 *  number is on every shipping mail the store holds.
 *
 *  Every rule here narrows what may be treated as an ORDER NUMBER. A false
 *  negative costs a suggestion nobody made; a false positive costs a wrong edge
 *  in the case graph, which then has to be disproved. */
function looksLikeDate(digits: string): boolean {
  // 20260809 — a compact ISO date, which is also how some systems stamp files.
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(digits)) return true
  // 202608 — year+month, the shape of a statement/period reference.
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])$/.test(digits)) return true
  return false
}

function looksLikePhone(digits: string, before: string, after: string): boolean {
  // A leading '+' (or an international 00 prefix) makes it a phone, whatever the
  // digits say. `before` is the text immediately preceding the run.
  if (/[+]\s?$/.test(before)) return true
  if (/\b00\s?$/.test(before)) return true
  // Hungarian numbers written without separators: 06 30 123 4567 / +36 …
  if (/^(?:06|36)\d{7,10}$/.test(digits)) return true
  // A run that continues into further digit groups is a phone/IBAN fragment,
  // not a standalone identifier: "30 123 4567" after a "+36".
  if (/^\s?\d/.test(after)) return true
  return false
}

/** A whole phone number as written by a human: an international or 06 prefix
 *  followed by digit groups. Matched and BLANKED before identifiers are read,
 *  because the digit groups of "+36 1 8888888" are individually innocent — the
 *  last one is a perfectly good `\d{6,}` and became the "shared identifier" that
 *  linked two merchants who print the same courier hotline. */
const PHONE_LIKE_RE = /(?:\+|\b00)[\s.\-/()]{0,2}\d[\d\s.\-/()]{5,}\d|\b06[\s.\-/]?\d[\d\s.\-/]{5,}\d/g

/** Replace phone-shaped runs with spaces, preserving length so the surrounding
 *  context offsets used below stay meaningful. */
function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_LIKE_RE, (m2) => ' '.repeat(m2.length))
}

const AMOUNT_SUFFIX = /^\s?(?:ft\b|huf\b|eur\b|usd\b|gbp\b|,-|\.-|€|\$)/i
const AMOUNT_PREFIX = /(?:€|\$|\b(?:huf|eur|usd|gbp)\s?)$/i

function looksLikeAmount(before: string, after: string): boolean {
  return AMOUNT_SUFFIX.test(after) || AMOUNT_PREFIX.test(before)
}

/** Is this digit run usable as a transaction identifier? */
export function isLinkableIdentifier(digits: string, before = '', after = ''): boolean {
  if (looksLikeDate(digits)) return false
  if (looksLikePhone(digits, before, after)) return false
  if (looksLikeAmount(before, after)) return false
  return true
}

const ACCENTS = 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ'
const PLAIN = 'aeiooouuuAEIOOOUUU'
function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const i = ACCENTS.indexOf(ch)
    out += i >= 0 ? PLAIN[i] : ch
  }
  return out.toLowerCase()
}

/** Pull the linkable entities out of free text (subject + body + description). */
export function extractEntities(text: string): Entities {
  const raw = text ?? ''
  const folded = fold(raw)
  const scanned = maskPhoneNumbers(raw)
  const ids: string[] = []
  ID_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ID_RE.exec(scanned)) !== null) {
    // Four characters of context is enough for every disqualifier: a '+', an
    // 'HUF ', a continuing digit group, a trailing ' Ft'.
    const before = scanned.slice(Math.max(0, m.index - 4), m.index)
    const after = scanned.slice(m.index + m[0].length, m.index + m[0].length + 4)
    if (isLinkableIdentifier(m[0], before, after)) ids.push(m[0])
  }
  const identifiers = Array.from(new Set(ids))
  const merchants = MERCHANTS.filter((m2) => folded.includes(fold(m2)))
  // De-duplicate the ecipo/ecipő spellings into one merchant.
  const normalised = Array.from(new Set(merchants.map((m) => fold(m))))
  return { identifiers, merchants: normalised }
}

interface CaseRow {
  case_id: string; title: string; description: string | null; source_references: string | null
  next_action: string | null; waiting_on: string | null; blocked_reason: string | null; closure_reason: string | null
}

/** The case columns whose text the OWNER or this SYSTEM authored.
 *
 *  `title` and `description` are NOT here, and that is the whole point: intake
 *  copies the title straight from a stranger's Subject line and the description
 *  from the From header, so an identifier found there proves only that somebody
 *  typed it. `source_references` is the message id we recorded; the rest are
 *  fields the owner or the engine wrote while working the case. */
const TRUSTED_CASE_FIELDS = ['source_references', 'next_action', 'waiting_on', 'blocked_reason', 'closure_reason'] as const

function trustedBlob(r: CaseRow): string {
  return TRUSTED_CASE_FIELDS.map((f) => r[f] ?? '').join('\n')
}

export interface SuggestOptions {
  /** Text on the INCOMING side that the caller vouches for — owner-typed, or a
   *  structured field from a provider we trust. Intake has none (its whole input
   *  is the correspondent's message), which is why the intake path can only
   *  auto-link on the CASE side's trusted fields. */
  trustedText?: string
}

/** Propose links for `text` against the OPEN cases, excluding `excludeCaseId`.
 *
 *  Ordering is deliberate: STRONG first. A caller that takes only the first
 *  candidate should get the identifier match, never the brand coincidence. */
export function suggestLinks(
  db: Database.Database,
  text: string,
  excludeCaseId?: string,
  table = 'personal_cases',
  opts: SuggestOptions = {},
): LinkCandidate[] {
  const want = extractEntities(text)
  if (!want.identifiers.length && !want.merchants.length) return []
  const trustedIncoming = opts.trustedText ? extractEntities(opts.trustedText).identifiers : []

  let rows: CaseRow[] = []
  try {
    rows = db.prepare(
      `SELECT case_id, title, description, source_references,
              next_action, waiting_on, blocked_reason, closure_reason FROM ${table}
       WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')`
    ).all() as CaseRow[]
  } catch (e) {
    // Only "the table is not there" — this runs against installs where the ZST
    // namespace has not been migrated yet. A corrupted store reading as "no
    // candidates" is how a linking outage looks like a quiet week.
    if (isMissingTableError(e, table)) return []
    throw e
  }

  const out: LinkCandidate[] = []
  for (const r of rows) {
    if (r.case_id === excludeCaseId) continue
    // The trusted fields are part of what we MATCH on as well as what we trust:
    // an order number the owner recorded in waiting_on is exactly the kind of
    // identifier a courier's mail should find.
    const trusted = trustedBlob(r)
    const have = extractEntities(`${r.title}\n${r.description ?? ''}\n${trusted}`)

    const sharedId = want.identifiers.find((i) => have.identifiers.includes(i))
    if (sharedId) {
      const trustedHere = extractEntities(trustedBlob(r)).identifiers.includes(sharedId)
      out.push({
        caseId: r.case_id, title: r.title, strength: 'STRONG', evidence: `azonosító: ${sharedId}`,
        autoLinkable: trustedHere || trustedIncoming.includes(sharedId),
      })
      continue
    }
    const sharedMerchant = want.merchants.find((m) => have.merchants.includes(m))
    if (sharedMerchant) {
      // A merchant name was never auto-linkable and still is not: two cases
      // mentioning the same shop are usually unrelated.
      out.push({ caseId: r.case_id, title: r.title, strength: 'WEAK', evidence: `kereskedő: ${sharedMerchant}`, autoLinkable: false })
    }
  }
  const rank: Record<LinkStrength, number> = { STRONG: 0, WEAK: 1 }
  return out.sort((a, b) => rank[a.strength] - rank[b.strength])
}

/** SQLite's "no such table" for the table we asked about, and nothing else. */
function isMissingTableError(e: unknown, table: string): boolean {
  const msg = String((e as Error)?.message ?? '')
  return msg.includes('no such table') && msg.includes(table)
}

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export interface LinkResult {
  linked: boolean
  reason: string
}

/** Link two cases, both directions, recording WHY on each side.
 *
 *  Symmetric on purpose: a one-way link is invisible from the case you happen to
 *  open, which is the same as no link. Idempotent — re-linking an existing pair
 *  is a no-op rather than a duplicate entry. */
export function linkCases(
  db: Database.Database,
  caseA: string,
  caseB: string,
  reason: string,
  now: number,
  table = 'personal_cases',
  eventsTable = 'personal_case_events',
): LinkResult {
  if (caseA === caseB) return { linked: false, reason: 'egy ügyet nem lehet önmagához kötni' }

  const get = (id: string) =>
    db.prepare(`SELECT case_id, related_case_ids, version FROM ${table} WHERE case_id = ?`).get(id) as
      | { case_id: string; related_case_ids: string | null; version: number } | undefined

  // The whole read-modify-write runs inside ONE transaction. It used to read the
  // versions outside it and then write with `AND version = @version` while never
  // looking at info.changes: on a stale version the related_case_ids update
  // simply did not happen, and the CASE_LINKED event was inserted anyway,
  // stamped version+1 — an audit row referring to a case version that never
  // existed, describing a link that is not in the store, and quite possibly
  // one-directional (case A written, case B not). transitionCase has always
  // treated a 0-row conditional update as CaseConcurrencyError; so does this.
  const tx = db.transaction((): LinkResult => {
    const a = get(caseA), b = get(caseB)
    if (!a) return { linked: false, reason: `nincs ilyen ügy: ${caseA}` }
    if (!b) return { linked: false, reason: `nincs ilyen ügy: ${caseB}` }

    const aIds = parseIds(a.related_case_ids), bIds = parseIds(b.related_case_ids)
    if (aIds.includes(caseB) && bIds.includes(caseA)) return { linked: false, reason: 'már össze van kötve' }

    const write = (id: string, ids: string[], other: string, version: number) => {
      if (!ids.includes(other)) ids.push(other)
      const info = db.prepare(
        `UPDATE ${table} SET related_case_ids = @ids, version = version + 1, updated_at = @now
         WHERE case_id = @id AND version = @version`
      ).run({ ids: JSON.stringify(ids), now, id, version })
      // Throwing rolls the whole transaction back, so neither side is half
      // linked and NO event is written for a link that did not happen.
      if (info.changes === 0) throw new CaseConcurrencyError(id, version)
      db.prepare(
        `INSERT INTO ${eventsTable} (case_id, case_version, actor, event_type, reason, created_at)
         VALUES (@id, @v, 'marveen', 'CASE_LINKED', @reason, @now)`
      ).run({ id, v: version + 1, reason: `${other}: ${reason}`, now })
    }
    write(caseA, aIds, caseB, a.version)
    write(caseB, bIds, caseA, b.version)
    return { linked: true, reason }
  })

  // One retry, because the versions are re-read at the top of the transaction:
  // a writer that got in between the two attempts has already committed, so the
  // second read sees its version. A second failure is reported, never swallowed
  // and never written down as if it had worked.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return tx() } catch (e) {
      if (!(e instanceof CaseConcurrencyError)) throw e
      if (attempt === 1) return { linked: false, reason: `verzióütközés, az összekötés nem történt meg: ${e.message}` }
    }
  }
  /* c8 ignore next */
  return { linked: false, reason: 'verzióütközés' }
}

/** The cases linked to this one. */
export function linkedCases(db: Database.Database, caseId: string, table = 'personal_cases'): string[] {
  const r = db.prepare(`SELECT related_case_ids FROM ${table} WHERE case_id = ?`).get(caseId) as
    | { related_case_ids: string | null } | undefined
  return parseIds(r?.related_case_ids ?? null)
}
