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

interface PdfStream { dict: string; body: Buffer; objRef: string | null }

/**
 * Streams that could plausibly BE page content, each with the dictionary that
 * introduced it.
 *
 * The dictionary is the point. Scanning every stream in the file lets a font
 * program, a form, an embedded file or a metadata blob contribute "text" if its
 * bytes happen to contain BT..ET show-text syntax -- so a SCANNED page could
 * come back with apparent text, which is precisely the fabrication this module
 * promises not to do. Codex review PDF-STREAM-002 raised it, and it is right:
 * the previous version took all of them.
 *
 * A conforming answer resolves each page's /Contents. This is narrower than
 * that and says so: it refuses the object types that are known NOT to be page
 * content. What that buys is a real reduction in the fabrication surface
 * without a PDF object parser; what it does not buy is a guarantee, and a
 * stream with no dictionary at all is still read.
 */
const NOT_PAGE_CONTENT = /\/(Subtype\s*\/Image|Type\s*\/(Font|FontDescriptor|Metadata|XRef|EmbeddedFile|Filespec)|FontFile[23]?\b)/

// `/ToUnicode` is deliberately NOT in that list, and the reason cost a real
// document. A PAGE's /Resources references its fonts' ToUnicode CMaps by
// indirect reference, so excluding on that token threw away the page itself:
// measured, one quote PDF went from 994 characters to zero. The token appears
// on both sides, so it cannot separate them.

function streams(pdf: Buffer): PdfStream[] {
  const out: PdfStream[] = []
  // `(?<![a-zA-Z])` because `endstream\n` ENDS WITH `stream\n`. Without it every
  // stream produced a phantom second one starting at its own terminator, whose
  // "body" was whatever followed in the file. Harmless-looking -- those bytes
  // rarely inflate and rarely contain BT..ET -- but it is a route for text to
  // appear from outside any content stream, which is the fabrication this
  // module must not commit. Found by a test written for a different finding.
  const re = /(?<![a-zA-Z])stream\r?\n/g
  let m: RegExpExecArray | null
  const hay = pdf.toString('latin1')
  while ((m = re.exec(hay)) !== null) {
    const start = m.index + m[0].length
    const end = hay.indexOf('endstream', start)
    if (end < 0) continue
    // The WHOLE object header, from `obj` to `stream` -- not the nearest `<<`.
    // Taking the nearest one lands inside a nested dictionary (a /Resources or
    // a /Font entry) and then judges the stream by a fragment of something
    // else's declaration.
    const objStart = hay.lastIndexOf(' obj', m.index)
    const dict = objStart >= 0 && m.index - objStart < 4096 ? hay.slice(objStart, m.index) : ''
    // The object's FULL identity -- number AND generation. Codex review
    // PDF-STREAM-004: discarding the generation lets `/Contents 5 1 R` select
    // an unreferenced `5 0 obj`, which is precisely the wrong stream dressed as
    // positive identification.
    const header = objStart >= 0 ? hay.slice(Math.max(0, objStart - 24), objStart) : ''
    const num = /(\d+)\s+(\d+)\s*$/.exec(header)
    const objRef = num ? `${num[1]} ${num[2]}` : null
    const raw = pdf.subarray(start, end)
    let body: Buffer
    try {
      body = inflateSync(raw)
    } catch {
      // Not deflated (or damaged). The bytes may still be readable text
      // operators, so it is kept rather than dropped -- an unreadable stream is
      // a fact for the classifier, not a reason to lose the others.
      body = raw
    }
    out.push({ dict, body, objRef })
  }
  return out
}

/** Streams whose own dictionary says they are not page content. */
function isPageContentCandidate(s: PdfStream): boolean {
  return !NOT_PAGE_CONTENT.test(s.dict)
}

/**
 * The object numbers a `/Type /Page` names in its `/Contents`.
 *
 * POSITIVE IDENTIFICATION, which is what Codex review PDF-STREAM-003 asked for:
 * a blacklist of known-bad dictionary types renders everything it has not been
 * told about -- untyped streams, object streams, anything a future producer
 * invents -- and "not on my list" is not the same claim as "this is page
 * content". When the pages can be resolved, ONLY they are read.
 *
 * The blacklist survives as the fallback for files where no page object is
 * found at all (a linearised or object-stream PDF this regex cannot walk), and
 * the result says which path was taken, so a caller is never left guessing
 * whether the strict rule applied.
 */
function pageContentObjects(pdf: string): Set<string> {
  const wanted = new Set<string>()
  for (const m of pdf.matchAll(/\/Type\s*\/Page[^s]([\s\S]{0,2000}?)(?:endobj|>>\s*stream)/g)) {
    const contents = /\/Contents\s*(?:(\d+)\s+(\d+)\s*R|\[([^\]]*)\])/.exec(m[1])
    if (!contents) continue
    if (contents[1]) { wanted.add(`${contents[1]} ${contents[2]}`); continue }
    for (const ref of (contents[3] ?? '').matchAll(/(\d+)\s+(\d+)\s*R/g)) wanted.add(`${ref[1]} ${ref[2]}`)
  }
  return wanted
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
export interface CMap { map: Map<number, string>; codeBytes: 1 | 2 }

function toUnicodeMap(chunks: PdfStream[]): CMap {
  const map = new Map<number, string>()
  // How wide the SOURCE codes are, read off the CMap's own keys rather than
  // guessed per string. Codex review PDF-CMAP-001: a subset font's literals
  // carry two-byte codes, and decoding them one byte at a time turns real text
  // into noise. Four hex digits means two bytes.
  let codeBytes: 1 | 2 = 1
  const hexChar = (h: string): string => {
    // A destination can be several UTF-16 code units; take them all.
    let s = ''
    for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    return s || String.fromCharCode(parseInt(h.slice(0, 4).padEnd(4, '0'), 16))
  }
  for (const c of chunks) {
    const t = c.body.toString('latin1')
    for (const block of t.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      for (const pair of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const code = parseInt(pair[1], 16)
        if (!map.has(code)) map.set(code, hexChar(pair[2]))
        // Width is the KEY'S HEX LENGTH, not its numeric value. Codex review
        // PDF-CMAP-002: `<0001> <0041>` is a perfectly ordinary two-byte
        // mapping whose value happens to be small, and testing `code > 0xff`
        // left it decoding at one byte. Four hex digits IS the declaration.
        //
        // Width is claimed only by an entry that was actually KEPT. A rejected
        // one must not widen the decoder: measured on a real quote PDF, a
        // discarded wide range still flipped the width to two bytes, and every
        // literal then decoded through an EMPTY map to nothing at all --
        // 994 characters became zero.
        if (pair[1].length >= 4) codeBytes = 2
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
        if (r[1].length >= 4) codeBytes = 2
      }
    }
  }
  // An empty table cannot declare a width: two-byte decoding through no map at
  // all returns nothing for every string, which is worse than not remapping.
  return { map, codeBytes: map.size === 0 ? 1 : codeBytes }
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
function renderText(chunks: PdfStream[], cmap: CMap, pages: Set<string>): string {
  const parts: string[] = []
  for (const c of chunks) {
    if (pages.size > 0) {
      if (c.objRef === null || !pages.has(c.objRef)) continue
    } else if (!isPageContentCandidate(c)) continue
    const t = c.body.toString('latin1')
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
function showText(operand: string, cmap: CMap): string {
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

function hexString(hex: string, cmap: CMap): string {
  const h = hex.replace(/\s+/g, '')
  if (!h) return ''
  // The width comes from the CMap's own keys, not from whether the string
  // happens to divide by four.
  const width = cmap.codeBytes === 2 && h.length % 4 === 0 ? 4 : 2
  let s = ''
  for (let i = 0; i + width <= h.length; i += width) {
    const code = parseInt(h.slice(i, i + width), 16)
    s += cmap.map.get(code) ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : '')
  }
  return s
}

/** THE PITFALL THAT COST A REAL INVOICE, 2026-08-09: the CMap has to be applied
 *  to the PARENTHESISED literals too. An invoice came back as `2 # ) '` because
 *  all of its content sat in `(...)` and the remap only ran on hex. The tell is
 *  specific: a NON-EMPTY CMap and still-garbled output means the map is being
 *  applied in the wrong place, not that it is missing. */
function literalString(src: string, cmap: CMap): string {
  const bytes = literalBytes(src)
  // MULTIBYTE CODES. Codex review PDF-CMAP-001: a subset font addresses glyphs
  // with two-byte codes, and a literal carrying them decoded one byte at a time
  // is noise, not text. The width is the CMap's, read from its keys.
  if (cmap.codeBytes === 2) {
    let s = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1]
      s += cmap.map.get(code) ?? ''
    }
    return s
  }
  return bytes
    .map((b) => cmap.map.get(b) ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : ''))
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
  /** Streams the dictionary filter refused as not-page-content. Reported so a
   *  surprising empty result can be told apart from a file with no text. */
  streamsSkipped: number
  /** Source-code width the CMap declares, 1 or 2 bytes. */
  codeBytes: 1 | 2
  /** How page content was identified. `PAGE_CONTENTS` means only the streams a
   *  /Type /Page names were read. `TYPE_BLACKLIST` means no page object could
   *  be resolved and the weaker rule applied -- stated rather than hidden,
   *  because the two carry different guarantees. */
  contentSelection: 'PAGE_CONTENTS' | 'TYPE_BLACKLIST'
}

/**
 * Extract what text a PDF actually carries. Deterministic: no clock, no
 * randomness, so the same bytes always produce the same string and a re-run
 * cannot mint a spurious change.
 */
export function pdfText(bytes: Buffer): PdfTextResult {
  const chunks = streams(bytes)
  // The CMap is gathered from EVERY stream -- ToUnicode lives in its own object
  // and is filtered out of rendering on purpose, so it must be read before that
  // filter applies.
  const cmap = toUnicodeMap(chunks)
  const pages = pageContentObjects(bytes.toString('latin1'))
  const raw = renderText(chunks, cmap, pages)
  // Collapse the whitespace PDFs scatter between glyph runs, without joining
  // words that were genuinely separate.
  const text = raw.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return {
    text,
    streams: chunks.length,
    cmapEntries: cmap.map.size,
    streamsSkipped: pages.size > 0
      ? chunks.filter((c) => c.objRef === null || !pages.has(c.objRef)).length
      : chunks.filter((c) => !isPageContentCandidate(c)).length,
    codeBytes: cmap.codeBytes,
    contentSelection: pages.size > 0 ? 'PAGE_CONTENTS' : 'TYPE_BLACKLIST',
  }
}
