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
import { extractPoolClaims, EXTRACTOR_VERSION } from '../cos/claims/pool-claims.js'
import { segmentBody } from '../cos/claims/segments.js'
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

/** Only the rows that actually carry a value. The extractor now also emits
 *  NO_CUE and UNSUPPORTED rows, which are the point of those statuses but are
 *  not what a value assertion is about. */
const valued = (cs: StructuredClaim[], t: string, f?: string) =>
  find(cs, t, f).filter((c) => c.normalizedValue !== '')

describe('the author is not the quote', () => {
  it('splits Outlook reply text at the separator, with no ">" prefixes to help', () => {
    // Fluidra sends from Outlook, which quotes without any prefix at all. A
    // splitter keyed on ">" would have called this whole mail authored.
    const segs = segmentBody(KALLAI_BODY)
    const authored = segs.filter((s) => s.kind === 'AUTHORED').map((s) => s.text).join('')
    const quoted = segs.filter((s) => s.kind === 'QUOTED').map((s) => s.text).join('')
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
    expect(price[0].attributionStatus).toBe('QUOTED_ORIGIN_UNRESOLVED')
    expect(find(cs, 'PACKAGE_QUANTITY')[0].attributionStatus).toBe('AUTHOR_ASSERTED')
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
    expect(price[0].attributionStatus).toBe('QUOTED_ORIGIN_UNRESOLVED')
    expect(price[0].status).toBe('EXTRACTED_VALID')
    // Asserted on the STRUCTURE, not on the prose: a reader downstream acts on
    // assertedBy being null, and a test on wording would pass a version that
    // said the right thing and filled the field anyway.
    expect(price[0].assertedBy).toBeNull()
    expect(price[0].span.segmentKind).toBe('QUOTED')
  })

  it('and the quoted claim is still RECORDED, not dropped', () => {
    // It is real evidence that the text was in this message; losing it would
    // lose the reply context that makes the thread readable.
    const cs = kallai()
    expect(find(cs, 'PART_NUMBER')[0].normalizedValue).toBe('PLYCOMP112X')
    expect(find(cs, 'PART_NUMBER')[0].attributionStatus).toBe('QUOTED_ORIGIN_UNRESOLVED')
    expect(find(cs, 'POSITION')[0].normalizedValue).toBe('C')
    expect(find(cs, 'POSITION')[0].attributionStatus).toBe('QUOTED_ORIGIN_UNRESOLVED')
  })
})

describe("what Kállai himself asserts", () => {
  it('the package contains 2 pieces, and that IS his claim', () => {
    const qty = find(kallai(), 'PACKAGE_QUANTITY')
    expect(qty).toHaveLength(1)
    expect(qty[0].normalizedValue).toBe('2')
    expect(qty[0].normalizedUnit).toBe('pcs')
    expect(qty[0].attributionStatus).toBe('AUTHOR_ASSERTED')
    expect(qty[0].originalValue).toContain('2 darabos készlet')
  })

  it('production is 2027 January, as a month -- no invented day', () => {
    const av = find(kallai(), 'AVAILABILITY', 'production')
    expect(av[0].normalizedValue).toBe('2027-01')
    expect(av[0].normalizedUnit).toBe('month')
    expect(av[0].attributionStatus).toBe('AUTHOR_ASSERTED')
  })

  it('HEADLINE: a value is read from its cue\'s OWN sentence, not the one before', () => {
    // Found by the dossier readback on the live store, and it was producing a
    // WRONG claim rather than a missing one. Kállai's two facts sit on
    // consecutive lines: production "2027 januárban", then the colleague's
    // "februári kiadási dátum" for the Hungarian handover. The local-release
    // rule gated on its own cue and then read the first month in the segment,
    // so it reported January as the Hungarian release -- contradicting the
    // source it claimed to be quoting.
    const cs = kallai()
    const prod = valued(cs, 'AVAILABILITY', 'production')
    expect(prod).toHaveLength(1)
    expect(prod[0].normalizedValue).toBe('2027-01')

    const local = find(cs, 'AVAILABILITY', 'local_release')
    expect(local).toHaveLength(1)
    // It must NOT have borrowed January from the sentence above.
    expect(local[0].normalizedValue).not.toBe('2027-01')
  })

  it('a month with no year is recorded verbatim, never completed by inference', () => {
    // "februári" names no year. Completing it from a year in another sentence
    // would be inference, and this layer does not infer -- but staying silent
    // would be wrong too, because the source really does address the field.
    const local = find(kallai(), 'AVAILABILITY', 'local_release')[0]
    expect(local.status).toBe('CUE_WITHOUT_VALUE')
    expect(local.normalizedValue).toBe('')
    expect(local.originalValue).toBe('februári')
    expect(local.attributionStatus).toBe('AUTHOR_ASSERTED')
    expect(local.provenance).toContain('without inferring')
  })

  it('the vendor identity comes from the envelope, not the prose', () => {
    const v = find(kallai(), 'VENDOR_IDENTITY')
    expect(v).toHaveLength(1)
    expect(v[0].attributionStatus).toBe('AUTHOR_ASSERTED')
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
      // NO_CUE, CUE_WITHOUT_VALUE and UNSUPPORTED rows legitimately carry no
      // verbatim value: nothing was read. Requiring one would force the
      // extractor to invent a string it never saw.
      if (c.status === 'EXTRACTED_VALID') expect(c.originalValue.length).toBeGreaterThan(0)
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
    const p = find(cs, 'PACKAGE_PRICE')
    // NOT an empty list any more, and that is the improvement: the rule ran and
    // says so. What must never appear is an extracted value.
    expect(p).toHaveLength(1)
    expect(p[0].status).toBe('NO_CUE')
    expect(p[0].normalizedValue).toBe('')
  })

  it('a bare uppercase WORD is not a part number', () => {
    // Found in the dossier readback: "MESSAGE", out of an upper-cased forward
    // banner, was being filed as a part number at HIGH confidence. Every real
    // code here carries digits.
    const cs = extractPoolClaims({
      sourceId: 'pn1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'A cikkszám ügyében: ORIGINAL MESSAGE FORWARDED',
    })
    expect(valued(cs, 'PART_NUMBER')).toEqual([])
  })

  it('but a real code with digits still reads', () => {
    for (const code of ['PLYCOMP112X', 'PLYCOMP112SKX', 'KPCOV52']) {
      const cs = extractPoolClaims({
        sourceId: 'pn2', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
        text: `a cikkszám ${code}`,
      })
      expect(valued(cs, 'PART_NUMBER')[0].normalizedValue).toBe(code)
    }
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
    // Only rows that actually parsed a value can carry the partial-source
    // status; NO_CUE and UNSUPPORTED are statements of a different kind.
    const parsed = cs.filter((c) => c.normalizedValue !== '')
    expect(parsed.length).toBeGreaterThan(0)
    for (const c of parsed) expect(c.status).toBe('LOW_QUALITY_PARTIAL_SOURCE')
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

// MESSAGE != ATTRIBUTION UNIT, as a general invariant rather than one mail's fix.
// Owner 2026-09-04: separate authored, quoted, forwarded and signature content;
// never attribute a quoted claim to the containing sender; fill assertedBy only
// where it is proven.
describe('the four segment kinds are kept apart', () => {
  const SENDER = '"Krisztian Kállai" <kkallai@fluidra.com>'

  it('a SIGNATURE contributes no claims at all', () => {
    // A Fluidra footer carries a company name, an address and often a VAT
    // number -- exactly the shapes the rules look for. Left in the authored
    // segment, a legal footer becomes a vendor's assertion about VAT.
    // The observed word order from the real mail ("2 darabos készlet"), not an
    // invented one: widening the rule for a phrasing nothing in the dossier
    // uses would be speculation dressed as coverage.
    const segs = segmentBody([
      'Kompozit szegély, 2 darabos készlet.',
      'Üdvözlettel / Best Regards:',
      'Fluidra Hungary Kft., bruttó 1 000 000 Ft alaptőke',
    ].join('\n'))
    expect(segs.map((s) => s.kind)).toContain('SIGNATURE')

    const cs = extractPoolClaims({
      sourceId: 'sig1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      from: SENDER,
      text: 'Kompozit szegély, 2 darabos készlet.\nÜdvözlettel / Best Regards:\nFluidra Hungary Kft., bruttó 1 000 000 Ft alaptőke',
    })
    // The footer's amount must NOT become a price claim.
    expect(valued(cs, 'PACKAGE_PRICE', 'gross')).toEqual([])
    expect(valued(cs, 'PACKAGE_QUANTITY')[0].normalizedValue).toBe('2')
  })

  it('FORWARDED content is distinguished from QUOTED, not merged with it', () => {
    const body = [
      'Továbbítom, amit a gyártó írt.',
      '---------- Forwarded message ----------',
      'A bruttó ár 74 900 Ft.',
    ].join('\n')
    const kinds = segmentBody(body).map((s) => s.kind)
    expect(kinds).toContain('FORWARDED')
    expect(kinds).not.toContain('QUOTED')

    const cs = extractPoolClaims({
      sourceId: 'fw1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      from: SENDER, text: body,
    })
    const price = valued(cs, 'PACKAGE_PRICE', 'gross')
    expect(price).toHaveLength(1)
    expect(price[0].attributionStatus).toBe('FORWARDED_ORIGIN_UNRESOLVED')
    expect(price[0].assertedBy).toBeNull()
  })

  it('a sign-off INSIDE a quote does not pull the quote back out of it', () => {
    // The failure direction that matters: re-classifying a region out of a
    // quote would turn an unresolved assertion into an attributed one.
    // The value sits AFTER the quoted author's own sign-off. That placement is
    // the whole test: with the guard, the line stays inside the quote and the
    // claim survives as unresolved; without it, the sign-off re-opens a
    // SIGNATURE segment mid-quote and the claim vanishes entirely.
    const body = [
      'Válaszolok alább.',
      '________________________________',
      'Feladó: István Szabó <iszzu80@gmail.com>',
      'Köszönöm az árajánlatot.',
      'Üdvözlettel,',
      'István',
      'ui. a bruttó ár 69 130 Ft volt.',
    ].join('\n')
    const cs = extractPoolClaims({
      sourceId: 'q2', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      from: SENDER, text: body,
    })
    const price = valued(cs, 'PACKAGE_PRICE', 'gross')
    expect(price).toHaveLength(1)
    expect(price[0].attributionStatus).toBe('QUOTED_ORIGIN_UNRESOLVED')
    expect(price[0].assertedBy).toBeNull()
  })

  it('assertedBy is filled ONLY for authored segments, and from the envelope', () => {
    const cs = kallai()
    for (const c of cs) {
      if (c.attributionStatus === 'AUTHOR_ASSERTED') {
        expect(c.assertedBy).not.toBeNull()
      } else {
        expect(c.assertedBy).toBeNull()
      }
    }
  })

  it('INVARIANT: assertedBy is never the source id', () => {
    for (const c of kallai()) expect(c.assertedBy).not.toBe(c.source.sourceId)
  })

  it('every claim carries the span it was read from', () => {
    for (const c of kallai()) {
      expect(c.span.segmentKind).toBeTruthy()
      expect(c.span.end).toBeGreaterThanOrEqual(c.span.start)
    }
  })

  it('every claim carries the extractor version that produced it', () => {
    for (const c of kallai()) expect(c.extractorVersion).toBe(EXTRACTOR_VERSION)
  })
})

describe('absence is reported, never implied', () => {
  it('NO_CUE and UNSUPPORTED are different statements', () => {
    const cs = kallai()
    // A rule exists for availability and it found one: a fact about the source.
    expect(valued(cs, 'AVAILABILITY', 'production')).toHaveLength(1)
    // No rule exists for warranty: a fact about the extractor, said out loud so
    // that its absence is never read as "the vendor mentioned no warranty".
    const w = find(cs, 'WARRANTY')
    expect(w).toHaveLength(1)
    expect(w[0].status).toBe('UNSUPPORTED')
    expect(w[0].provenance).toContain('no rule for')
  })

  it('a rule that ran and found nothing says NO_CUE', () => {
    const cs = extractPoolClaims({
      sourceId: 'n1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      text: 'Köszönöm a levelét, hamarosan válaszolok.',
    })
    const pos = find(cs, 'POSITION')
    expect(pos).toHaveLength(1)
    expect(pos[0].status).toBe('NO_CUE')
  })
})
