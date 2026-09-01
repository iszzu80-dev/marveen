// PHASE 3 (P3-B2) -- THE SENDER IS A FIELD, NOT A PROPERTY OF THE CASE.
//
// Owner ruling 2026-09-01, after the B1 pilot returned zero ZST cases:
//
//   "Egy From: email-cim szemelyes adat lehet, de ettol az egesz case nem valik
//    automatikusan HIGHLY_SENSITIVE-ve kutatasi szempontbol. Ne lazitsd az
//    email-cim vedelmet."
//
// WHAT WENT WRONG IN B1. Every case the intake creates carries a `From:` line in
// its description. The corporate content classifier reads an address as
// ZST_PERSONAL_DATA, which normalises to HIGHLY_SENSITIVE, so the one field
// EVERY case has lifted the entire corporate namespace out of the pilot. The
// classifier was not wrong about the address; it was answering the wrong
// question. "Does this case contain personal data" and "is this case about
// something private" are different, and only the second should decide whether a
// public fact about a vendor may be looked up.
//
// THE CANONICAL RULE, and it is stricter about the address than B1 was:
//
//   the sender ADDRESS and DISPLAY NAME are sensitive fields, and they never
//   travel -- not redacted, not pseudonymised, not at all;
//
//   the REGISTRABLE DOMAIN derived from them locally is a SEPARATE field, and it
//   travels only if `publicVendorIdentifier` says it is a public corporate root;
//
//   the case's CONTENT is classified on its own, with the structural intake
//   header removed, because that header is metadata the intake wrote and not
//   something the case is about.
//
// The last clause is the only loosening, and it is bounded: an address written
// in the BODY is still content and still escalates. Only the intake's own
// `From:` line -- present on every case, therefore carrying no information that
// distinguishes one case from another -- is excluded.
//
// SYMMETRY IS THE POINT. Both namespaces use this, so the personal and corporate
// classifiers give the same canonical meaning to the same fact, and the
// namespace vocabulary stays what the owner said it should be: a normalisation
// layer, not a second policy.

/** The structural header the intake writes. Anchored to the start of a line so a
 *  `From:` quoted inside a forwarded body is not mistaken for it. */
const INTAKE_SENDER_HEADER = /^From:[^\n]*$/gm

export interface SenderField {
  /** The whole header line, for provenance. NEVER egressed. */
  headerLine: string | null
  /** A person's name, when the header carried one. NEVER egressed. */
  displayName: string | null
  /** The address. NEVER egressed. */
  address: string | null
  /** The host part, for `publicVendorIdentifier` to judge. Not egressed as-is
   *  either -- only the registrable root that check returns. */
  host: string | null
}

export function parseSenderField(description: string | null | undefined): SenderField {
  const line = (description ?? '').match(/^From:[^\n]*$/m)?.[0] ?? null
  if (!line) return { headerLine: null, displayName: null, address: null, host: null }

  const angle = /<([^>]+)>/.exec(line)
  const address = (angle ? angle[1] : /From:\s*([^\s<>"]+@[^\s<>"]+)/i.exec(line)?.[1] ?? null)?.trim() ?? null
  const namePart = line.replace(/^From:\s*/i, '').replace(/<[^>]*>/, '').trim()
  const displayName = namePart.replace(/^["']|["']$/g, '').replace(/\\"/g, '').trim() || null

  return {
    headerLine: line,
    displayName: displayName && displayName !== address ? displayName : null,
    address,
    host: address && address.includes('@') ? address.split('@').pop()!.toLowerCase() : null,
  }
}

/**
 * The case's own content, with the intake's structural sender header removed.
 *
 * This is what the sensitivity classifiers are given. An address the sender
 * typed into the body survives here and still escalates; only the header the
 * intake itself wrote is taken out.
 */
export function contentWithoutSenderHeader(
  title: string | null | undefined, description: string | null | undefined,
): string {
  const body = (description ?? '').replace(INTAKE_SENDER_HEADER, '').trim()
  return [title ?? '', body].filter(Boolean).join('\n')
}

/** The fields that may never appear in an outgoing query, by name, so a test can
 *  assert on the list rather than on one example. */
export const NEVER_EGRESSED_SENDER_FIELDS = Object.freeze(['headerLine', 'displayName', 'address'] as const)
