// STRUCTURED CLAIMS -- what a SOURCE says, never what is true.
//
// Priority 2, owner scope 2026-09-04:
//
//   "A claim azt mondja: »EZ A FORRÁS ezt állítja«, nem azt, hogy »ez az
//    igazság«. Ne legyen új truth store."
//
// So a claim is an OBSERVATION ABOUT A SOURCE. Two sources saying different
// prices produce two claims, both true as observations, and nothing here picks
// between them -- the comparison and conflict layer is Priority 3 and must stay
// separate. This module has no notion of "correct", no precedence rule, no
// merge, and no way to express that one claim supersedes another.
//
// WHY THAT SEPARATION IS LOAD-BEARING. The moment an extractor is allowed to
// prefer a value, its output stops being evidence and becomes a verdict, and a
// verdict recorded as evidence cannot be re-examined: nobody can see what the
// other source said, only what somebody decided. The pool dossier is the case in
// point -- Piscinarium and Fluidra are both mid-conversation about the same part
// and the owner has explicitly not chosen between them.

/** WHAT is being claimed. Deliberately a closed vocabulary: an extractor that
 *  can invent a claim type can quietly change what the board means. */
export type ClaimType =
  // Identity of the thing
  | 'POOL_MODEL'
  | 'MANUFACTURER'
  | 'PRODUCT_FAMILY'
  | 'PART_NUMBER'
  | 'POSITION'
  // Counting and measurement
  | 'PACKAGE_QUANTITY'
  | 'QUANTITY_REQUIRED'
  | 'DIMENSION'
  | 'COMPATIBILITY'
  // Money. Kept apart on purpose: a unit price and a package price are
  // different claims about different things, and folding them into one
  // "price" field is how a 2-piece set gets ordered twice.
  | 'UNIT_PRICE'
  | 'PACKAGE_PRICE'
  | 'TOTAL_PRICE'
  | 'VAT'
  | 'SHIPPING_COST'
  // Time and terms
  | 'AVAILABILITY'
  | 'LEAD_TIME'
  | 'WARRANTY'
  | 'RETURN_POLICY'
  // Who says it
  | 'VENDOR_IDENTITY'

/**
 * WHOSE words these are, inside the source.
 *
 * FOUND IN THE REAL DATA, not anticipated. Kállai's message of 2026-09-04
 * carries `PLYCOMP112X`, `C pozíció` and `bruttó 69 130 Ft` -- but all three sit
 * inside a quoted block of Istvan's OWN earlier mail, below the reply
 * separator. An extractor that reads the whole body attributes Istvan's
 * question to the vendor as though the vendor had asserted the price.
 *
 * That is not a formatting nicety. The entire value of a source-bound claim is
 * the binding between a statement and who made it; get that wrong and the
 * provenance is worse than absent, because it looks authoritative.
 *
 * QUOTED claims are still recorded. They are real evidence that the text was
 * present in that message, and dropping them would lose the reply context. They
 * are simply not attributed to the message's author.
 */
export type ClaimAttribution = 'AUTHOR' | 'QUOTED'

/**
 * How well the extraction went, as a status rather than a number.
 *
 * Separate from confidence on purpose. Confidence says how sure the rule is
 * that it read the value correctly; status says what KIND of reading it was.
 * A value read from a snippet can be perfectly confident and still be a partial
 * view of the source -- those are different facts and a reader needs both.
 */
export type ExtractionStatus =
  /** Parsed from the full source text, by a cue that names the field. */
  | 'OK'
  /** Parsed, but from a truncated view (a Gmail snippet rather than the body).
   *  The value may be right; what is missing is everything past the cut. */
  | 'PARTIAL_SOURCE'
  /** Parsed from quoted reply text. See ClaimAttribution. */
  | 'QUOTED_CONTEXT'
  /** A cue for this field was present but its value could not be parsed. Worth
   *  recording: it marks a format the extractor does not yet handle, which is
   *  the difference between "this source says nothing about price" and "this
   *  source talks about price and we failed to read it". */
  | 'CUE_WITHOUT_VALUE'

export type ClaimConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Where the claim was read from. Every field is required: a claim whose origin
 *  cannot be reconstructed is not evidence. */
export interface ClaimSource {
  /** The message, thread or document id. */
  sourceId: string
  sourceType: 'GMAIL_MESSAGE' | 'GMAIL_THREAD' | 'DOCUMENT' | 'CASE'
  /** When the SOURCE said it -- the message's own date, not extraction time.
   *  Unix seconds. A claim timestamped at read time would make every
   *  re-extraction look like fresh information. */
  sourceTimestamp: number
  /** Which mailbox or store it came through, when known. */
  channel?: string
}

export interface StructuredClaim {
  claimType: ClaimType
  /** Optional narrowing inside a type: which dimension, which VAT rate basis.
   *  Null where the type is already specific. */
  field: string | null
  /** Canonical form: an integer for money and counts, ISO-8601 for dates and
   *  months, an uppercased code for part numbers. */
  normalizedValue: string
  /** The unit the normalised value is in, where one applies (`HUF`, `EUR`,
   *  `pcs`, `mm`, `month`). Null for codes and free identifiers. */
  normalizedUnit: string | null
  /** VERBATIM, as it appeared in the source. Kept so a reader can check the
   *  normalisation rather than trust it, and so a mis-normalisation is
   *  recoverable without re-fetching the mail. */
  sourceValue: string
  source: ClaimSource
  attribution: ClaimAttribution
  confidence: ClaimConfidence
  status: ExtractionStatus
  /** WHY this was read as that: the cue that matched, in words. The same role
   *  the semantic layer's `reasons` play -- a score with no reason is not
   *  reviewable. */
  provenance: string
}
