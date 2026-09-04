// THE INDEPENDENCE RULE, and the arithmetic that serves it.
//
// The owner's constraint was concrete: the word "Valencia" alone must not join
// two different trips. These tests are written against the GENERAL form of that
// rule — one family of evidence is not two — because the specific form invites a
// place-name list, and a place-name list says nothing about "Sixt alone".

import { describe, it, expect } from 'vitest'
import {
  terms, identifiers, dates, dateSpan, domains, documentFrequency, rareTerms,
  MIN_CORPUS_FOR_DF,
} from '../cos/semantic/text-features.js'
import {
  scorePair, parentCandidates, sourceCaseCandidates, algorithmFingerprint,
  CANDIDATE_THRESHOLD, WEIGHTS, type CandidateInput,
} from '../cos/semantic/relation-candidates.js'

const day = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)

const TRIP: CandidateInput = {
  id: 'PRI-TRIP-2026-001', namespace: 'personal',
  text: 'Spanyol ut 2026-08-11 -- 08-23 (Valencia, Granada, Malaga). Ernyo-ugy a spanyol utra.',
  createdAtDay: day('2026-08-16'),
}
// A REALISTIC CORPUS, because document frequency is the engine's only defence
// against ordinary words and it needs documents to count. Three of these tests
// first failed against two-document corpora: with nothing to compare, "from"
// and "foglalas" read as rare, the TERM family fired on them, and a Berlin car
// hire nearly joined a Spanish holiday. The engine was right; the fixture was
// starving it. MIN_CORPUS_FOR_DF now refuses to pretend either way.
const BACKGROUND: string[] = [
  'From: Telekom szamla foglalas berles hatarido 2026-09-18',
  'From: NAV ertesites foglalas berles adobevallas 2026-07-01',
  'From: Booking berles foglalas szallas Budapest 2026-05-02',
  'From: OTP bank foglalas berles atutalas 2026-06-11',
  'From: iskola foglalas berles szuloi ertekezlet 2026-09-02',
  'From: orvos foglalas berles idopont 2026-04-19',
  'From: biztosito foglalas berles kotveny 2026-03-08',
  'From: aruhaz foglalas berles rendeles 2026-02-14',
  'From: szolgaltato foglalas berles szerzodes 2026-01-20',
  'From: konyvelo foglalas berles zaras 2026-10-05',
  'From: futar foglalas berles kezbesites 2026-11-11',
  'From: teleco foglalas berles elofizetes 2026-12-01',
]
const corpusOf = (...xs: CandidateInput[]): string[] => [...BACKGROUND, ...xs.map((x) => x.text)]

describe('the feature extractor says what it found, not what it guessed', () => {
  it('HEADLINE: a booking reference is an identifier and a date is not', () => {
    // If a date survived as an identifier, every case from the same fortnight
    // would appear to share the single most decisive feature in the engine.
    expect(identifiers('Centauro berles D014745393 atvetel 2026-08-11'))
      .toEqual(['D014745393'])
    expect(identifiers('foglalas 2026-08-11 -- 2026-08-23')).toEqual([])
  })

  it('a bare MM-DD is read against the years the same text names', () => {
    // "2026-08-11 -- 08-23" is a range. Without this it is one date and a number.
    const s = dateSpan('Spanyol ut 2026-08-11 -- 08-23')
    expect(s).toEqual({ from: day('2026-08-11'), to: day('2026-08-23') })
  })

  it('a text naming one date has no span', () => {
    expect(dateSpan('atvetel 2026-08-18 10:00')).toBeNull()
    expect(dates('atvetel 2026-08-18 10:00')).toHaveLength(1)
  })

  it('vendor comes from the address, not from a list of company names', () => {
    expect(domains('From: SIXT <booking@sixt.com>')).toEqual(['sixt.com'])
    expect(domains('From: "Booking.com" <noreply@booking.com>')).toEqual(['booking.com'])
  })

  it('HEADLINE: "ordinary" is measured in this corpus, not declared in a stopword list', () => {
    const corpus = [...BACKGROUND, 'foglalas berles valencia']
    const df = documentFrequency(corpus)
    const rare = rareTerms('foglalas berles valencia', df, corpus.length)
    expect(rare).toContain('valencia')
    expect(rare, 'a term in every document carries nothing').not.toContain('foglalas')
    expect(rare).not.toContain('berles')
  })

  it('HEADLINE: below MIN_CORPUS_FOR_DF the filter steps aside instead of deleting everything', () => {
    // Document frequency over four documents is not a statistic. Applied anyway,
    // every shared term sits at 50% and the whole TERM family vanishes silently
    // -- which is indistinguishable from two cases having nothing in common.
    const tiny = ['foglalas valencia', 'foglalas granada', 'foglalas malaga', 'foglalas sevilla']
    expect(tiny.length).toBeLessThan(MIN_CORPUS_FOR_DF)
    const df = documentFrequency(tiny)
    expect(rareTerms('foglalas valencia', df, tiny.length), 'no filtering applied')
      .toEqual(expect.arrayContaining(['foglalas', 'valencia']))

    // ...and above the line it does apply, or the escape above is unconditional.
    const big = [...BACKGROUND, 'foglalas valencia']
    expect(big.length).toBeGreaterThanOrEqual(MIN_CORPUS_FOR_DF)
    expect(rareTerms('foglalas valencia', documentFrequency(big), big.length))
      .not.toContain('foglalas')
  })

  it('accents fold, so "szállás" and "szallas" are one term', () => {
    expect(terms('Szállás')).toEqual(terms('szallas'))
  })
})

describe('THE INDEPENDENCE RULE', () => {
  const CORPUS = corpusOf(TRIP)
  const df = documentFrequency(CORPUS)
  const N = CORPUS.length

  it('HEADLINE: a shared rare term ALONE does not reach the threshold', () => {
    // The owner's example, in its general form. This case shares "valencia" with
    // the trip and nothing else — no dates, no reference, no vendor.
    const other: CandidateInput = {
      id: 'other-trip', namespace: 'personal',
      text: 'Valencia varoslatogatas tervezese jovo evre',
      createdAtDay: day('2027-03-01'),
    }
    const r = scorePair(other, TRIP, df, N)
    expect(r.confidence).toBeLessThan(CANDIDATE_THRESHOLD)
    expect(r.negatives.map((n) => n.name)).toContain('SINGLE_FAMILY_ONLY')
  })

  it('the same rule refuses a shared VENDOR alone, which no place-name list would', () => {
    // This is why the rule is about families and not about places.
    const vendorOnly: CandidateInput = {
      id: 'unrelated-sixt', namespace: 'personal',
      text: 'From: SIXT <booking@sixt.com> berles Berlinben',
      createdAtDay: day('2027-05-05'),
    }
    const tripWithVendor: CandidateInput = { ...TRIP, text: `${TRIP.text} From: SIXT <booking@sixt.com>` }
    const c2 = corpusOf(tripWithVendor, vendorOnly)
    const r = scorePair(vendorOnly, tripWithVendor, documentFrequency(c2), c2.length)
    expect(r.negatives.map((n) => n.name)).toContain('SINGLE_FAMILY_ONLY')
    expect(r.confidence).toBeLessThan(CANDIDATE_THRESHOLD)
  })

  it('HEADLINE: two independent families DO reach it', () => {
    // Same shared term, but now the case also falls inside the trip's window.
    const inTrip: CandidateInput = {
      id: 'case-lorca', namespace: 'personal',
      text: 'Lorca szallas: erkezesi idot ker a szallasado, Valencia utan, 2026-08-14',
      createdAtDay: day('2026-08-14'),
    }
    const r = scorePair(inTrip, TRIP, df, N)
    expect(new Set(r.features.map((f) => f.family)).size).toBeGreaterThanOrEqual(2)
    expect(r.confidence).toBeGreaterThanOrEqual(CANDIDATE_THRESHOLD)
    expect(r.negatives.map((n) => n.name)).not.toContain('SINGLE_FAMILY_ONLY')
  })

  it('a shared reference number is decisive ALONE, because it is not a coincidence', () => {
    // NOTHING ELSE MAY BE SHARED HERE. The first version of this test used two
    // texts that both said "Hertz", so the TERM family fired as well, two
    // families cleared the bar on their own, and the test passed just as
    // happily with decisiveness removed from the engine. It proved nothing.
    const sameBooking: CandidateInput = {
      id: 'case-alpha', namespace: 'personal',
      text: 'online check-in elvegzese D014889443',
      createdAtDay: day('2027-01-01'),
    }
    const target: CandidateInput = {
      id: 'PRI-X', namespace: 'personal',
      text: 'kaucio-kartya megerosites kerve D014889443',
      createdAtDay: day('2026-08-08'),
    }
    const c3 = corpusOf(target, sameBooking)
    const r = scorePair(sameBooking, target, documentFrequency(c3), c3.length)
    expect(new Set(r.features.map((f) => f.family)), 'only the identifier may fire')
      .toEqual(new Set(['IDENTIFIER']))
    expect(r.confidence).toBeGreaterThanOrEqual(CANDIDATE_THRESHOLD)
    expect(r.negatives.map((n) => n.name)).not.toContain('SINGLE_FAMILY_ONLY')
  })

  it('the weak signal is RECORDED, not erased', () => {
    // A reviewer should be able to see what was noticed and rejected, and why.
    // The confidence itself may reach zero -- a case dated seven months outside
    // the window also takes the TEMPORAL_DISJOINT penalty -- but the evidence
    // and the stated reason for refusing it both survive.
    const other: CandidateInput = {
      id: 'other-trip', namespace: 'personal',
      text: 'Valencia varoslatogatas', createdAtDay: day('2027-03-01'),
    }
    const r = scorePair(other, TRIP, df, N)
    expect(r.features.map((f) => f.name)).toContain('SHARED_RARE_TERM')
    expect(r.negatives.map((n) => n.name)).toEqual(
      expect.arrayContaining(['SINGLE_FAMILY_ONLY', 'TEMPORAL_DISJOINT']))
  })

  it('and a weak signal WITHOUT a date conflict is held just under the line, not at zero', () => {
    // The distinction the test above cannot make: held-below is a cap, and a
    // proposal one family short should sit near the bar rather than at the floor.
    const noDates: CandidateInput = {
      id: 'undated', namespace: 'personal',
      text: 'Valencia Granada Malaga emlekek', createdAtDay: day('2026-08-14'),
    }
    const undatedTarget: CandidateInput = {
      id: 'PRI-UNDATED', namespace: 'personal',
      text: 'Valencia Granada Malaga ernyo-ugy', createdAtDay: day('2026-08-16'),
    }
    const c = corpusOf(noDates, undatedTarget)
    const r = scorePair(noDates, undatedTarget, documentFrequency(c), c.length)
    expect(r.negatives.map((n) => n.name)).toContain('SINGLE_FAMILY_ONLY')
    expect(r.confidence).toBeGreaterThan(0)
    expect(r.confidence).toBeLessThan(CANDIDATE_THRESHOLD)
  })
})

describe('what a candidate may never do', () => {
  const df = documentFrequency(corpusOf(TRIP))

  it('HEADLINE: cross-namespace is refused outright, not scored down', () => {
    // "Cross-mailbox candidate = YES. Cross-namespace canonicalization = NO."
    // A proposal the owner may not act on is not a weaker proposal.
    const zst: CandidateInput = { ...TRIP, id: 'ZST-1', namespace: 'zst' }
    const r = scorePair(zst, TRIP, df, corpusOf(TRIP).length)
    expect(r.negatives.find((n) => n.name === 'NAMESPACE_MISMATCH')?.disqualifying).toBe(true)
    expect(r.confidence).toBe(0)
    expect(parentCandidates(zst, [TRIP], corpusOf(TRIP))).toEqual([])
  })

  it('a case is never proposed as its own parent', () => {
    expect(parentCandidates(TRIP, [TRIP], corpusOf(TRIP))).toEqual([])
  })

  it('every candidate carries evidence a person can dispute', () => {
    const child: CandidateInput = {
      id: 'case-sixt', namespace: 'personal',
      text: 'Sixt berles 9732668118 Valencia Ciudad de las Artes, atvetel 2026-08-18',
      createdAtDay: day('2026-08-16'),
    }
    const [c] = parentCandidates(child, [TRIP], corpusOf(TRIP, child))
    expect(c).toBeDefined()
    expect(c.reasons.length).toBe(c.features.length)
    expect(c.reasons.join(' ')).toMatch(/\w/)
    expect(c.algorithmFingerprint).toMatch(/^local-lexical-v1:[0-9a-f]+$/)
    expect(c.relationType).toBe('CASE_PARENT_CANDIDATE')
  })

  it('the fingerprint moves when the weights move, so a run is reproducible or visibly not', () => {
    const before = algorithmFingerprint()
    const w = WEIGHTS as unknown as Record<string, number>
    const original = w.SHARED_IDENTIFIER
    w.SHARED_IDENTIFIER = 0.99
    const after = algorithmFingerprint()
    w.SHARED_IDENTIFIER = original
    expect(after).not.toBe(before)
    expect(algorithmFingerprint()).toBe(before)
  })
})

describe('bounded by construction', () => {
  it('HEADLINE: topN is a bound the engine cannot widen', () => {
    const targets: CandidateInput[] = Array.from({ length: 12 }, (_, i) => ({
      id: `T${i}`, namespace: 'personal',
      text: `Spanyol ut 2026-08-11 -- 08-23 Valencia Granada Malaga D01474539${i}`,
      createdAtDay: day('2026-08-16'),
    }))
    const child: CandidateInput = {
      id: 'child', namespace: 'personal',
      text: 'Valencia Granada szallas 2026-08-14 D014745391 D014745392 D014745393 '
        + 'D014745394 D014745395 D014745396 D014745397 D014745398',
      createdAtDay: day('2026-08-14'),
    }
    const corpus = corpusOf(...targets, child)
    // THE FLOOR FIRST. Asserting "at most 3" against a set where only two ever
    // qualified is a bound that measures nothing: the first version of this
    // test passed with the slice removed entirely.
    const unbounded = parentCandidates(child, targets, corpus, 99)
    expect(unbounded.length, 'more than topN must qualify, or the cap is untested')
      .toBeGreaterThan(3)
    expect(parentCandidates(child, targets, corpus, 3)).toHaveLength(3)
    expect(parentCandidates(child, targets, corpus, 1)).toHaveLength(1)
  })

  it('results are ordered by confidence and tie-broken deterministically', () => {
    const a: CandidateInput = { id: 'AAA', namespace: 'personal', text: TRIP.text, createdAtDay: TRIP.createdAtDay }
    const b: CandidateInput = { id: 'BBB', namespace: 'personal', text: TRIP.text, createdAtDay: TRIP.createdAtDay }
    const child: CandidateInput = {
      id: 'child', namespace: 'personal',
      text: 'Valencia Granada szallas 2026-08-14', createdAtDay: day('2026-08-14'),
    }
    const r1 = parentCandidates(child, [a, b], corpusOf(a, b, child))
    const r2 = parentCandidates(child, [b, a], corpusOf(a, b, child))
    expect(r1.map((c) => c.targetCaseId)).toEqual(r2.map((c) => c.targetCaseId))
  })

  it('SOURCE_CASE_CANDIDATE is the same engine with a different relation type', () => {
    const src: CandidateInput = {
      id: 'thread-abc', namespace: 'personal',
      text: 'Neon credit: Billing oldal, 2026-08-14 From: support@neon.tech',
      createdAtDay: day('2026-08-14'),
    }
    const target: CandidateInput = {
      id: 'PRI-CLOUD-1', namespace: 'personal',
      text: 'Neon kredit ugy 2026-08-10 -- 2026-08-20 From: support@neon.tech',
      createdAtDay: day('2026-08-10'),
    }
    const [c] = sourceCaseCandidates(src, [target], corpusOf(src, target))
    expect(c?.relationType).toBe('SOURCE_CASE_CANDIDATE')
    expect(c?.sourceRef).toBe('thread-abc')
  })
})
