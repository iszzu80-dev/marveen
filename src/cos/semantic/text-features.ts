// WHAT TWO CASES HAVE IN COMMON, said in terms a person can check.
//
// Local, deterministic, no embedding service, no egress (owner ruling
// 2026-09-04: "Ne nyiss most új infrastruktúra-függőséget"). The corpus is ~140
// personal cases; at that size the useful signal is not distributional
// similarity, it is shared IDENTIFIERS, shared DATES and shared rare TERMS,
// each of which can be printed next to the proposal and disputed.
//
// NO GAZETTEER, deliberately. The owner's example is "the word Valencia alone
// must not join two different trips", and the obvious implementation is a list
// of place names plus a rule about them. That rule would be wrong in a narrow
// way and unfixable in a general one: it says nothing about "the word Sixt
// alone", or "the word Booking.com alone", which are the same mistake wearing a
// different word. So nothing here knows what a place IS. The rule that carries
// the owner's intent is about the INDEPENDENCE of the evidence — one family of
// signal, however strong it feels, is not two — and it generalises to every
// term the corpus will ever contain.

/** A token that looks like somebody's reference number rather than a word. */
const IDENTIFIER_RE = /\b(?=[A-Za-z0-9-]*\d)[A-Za-z]{0,3}\d[A-Za-z0-9-]{4,}\b/g
/** ISO-ish dates: 2026-08-11, 2026.08.11, 2026/08/11. */
const FULL_DATE_RE = /\b(20\d{2})[-./](0[1-9]|1[0-2])[-./](0[1-9]|[12]\d|3[01])\b/g
/** A bare month-day, which trip titles use for the far end of a range: 08-23. */
const SHORT_DATE_RE = /\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g

/** Tokens carrying no discriminating power anywhere, in any corpus: numbers on
 *  their own, and single letters. Domain stopwords are NOT listed here — they
 *  are DERIVED from the corpus below, because a hand-written Hungarian stopword
 *  list is a second gazetteer with the same problem as the first. */
function isNoiseToken(t: string): boolean {
  return t.length < 4 || /^\d+$/.test(t)
}

export function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Word tokens, accent-folded, noise dropped. */
export function terms(text: string): string[] {
  return [...new Set(
    normalise(text).split(/[^a-z0-9]+/).filter((t) => t && !isNoiseToken(t)),
  )]
}

/**
 * Reference-number-shaped tokens.
 *
 * Dates are removed FIRST. `2026-08-11` matches the identifier shape perfectly,
 * and if it survived here every case from the same fortnight would appear to
 * share a strong identifier — the single most confident feature in the engine,
 * firing on the calendar.
 */
export function identifiers(text: string): string[] {
  const withoutDates = text.replace(FULL_DATE_RE, ' ')
  const found = withoutDates.match(IDENTIFIER_RE) ?? []
  return [...new Set(found.map((s) => s.toUpperCase()).filter((s) => s.replace(/\D/g, '').length >= 4))]
}

export interface DateMention {
  /** Days since epoch, so comparisons are calendar comparisons. */
  day: number
  /** As written, kept for the human-readable reason. */
  text: string
}

/** Dates a text mentions. A bare `MM-DD` is resolved against the years the same
 *  text mentions in full — that is how "2026-08-11 -- 08-23" is read as a range
 *  rather than as one date and one number. */
export function dates(text: string): DateMention[] {
  const out: DateMention[] = []
  const years = new Set<number>()
  for (const m of text.matchAll(FULL_DATE_RE)) {
    const [raw, y, mo, d] = m
    years.add(Number(y))
    out.push({ day: Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86_400_000), text: raw })
  }
  const withoutFull = text.replace(FULL_DATE_RE, ' ')
  for (const m of withoutFull.matchAll(SHORT_DATE_RE)) {
    const [raw, mo, d] = m
    for (const y of years) {
      out.push({ day: Math.floor(Date.UTC(y, Number(mo) - 1, Number(d)) / 86_400_000), text: raw })
    }
  }
  return out
}

/** The inclusive span a text describes, or null if it names fewer than two dates. */
export function dateSpan(text: string): { from: number; to: number } | null {
  const ds = dates(text).map((d) => d.day).sort((a, b) => a - b)
  if (ds.length < 2) return null
  return { from: ds[0], to: ds[ds.length - 1] }
}

/** Sender/recipient domains — the vendor signal, taken from addresses rather
 *  than from a list of company names. */
export function domains(text: string): string[] {
  const found = normalise(text).match(/@([a-z0-9.-]+\.[a-z]{2,})/g) ?? []
  return [...new Set(found.map((d) => d.slice(1).replace(/^(www|mail|noreply|no-reply)\./, '')))]
}

/**
 * How ordinary each term is in THIS corpus.
 *
 * Document frequency, not a stopword list. "foglalas" and "berles" are
 * uninformative here because they appear everywhere in this particular store,
 * and that is a fact about the store which can be measured, not a fact about
 * Hungarian which somebody has to remember to maintain.
 */
export function documentFrequency(docs: readonly string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const t of terms(doc)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return df
}

/**
 * Below this many documents, document frequency is not a statistic and must not
 * be used as one. On a four-document corpus every shared term sits at 50% and
 * the filter silently deletes the entire TERM family — a rule that stops
 * applying without saying so, which looks exactly like a term that is not
 * shared.
 */
export const MIN_CORPUS_FOR_DF = 10

/** Terms rare enough to mean something, given the corpus. */
export function rareTerms(
  text: string, df: Map<string, number>, corpusSize: number, maxShare = 0.2,
): string[] {
  if (corpusSize < MIN_CORPUS_FOR_DF) return terms(text)
  const cap = Math.max(1, corpusSize * maxShare)
  return terms(text).filter((t) => (df.get(t) ?? 0) <= cap)
}

/**
 * The word-parts of things another family already counts.
 *
 * INDEPENDENCE HAS TO BE BUILT, NOT ASSERTED. `booking@sixt.com` yields the
 * domain `sixt.com` for the VENDOR family and, left alone, also the terms
 * "sixt", "booking" and "com" for the TERM family. Two families would then fire
 * on one fact, and the rule requiring two independent kinds of evidence would
 * be satisfied by a single one. A test caught exactly that: a Berlin car
 * rental and a Spanish holiday, joined by nothing but a shared rental company,
 * were about to clear the bar.
 */
export function subsumedTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const d of domains(text)) for (const part of terms(d)) out.add(part)
  for (const i of identifiers(text)) for (const part of terms(i)) out.add(part)
  return out
}
