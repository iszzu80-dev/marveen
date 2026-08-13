// Shared heuristics for the ZST email extractors (invoice, contract).
//
// Extracted 2026-08-13. parseHufAmounts, parseDates and the sender-name parser
// existed twice — zst-invoice-extract.ts and zst-contract-extract.ts — and had
// ALREADY drifted: the invoice copy's thousands-separator class had grown a
// U+00A0 and the contract copy's had not. So the same email produced 1 234 567
// on one side and 0 on the other, silently, because the fallback alternative
// `\d{3,}` matches the LAST group of an NBSP-formatted number and everything
// downstream (dedup hashes, bank matching) then disagrees about the amount.
// One copy now, so a fix lands once.

/** Money and dates arrive from Gmail snippets and HTML-derived bodies, where the
 *  thousands separator is routinely a NO-BREAK SPACE (U+00A0) or a NARROW
 *  NO-BREAK SPACE (U+202F) rather than a plain space — that is what an HTML
 *  `&nbsp;` becomes, and what Hungarian typesetting produces. Normalising once,
 *  up front, means every regex below only has to know about ordinary spaces.
 *  The separator classes still list the code points as well: normalisation is
 *  the fix, redundancy is the seatbelt for a caller that skips it. */
export function normaliseExtractionText(text: string): string {
  return text.replace(/[\u00A0\u202F\u2009]/g, ' ')
}

// "1 234 567 Ft", "1.234.567 Ft", "1<NBSP>234<NBSP>567 Ft", "15 484 HUF",
// "15484Ft" → 1234567 (forint int).
const HUF_AMOUNT = /(\d{1,3}(?:[ .\u00A0\u202F\u2009]\d{3})+|\d{3,})\s?(?:Ft|HUF|forint)\b/gi
const HUF_SEPARATORS = /[ .\u00A0\u202F\u2009]/g

export function parseHufAmounts(text: string): number[] {
  const out: number[] = []
  for (const m of normaliseExtractionText(text).matchAll(HUF_AMOUNT)) {
    const n = parseInt(m[1].replace(HUF_SEPARATORS, ''), 10)
    if (!Number.isNaN(n)) out.push(n)
  }
  return out
}

// ISO or hu date "2026-07-22", "2026.07.22", "2026. 07. 22." → ISO.
const DATE_RE = /\b(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})\b/g

export function parseDates(text: string): string[] {
  const out: string[] = []
  for (const m of normaliseExtractionText(text).matchAll(DATE_RE)) {
    out.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`)
  }
  return out
}

/** The other party's name: the sender's display name, else the domain. Used as
 *  supplier_id by the invoice extractor and counterparty_id by the contract one
 *  — same rule, and it must stay the same rule, because the two ids are compared
 *  against each other during reconciliation. */
export function nameFromSender(from: string): string | null {
  const disp = /"?([^"<]+?)"?\s*</.exec(from)
  if (disp && disp[1].trim()) return disp[1].trim()
  const dom = /@([\w.-]+)/.exec(from)
  return dom ? dom[1] : null
}
