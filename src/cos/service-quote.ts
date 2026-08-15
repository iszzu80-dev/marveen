/**
 * SERVICE_QUOTE — a renewing contract, which is not a product and must not be
 * treated as one.
 *
 * Istvan's example: the Groupama renewal in September. Also utilities, phone
 * and net, subscriptions, banks. The question is never "did the price fall
 * below X" — it is "is there a better deal, and what would it take to find
 * out".
 *
 * WHY NOT `PRODUCT` (card 2026-08-15, and the reason matters more than the
 * enum):
 *
 *   the price      a product has a list price that is simply out there;
 *                  an insurance premium depends on YOUR age, car, cover, address
 *   "cheaper"      a product: price <= target, measurable;
 *                  a service: only real AFTER a quote request
 *   the find       a product: one concrete offer, put it in a basket;
 *                  a service: CANDIDATES, from which a quote must be requested
 *   time           a product: open-ended, until it drops;
 *                  a service: bound to a renewal date, moot afterwards
 *   delivery       a product: an alert, "buy it now";
 *                  a service: a QUESTION to Istvan, "look at these three"
 *
 * Filed under one roof with the shoes, this would pick the worse of two
 * failures: never speak (there is no `price <= target` to trip) or speak
 * nonsense (an indicative calculator number reported as a real offer).
 *
 * ═══ WHAT THIS KIND NEVER DOES ═══
 *
 * IT NEVER REQUESTS A QUOTE. A quote request is an outbound action to a third
 * party carrying personal data — age, address, claims history. Istvan's mode
 * decision on 2026-08-15 is `external_shadow`, `live` not enabled, so such a
 * send has no live path today anyway. That is EXACTLY why the refusal is
 * structural here and not a mode check: a later mode change must not silently
 * turn "just a calculator lookup" into an outbound path. This module composes
 * only a question addressed to Istvan; there is no function here that can
 * address anyone else.
 */
import type Database from 'better-sqlite3'
import type { RadarItemRow } from './radar.js'

/**
 * One plausible alternative. Every field is required because a candidate
 * missing any of them is not actionable — and an unactionable candidate on a
 * list of three makes the whole list look researched when it is not.
 */
export interface QuoteCandidate {
  /** Who would provide it. */
  provider: string
  /**
   * An INDICATIVE figure or range, in the item's currency. Never a quote.
   * Nullable on purpose: "we could not establish a number" is a real answer and
   * must be sayable, exactly as `shippable: UNKNOWN` is for products. A
   * fabricated number here would be the same failure class as a calculator
   * price reported as an offer.
   */
  indicativePrice: number | null
  /** Free text when the price is a range or conditional ("kb. 90-110 e Ft/ev"). */
  indicativeNote?: string
  /** Where the figure came from. A number without a source is a rumour. */
  sourceUrl: string
  /** What Istvan would have to supply for a REAL quote. This is the field that
   *  keeps the candidate honest: it states, in the same breath, that this is
   *  not yet an offer. */
  needsForRealQuote: string
}

export const INDICATIVE_MARK = 'IRANYADO'

/** The minimum and maximum number of candidates worth putting in front of him.
 *  Fewer than two is not a comparison; more than three is a research report he
 *  did not ask for. */
export const MIN_CANDIDATES = 2
export const MAX_CANDIDATES = 3

export interface ServiceQuoteQuestion {
  text: string
  /** Stable identity of the question, so re-deriving the same candidates does
   *  not re-ask. Mirrors OwnerQuestion.hash's doctrine. */
  hash: string
}

function formatPrice(c: QuoteCandidate, currency: string): string {
  if (c.indicativeNote) return `${INDICATIVE_MARK} ${c.indicativeNote}`
  if (c.indicativePrice == null) return `${INDICATIVE_MARK} ar: NEM SIKERULT megallapitani`
  return `${INDICATIVE_MARK} kb. ${c.indicativePrice.toLocaleString('hu-HU')} ${currency}`
}

/**
 * Compose the question. Every price line carries the word IRANYADO.
 *
 * Not decoration. A calculator figure that reads like a firm offer is the same
 * error as `best_price = NULL` reading as "nothing was cheap enough": a number
 * believed to mean more than it does. The mark is applied HERE, on every line,
 * rather than once in a preamble a reader skips.
 */
export function buildServiceQuoteQuestion(
  item: Pick<RadarItemRow, 'radar_id' | 'label' | 'target_price' | 'currency' | 'expires_at'>,
  candidates: QuoteCandidate[],
): ServiceQuoteQuestion {
  const currency = item.currency ?? 'HUF'
  const deadline = item.expires_at != null
    ? new Date(item.expires_at * 1000).toISOString().slice(0, 10)
    : '(nincs datum)'
  const current = item.target_price != null
    ? `${item.target_price.toLocaleString('hu-HU')} ${currency}`
    : '(nincs rogzitve)'

  const lines = candidates.map((c, i) =>
    `${i + 1}. ${c.provider} -- ${formatPrice(c, currency)}\n`
    + `   forras: ${c.sourceUrl}\n`
    + `   valodi ajanlathoz kell: ${c.needsForRealQuote}`)

  const text =
    `❓ ${item.label} -- megujulas ${deadline}\n\n`
    + `Jelenlegi: ${current}. Talaltam ${candidates.length} lehetseges alternativat.\n`
    + `MINDEGYIK AR ${INDICATIVE_MARK}: kalkulatorbol vagy nyilvanos listabol valo, NEM ajanlat.\n`
    + `Ajanlatot NEM kertem es nem is fogok -- az a te dontesed.\n\n`
    + `${lines.join('\n\n')}\n\n`
    + `Mit szeretnel: kerjek-e valamelyiktol ajanlatot (akkor te inditod), vagy maradjon a jelenlegi?`

  return { text, hash: `service-quote:${item.radar_id}:${candidates.map(c => c.provider).sort().join('|')}` }
}

/**
 * Why this set of candidates cannot be put in front of him, or null when it
 * can.
 *
 * Refusing is the point. A list of one is not a comparison; a candidate with no
 * source is a rumour; a candidate with no "what a real quote needs" hides that
 * it is not an offer. Any of those turns a question Istvan can act on into a
 * paragraph he has to audit.
 */
export function serviceQuoteRefusal(candidates: QuoteCandidate[]): string | null {
  if (candidates.length < MIN_CANDIDATES) {
    return `${candidates.length} jelolt -- legalabb ${MIN_CANDIDATES} kell, egy lista nem osszehasonlitas`
  }
  if (candidates.length > MAX_CANDIDATES) {
    return `${candidates.length} jelolt -- legfeljebb ${MAX_CANDIDATES}, a tobbi mar kutatasi jelentes`
  }
  for (const c of candidates) {
    if (!c.provider.trim()) return 'van jelolt szolgaltato-nev nelkul'
    if (!c.sourceUrl.trim()) return `${c.provider}: nincs forras -- egy szam forras nelkul pletyka`
    if (!c.needsForRealQuote.trim()) {
      return `${c.provider}: nincs megadva, mi kell egy valodi ajanlathoz -- e nelkul ugy olvasodik, mintha mar ajanlat lenne`
    }
  }
  return null
}

/**
 * The closing sentence for a SERVICE_QUOTE whose deadline arrived.
 *
 * Separate from the digest's generic closure line because THIS kind's silence
 * is the most expensive: a renewal date passing unmentioned means Istvan
 * renewed by default without ever being asked. It says something whether or not
 * anything was found — the found case still needs the reminder that the date is
 * here, and the empty case needs it more.
 */
export function serviceQuoteClosingNote(
  item: Pick<RadarItemRow, 'label'>, candidatesFound: number,
): string {
  return candidatesFound > 0
    ? `${item.label}: a megujulas hatarideje ma van. ${candidatesFound} alternativat mutattam korabban; ha nem leptel, a jelenlegi szerzodes ujul meg.`
    : `${item.label}: a megujulas hatarideje ma van, es NEM talaltam bemutathato alternativat. Ez nem azt jelenti, hogy nincs -- azt, hogy en nem talaltam. Ha nem leptel, a jelenlegi szerzodes ujul meg.`
}

/**
 * Guard: this module must never gain a function that speaks to a third party.
 * Exported so a test can assert the surface, the same way
 * `assertNoCheckoutSurface` guards the shopping adapters — a rule that is only
 * written in a comment is a rule that a later edit does not see.
 */
export function serviceQuoteExportedSurface(): string[] {
  return [
    'buildServiceQuoteQuestion', 'serviceQuoteRefusal', 'serviceQuoteClosingNote',
    'serviceQuoteExportedSurface',
  ]
}

/** Kept as a named constant so the kind string is never re-typed. */
export const KIND_SERVICE_QUOTE = 'SERVICE_QUOTE'

/** Whether a radar row is this kind. */
export function isServiceQuote(item: Pick<RadarItemRow, 'kind'>): boolean {
  return item.kind === KIND_SERVICE_QUOTE
}

/** SERVICE_QUOTE items never go to a price adapter — there is no list price to
 *  read. Used by the tick so the kind cannot silently fall into the product
 *  path and produce nonsense. */
export function servesPriceAdapter(db: Database.Database, radarId: string): boolean {
  const row = db.prepare('SELECT kind FROM radar_items WHERE radar_id=?').get(radarId) as { kind?: string } | undefined
  return row?.kind !== KIND_SERVICE_QUOTE
}
