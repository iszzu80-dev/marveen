// STRUCTURED CLAIM EXTRACTION, against the real dossier.
//
// The fixture below is Kállai's message of 2026-09-04 13:01 UTC, verbatim, read
// from Gmail. That is deliberate and it is the main thing this file gets right:
// an extractor tested on text its own author wrote measures how well the author
// can write text the regex likes. My first attempt at the semantic acceptance
// earlier the same day failed for exactly that reason, on a paraphrase.
//
// The owner's acceptance facts for this message:
//   PLYCOMP112X; C position; package contains 2 pieces; gross 69 130 Ft;
//   production 2027 January; Hungarian release February; no earlier Fluidra stock.
//
// Note where each of those actually LIVES in the mail, because it is not where
// a reader would assume: the part number, the position and the gross price are
// in Istvan's own quoted question, not in Kállai's reply. The package quantity
// and both dates are Kállai's.

import { describe, it, expect } from 'vitest'
import { extractPoolClaims } from '../cos/claims/pool-claims.js'
import { splitQuotedBody } from '../cos/claims/quoted-text.js'
import type { StructuredClaim } from '../cos/claims/claim-types.js'

const KALLAI_TS = Date.UTC(2026, 8, 4, 13, 1, 35) / 1000

/** Verbatim, including the Outlook separator and the quoted original. */
const KALLAI_BODY = `Kedves István !


1.Kompozit medencevédő szegély, 2 darabos készlet így önnek egy egységet kell rendelni

2.-

3/4. A logisztika látja a többi fluidra készleteit így gyártásból érkezik 2027 januárban lenne szállítható
A kollegám februári kiadási dátumot jelölt meg az magyar átvételre


Üdvözlettel / Best Regards:

________________________________
Feladó: István Szabó <iszzu80@gmail.com>
Elküldve: 2026. szeptember 4., péntek 14:06
Címzett: Krisztian Kállai <kkallai@fluidra.com>
Tárgy: Re: Pótalkatrész és árajánlatkérés

Kedves Krisztián!

Köszönöm, a cikkszám ezzel megvan: PLYCOMP112X, C pozíció.

Négy dolgot kérnék még, mielőtt döntünk:

1. A 145,14 EUR + áfa (bruttó 69 130 Ft) DARABÁR? Nekem 2 db kell.
2. Két darab esetén ugyanez az egységár, vagy változik?
`

const kallai = () => extractPoolClaims({
  sourceId: '1a06c82f801a51f6',
  sourceType: 'GMAIL_MESSAGE',
  sourceTimestamp: KALLAI_TS,
  channel: 'private',
  from: '"Krisztian Kállai" <kkallai@fluidra.com>',
  text: KALLAI_BODY,
})

const find = (cs: StructuredClaim[], t: string, f?: string) =>
  cs.filter((c) => c.claimType === t && (f === undefined || c.field === f))

describe('the author is not the quote', () => {
  it('splits Outlook reply text at the separator, with no ">" prefixes to help', () => {
    // Fluidra sends from Outlook, which quotes without any prefix at all. A
    // splitter keyed on ">" would have called this whole mail authored.
    const { authored, quoted } = splitQuotedBody(KALLAI_BODY)
    expect(authored).toContain('2 darabos készlet')
    expect(authored).not.toContain('PLYCOMP112X')
    expect(quoted).toContain('PLYCOMP112X')
    expect(quoted).toContain('69 130 Ft')
  })

  it('the underscore rule separates on its own, with no attribution line', () => {
    // Its own fixture, because in the real Kállai mail the underscores and the
    // "Feladó:" line sit together -- so both separators cut at the same place
    // and neither could be shown to be doing anything. A mail quoted with the
    // rule alone is the only thing that proves this branch.
    const body = [
      'A készlet 2 darabos.',
      '',
      '____________________________',
      'bruttó 69 130 Ft',
    ].join('\n')
    const cs = extractPoolClaims({
      sourceId: 'u1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS, text: body,
    })
    const price = find(cs, 'PACKAGE_PRICE', 'gross')
    expect(price).toHaveLength(1)
    expect(price[0].attribution).toBe('QUOTED')
    expect(find(cs, 'PACKAGE_QUANTITY')[0].attribution).toBe('AUTHOR')
  })

  it('a month claim keeps its year', () => {
    // "2027-01" and "01" are not the same statement, and a month with no year
    // is a lead time nobody can act on.
    const av = find(kallai(), 'AVAILABILITY', 'production')
    expect(av[0].normalizedValue).toMatch(/^20\d{2}-\d{2}$/)
    expect(av[0].normalizedValue.startsWith('2027')).toBe(true)
  })

  it('HEADLINE: the price in the vendor mail is NOT attributed to the vendor', () => {
    // The failure this prevents is not a missing claim, which is visible. It is
    // a confident wrong attribution: Istvan's own quoted question becoming
    // "Fluidra states 69 130 Ft".
    const price = find(kallai(), 'PACKAGE_PRICE', 'gross')
    expect(price).toHaveLength(1)
    expect(price[0].normalizedValue).toBe('69130')
    expect(price[0].attribution).toBe('QUOTED')
    expect(price[0].status).toBe('QUOTED_CONTEXT')
    expect(price[0].provenance).toContain("NOT this author's assertion")
  })

  it('and the quoted claim is still RECORDED, not dropped', () => {
    // It is real evidence that the text was in this message; losing it would
    // lose the reply context that makes the thread readable.
    const cs = kallai()
    expect(find(cs, 'PART_NUMBER')[0].normalizedValue).toBe('PLYCOMP112X')
    expect(find(cs, 'PART_NUMBER')[0].attribution).toBe('QUOTED')
    expect(find(cs, 'POSITION')[0].normalizedValue).toBe('C')
    expect(find(cs, 'POSITION')[0].attribution).toBe('QUOTED')
  })
})

describe("what Kállai himself asserts", () => {
  it('the package contains 2 pieces, and that IS his claim', () => {
    const qty = find(kallai(), 'PACKAGE_QUANTITY')
    expect(qty).toHaveLength(1)
    expect(qty[0].normalizedValue).toBe('2')
    expect(qty[0].normalizedUnit).toBe('pcs')
    expect(qty[0].attribution).toBe('AUTHOR')
    expect(qty[0].sourceValue).toContain('2 darabos készlet')
  })

  it('production is 2027 January, as a month -- no invented day', () => {
    const av = find(kallai(), 'AVAILABILITY', 'production')
    expect(av[0].normalizedValue).toBe('2027-01')
    expect(av[0].normalizedUnit).toBe('month')
    expect(av[0].attribution).toBe('AUTHOR')
  })

  it('the vendor identity comes from the envelope, not the prose', () => {
    const v = find(kallai(), 'VENDOR_IDENTITY')
    expect(v).toHaveLength(1)
    expect(v[0].attribution).toBe('AUTHOR')
    expect(v[0].confidence).toBe('HIGH')
  })

  it('every claim carries a full, checkable origin', () => {
    for (const c of kallai()) {
      expect(c.source.sourceId).toBe('1a06c82f801a51f6')
      expect(c.source.sourceType).toBe('GMAIL_MESSAGE')
      // The SOURCE's own timestamp, not read time: a claim stamped at
      // extraction would make every re-run look like fresh information.
      expect(c.source.sourceTimestamp).toBe(KALLAI_TS)
      expect(c.provenance.length).toBeGreaterThan(10)
      // A CUE_WITHOUT_VALUE claim legitimately has no source value: the cue
      // fired and nothing parsed. Requiring one here would have forced the
      // extractor to invent a verbatim string it never read.
      if (c.status !== 'CUE_WITHOUT_VALUE') expect(c.sourceValue.length).toBeGreaterThan(0)
    }
  })
})

describe('what the extractor refuses to do', () => {
  it('does not read a price without a cue naming it', () => {
    // The scar this rule comes from is in this repo: an extractor that took the
    // largest number in a mail once stored a bank account as an invoice number,
    // at HIGH confidence.
    const cs = extractPoolClaims({
      sourceId: 'm1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'A rendelés száma 69130, köszönjük a megkeresést.',
    })
    expect(find(cs, 'PACKAGE_PRICE')).toEqual([])
  })

  it('records a cue whose value it could not read, instead of staying silent', () => {
    // "This source says nothing about price" and "this source talks about price
    // and we failed to read it" are different facts, and only one of them is
    // safe to act on.
    const cs = extractPoolClaims({
      sourceId: 'm2', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'A bruttó árat a kollégám küldi majd külön levélben.',
    })
    const p = find(cs, 'PACKAGE_PRICE')
    expect(p).toHaveLength(1)
    expect(p[0].status).toBe('CUE_WITHOUT_VALUE')
    expect(p[0].confidence).toBe('LOW')
    expect(p[0].normalizedValue).toBe('')
  })

  it('marks a snippet as a partial view even when the value parses', () => {
    const cs = extractPoolClaims({
      sourceId: 'm3', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'A 2 darabos készlet ára bruttó 69 130 Ft', truncated: true,
    })
    const parsed = cs.filter((c) => c.status !== 'CUE_WITHOUT_VALUE')
    expect(parsed.length).toBeGreaterThan(0)
    for (const c of parsed) expect(c.status).toBe('PARTIAL_SOURCE')
  })

  it('does NOT choose between two sources that disagree', () => {
    // The Priority 3 boundary, asserted as behaviour. Two sources, two prices,
    // two claims -- and nothing that marks either as winning.
    const a = extractPoolClaims({
      sourceId: 'fluidra-1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'A bruttó ár 69 130 Ft.',
    })
    const b = extractPoolClaims({
      sourceId: 'piscinarium-1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS + 60,
      text: 'A bruttó ár 74 900 Ft.',
    })
    const both = [...a, ...b]
    const prices = find(both, 'PACKAGE_PRICE', 'gross')
    expect(prices).toHaveLength(2)
    expect(prices.map((p) => p.normalizedValue).sort()).toEqual(['69130', '74900'])
    // No field on a claim can express precedence. If one ever appears, this
    // fails and the conflict layer has leaked into the evidence layer.
    for (const p of prices) {
      expect(Object.keys(p)).not.toContain('preferred')
      expect(Object.keys(p)).not.toContain('supersedes')
      expect(Object.keys(p)).not.toContain('winner')
    }
  })

  it('normalises the gross amount past a no-break space', () => {
    // HTML-derived bodies carry &nbsp; as the thousands separator. The shared
    // helper handles it; this pins that the extractor actually uses the helper.
    const cs = extractPoolClaims({
      sourceId: 'm4', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'bruttó 69 130 Ft',
    })
    expect(find(cs, 'PACKAGE_PRICE', 'gross')[0].normalizedValue).toBe('69130')
  })
})
