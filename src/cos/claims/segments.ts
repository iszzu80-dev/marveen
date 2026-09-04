// MESSAGE != ATTRIBUTION UNIT.
//
// Standing invariant, owner 2026-09-04, generalised from a defect found in one
// real mail:
//
//   "A claim attribúciója a speaker-authored evidence segmenthez kötődjön, ne a
//    teljes message senderéhez."
//
// The mail was Kállai's of 2026-09-04. It carries `PLYCOMP112X`, `C pozíció`
// and `bruttó 69 130 Ft` -- all three inside a quoted block of Istvan's own
// earlier message. Reading the body as one unit makes the vendor assert the
// buyer's question back at him, confidently and with a real message id behind
// it. The failure is not a missing claim, which is visible; it is a false
// attribution that looks authoritative.
//
// So a message is a SEQUENCE OF SEGMENTS, and a claim binds to the segment it
// was read from. Four kinds, and each exists because it answers a different
// question about whose words these are:
//
//   AUTHORED   this message's sender wrote it -> attributable
//   QUOTED     included from an earlier message in the same conversation
//   FORWARDED  included from a message sent by somebody else entirely
//   SIGNATURE  not a claim at all: sign-off, legal footer, contact block
//
// QUOTED AND FORWARDED ARE NOT THE SAME THING, and collapsing them would lose
// the more useful half. A quote is part of a reply chain this mailbox usually
// has, so a later resolver could bind it back to its original message. A
// forward's origin may never have passed through here at all. The owner has
// deferred that resolver out of Priority 2; keeping the distinction now is what
// makes it possible later without re-reading every mail.
//
// SIGNATURE IS NOT DECORATION EITHER. A Fluidra footer carries a company name,
// an address and often a VAT number -- exactly the shapes the extractors look
// for. Left in the authored segment, a legal footer becomes a vendor's claim
// about VAT.

export type SegmentKind = 'AUTHORED' | 'QUOTED' | 'FORWARDED' | 'SIGNATURE'

export interface EvidenceSegment {
  kind: SegmentKind
  text: string
  /** Character offsets into the original body. This is the `evidence segment /
   *  span provenance` the owner asked for: it lets a reader open the source and
   *  see the exact region a claim came from, rather than trusting a label. */
  start: number
  end: number
  /** The line that opened this segment, verbatim and trimmed. Null for the
   *  first segment, which no marker introduces. */
  marker: string | null
}

interface Boundary {
  index: number
  kind: SegmentKind
  marker: string
}

/** Openers for quoted reply text. Anchored to line start: `From:` inside a
 *  sentence is not a separator. */
const QUOTE_MARKERS: readonly RegExp[] = [
  /^_{10,}\s*$/m,
  /^\s*Feladó:\s.*$/m,
  /^\s*From:\s.*$/m,
  /^\s*On .{0,120}\bwrote:\s*$/m,
  /^\s*.{0,80}\bírta \(?\d{4}\.?.{0,40}\)?:\s*$/m,
  /^-{2,}\s*(Original Message|Eredeti üzenet)\s*-{2,}.*$/mi,
]

/** Openers for forwarded content. Checked BEFORE quote markers at the same
 *  index, because a forward banner is usually followed by a `From:` line and
 *  the outer classification is the true one. */
const FORWARD_MARKERS: readonly RegExp[] = [
  /^-{2,}\s*Forwarded message\s*-{2,}.*$/mi,
  /^-{2,}\s*Továbbított (üzenet|levél)\s*-{2,}.*$/mi,
  /^\s*Begin forwarded message:\s*$/mi,
]

/** Openers for a signature or legal footer. `-- ` on its own line is the RFC
 *  3676 signature delimiter; the rest are what this mailbox actually receives. */
const SIGNATURE_MARKERS: readonly RegExp[] = [
  /^-- \s*$/m,
  /^\s*(Üdvözlettel|Udvozlettel|Tisztelettel|Best Regards|Kind regards|Br,)\b.*$/mi,
  /^\s*(This e-?mail|Ez az e-?mail|A jelen e-?mail).{0,40}(confidential|bizalmas)/mi,
]

interface Found { index: number; kind: SegmentKind; marker: string }

function allMatches(markers: readonly RegExp[], kind: SegmentKind, body: string): Found[] {
  const out: Found[] = []
  for (const re of markers) {
    // A fresh global copy: the source regexes are shared module state, and a
    // sticky `lastIndex` between calls would make the segmenter's answer depend
    // on which body was parsed before it.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of body.matchAll(g)) {
      if (m.index !== undefined) out.push({ index: m.index, kind, marker: m[0].trim() })
    }
  }
  return out
}

/**
 * Split a plain-text body into attributable segments.
 *
 * EVERY boundary is used, not just the first. An earlier cut of this cut once
 * and put everything after it into a single segment -- and Kállai's real mail
 * signs off with "Üdvözlettel / Best Regards:" BEFORE the quoted original, so
 * the whole quote was classified as signature and silently dropped. One
 * boundary is not a segmentation.
 *
 * A SIGNATURE MARKER ONLY COUNTS WHILE STILL IN AUTHORED TEXT. A sign-off
 * inside a quote belongs to the quoted author, and letting it re-classify the
 * region would move text out of the quote -- turning an unresolved assertion
 * back into an attributable one, which is the exact direction this must never
 * fail in.
 *
 * `>`-prefixed lines are deliberately NOT a boundary. Outlook -- which Fluidra
 * sends from -- quotes with no prefix at all, so a rule depending on `>` would
 * have classified the entire Kállai reply as authored.
 */
export function segmentBody(body: string): EvidenceSegment[] {
  const found = [
    ...allMatches(FORWARD_MARKERS, 'FORWARDED', body),
    ...allMatches(QUOTE_MARKERS, 'QUOTED', body),
    ...allMatches(SIGNATURE_MARKERS, 'SIGNATURE', body),
  ]
  // Earliest first; on a tie the OUTER classification wins, because a forward
  // banner is normally followed immediately by the quoted headers it introduces.
  const rank: Record<SegmentKind, number> = { FORWARDED: 0, QUOTED: 1, SIGNATURE: 2, AUTHORED: 3 }
  found.sort((a, b) => a.index - b.index || rank[a.kind] - rank[b.kind])

  const boundaries: Found[] = []
  let current: SegmentKind = 'AUTHORED'
  let lastIndex = -1
  for (const f of found) {
    if (f.index === lastIndex) continue          // two markers on the same spot
    if (f.kind === 'SIGNATURE' && current !== 'AUTHORED') continue
    if (f.kind === current) continue             // already in that kind
    boundaries.push(f)
    current = f.kind
    lastIndex = f.index
  }

  if (!boundaries.length) {
    return [{ kind: 'AUTHORED', text: body, start: 0, end: body.length, marker: null }]
  }

  const segments: EvidenceSegment[] = []
  if (boundaries[0].index > 0) {
    segments.push({
      kind: 'AUTHORED', text: body.slice(0, boundaries[0].index),
      start: 0, end: boundaries[0].index, marker: null,
    })
  }
  boundaries.forEach((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : body.length
    segments.push({
      kind: b.kind, text: body.slice(b.index, end),
      start: b.index, end, marker: b.marker.slice(0, 60),
    })
  })
  return segments
}
