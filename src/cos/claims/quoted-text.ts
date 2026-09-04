// WHERE THE AUTHOR STOPS AND THE QUOTE BEGINS.
//
// Found by reading Kállai's actual reply of 2026-09-04 rather than by imagining
// one. His message answers four numbered questions in about six lines, and then
// carries Istvan's entire previous mail below a separator -- including
// `PLYCOMP112X`, `C pozíció` and `bruttó 69 130 Ft`. Every one of those is a
// real string in the vendor's message, and not one of them is the vendor's
// claim.
//
// Getting this wrong does not produce a missing claim, which is visible. It
// produces a CONFIDENT WRONG ATTRIBUTION: the price Istvan quoted back becomes
// "the vendor states 69 130 Ft", and the whole point of a source-bound claim is
// exactly the binding this would break.
//
// The rule is deliberately conservative. Everything from the FIRST separator
// onward is quoted; a separator that appears mid-sentence in ordinary prose
// would only ever cause claims to be marked QUOTED rather than dropped, and a
// claim marked quoted is still recorded. The failure direction is therefore
// under-attribution, never over-attribution.

/** Lines that begin quoted reply text, in the clients this mailbox actually
 *  receives. Each is anchored to line start: `From:` inside a sentence is not a
 *  separator, and Outlook's underscore rule is a whole line of its own. */
const SEPARATORS: readonly RegExp[] = [
  // Outlook's horizontal rule, as plain text: a long run of underscores.
  /^_{10,}\s*$/m,
  // Outlook Hungarian and English attribution headers.
  /^\s*Feladó:\s/m,
  /^\s*From:\s/m,
  // Apple Mail / Gmail: "On <date> X wrote:" and its Hungarian form.
  /^\s*On .{0,120}\bwrote:\s*$/m,
  /^\s*.{0,80}\bírta \(?\d{4}\.?.{0,40}\)?:\s*$/m,
  // Classic forward/reply banner.
  /^-{2,}\s*(Original Message|Eredeti üzenet|Forwarded message)\s*-{2,}/mi,
]

export interface SplitBody {
  /** What the author of this message actually wrote. */
  authored: string
  /** Everything from the first quote separator onward, if any. */
  quoted: string
  /** Which separator matched, for the provenance line. Null when none did. */
  separator: string | null
}

/**
 * Split a plain-text mail body into what its author wrote and what it quotes.
 *
 * `>`-prefixed lines are NOT used as the boundary. They mark quoting in some
 * clients and nothing at all in others, and Outlook -- which is what Fluidra
 * sends from -- quotes without any prefix whatsoever. A rule that depended on
 * `>` would have marked the entire Kállai reply as authored, which is precisely
 * the failure this exists to stop.
 */
export function splitQuotedBody(body: string): SplitBody {
  let cut = -1
  let separator: string | null = null
  for (const re of SEPARATORS) {
    const m = re.exec(body)
    if (m && m.index >= 0 && (cut === -1 || m.index < cut)) {
      cut = m.index
      separator = m[0].trim().slice(0, 40)
    }
  }
  if (cut === -1) return { authored: body, quoted: '', separator: null }
  return { authored: body.slice(0, cut), quoted: body.slice(cut), separator }
}
