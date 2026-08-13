import { describe, it, expect } from 'vitest'
import {
  deriveAnswerOptions, hasButtons, answerIntentOf, declaredOptionValues, OPTION_INTENTS,
} from '../cos/answer-options.js'

// Answer options derived from the question.
//
// Istvan's complaint: "az igen/nem rádiógomb sem egyértelmű sokszor". The cause
// is structural — the engine asks without supplying options, so the surface has
// only the generic pair to show. The fix is not more buttons; it is the RIGHT
// buttons, and no buttons at all when the question is open.
//
// The test that matters most is the last kind: a question with no real two
// sides must NOT get yes/no. A forced binary does not collect an answer, it
// collects whichever button was closer.

describe('answer options', () => {
  it('keeps yes/no when the question really is binary', () => {
    for (const q of [
      'Jóváhagyod a levelet a Modivónak?',
      'Elküldjem az ajánlatkérést?',
      'Rendben van így a szöveg?',
    ]) {
      const d = deriveAnswerOptions(q)
      expect(d.options.map((o) => o.value), q).toEqual(['YES', 'NO'])
      expect(d.rule).toBe('genuinely-binary')
    }
  })

  it('gives real choices for the stall escalation — the D-option question', () => {
    const d = deriveAnswerOptions('Nem haladunk a Volitával. Kérjünk ajánlatot mástól is?')
    expect(d.options.map((o) => o.value)).toEqual(['ASK_OTHERS', 'KEEP_WAITING', 'DROP'])
    expect(d.rule).toBe('stall-escalation')
  })

  it('gives three ways for a trip, not yes/no', () => {
    // The spec's own example of a bad binary.
    const d = deriveAnswerOptions('Mi legyen a spanyol úttal, megyünk?')
    expect(d.options.map((o) => o.label)).toEqual(['Megyünk', 'Elhalasztjuk', 'Lemondjuk'])
  })

  it('offers repair or replace where that is the real question', () => {
    const d = deriveAnswerOptions('A medence alkatrészét javítsuk vagy cseréljük?')
    expect(d.options.map((o) => o.value)).toContain('REPAIR')
    expect(d.options.map((o) => o.value)).toContain('REPLACE')
  })

  it('an OPEN question gets NO buttons — the whole point', () => {
    // This is the failure being fixed. Igen/Nem on an open question is a false
    // pair, and a false pair collects the nearer button, not an answer.
    const d = deriveAnswerOptions('Mi legyen a következő lépés az ürömi ügyben?')
    expect(hasButtons(d)).toBe(false)
    expect(d.freeText).toBe(true)
    expect(d.rule).toBe('open-question')
  })

  it('an empty question gets no buttons either — inventing one would be worse', () => {
    const d = deriveAnswerOptions('')
    expect(hasButtons(d)).toBe(false)
    expect(d.rule).toBe('no-question')
  })

  it('case-supplied choices beat every pattern — a real list beats a guessed one', () => {
    const d = deriveAnswerOptions('Melyik ajánlatot válasszuk?', [
      { value: 'P1', label: 'Kovács — 390 000 Ft' },
      { value: 'P2', label: 'Nagy — 450 000 Ft' },
    ])
    expect(d.rule).toBe('case-supplied')
    expect(d.options).toHaveLength(2)
    expect(d.options[0].label).toContain('390 000')
  })

  it('every option keeps a stable value, so a stored answer means one thing forever', () => {
    const a = deriveAnswerOptions('Kérjünk ajánlatot mástól?')
    const b = deriveAnswerOptions('Kérjünk ajánlatot mástól?')
    expect(a.options).toEqual(b.options)
    for (const o of a.options) expect(o.value).toMatch(/^[A-Z_]+$/)
  })

  it('matches regardless of accents', () => {
    expect(deriveAnswerOptions('Kerjunk ajanlatot mastol?').rule).toBe('stall-escalation')
    expect(deriveAnswerOptions('Kérjünk ajánlatot mástól?').rule).toBe('stall-escalation')
  })

  it('free text is always available — a button set is never the only way to answer', () => {
    for (const q of ['Jóváhagyod?', 'Mi legyen a spanyol úttal?', 'Nyitott kérdés valamiről']) {
      expect(deriveAnswerOptions(q).freeText, q).toBe(true)
    }
  })
})

// ── Every button has a consumer ───────────────────────────────────────────
//
// This module built real alternatives and Mission Control submitted them, and
// NOTHING outside this file ever read the values: the pipeline compared
// `choice === 'NO'` and treated everything else as go-ahead. So "Lemondjuk"
// (cancel) and "Várjunk még rá" (keep waiting) advanced the plan exactly as if
// the owner had approved. Offering a real choice and ignoring which one he
// picked is worse than the false yes/no pair it replaced.
describe('option meanings', () => {
  it('every value this module can render has a declared meaning', () => {
    // The standing check: a new PATTERN option with no entry here is a button
    // that silently means nothing. That is precisely how the first six got
    // ignored for months.
    for (const v of declaredOptionValues()) {
      expect(OPTION_INTENTS[v], `option ${v} has no declared engine meaning`).toBeDefined()
    }
  })

  it('the cancel-shaped options are ABANDON, never proceed', () => {
    expect(answerIntentOf('CANCEL')).toBe('ABANDON')
    expect(answerIntentOf('DROP')).toBe('ABANDON')
  })

  it('the wait-shaped options are HOLD, never proceed', () => {
    expect(answerIntentOf('KEEP_WAITING')).toBe('HOLD')
    expect(answerIntentOf('POSTPONE')).toBe('HOLD')
    expect(answerIntentOf('LATER')).toBe('HOLD')
  })

  it('only an affirmative settles the question', () => {
    expect(answerIntentOf('YES')).toBe('PROCEED')
    expect(answerIntentOf('GO')).toBe('PROCEED')
    expect(answerIntentOf('NO')).toBe('REFUSE')
  })

  it('an unknown or absent choice is UNMAPPED, never PROCEED', () => {
    // Case-supplied options (the providers who actually quoted) arrive here
    // too. A provider name must not read as approval merely because it is not
    // the string 'NO' — which is exactly what the old comparison did.
    expect(answerIntentOf('SZOMSZED_KFT')).toBe('UNMAPPED')
    expect(answerIntentOf(null)).toBe('UNMAPPED')
    expect(answerIntentOf('')).toBe('UNMAPPED')
  })

  it('no option means PROCEED by accident: every mapping is deliberate', () => {
    const proceeds = Object.entries(OPTION_INTENTS)
      .filter(([, v]) => v === 'PROCEED').map(([k]) => k).sort()
    expect(proceeds).toEqual(['GO', 'NOW', 'REPAIR', 'REPLACE', 'YES'])
  })
})
