// Text out of a PDF, with nothing but Node's own zlib.
//
// WHY THIS EXISTS. Measured on the live store, 2026-09-06: 236 documents, and
// only 58 carry usable text. The single largest silent gap is PDF -- 48
// documents, ZERO of them with any text at all -- and the pre-question evidence
// gate reads `extracted_text`, so every one of those 48 is invisible to it.
// The text-extraction script that runs today handles `text/*` and deliberately
// refuses everything else, saying that "a PDF or an image needs a real
// extractor". This is that extractor for the PDF half.
//
// NO NEW DEPENDENCY, and that is a constraint rather than a preference: this
// host has no pip, no poppler, no pdftotext. The procedure below is the one
// proven on this machine against real invoices and authority specs, and its
// pitfalls are paid for -- see `pdf-text-extract-stdlib`.
//
// WHAT IT DOES NOT DO. It does not OCR. A scanned PDF has no text to find, and
// this returns little or nothing for one -- which is the correct answer and,
// usefully, is also the MEASUREMENT of how many documents would actually need
// OCR. Nobody has to guess at that number now; running this produces it.
//
// The caller decides whether what comes back is usable. `classifyExtraction`
// already exists for that and is not duplicated here: a garbage field is worse
// than an empty one.
import { inflateSync } from 'node:zlib'

/** Every `stream ... endstream` body, inflated where it inflates. */
function streams(pdf: Buffer): Buffer[] {
  const out: Buffer[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  const hay = pdf.toString('latin1')
  while ((m = re.exec(hay)) !== null) {
    const start = m.index + m[0].length
    const end = hay.indexOf('endstream', start)
    if (end < 0) continue
    const raw = pdf.subarray(start, end)
    try {
      out.push(inflateSync(raw))
    } catch {
      // Not deflated (or damaged). The bytes may still be readable text
      // operators, so it is kept rather than dropped -- an unreadable stream is
      // a fact for the classifier, not a reason to lose the others.
      out.push(raw)
    }
  }
  return out
}

/**
 * The `code -> character` table a subset font needs.
 *
 * Built by merging every ToUnicode CMap in the file rather than tracking which
 * font is current. That is deliberately approximate: getting it exactly right
 * means interpreting `Tf` operators and font resources, and the payoff here is
 * a letter ratio the classifier will accept, not typographic fidelity. Where
 * two fonts disagree on a code the first wins, which is stable across runs.
 */
function toUnicodeMap(chunks: Buffer[]): Map<number, string> {
  const map = new Map<number, string>()
  const hexChar = (h: string): string => {
    // A destination can be several UTF-16 code units; take them all.
    let s = ''
    for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    return s || String.fromCharCode(parseInt(h.slice(0, 4).padEnd(4, '0'), 16))
  }
  for (const c of chunks) {
    const t = c.toString('latin1')
    for (const block of t.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      for (const pair of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const code = parseInt(pair[1], 16)
        if (!map.has(code)) map.set(code, hexChar(pair[2]))
      }
    }
    for (const block of t.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      for (const r of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), dst = parseInt(r[3], 16)
        // A range covering the whole 16-bit space is an IDENTITY map dressed as
        // a translation. Merging one poisons every other font's codes: measured
        // on a real quote PDF it produced a 65536-entry map and a 0.17 letter
        // ratio. A map that claims everything explains nothing.
        if (hi < lo || hi - lo > 4096) continue
        for (let i = lo; i <= hi; i++) if (!map.has(i)) map.set(i, String.fromCharCode(dst + (i - lo)))
      }
    }
  }
  return map
}

/** Decode one `(...)` literal's bytes, honouring PDF escapes. */
function literalBytes(src: string): number[] {
  const out: number[] = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch !== '\\') { out.push(src.charCodeAt(i)); continue }
    const next = src[++i]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && src[i + 1] >= '0' && src[i + 1] <= '7') oct += src[++i]
      out.push(parseInt(oct, 8) & 0xff)
      continue
    }
    const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
    out.push(esc[next] ?? next.charCodeAt(0))
  }
  return out
}

/**
 * THE PITFALL THAT COST A REAL INVOICE. The CMap must be applied to the
 * PARENTHESISED literals too, not only to `<hex>` strings.
 *
 * On 2026-08-09 an invoice came back as `2 # ) '` because every piece of its
 * content sat in `(...)` literals and the remap only ran on hex. The tell is
 * specific and worth keeping: a NON-EMPTY CMap and still-garbled output means
 * the map is being applied in the wrong place, not that it is missing.
 */
function renderText(chunks: Buffer[], cmap: Map<number, string>): string {
  const parts: string[] = []
  for (const c of chunks) {
    const t = c.toString('latin1')
    // ONLY inside text objects, and only strings that are OPERANDS of a
    // show-text operator. The first version took every `(...)` in every
    // stream, which swept up operator arguments, font names and binary noise:
    // measured on 48 real PDFs it produced letter ratios of 0.17-0.44 and the
    // classifier rejected 38 of them. The text is there; the surrounding
    // garbage is what made it unreadable.
    for (const block of t.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      const body = block[1]
      for (const op of body.matchAll(
        /(\[(?:[^\]\\]|\\[\s\S])*\]|<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\[\s\S])*\))\s*(TJ|Tj|'|")/g,
      )) {
        parts.push(showText(op[1], cmap))
      }
      parts.push('\n')
    }
  }
  return parts.join('')
}

/** One show-text operand: an array, a hex string, or a literal. */
function showText(operand: string, cmap: Map<number, string>): string {
  if (operand.startsWith('[')) {
    // A TJ array interleaves strings with kerning numbers. A large negative
    // kern is a word gap; keeping that is the difference between readable text
    // and one long word.
    let out = ''
    for (const m of operand.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\[\s\S])*)\)|(-?\d+(?:\.\d+)?)/g)) {
      if (m[1] !== undefined) out += hexString(m[1], cmap)
      else if (m[2] !== undefined) out += literalString(m[2], cmap)
      else if (m[3] !== undefined && Number(m[3]) <= -120) out += ' '
    }
    return out
  }
  if (operand.startsWith('<')) return hexString(operand.slice(1, -1), cmap)
  return literalString(operand.slice(1, -1), cmap)
}

function hexString(hex: string, cmap: Map<number, string>): string {
  const h = hex.replace(/\s+/g, '')
  if (!h) return ''
  const width = h.length % 4 === 0 && cmap.size > 0 ? 4 : 2
  let s = ''
  for (let i = 0; i + width <= h.length; i += width) {
    const code = parseInt(h.slice(i, i + width), 16)
    s += cmap.get(code) ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : '')
  }
  return s
}

/** THE PITFALL THAT COST A REAL INVOICE, 2026-08-09: the CMap has to be applied
 *  to the PARENTHESISED literals too. An invoice came back as `2 # ) '` because
 *  all of its content sat in `(...)` and the remap only ran on hex. The tell is
 *  specific: a NON-EMPTY CMap and still-garbled output means the map is being
 *  applied in the wrong place, not that it is missing. */
function literalString(src: string, cmap: Map<number, string>): string {
  return literalBytes(src)
    .map((b) => cmap.get(b) ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : ''))
    .join('')
}

export interface PdfTextResult {
  text: string
  /** Streams found; zero means this did not parse as a PDF we can read. */
  streams: number
  /** ToUnicode entries merged. Non-empty plus garbled output is the signature
   *  of a remap applied in the wrong place -- kept in the result so a caller
   *  can tell that case from "the PDF has no text layer". */
  cmapEntries: number
}

/**
 * Extract what text a PDF actually carries. Deterministic: no clock, no
 * randomness, so the same bytes always produce the same string and a re-run
 * cannot mint a spurious change.
 */
export function pdfText(bytes: Buffer): PdfTextResult {
  const chunks = streams(bytes)
  const cmap = toUnicodeMap(chunks)
  const raw = renderText(chunks, cmap)
  // Collapse the whitespace PDFs scatter between glyph runs, without joining
  // words that were genuinely separate.
  const text = raw.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { text, streams: chunks.length, cmapEntries: cmap.size }
}
