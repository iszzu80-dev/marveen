import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { createRadarItem, radarCreationRefusal, getRadarItem, recordObservation } from '../cos/radar.js'
import {
  buildServiceQuoteQuestion, serviceQuoteRefusal, serviceQuoteClosingNote,
  INDICATIVE_MARK, MIN_CANDIDATES, MAX_CANDIDATES, type QuoteCandidate,
} from '../cos/service-quote.js'

/**
 * SERVICE_QUOTE — the fifth and last piece of the 2026-08-15 card, and a
 * different shape from everything above it.
 *
 * Two places where this kind goes silent most easily, both flagged in advance:
 *   1. the "indicative" nature disappearing from the output, so a calculator
 *      figure reads as a firm offer;
 *   2. the deadline day passing without a word when nothing was found.
 * Both have their own tests below.
 */

const NOW = 1_000_000
const DAY = 86400

const CANDIDATES: QuoteCandidate[] = [
  { provider: 'Alfa Biztosito', indicativePrice: 78000, sourceUrl: 'https://alfa.hu/kalkulator', needsForRealQuote: 'rendszam, karmentesseg, iranyitoszam' },
  { provider: 'Generali', indicativePrice: 84000, sourceUrl: 'https://generali.hu/lakas', needsForRealQuote: 'alapterulet, epites eve' },
]

const ITEM = {
  radar_id: 'sq1', label: 'Groupama lakasbiztositas megujulas',
  target_price: 92000, currency: 'HUF', expires_at: NOW + 30 * DAY,
}

describe('SERVICE_QUOTE: the indicative nature is on EVERY price line', () => {
  it('every candidate line is marked, not just a preamble', () => {
    // A mark stated once at the top is a mark a reader skips. The failure it
    // prevents is the same class as best_price=NULL reading as "nothing cheap":
    // a number believed to mean more than it does.
    //
    // ASSERTED AGAINST THE LITERAL WORD, not against INDICATIVE_MARK. The first
    // version used the constant, and emptying the constant left all seventeen
    // tests green — the third tautology of this class today, and this one my
    // own: `toContain('')` is true of every string. A test may not take its
    // expected value from the thing it is testing.
    expect(INDICATIVE_MARK).toBe('IRANYADO')
    const q = buildServiceQuoteQuestion(ITEM, CANDIDATES)
    for (const c of CANDIDATES) {
      const line = q.text.split('\n').find(l => l.includes(c.provider))!
      expect(line, `${c.provider} line unmarked`).toContain('IRANYADO')
    }
  })

  it('says outright that no quote was requested and none will be', () => {
    // The structural refusal, in the text Istvan actually reads.
    expect(buildServiceQuoteQuestion(ITEM, CANDIDATES).text).toMatch(/Ajanlatot NEM kertem/)
  })

  it('an unknown price is SAID, not omitted', () => {
    // Same three-valued honesty as deliverability: "we could not establish it"
    // is an answer, and dropping the candidate would hide that we looked.
    const q = buildServiceQuoteQuestion(ITEM, [
      CANDIDATES[0]!,
      { provider: 'Union', indicativePrice: null, sourceUrl: 'https://union.hu', needsForRealQuote: 'szemelyes adatok' },
    ])
    expect(q.text).toContain('IRANYADO ar: NEM SIKERULT megallapitani')
    expect(q.text).toContain('Union')
  })

  it('each candidate carries its source and what a real quote needs', () => {
    const q = buildServiceQuoteQuestion(ITEM, CANDIDATES)
    expect(q.text).toContain('https://alfa.hu/kalkulator')
    expect(q.text).toContain('valodi ajanlathoz kell')
  })

  it('the same candidate set produces the same hash — no re-asking', () => {
    const a = buildServiceQuoteQuestion(ITEM, CANDIDATES)
    const b = buildServiceQuoteQuestion(ITEM, [CANDIDATES[1]!, CANDIDATES[0]!])
    expect(a.hash).toBe(b.hash)
  })
})

describe('SERVICE_QUOTE: a candidate set that is not worth showing is refused', () => {
  it('refuses a single candidate — one is not a comparison', () => {
    expect(serviceQuoteRefusal([CANDIDATES[0]!])).toMatch(/legalabb 2/)
  })

  it('refuses more than three — that is a research report he did not ask for', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({ ...CANDIDATES[0]!, provider: `P${i}` }))
    expect(serviceQuoteRefusal(many)).toMatch(/legfeljebb 3/)
  })

  it('refuses a candidate with no source — a number without one is a rumour', () => {
    expect(serviceQuoteRefusal([CANDIDATES[0]!, { ...CANDIDATES[1]!, sourceUrl: '' }])).toMatch(/nincs forras/)
  })

  it('refuses a candidate that hides what a real quote would need', () => {
    expect(serviceQuoteRefusal([CANDIDATES[0]!, { ...CANDIDATES[1]!, needsForRealQuote: '' }])).toMatch(/valodi ajanlathoz/)
  })

  it('accepts a proper set — positive control', () => {
    expect(serviceQuoteRefusal(CANDIDATES)).toBeNull()
    expect(MIN_CANDIDATES).toBe(2)
  })
})

describe('SERVICE_QUOTE: the creation gate knows this kind', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const base = {
    radarId: 'sq1', kind: 'SERVICE_QUOTE', label: 'Groupama megujulas',
    targetPrice: 92000, query: { terms: 'lakasbiztositas' },
  }

  it('refuses one with no renewal date — the date IS the case', () => {
    expect(radarCreationRefusal(base)).toMatch(/megujulasi hatarido nelkul/)
  })

  it('refuses one declared as anything but a deadline', () => {
    expect(radarCreationRefusal({ ...base, expiresAt: NOW + DAY, watchShape: 'STANDING' }))
      .toMatch(/csak DEADLINE/)
  })

  it('defaults to the DEADLINE rhythm without being told', () => {
    const item = createRadarItem(getDb(), { ...base, expiresAt: NOW + 40 * DAY }, NOW)
    expect(item.watch_shape).toBe('DEADLINE')
    expect(item.check_interval_sec).toBe(7 * DAY)
  })
})

describe('SERVICE_QUOTE: the deadline day speaks — especially with nothing found', () => {
  it('says the date arrived even when NOTHING was found', () => {
    // The most expensive silence of this kind: a renewal date passing
    // unmentioned means Istvan renewed by default without ever being asked.
    const note = serviceQuoteClosingNote({ label: 'Groupama megujulas' }, 0)
    expect(note).toMatch(/hatarideje ma van/)
    expect(note).toMatch(/NEM talaltam/)
    // ...and it does not overclaim: absence of a find is not absence of options.
    expect(note).toMatch(/nem azt jelenti, hogy nincs/)
  })

  it('says it when something WAS found too', () => {
    expect(serviceQuoteClosingNote({ label: 'Groupama megujulas' }, 3)).toMatch(/3 alternativat/)
  })

  it('the watch actually closes on the day, through the shared rhythm', () => {
    initDatabase(':memory:')
    const db = getDb()
    createRadarItem(db, {
      radarId: 'sq2', kind: 'SERVICE_QUOTE', label: 'Groupama', targetPrice: 92000,
      query: { terms: 'lakasbiztositas' }, expiresAt: NOW + 10 * DAY,
    }, NOW)
    recordObservation(db, 'sq2', { bestPrice: null, offerId: null }, NOW + 10 * DAY)
    expect(getRadarItem(db, 'sq2')!.status).toBe('CLOSED')
    // ...and the closure is queued for the digest, not swallowed.
    expect(getRadarItem(db, 'sq2')!.closure_reported_at).toBeNull()
    expect(getRadarItem(db, 'sq2')!.closure_reason).toMatch(/targytalan/)
  })
})

describe('SERVICE_QUOTE: it can never ask for a quote itself', () => {
  it('STANDING: the module exposes no outbound-capable function', () => {
    // Structural, not mode-dependent. Istvan's mode is external_shadow today,
    // so an outbound send has no live path anyway — which is exactly why the
    // refusal must not BE the mode check: a later mode change must not turn a
    // calculator lookup into an outbound path.
    const src = readFileSync(new URL('../cos/service-quote.ts', import.meta.url), 'utf8')
    for (const forbidden of ['createAgentMessage', 'enqueueOutbox', 'sendMail', 'executeAction', 'fetch(']) {
      expect(src.includes(forbidden), `service-quote.ts references ${forbidden}`).toBe(false)
    }
  })
})
