import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { officeText } from '../cos/office-text.js'

// The Office half of P2 source coverage. After the PDF slice the live store
// read 161 of 236 documents; nine of the remainder are Office files. Fixtures
// are synthetic, as with the PDFs -- the real ones are Istvan's contracts and
// quotes, and a test corpus is a place secrets go to live.

/** A minimal ZIP with a central directory, which is what the reader walks.
 *  `method` and `corrupt` exist so the failure paths can be exercised for real
 *  -- Codex review P2-OFFICE-003 caught a "survives a broken member" case whose
 *  fixture had no broken member in it. */
function zip(files: Array<[string, string] | [string, string, { method?: number; corrupt?: boolean }]>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of files) {
    const [name, content] = entry
    const opts = (entry[2] ?? {}) as { method?: number; corrupt?: boolean }
    const method = opts.method ?? 8
    const deflated = deflateRawSync(Buffer.from(content, 'utf8'))
    // Garbage of the SAME length, so the header stays truthful about sizes and
    // only the payload is undecodable -- which is what a damaged member is.
    const data = opts.corrupt ? Buffer.alloc(deflated.length, 0xff) : deflated
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(Buffer.byteLength(content), 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(Buffer.byteLength(content), 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

describe('officeText', () => {
  it('reads a .docx and keeps paragraphs on their own lines', () => {
    const r = officeText(zip([['word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>Arajanlat</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Vegosszeg 31138 Ft</w:t></w:r></w:p></w:body></w:document>']]))
    expect(r.kind).toBe('DOCX')
    expect(r.text).toContain('Arajanlat')
    expect(r.text).toContain('Vegosszeg 31138 Ft')
    // Paragraphs are lines, not one run-on sentence.
    expect(r.text.split('\n').length).toBeGreaterThan(1)
  })

  it('resolves an .xlsx SHARED STRING table', () => {
    // A spreadsheet keeps most text in a shared table and the cells hold
    // indices. Reading only the sheets returns bare numbers, which reads as a
    // document that "has no words" -- wrong twice over.
    const r = officeText(zip([
      ['xl/sharedStrings.xml', '<sst><si><t>Hatarido</t></si><si><t>Osszeg</t></si></sst>'],
      ['xl/worksheets/sheet1.xml',
        '<worksheet><sheetData>'
        + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
        + '<row><c><v>2026</v></c><c><v>31138</v></c></row>'
        + '</sheetData></worksheet>'],
    ]))
    expect(r.kind).toBe('XLSX')
    expect(r.text).toContain('Hatarido Osszeg')
    expect(r.text).toContain('2026 31138')
  })

  it('keeps rows on separate lines, so a total is not glued to a date', () => {
    const r = officeText(zip([['xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row><c><v>1</v></c></row><row><c><v>2</v></c></row></sheetData></worksheet>']]))
    expect(r.text).toBe('1\n2')
  })

  it('reads an inline string cell, which carries no shared-table index', () => {
    const r = officeText(zip([['xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row><c t="inlineStr"><is><t>Inline value</t></is></c></row></sheetData></worksheet>']]))
    expect(r.text).toContain('Inline value')
  })

  it('decodes XML entities rather than leaking them into the text', () => {
    const r = officeText(zip([['word/document.xml',
      '<w:p><w:t>Bont&#225;s &amp; burkol&#225;s &lt;20 m2&gt;</w:t></w:p>']]))
    expect(r.text).toContain('Bontás & burkolás <20 m2>')
  })

  it('reads several sheets in a stable order', () => {
    const r = officeText(zip([
      ['xl/worksheets/sheet2.xml', '<sheetData><row><c><v>second</v></c></row></sheetData>'],
      ['xl/worksheets/sheet1.xml', '<sheetData><row><c><v>first</v></c></row></sheetData>'],
    ]))
    expect(r.text).toBe('first\nsecond')
  })

  it('is deterministic: the same bytes give the same text', () => {
    const bytes = zip([['word/document.xml', '<w:p><w:t>same every time</w:t></w:p>']])
    expect(officeText(bytes).text).toBe(officeText(bytes).text)
  })

  it('a legacy .doc is UNSUPPORTED, not guessed at', () => {
    // An OLE compound file. There is exactly one in the store, and inventing a
    // reader for it would produce the garbage the classifier exists to reject
    // while hiding the fact that a document still needs real work.
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    const r = officeText(ole)
    expect(r.kind).toBe('UNSUPPORTED')
    expect(r.text).toBe('')
    expect(r.entries).toBe(0)
  })

  it('a ZIP that is neither docx nor xlsx is UNSUPPORTED but still parses', () => {
    const r = officeText(zip([['some/other.xml', '<x>content</x>']]))
    expect(r.kind).toBe('UNSUPPORTED')
    expect(r.entries).toBe(1)
  })

  it('survives a member that genuinely does NOT inflate, and still reads the others', () => {
    // The fixture now corrupts the payload for real. The earlier version
    // deflated both members correctly and therefore proved nothing -- a test
    // whose failure path never runs is a test that passes for the wrong reason.
    const bytes = zip([
      ['word/broken.xml', 'this payload gets replaced by garbage', { corrupt: true }],
      ['word/document.xml', '<w:p><w:t>still readable</w:t></w:p>'],
    ])
    const r = officeText(bytes)
    expect(r.entries).toBe(1)   // the broken one is skipped, not faked
    expect(r.text).toContain('still readable')
  })

  it('P2-OFFICE-002: an unsupported compression method is skipped, not guessed as deflate', () => {
    // Method 9 (deflate64) is not deflate. Feeding its payload to inflateRaw
    // and keeping whatever comes out is how an unreadable member becomes
    // "document text".
    const bytes = zip([['word/document.xml', '<w:p><w:t>should not appear</w:t></w:p>', { method: 9 }]])
    const r = officeText(bytes)
    expect(r.entries).toBe(0)
    expect(r.kind).toBe('UNSUPPORTED')
    expect(r.text).toBe('')
  })
})
