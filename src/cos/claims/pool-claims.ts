// READING A POOL-PART CONVERSATION INTO CLAIMS.
//
// Every rule below was written against a real message in the PRI-HOME-2026-005
// dossier, not against an imagined one, and the comments name which. That
// matters more than usual here: a heuristic extractor tested only on text its
// author invented measures how well the author can write text the regex likes.
//
// THE STANDING PROHIBITIONS, owner 2026-09-04, and they are the shape of this
// file rather than a note on it:
//
//   - no conflict resolution: two sources disagreeing produce two claims
//   - no "correct" value chosen between sources
//   - no reply draft
//   - no research
//
// So there is no comparison, no ranking between sources, no dedupe ACROSS
// sources, and nothing here reads another claim. A function that took two
// claims and returned one would be the Priority 3 layer wearing this file's
// name.
//
// DELIBERATELY CONSERVATIVE. Every rule needs a CUE -- a word that names the
// field -- before it will read a value. Pulling the largest number out of a mail
// and calling it the price is how an extractor produces confident nonsense; the
// invoice extractor in this repo carries a scar from exactly that (it once
// stored a supplier's bank account as an invoice number, at HIGH confidence).

import {
  normaliseExtractionText, parseHufAmounts, nameFromSender,
} from '../zst-extract-common.js'
import { segmentBody, type SegmentKind } from './segments.js'
import type {
  ClaimType, AttributionStatus, ClaimConfidence, ExtractionStatus,
  StructuredClaim, ClaimSource,
} from './claim-types.js'

/** Bumped whenever a rule below changes what it would extract from the same
 *  text. Stored on every claim, so a re-extraction under new rules is
 *  distinguishable from the source having changed -- the same lesson the
 *  attention ledger learned the hard way on 2026-09-04. */
export const EXTRACTOR_VERSION = 'pool-lexical-v2-segments'

/** Claim types this extractor has NO rule for yet. Listed explicitly so their
 *  absence is reported as UNSUPPORTED -- a fact about the extractor -- rather
 *  than looking like a source that stayed silent about warranty. */
export const UNSUPPORTED_TYPES: readonly ClaimType[] = [
  'POOL_MODEL', 'MANUFACTURER', 'PRODUCT_FAMILY', 'QUANTITY_REQUIRED',
  'DIMENSION', 'COMPATIBILITY', 'TOTAL_PRICE', 'VAT', 'SHIPPING_COST',
  'LEAD_TIME', 'WARRANTY', 'RETURN_POLICY',
]

export interface ClaimTextSource extends ClaimSource {
  /** The mail body or document text. */
  text: string
  /** Who wrote it, for VENDOR_IDENTITY and nothing else. */
  from?: string
  /** True when `text` is a Gmail snippet rather than a full body. Drives
   *  PARTIAL_SOURCE: the value may be right, but everything past the cut is
   *  unread, and a truncated view must not look like a complete one. */
  truncated?: boolean
}

interface Rule {
  claimType: ClaimType
  field?: string
  /** Must match before any value is read. */
  cue: RegExp
  /** Pulls the value out. Returns null when the cue fired but nothing parsed --
   *  which is recorded as CUE_WITHOUT_VALUE rather than silently dropped. */
  read: (text: string) => { value: string; source: string; unit: string | null } | null
  confidence: ClaimConfidence
  provenance: string
}

// PART NUMBER. Fluidra's codes are letters+digits with no separator, at least
// eight characters: PLYCOMP112X, PLYCOMP112SKX, KPCOV52. The length floor is
// what keeps ordinary uppercase words out; the cue keeps everything else out.
// AT LEAST ONE DIGIT, and the readback is why. Without it this matched the bare
// word MESSAGE -- out of "---------- Forwarded message ----------" upper-cased in
// a thread dump -- and filed it as a part number at HIGH confidence. Every real
// code in this dossier carries digits: PLYCOMP112X, PLYCOMP112SKX, KPCOV52.
// Found by running the extractor over the actual dossier, not by inspection.
const PART_NUMBER_RE = /\b([A-Z]{3,}[A-Z0-9]*\d[A-Z0-9]*)\b/g
const PART_CUE = /cikkszám|part\s?number|reference|ref\.|termékkód|item\s?code|SKU/i

// POSITION. "C pozíció", "position C", "C position" -- a single letter naming
// which section of the pool edge the part sits in. Measured in the dossier:
// Istvan and Kállai both use the bare letter with the word beside it.
// `(?![\p{L}])` rather than a trailing `\b`, and the `u` flag with it. JavaScript's
// `\b` is ASCII-only, so after "pozíció" -- which ends in an accented letter --
// there is no word boundary before a full stop, and the whole rule silently
// matched nothing. The invoice extractor in this repo carries a comment warning
// about exactly this, which I read and then walked into anyway; the fix is the
// same one it made.
const POSITION_RE = /\b([A-H])\s*(?:pozíció|pozicio|position)(?![\p{L}])|(?:pozíció|pozicio|position)\s*:?\s*([A-H])\b/iu

// PACKAGE QUANTITY. Kállai, 2026-09-04, verbatim: "Kompozit medencevédő
// szegély, 2 darabos készlet". Also "2 db-os", "set of 2", "pack of 2".
const PACKAGE_QTY_RE = /(\d+)\s*(?:darabos|db-?os|darabból\s+álló)\s*(?:készlet|szett|csomag)|(?:set|pack)\s+of\s+(\d+)/i
const PACKAGE_QTY_CUE = /készlet|szett|csomag|\bset\b|\bpack\b/i

// MONTH-LEVEL AVAILABILITY. Kállai: "gyártásból érkezik 2027 januárban lenne
// szállítható". A month and a year, no day -- so the normalised form is a
// YYYY-MM, and inventing a day would be inventing precision.
const HU_MONTHS: Record<string, string> = {
  január: '01', februar: '02', február: '02', március: '03', marcius: '03',
  április: '04', aprilis: '04', május: '05', majus: '05', június: '06', junius: '06',
  július: '07', julius: '07', augusztus: '08', szeptember: '09', október: '10',
  oktober: '10', november: '11', december: '12', januar: '01',
}
const HU_MONTH_YEAR = new RegExp(
  `\\b(20\\d{2})\\.?\\s*(${Object.keys(HU_MONTHS).join('|')})`, 'i')
const MONTH_YEAR_REVERSED = new RegExp(
  `\\b(${Object.keys(HU_MONTHS).join('|')})\\w*\\s+(20\\d{2})`, 'i')

/**
 * A month-and-year NEAR a cue, not merely somewhere in the same segment.
 *
 * FOUND IN THE DOSSIER READBACK, and it was producing a false claim rather than
 * a missing one. Kállai's message says production is "2027 januárban" and then,
 * a line later, that his colleague gave "februári kiadási dátumot" for the
 * Hungarian handover. The local-release rule gated on its own cue and then read
 * the FIRST month in the whole segment -- so it reported January as the
 * Hungarian release date, contradicting the source it claimed to be quoting.
 *
 * The window is the fix and it is the same discipline the price rule already
 * had: a cue tells you which field, and the value has to be beside it.
 */
function readNearCue(
  cue: RegExp, text: string,
): { value: string; source: string; unit: string | null } | null {
  const c = cue.exec(text)
  if (!c || c.index === undefined) return null
  // THE SENTENCE, not a character window. A fixed window was the first attempt
  // and it still reached back into the previous line: Kállai's two facts sit on
  // consecutive lines, ninety characters apart, so the local-release rule kept
  // reading January out of the production sentence. A count is arbitrary; a
  // sentence is the unit the writer actually used.
  const before = text.slice(0, c.index)
  const start = Math.max(
    before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf('! '),
  ) + 1
  const after = text.slice(c.index)
  const rel = [after.indexOf('\n'), after.indexOf('. ')].filter((i) => i >= 0)
  const end = rel.length ? c.index + Math.min(...rel) : text.length
  return readMonthYear(text.slice(start, end))
}

function readMonthYear(text: string): { value: string; source: string; unit: string | null } | null {
  const m = HU_MONTH_YEAR.exec(text) ?? null
  if (m) {
    const month = HU_MONTHS[m[2].toLowerCase()]
    if (month) return { value: `${m[1]}-${month}`, source: m[0].trim(), unit: 'month' }
  }
  const r = MONTH_YEAR_REVERSED.exec(text)
  if (r) {
    const month = HU_MONTHS[r[1].toLowerCase()]
    if (month) return { value: `${r[2]}-${month}`, source: r[0].trim(), unit: 'month' }
  }
  // A MONTH WITH NO YEAR. The source really does address the field -- Kállai
  // wrote "februári kiadási dátum" and named no year -- so staying silent would
  // be wrong. But completing it from a year mentioned in another sentence is
  // inference, and this layer does not infer. An empty value with the verbatim
  // preserved is recorded as CUE_WITHOUT_VALUE: a reader sees exactly what was
  // said and that we would not finish the sentence for them.
  const bare = new RegExp(`\\b(${Object.keys(HU_MONTHS).join('|')})\\w*`, 'i').exec(text)
  if (bare) return { value: '', source: bare[0].trim(), unit: null }
  return null
}

const RULES: readonly Rule[] = [
  {
    claimType: 'PART_NUMBER',
    cue: PART_CUE,
    read: (t) => {
      const m = [...t.matchAll(PART_NUMBER_RE)].map((x) => x[1])
      return m.length ? { value: m[0].toUpperCase(), source: m[0], unit: null } : null
    },
    confidence: 'HIGH',
    provenance: 'a part-number cue names the field, and an alphanumeric code follows it',
  },
  {
    claimType: 'POSITION',
    cue: /pozíció|pozicio|position/i,
    read: (t) => {
      const m = POSITION_RE.exec(t)
      if (!m) return null
      const letter = (m[1] ?? m[2] ?? '').toUpperCase()
      return letter ? { value: letter, source: m[0].trim(), unit: null } : null
    },
    confidence: 'HIGH',
    provenance: 'a single section letter stands beside the word "position"',
  },
  {
    claimType: 'PACKAGE_QUANTITY',
    cue: PACKAGE_QTY_CUE,
    read: (t) => {
      const m = PACKAGE_QTY_RE.exec(t)
      if (!m) return null
      const n = m[1] ?? m[2]
      return n ? { value: String(parseInt(n, 10)), source: m[0].trim(), unit: 'pcs' } : null
    },
    confidence: 'HIGH',
    provenance: 'the source states how many pieces one package contains',
  },
  {
    claimType: 'PACKAGE_PRICE',
    field: 'gross',
    // GROSS ONLY, and the cue is what makes that safe. `bruttó 69 130 Ft` in
    // the dossier is a gross figure; taking the largest amount in the mail
    // instead would have picked whichever number happened to be biggest.
    cue: /bruttó|brutto|gross|áfával|afaval|incl\.?\s?VAT/i,
    read: (t) => {
      const m = /(?:bruttó|brutto|gross|áfával|afaval|incl\.?\s?VAT)[^\d]{0,20}((?:\d{1,3}(?:[ .]\d{3})+|\d{3,})\s?(?:Ft|HUF|forint))/i
        .exec(normaliseExtractionText(t))
      if (!m) return null
      const amounts = parseHufAmounts(m[1])
      return amounts.length
        ? { value: String(amounts[0]), source: m[1].trim(), unit: 'HUF' }
        : null
    },
    confidence: 'HIGH',
    provenance: 'an amount stands immediately after a gross-price cue',
  },
  {
    claimType: 'UNIT_PRICE',
    field: 'net',
    cue: /EUR|€/,
    read: (t) => {
      const m = /((?:\d{1,3}(?:[ .]\d{3})*)(?:,\d{1,2})?)\s?(?:EUR|€)/i.exec(normaliseExtractionText(t))
      if (!m) return null
      // Hungarian decimal comma; the value is kept in cents so no float rounds.
      const cents = Math.round(parseFloat(m[1].replace(/[ .]/g, '').replace(',', '.')) * 100)
      return Number.isFinite(cents)
        ? { value: String(cents), source: m[0].trim(), unit: 'EUR_cents' }
        : null
    },
    confidence: 'MEDIUM',
    provenance: 'a euro amount appears; whether it is per piece or per package is NOT decided here',
  },
  {
    claimType: 'AVAILABILITY',
    field: 'production',
    cue: /gyártás|gyartas|production|szállítható|szallithato|manufactur/i,
    read: (t) => readNearCue(/gyártás|gyartas|production|szállítható|szallithato|manufactur/i, t),
    confidence: 'MEDIUM',
    provenance: 'a month and year stand beside a production or shipping cue',
  },
  {
    claimType: 'AVAILABILITY',
    field: 'local_release',
    cue: /kiadási|kiadasi|magyar átvétel|magyar atvetel|release date|helyi átvétel/i,
    read: (t) => readNearCue(/kiadási|kiadasi|magyar átvétel|magyar atvetel|release date|helyi átvétel/i, t),
    confidence: 'MEDIUM',
    provenance: 'a month and year stand beside a local-release cue',
  },
]

/** A segment's kind decides the attribution, and nothing else does. */
const ATTRIBUTION: Record<SegmentKind, AttributionStatus | null> = {
  AUTHORED: 'AUTHOR_ASSERTED',
  QUOTED: 'QUOTED_ORIGIN_UNRESOLVED',
  FORWARDED: 'FORWARDED_ORIGIN_UNRESOLVED',
  // A signature is not a claim. Nothing is extracted from it at all, so it has
  // no attribution to give.
  SIGNATURE: null,
}

/**
 * Read one source into claims.
 *
 * Segments are extracted SEPARATELY and never merged: the owner's standing
 * invariant is that a message is not an attribution unit, and merging the
 * halves is precisely how the vendor ends up asserting the buyer's question.
 *
 * Quoted and forwarded claims are RECORDED but not attributed. They are real
 * evidence that the text was present in this source, and dropping them would
 * lose the reply context that makes a thread readable.
 *
 * Returns every claim it can support, plus an explicit row for each field it
 * looked for and did not find, and for each field it has no rule for. It does
 * not deduplicate across sources, does not rank, and decides nothing.
 */
export function extractPoolClaims(src: ClaimTextSource): StructuredClaim[] {
  const out: StructuredClaim[] = []
  const source: ClaimSource = {
    sourceId: src.sourceId, sourceType: src.sourceType,
    sourceTimestamp: src.sourceTimestamp,
    ...(src.channel ? { channel: src.channel } : {}),
  }
  const envelopeParty = src.from ? nameFromSender(src.from) : null

  const push = (c: Omit<StructuredClaim, 'source' | 'extractorVersion'>): void => {
    // THE INVARIANT, enforced where a violation would be created rather than
    // asserted in a comment: a party is not a message id.
    if (c.assertedBy !== null && c.assertedBy === source.sourceId) {
      throw new Error(
        `claim invariant: assertedBy must not equal sourceId (${source.sourceId})`,
      )
    }
    out.push({ ...c, source, extractorVersion: EXTRACTOR_VERSION })
  }

  const segments = segmentBody(src.text)
  const seenTypes = new Set<string>()

  for (const seg of segments) {
    const attribution = ATTRIBUTION[seg.kind]
    if (attribution === null) continue  // SIGNATURE: not a claim
    const normalised = normaliseExtractionText(seg.text)
    const span = {
      segmentKind: seg.kind, start: seg.start, end: seg.end, marker: seg.marker,
    }

    for (const rule of RULES) {
      const key = `${rule.claimType}:${rule.field ?? ''}`
      if (!rule.cue.test(normalised)) continue
      seenTypes.add(key)
      const hit = rule.read(normalised)
      // A rule may return a verbatim with an EMPTY value: it saw the thing and
      // could not normalise it without inventing the missing part.
      const recovered = hit !== null && hit.value !== ''
      const status: ExtractionStatus =
        !recovered ? 'CUE_WITHOUT_VALUE'
        : src.truncated ? 'LOW_QUALITY_PARTIAL_SOURCE'
        : 'EXTRACTED_VALID'
      push({
        claimType: rule.claimType,
        field: rule.field ?? null,
        normalizedValue: hit?.value ?? '',
        normalizedUnit: hit?.unit ?? null,
        originalValue: hit?.source ?? '',
        span,
        attributionStatus: attribution,
        // Filled ONLY where the segment's own author wrote it, and taken from
        // the envelope rather than from anything the prose says.
        assertedBy: attribution === 'AUTHOR_ASSERTED' ? envelopeParty : null,
        confidence: recovered ? rule.confidence : 'LOW',
        status,
        provenance: !recovered
          ? `a ${rule.claimType} cue appeared${hit ? ` beside "${hit.source}"` : ''} but no complete value could be read without inferring the missing part`
          : attribution === 'AUTHOR_ASSERTED'
            ? rule.provenance
            : `${rule.provenance}; read from ${seg.kind.toLowerCase()} text opened by "${seg.marker ?? 'a separator'}", so the original asserter is unresolved`,
      })
    }
  }

  // WHAT WAS LOOKED FOR AND NOT FOUND. Recorded per rule, once, so that "no
  // source mentions availability" is a readable answer rather than an inference
  // from missing rows.
  const authored = segments.find((s2) => s2.kind === 'AUTHORED')
  for (const rule of RULES) {
    const key = `${rule.claimType}:${rule.field ?? ''}`
    if (seenTypes.has(key)) continue
    push({
      claimType: rule.claimType, field: rule.field ?? null,
      normalizedValue: '', normalizedUnit: null, originalValue: '',
      span: {
        segmentKind: 'AUTHORED',
        start: authored?.start ?? 0, end: authored?.end ?? src.text.length,
        marker: null,
      },
      attributionStatus: 'AUTHOR_ASSERTED',
      assertedBy: envelopeParty,
      confidence: 'HIGH',
      status: 'NO_CUE',
      provenance: `a rule for ${rule.claimType} ran and found no cue in this source`,
    })
  }

  // AND WHAT WE CANNOT LOOK FOR AT ALL. A statement about this extractor.
  for (const t of UNSUPPORTED_TYPES) {
    push({
      claimType: t, field: null,
      normalizedValue: '', normalizedUnit: null, originalValue: '',
      span: { segmentKind: 'AUTHORED', start: 0, end: 0, marker: null },
      attributionStatus: 'AUTHOR_ASSERTED',
      assertedBy: envelopeParty,
      confidence: 'LOW',
      status: 'UNSUPPORTED',
      provenance: `this extractor (${EXTRACTOR_VERSION}) has no rule for ${t}; its absence says nothing about the source`,
    })
  }

  if (envelopeParty) {
    push({
      claimType: 'VENDOR_IDENTITY', field: null,
      normalizedValue: envelopeParty, normalizedUnit: null, originalValue: src.from!,
      span: { segmentKind: 'AUTHORED', start: 0, end: 0, marker: null },
      attributionStatus: 'AUTHOR_ASSERTED',
      assertedBy: envelopeParty,
      confidence: 'HIGH',
      status: 'EXTRACTED_VALID',
      provenance: 'the envelope sender of the message',
    })
  }
  return out
}
