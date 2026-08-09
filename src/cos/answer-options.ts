// Personal Chief of Staff (COS) — answer options that come from the question.
//
// The board asks REQUEST_DECISION questions and offers Igen / Nem. Istvan's
// objection, 2026-08-09: "az igen/nem rádiógomb sem egyértelmű sokszor". He is
// right, and the reason is structural rather than cosmetic — the engine asks a
// question without supplying any options, so the surface has nothing to show
// but the generic pair. On a question like "mi legyen a spanyol úttal", Igen
// answers nothing: it is not a two-sided question.
//
// So the options are derived HERE, from the question and the case, once, and
// the surface renders whatever it is given. Two rules shape it:
//
//   1. If the question is genuinely binary, keep yes/no — replacing a good
//      binary with three vague choices is not an improvement.
//   2. If it is not, offer the real alternatives and NEVER a false pair. A
//      forced yes/no on an open question does not collect an answer, it
//      collects whichever button was closer.
//
// Deterministic: no model call. Istvan's own rule for the answer path is that
// the model may propose and never decide; deriving the options is upstream of
// his decision, so it must be inspectable and repeatable rather than generated
// fresh each render.

export interface AnswerOption {
  /** Stored value. Stable across renders so an answer means one thing forever. */
  value: string
  /** What Istvan reads on the button. */
  label: string
}

export interface DerivedAnswer {
  options: AnswerOption[]
  /** True when a free-text box should accompany the buttons. */
  freeText: boolean
  /** Which rule produced this, for debugging a bad question later. */
  rule: string
}

const YES_NO: AnswerOption[] = [{ value: 'YES', label: 'Igen' }, { value: 'NO', label: 'Nem' }]

/** Question shapes that really are binary. Matched on the folded question. */
const BINARY_MARKERS = [
  'jóváhagyod', 'jovahagyod', 'rendben van', 'egyetértesz', 'egyetertesz',
  'menjen ki', 'elküldjem', 'elkuldjem', 'kérjek', 'kerjek', 'induljon',
  'megrendeljem', 'foglaljam', 'igen vagy nem',
]

/** Recognisable multi-way questions and the choices that actually apply. */
const PATTERNS: Array<{ test: RegExp; rule: string; options: AnswerOption[]; freeText?: boolean }> = [
  {
    test: /(ajánlat|ajanlat).*(mástól|mastol|más(ik)? (kivitelező|kivitelezo|szolgáltató|szolgaltato))|kérjünk.*mástól|kerjunk.*mastol/,
    rule: 'stall-escalation',
    options: [
      { value: 'ASK_OTHERS', label: 'Kérjünk mástól is' },
      { value: 'KEEP_WAITING', label: 'Várjunk még rá' },
      { value: 'DROP', label: 'Hagyjuk ezt az utat' },
    ],
  },
  {
    test: /(utaz|út|ut)\w*.*(megy|halaszt|lemond)|megyünk|megyunk/,
    rule: 'trip-decision',
    options: [
      { value: 'GO', label: 'Megyünk' },
      { value: 'POSTPONE', label: 'Elhalasztjuk' },
      { value: 'CANCEL', label: 'Lemondjuk' },
    ],
  },
  {
    test: /(melyik|válassz|valassz).*(ajánlat|ajanlat|szolgáltató|szolgaltato|kivitelező|kivitelezo)/,
    rule: 'pick-provider',
    options: [],           // filled from the case's own quotes by the caller
    freeText: true,
  },
  {
    test: /(javít|javit|cserél|csereljuk|cserel)\w*.*(vagy)|javítsuk vagy/,
    rule: 'repair-or-replace',
    options: [
      { value: 'REPAIR', label: 'Javítsuk' },
      { value: 'REPLACE', label: 'Cseréljük' },
      { value: 'GET_QUOTE', label: 'Kérjünk rá árat' },
    ],
  },
  {
    test: /(mikor|határidő|hatarido)/,
    rule: 'timing',
    options: [
      { value: 'NOW', label: 'Most' },
      { value: 'LATER', label: 'Később' },
      { value: 'SPECIFY', label: 'Megmondom mikor' },
    ],
    freeText: true,
  },
]

const ACCENTS = 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ'
const PLAIN = 'aeiooouuuAEIOOOUUU'
function fold(s: string): string {
  let out = ''
  for (const ch of s ?? '') {
    const i = ACCENTS.indexOf(ch)
    out += i >= 0 ? PLAIN[i] : ch
  }
  return out.toLowerCase()
}

/**
 * Derive the answer set for a question.
 *
 * `choices` lets the caller supply case-specific alternatives — the providers
 * who actually quoted, for instance. Options that come from the case beat any
 * pattern, because a real list is always better than a guessed one.
 */
export function deriveAnswerOptions(question: string, choices?: AnswerOption[]): DerivedAnswer {
  const q = (question ?? '').trim()
  if (choices?.length) {
    return { options: choices, freeText: true, rule: 'case-supplied' }
  }
  if (!q) {
    // No question text at all. Yes/no here would be inventing a question, so the
    // honest surface is a free-text box and nothing else.
    return { options: [], freeText: true, rule: 'no-question' }
  }
  const folded = fold(q)

  for (const p of PATTERNS) {
    if (p.test.test(folded) && p.options.length) {
      return { options: p.options, freeText: p.freeText ?? true, rule: p.rule }
    }
  }
  if (BINARY_MARKERS.some((m) => folded.includes(fold(m)))) {
    return { options: YES_NO, freeText: true, rule: 'genuinely-binary' }
  }
  // Not recognisably binary and not a known shape. Offering Igen/Nem here is the
  // exact complaint: a false pair collects whichever button was closer.
  return { options: [], freeText: true, rule: 'open-question' }
}

/** Does this question deserve buttons at all? */
export function hasButtons(d: DerivedAnswer): boolean {
  return d.options.length > 0
}
