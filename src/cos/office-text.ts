// Text out of the Office formats, again with nothing but Node's own zlib.
//
// WHY. After the PDF slice the live store reads 161 of 236 documents. What is
// left, apart from the 57 images that genuinely need OCR, is nine Office files:
// six spreadsheets, two .docx and one legacy .doc. A `.docx` and an `.xlsx` are
// ZIP archives of XML, so their text is an inflate and a tag-strip away -- no
// pip, no poppler, no new dependency, exactly as with the PDFs.
//
// THE LEGACY `.doc` IS NOT HANDLED and is not pretended to be. It is an OLE
// compound file, a different format wearing a similar extension, and there is
// exactly one of them. Guessing at it would produce the letter-ratio garbage
// the classifier exists to reject; leaving it as an honest UNSUPPORTED keeps
// the number of documents needing real work visible.
//
// The caller still decides whether the result is usable: `classifyExtraction`
// is not duplicated here.
import { inflateRawSync } from 'node:zlib'

/** One stored entry of a ZIP archive. */
interface ZipEntry { name: string; data: Buffer }

/**
 * Read a ZIP's entries via its END OF CENTRAL DIRECTORY record.
 *
 * Walking local file headers from the front is the tempting shortcut and it is
 * wrong: a local header may carry sizes of zero with the real values in a data
 * descriptor AFTER the compressed bytes, so a front-to-back reader has to guess
 * where each member ends. The central directory states both sizes and the
 * offset outright, which is why it exists.
 */
function zipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) return []
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    // ONLY stored (0) and deflate (8). Codex review P2-OFFICE-002: treating
    // every other method as raw deflate means an unsupported compression whose
    // payload happens to inflate gets read as document text. A member we cannot
    // decode is skipped explicitly; the others still carry the text.
    if (method !== 0 && method !== 8) continue
    try {
      out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) })
    } catch {
      // Damaged or truncated. Skipped rather than faked.
    }
  }
  return out
}

/** The end-of-central-directory record, searched from the back as the spec says. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i
  return -1
}

/** XML to readable text: entities decoded, tags dropped, paragraphs kept apart. */
function xmlText(xml: string, blockTags: RegExp): string {
  return xml
    // A paragraph or row boundary is a line, not a space: joining a
    // spreadsheet's rows into one line is how a total ends up glued to a date.
    .replace(blockTags, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface OfficeTextResult {
  text: string
  /** Which reader ran, so an empty result can be told from an unsupported one. */
  kind: 'DOCX' | 'XLSX' | 'UNSUPPORTED'
  /** ZIP members found. Zero means this did not parse as a ZIP at all. */
  entries: number
}

/**
 * Extract text from a `.docx` or `.xlsx`. Deterministic: no clock, no
 * randomness, so an unchanged rerun cannot mint a change.
 */
export function officeText(bytes: Buffer): OfficeTextResult {
  const entries = zipEntries(bytes)
  if (entries.length === 0) return { text: '', kind: 'UNSUPPORTED', entries: 0 }
  const byName = new Map(entries.map((e) => [e.name, e.data]))

  const doc = byName.get('word/document.xml')
  if (doc) {
    return {
      text: xmlText(doc.toString('utf8'), /<\/w:p>|<w:br\b[^>]*\/?>/g),
      kind: 'DOCX',
      entries: entries.length,
    }
  }

  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
  if (sheets.length > 0) {
    // A spreadsheet keeps most of its text in a SHARED STRING TABLE and the
    // cells hold indices into it. Reading only the sheets returns numbers and
    // nothing else, which reads as a successful extraction of a document that
    // "has no words" -- the wrong answer twice over.
    const shared = byName.get('xl/sharedStrings.xml')
    const strings = shared
      ? [...shared.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
        .map((m) => xmlText(m[1], /<\/t>/g))
      : []
    const parts: string[] = []
    for (const sheet of sheets.sort((a, b) => a.name.localeCompare(b.name))) {
      const xml = sheet.data.toString('utf8')
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = []
        for (const c of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const isShared = /\bt="s"/.test(c[1])
          const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1]
          if (v === undefined) {
            const inline = xmlText(c[2], /<\/t>/g)
            if (inline) cells.push(inline)
            continue
          }
          cells.push(isShared ? (strings[Number(v)] ?? '') : v)
        }
        const line = cells.filter((x) => x !== '').join(' ')
        if (line) parts.push(line)
      }
    }
    return { text: parts.join('\n').trim(), kind: 'XLSX', entries: entries.length }
  }

  return { text: '', kind: 'UNSUPPORTED', entries: entries.length }
}
