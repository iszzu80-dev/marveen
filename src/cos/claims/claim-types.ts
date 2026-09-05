// STRUCTURED CLAIMS -- what a SOURCE says, never what is true.
//
// Priority 2, owner scope 2026-09-04:
//
//   "A claim azt mondja: »EZ A FORRÁS ezt állítja«, nem azt, hogy »ez az
//    igazság«. Ne legyen új truth store."
//
// So a claim is an OBSERVATION ABOUT A SOURCE. Two sources saying different
// prices produce two claims, both true as observations, and nothing here picks
// between them -- comparison and conflict resolution are Priority 3 and must
// stay separate. This module has no notion of "correct", no precedence rule, no
// merge, and no field an extractor could use to mark a winner.
//
// WHY THAT SEPARATION IS LOAD-BEARING. The moment an extractor may prefer a
// value, its output stops being evidence and becomes a verdict -- and a verdict
// recorded as evidence cannot be re-examined, because nobody can see what the
// other source said, only what somebody decided.

/** WHAT is being claimed. A closed vocabulary on purpose: an extractor that can
 *  invent a claim type can quietly change what the board means. */
export type ClaimType =
  | 'POOL_MODEL' | 'MANUFACTURER' | 'PRODUCT_FAMILY' | 'PART_NUMBER' | 'POSITION'
  | 'PACKAGE_QUANTITY' | 'QUANTITY_REQUIRED' | 'DIMENSION' | 'COMPATIBILITY'
  // Money types stay apart: a unit price and a package price are claims about
  // different things, and folding them into one "price" is how a two-piece set
  // gets ordered twice.
  | 'UNIT_PRICE' | 'PACKAGE_PRICE' | 'TOTAL_PRICE' | 'VAT' | 'SHIPPING_COST'
  | 'AVAILABILITY' | 'LEAD_TIME' | 'WARRANTY' | 'RETURN_POLICY'
  | 'VENDOR_IDENTITY'

/**
 * WHOSE assertion this is -- and the honest answer is usually "not yet known".
 *
 * Owner ruling 2026-09-04, MESSAGE != ATTRIBUTION UNIT:
 *
 *   "A quoted claimet ne dobd el, de ne tulajdonítsd automatikusan a containing
 *    message senderének. attribution_status = QUOTED_ORIGIN_UNRESOLVED amíg
 *    nincs provenance-backed bizonyíték az eredeti állítóra."
 *
 * The containing message is always the PROVENANCE -- we really did read the
 * text there. Who ASSERTED it is a separate question, and for quoted or
 * forwarded text this layer cannot answer it. Saying UNRESOLVED is not a
 * weakness of the record; it is the only true thing available, and a resolver
 * that binds a quoted span back to its original message is explicitly deferred
 * out of Priority 2.
 */
export type AttributionStatus =
  /** The sender of the containing message wrote this segment. `assertedBy` is
   *  filled, and it is filled from the envelope rather than from prose. */
  | 'AUTHOR_ASSERTED'
  /** Read from quoted reply text. Somebody said it; this layer does not know
   *  who, and will not guess. */
  | 'QUOTED_ORIGIN_UNRESOLVED'
  /** Read from forwarded content, whose origin may never have passed through
   *  this mailbox at all. Kept distinct from QUOTED because the two have
   *  different chances of ever being resolved. */
  | 'FORWARDED_ORIGIN_UNRESOLVED'

/**
 * How the extraction went. Four outcomes that are routinely confused and must
 * not be, owner 2026-09-04.
 *
 * The distinction that does the most work is UNSUPPORTED versus NO_CUE. If the
 * extractor has no rule for warranty, then no warranty claim appearing is a
 * fact about US. If it has a rule that ran and found nothing, that is a fact
 * about the SOURCE. Collapsing them makes an unbuilt feature look like a silent
 * vendor, which is the shape of every absence-based false conclusion.
 */
export type ExtractionStatus =
  /** A cue named the field and a value was parsed. */
  | 'EXTRACTED_VALID'
  /** A rule exists, ran, and the source does not address this field at all. */
  | 'NO_CUE'
  /** The source addresses the field, but no value could be recovered from it. */
  | 'CUE_WITHOUT_VALUE'
  /** No rule exists for this claim type yet. A statement about the extractor,
   *  never about the source. */
  | 'UNSUPPORTED'
  /** Parsed, but from a truncated view of the source (a snippet, not a body).
   *  The value may be right; everything past the cut is unread. */
  | 'LOW_QUALITY_PARTIAL_SOURCE'

export type ClaimConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Where the claim was READ. Every field required: a claim whose origin cannot
 *  be reconstructed is not evidence. */
export interface ClaimSource {
  sourceId: string
  sourceType: 'GMAIL_MESSAGE' | 'GMAIL_THREAD' | 'DOCUMENT' | 'CASE'
  /** When the SOURCE said it -- its own date, not extraction time. A claim
   *  stamped at read time makes every re-run look like fresh information. */
  sourceTimestamp: number
  channel?: string
}

/** WHICH PART of the source, precisely enough to go and look. */
export interface EvidenceSpan {
  segmentKind: 'AUTHORED' | 'QUOTED' | 'FORWARDED' | 'SIGNATURE'
  /** Character offsets into the source text. */
  start: number
  end: number
  /** The line that opened the segment, when one did. */
  marker: string | null
}

export interface StructuredClaim {
  claimType: ClaimType
  /** Narrowing inside a type: which dimension, which price basis. Null where
   *  the type is already specific. */
  field: string | null
  /** Canonical form: integer for money and counts, ISO-8601 for dates and
   *  months, uppercased code for part numbers. Empty when nothing parsed. */
  normalizedValue: string
  /** `HUF`, `EUR_cents`, `pcs`, `mm`, `month`. Null for codes. */
  normalizedUnit: string | null
  /** VERBATIM, as it appeared. Kept so a reader can check the normalisation
   *  rather than trust it, and so a mis-normalisation is recoverable without
   *  re-fetching the mail. */
  originalValue: string
  source: ClaimSource
  span: EvidenceSpan
  attributionStatus: AttributionStatus
  /**
   * WHO asserted it, and null unless that is PROVEN.
   *
   * Owner: "asserted_by csak akkor legyen kitöltve, ha bizonyított." Filled
   * only for AUTHOR_ASSERTED segments, and taken from the message envelope --
   * never from a name appearing in the prose, which is exactly the kind of
   * inference that turns a quote into an attribution.
   *
   * INVARIANT: this is never the source id. A message id identifies where we
   * read something; a party identifies who said it. A store that let those be
   * the same value would make "the message asserted it" expressible, which is
   * the confusion this whole design exists to prevent.
   */
  assertedBy: string | null
  /**
   * The sender's display name, when the envelope carried one.
   *
   * PRESENTATION ONLY, and separate from `assertedBy` on purpose (owner,
   * 2026-09-05). A display name is chosen by the sender, is not unique, and is
   * absent from plenty of real mail; making it the principal would mean the
   * same party is a different party depending on what they typed into their
   * mail client that month. It is kept because dropping it would make every
   * readback less legible than it is today, and it is kept HERE because a field
   * named `display` cannot be mistaken for an identity.
   */
  assertedByName: string | null
  confidence: ClaimConfidence
  status: ExtractionStatus
  /** WHY it was read that way, in words. A score with no reason is not
   *  reviewable. */
  provenance: string
  /** Which rules produced this. A re-extraction under new rules must be
   *  distinguishable from the source having changed -- the lesson the attention
   *  ledger learned the hard way earlier the same day. */
  extractorVersion: string
}
