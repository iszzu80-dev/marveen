// The state of a document's extracted text — and why NULL was never enough.
//
// Owner decision, 2026-09-02, from a live case. Question QADBD occupied one of
// five channel slots for twenty-two days asking for "the text of the attached
// documents", while the contract's text had been read on the day the question
// was asked and its summary was sitting in the case's own description. The
// reader concluded the text was unavailable because `cos_documents.extracted_text`
// was NULL — and NULL is the same value for two completely different facts:
//
//   nobody has tried to extract this          → asking is reasonable
//   extraction was tried and produced garbage → asking is reasonable
//   extraction was tried and produced text    → asking is a bug
//
// One column could not tell them apart, so the reader guessed the one that costs
// the owner an interruption.
//
// AND THE OTHER DIRECTION IS WORSE. Extracting the same PDF with a stdlib reader
// produced 492,659 characters whose letter ratio was 0.014 — 98.6% binary noise
// with "Adobe UCS Adobe UCS" repeated through it. Written into `extracted_text`
// it would have looked like an extracted document to every consumer, and a
// reader handed that would have reported on the noise. An empty field is a
// missing answer; a garbage field is a wrong one.

/** What is known about a document's text. */
export type ExtractionState =
  /** No attempt has been made. Asking the owner about the content is fair. */
  | 'NOT_ATTEMPTED'
  /** Extracted, and the result reads as language. Usable as evidence. */
  | 'EXTRACTED_VALID'
  /** Extracted, and the result does not read as language. NEVER usable as
   *  evidence — kept only so the next run does not retry the same way and so a
   *  human can see that we tried. */
  | 'EXTRACTION_LOW_QUALITY'
  /** The attempt threw, or the container was unreadable. */
  | 'EXTRACTION_FAILED'
  /** We have no extractor for this type at all. */
  | 'EXTRACTION_UNSUPPORTED'

export interface ExtractionQuality {
  state: ExtractionState
  /** Fraction of the text made of letters inside words of 3+ letters. Prose
   *  sits well above 0.5; the PDF that started this was 0.014. */
  letterRatio: number
  wordCount: number
  chars: number
  reason: string
}

/** Below this the text is not language, whatever it looks like in the first
 *  eighty characters. Deliberately generous: the failing sample was 0.014, and
 *  a real extraction of a table-heavy invoice still clears 0.45 comfortably. */
export const MIN_LETTER_RATIO = 0.45
/** Reported, NOT enforced.
 *
 *  A word-count floor was tried and removed the same hour: it rejected 'rovid
 *  szoveg' and 'A kinyert szoveg.' -- two-word extractions of two-word
 *  documents, which are CORRECT extractions. Length is a question about the
 *  document; this module's question is whether the bytes read as language, and
 *  the letter ratio answers that independently of length. A floor here would
 *  have made the engine ask the owner for a short document it already held --
 *  the exact failure the gate above it exists to prevent, arriving through the
 *  quality check instead of through the NULL. */
export const MIN_WORDS = 0

/**
 * Judge an extraction result. Pure, so the threshold is testable without a file.
 *
 * The measure is deliberately about SHAPE and not about meaning: whether the
 * bytes read as words. A semantic check would need a model, and a model that
 * decides whether a document was extracted properly is a second thing that can
 * be wrong about it.
 */
export function classifyExtraction(text: string | null | undefined): ExtractionQuality {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) {
    return { state: 'NOT_ATTEMPTED', letterRatio: 0, wordCount: 0, chars: 0, reason: 'no text' }
  }
  // NUL bytes are the fingerprint of raw binary that survived a lossy decode.
  // SQLite's length() stops at the first one, so a garbage field can even
  // MEASURE as short while holding half a megabyte — that is how the live PDF
  // reported 672 characters for 853,370.
  const nulls = (t.match(/\u0000/g) ?? []).length
  const words = t.match(/[\p{L}]{3,}/gu) ?? []
  const letters = words.reduce((n, w) => n + w.length, 0)
  const letterRatio = t.length ? letters / t.length : 0
  const q = { letterRatio, wordCount: words.length, chars: t.length }

  if (nulls > 0) {
    return { ...q, state: 'EXTRACTION_LOW_QUALITY', reason: `${nulls} NUL byte(s) — raw binary, not text` }
  }
  if (words.length === 0) {
    return { ...q, state: 'EXTRACTION_LOW_QUALITY', reason: 'no words at all' }
  }
  if (letterRatio < MIN_LETTER_RATIO) {
    return { ...q, state: 'EXTRACTION_LOW_QUALITY', reason: `letter ratio ${letterRatio.toFixed(3)} < ${MIN_LETTER_RATIO}` }
  }
  return { ...q, state: 'EXTRACTED_VALID', reason: 'reads as language' }
}

/** May this document's text be used as evidence?
 *
 *  THE NEGATIVE CONTROL LIVES HERE. Only EXTRACTED_VALID passes. A low-quality
 *  extraction is not "some evidence" — it is noise that a reader would report
 *  on as though it were the document. */
export function isTrustedExtraction(state: string | null | undefined): boolean {
  return state === 'EXTRACTED_VALID'
}

/** The state a legacy row (written before this column existed) should be read
 *  as. Classified from its own text rather than assumed valid: the rows that
 *  predate the column were written by a path that had no quality check. */
export function effectiveExtractionState(
  storedState: string | null | undefined, text: string | null | undefined,
): ExtractionState {
  if (storedState) return storedState as ExtractionState
  return classifyExtraction(text).state
}
