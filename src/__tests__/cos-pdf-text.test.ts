import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { pdfText } from '../cos/pdf-text.js'

// The PDF half of P2 source coverage. Measured on the live store before writing
// any of it: 236 documents, 58 with usable text, and 48 PDFs carrying NONE --
// invisible to an evidence gate that reads `extracted_text`.
//
// These cases are built from synthetic PDFs rather than fixtures of real
// invoices, because the real ones are Istvan's and a test corpus is a place
// secrets go to live. What they pin down is the behaviour that the first
// implementation got WRONG against the real 48, since a measurement that
// improved from 10 to 44 is worth keeping from regressing.

/** A minimal PDF carrying one deflated content stream per body. */
function pdf(...streamBodies: string[]): Buffer {
  return pdfWithDicts(...streamBodies.map((b) => ['<< /Length 0 >>', b] as [string, string]))
}

/** One numbered object carrying a deflated stream. */
function pdfObj(num: number, dict: string, body: string): Buffer {
  return pdfObjGen(num, 0, dict, body)
}

/** The same, at an explicit generation. */
function pdfObjGen(num: number, gen: number, dict: string, body: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${num} ${gen} obj\n${dict}\nstream\n`, 'latin1'),
    deflateSync(Buffer.from(body, 'latin1')),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ])
}

/** The same, with each stream's object dictionary spelled out. */
function pdfWithDicts(...objects: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  objects.forEach(([dict, body], i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n${dict}\nstream\n`, 'latin1'))
    parts.push(deflateSync(Buffer.from(body, 'latin1')))
    parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'))
  })
  return Buffer.concat(parts)
}

describe('pdfText', () => {
  it('reads a plain text object', () => {
    const r = pdfText(pdf('BT /F1 12 Tf (Invoice 4062405874) Tj ET'))
    expect(r.text).toContain('Invoice 4062405874')
    expect(r.streams).toBe(1)
  })

  it('ONLY takes show-text operands, not every parenthesised literal', () => {
    // The defect the first version shipped with. Operator arguments, font names
    // and dictionary values are all parenthesised too, and sweeping them in
    // produced letter ratios of 0.17-0.44 on real files -- the classifier
    // rejected 38 of 48 PDFs whose text was in fact perfectly readable.
    const r = pdfText(pdf(
      '<< /Producer (SomeLibrary 9.9) /Title (not body text) >>\n'
      + 'BT (Fizetendo osszeg 31138 Ft) Tj ET',
    ))
    expect(r.text).toContain('Fizetendo osszeg 31138 Ft')
    expect(r.text).not.toContain('SomeLibrary')
    expect(r.text).not.toContain('not body text')
  })

  it('reads a TJ array and turns a large negative kern into a word gap', () => {
    const r = pdfText(pdf('BT [(Szamla) -400 (sorszama) -400 (4062405874)] TJ ET'))
    expect(r.text).toContain('Szamla sorszama 4062405874')
  })

  it('does NOT insert a gap for ordinary kerning', () => {
    const r = pdfText(pdf('BT [(Sza) -20 (mla)] TJ ET'))
    expect(r.text).toContain('Szamla')
  })

  it('applies the ToUnicode map to HEX strings', () => {
    const cmap = 'beginbfchar <0041> <0056> <0042> <00E1> endbfchar'
    const r = pdfText(pdf(cmap, 'BT <00410042> Tj ET'))
    expect(r.text).toContain('Vá')
  })

  it('applies the ToUnicode map to PARENTHESISED literals too', () => {
    // The pitfall that cost a real invoice on 2026-08-09: everything sat in
    // `(...)` and the remap only ran on hex, so the output stayed `2 # ) '`.
    // A non-empty CMap plus garbled text means the map is applied in the wrong
    // place, not that it is missing.
    // TWO-digit keys: a simple (non-CID) font addresses glyphs with one byte,
    // and the CMap says so through its key width. Four-digit keys would declare
    // a two-byte font, and the literal below carries single bytes.
    const cmap = 'beginbfchar <32> <0050> <23> <0041> <29> <0047> <27> <0045> endbfchar'
    // The `)` is escaped, as a real PDF must escape it: an unescaped one ENDS
    // the literal, which is exactly what the parser did when this fixture was
    // written wrong -- and being strict there is correct behaviour, not a bug.
    const r = pdfText(pdf(cmap, "BT (2#\\)') Tj ET"))
    expect(r.cmapEntries).toBeGreaterThan(0)
    expect(r.text).toContain('PAGE')
  })

  it('refuses an identity bfrange that claims the whole code space', () => {
    // Measured on a real quote PDF: a range covering 0000-FFFF produced a
    // 65536-entry map that poisoned every other font's codes and dropped the
    // letter ratio to 0.17. A map that claims everything explains nothing.
    const identity = 'beginbfrange <0000> <FFFF> <0000> endbfrange'
    const real = 'beginbfchar <0041> <00E9> endbfchar'
    const r = pdfText(pdf(identity, real, 'BT <0041> Tj ET'))
    expect(r.cmapEntries).toBeLessThan(4096)
    expect(r.text).toContain('é')
  })

  it('honours PDF escapes inside a literal', () => {
    const r = pdfText(pdf('BT (a\\(b\\)c \\101) Tj ET'))
    expect(r.text).toContain('a(b)c A')
  })

  it('is deterministic: the same bytes give the same text', () => {
    const bytes = pdf('BT (Fizetesi hatarido 2026.09.07) Tj ET')
    expect(pdfText(bytes).text).toBe(pdfText(bytes).text)
  })

  it('returns nothing readable for a PDF with no text layer, rather than inventing some', () => {
    // A scanned page. The honest answer is empty, and it is ALSO the
    // measurement of what would need OCR -- which is why this must not be
    // papered over with a fallback that scrapes bytes.
    const r = pdfText(pdf('/Im0 Do'))
    expect(r.text).toBe('')
  })

  it('survives a stream that does not inflate, and still reads the others', () => {
    const broken = Buffer.concat([
      Buffer.from('%PDF-1.4\nstream\n', 'latin1'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from('\nendstream\n', 'latin1'),
      Buffer.from('stream\n', 'latin1'),
      deflateSync(Buffer.from('BT (still here) Tj ET', 'latin1')),
      Buffer.from('\nendstream\n', 'latin1'),
    ])
    expect(pdfText(broken).text).toContain('still here')
  })

  // ── Codex review findings, 2026-09-06 ──────────────────────────────────────

  it('PDF-CMAP-001: decodes MULTIBYTE literal codes, not one byte at a time', () => {
    // A subset font addresses glyphs with two-byte codes. Decoding a literal
    // that carries them byte-wise turns real text into noise, and the first
    // implementation did exactly that.
    const cmap = 'beginbfchar <0101> <0056> <0102> <00E1> <0103> <0063> endbfchar'
    const body = 'BT (\\001\\001\\001\\002\\001\\003) Tj ET'
    const r = pdfText(pdf(cmap, body))
    expect(r.codeBytes).toBe(2)
    expect(r.text).toContain('Vác')
  })

  it('PDF-STREAM-002: a non-page stream carrying show-text syntax contributes NOTHING', () => {
    // A font program or an image can contain bytes that look like BT..ET. If
    // those reach the output, a SCANNED page can come back with apparent text
    // -- the exact fabrication this module promises not to commit.
    const r = pdfWithDicts(
      ['<< /Type /Font /Subtype /Type1 /Length 0 >>', 'BT (ghost text from a font) Tj ET'],
      ['<< /Subtype /Image /Width 8 /Length 0 >>', 'BT (ghost text from an image) Tj ET'],
    )
    const out = pdfText(r)
    expect(out.text).toBe('')
    expect(out.streamsSkipped).toBe(2)
  })

  it('...and a real page stream alongside them is still read', () => {
    const out = pdfText(pdfWithDicts(
      ['<< /Type /Font /Length 0 >>', 'BT (ghost) Tj ET'],
      ['<< /Filter /FlateDecode /Length 99 >>', 'BT (Fizetendo 31138 Ft) Tj ET'],
    ))
    expect(out.text).toContain('Fizetendo 31138 Ft')
    expect(out.text).not.toContain('ghost')
  })

  it('a REJECTED wide range must not widen the decoder', () => {
    // The regression the fix for PDF-CMAP-001 introduced, caught by re-running
    // the 48 real PDFs: a discarded 0000-FFFF range still flipped the width to
    // two bytes, every literal then decoded through an empty map, and one
    // document went from 994 characters to zero.
    const r = pdfText(pdf('beginbfrange <0000> <FFFF> <0000> endbfrange', 'BT (plain ascii) Tj ET'))
    expect(r.cmapEntries).toBe(0)
    expect(r.codeBytes).toBe(1)
    expect(r.text).toContain('plain ascii')
  })

  it('PDF-CMAP-002: a two-byte code whose VALUE is small still decodes at two bytes', () => {
    // `<0001> <0041>` is an ordinary two-byte mapping. Testing the numeric
    // value instead of the key's hex length left it decoding at one byte and
    // producing nothing. Four hex digits IS the declaration.
    const cmap = 'beginbfchar <0001> <0041> <0002> <0042> endbfchar'
    const r = pdfText(pdf(cmap, 'BT (\\000\\001\\000\\002) Tj ET'))
    expect(r.codeBytes).toBe(2)
    expect(r.text).toContain('AB')
  })

  it('PDF-STREAM-003: only the streams a /Type /Page NAMES are read', () => {
    // Positive identification, not a blacklist. An untyped stream that no page
    // references is not page content, and "not on my list" was never the same
    // claim as "this is page content".
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /Page /Contents 5 0 R >>\nendobj\n', 'latin1'),
      pdfObj(5, '<< /Length 0 >>', 'BT (real page text) Tj ET'),
      pdfObj(6, '<< /Length 0 >>', 'BT (orphan stream nobody references) Tj ET'),
    ])
    const r = pdfText(bytes)
    expect(r.contentSelection).toBe('PAGE_CONTENTS')
    expect(r.text).toContain('real page text')
    expect(r.text).not.toContain('orphan')
  })

  it('...and a /Contents ARRAY names several streams, all of which are read', () => {
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /Page /Contents [5 0 R 6 0 R] >>\nendobj\n', 'latin1'),
      pdfObj(5, '<< /Length 0 >>', 'BT (first half) Tj ET'),
      pdfObj(6, '<< /Length 0 >>', 'BT (second half) Tj ET'),
    ])
    const r = pdfText(bytes)
    expect(r.text).toContain('first half')
    expect(r.text).toContain('second half')
  })

  it('PDF-STREAM-004: a page reference honours the GENERATION number', () => {
    // `/Contents 5 1 R` must not select `5 0 obj`. Discarding the generation
    // picks the wrong stream while still calling itself positive
    // identification, which is worse than the blacklist it replaced.
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /Page /Contents 5 1 R >>\nendobj\n', 'latin1'),
      pdfObjGen(5, 0, '<< /Length 0 >>', 'BT (superseded generation) Tj ET'),
      pdfObjGen(5, 1, '<< /Length 0 >>', 'BT (the referenced generation) Tj ET'),
    ])
    const r = pdfText(bytes)
    expect(r.contentSelection).toBe('PAGE_CONTENTS')
    expect(r.text).toContain('the referenced generation')
    expect(r.text).not.toContain('superseded')
  })

  it('says out loud when it had to fall back to the weaker rule', () => {
    // No page object could be resolved, so the type blacklist applied. The two
    // paths carry different guarantees and the result must not blur them.
    const r = pdfText(pdf('BT (no page object anywhere) Tj ET'))
    expect(r.contentSelection).toBe('TYPE_BLACKLIST')
    expect(r.text).toContain('no page object anywhere')
  })

  it('is not a PDF at all: no streams, no text, no throw', () => {
    const r = pdfText(Buffer.from('this is a plain text file', 'utf8'))
    expect(r.streams).toBe(0)
    expect(r.text).toBe('')
  })
})
