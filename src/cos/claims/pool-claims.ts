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
import { splitQuotedBody } from './quoted-text.js'
import type {
  ClaimType, ClaimAttribution, ClaimConfidence, ExtractionStatus,
  StructuredClaim, ClaimSource,
} from './claim-types.js'

/** Bumped whenever a rule below changes what it would extract from the same
 *  text. Stored on every claim, so a re-extraction under new rules is
 *  distinguishable from the source having changed -- the same lesson the
 *  attention ledger learned the hard way on 2026-09-04. */
export const EXTRACTOR_FINGERPRINT = 'pool-lexical-v1'

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
const PART_NUMBER_RE = /\b([A-Z]{3,}[A-Z0-9]{3,})\b/g
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
    read: readMonthYear,
    confidence: 'MEDIUM',
    provenance: 'a month and year stand beside a production or shipping cue',
  },
  {
    claimType: 'AVAILABILITY',
    field: 'local_release',
    cue: /kiadási|kiadasi|magyar átvétel|magyar atvetel|release date|helyi átvétel/i,
    read: readMonthYear,
    confidence: 'MEDIUM',
    provenance: 'a month and year stand beside a local-release cue',
  },
]

/**
 * Read one source into claims.
 *
 * The author's text and the quoted text are extracted SEPARATELY, and the
 * quoted half is attributed to nobody. Both halves are kept: the quote is real
 * evidence that the text was in this message, and dropping it would lose the
 * reply context that makes a thread readable.
 *
 * Returns every claim it can support. It does not deduplicate across sources,
 * does not rank, and does not decide anything -- two sources contradicting each
 * other yield two claims, which is the point.
 */
export function extractPoolClaims(src: ClaimTextSource): StructuredClaim[] {
  const out: StructuredClaim[] = []
  const { authored, quoted, separator } = splitQuotedBody(src.text)

  const runHalf = (text: string, attribution: ClaimAttribution): void => {
    if (!text.trim()) return
    const normalised = normaliseExtractionText(text)
    for (const rule of RULES) {
      if (!rule.cue.test(normalised)) continue
      const hit = rule.read(normalised)
      const status: ExtractionStatus =
        hit === null ? 'CUE_WITHOUT_VALUE'
        : attribution === 'QUOTED' ? 'QUOTED_CONTEXT'
        : src.truncated ? 'PARTIAL_SOURCE'
        : 'OK'
      out.push({
        claimType: rule.claimType,
        field: rule.field ?? null,
        normalizedValue: hit?.value ?? '',
        normalizedUnit: hit?.unit ?? null,
        sourceValue: hit?.source ?? '',
        source: {
          sourceId: src.sourceId, sourceType: src.sourceType,
          sourceTimestamp: src.sourceTimestamp,
          ...(src.channel ? { channel: src.channel } : {}),
        },
        attribution,
        // A cue that fired without a readable value is a weak observation, and
        // saying so is the whole reason the status exists.
        confidence: hit === null ? 'LOW' : rule.confidence,
        status,
        provenance: hit === null
          ? `a ${rule.claimType} cue appeared but no value could be read from it`
          : attribution === 'QUOTED'
            ? `${rule.provenance}; found in text quoted below "${separator ?? 'a reply separator'}", so it is NOT this author's assertion`
            : rule.provenance,
      })
    }
  }

  runHalf(authored, 'AUTHOR')
  runHalf(quoted, 'QUOTED')

  // VENDOR IDENTITY is a fact about the message, not about its text, so it is
  // read from the envelope and only ever attributed to the author.
  const vendor = src.from ? nameFromSender(src.from) : null
  if (vendor) {
    out.push({
      claimType: 'VENDOR_IDENTITY', field: null,
      normalizedValue: vendor, normalizedUnit: null, sourceValue: src.from!,
      source: {
        sourceId: src.sourceId, sourceType: src.sourceType,
        sourceTimestamp: src.sourceTimestamp,
        ...(src.channel ? { channel: src.channel } : {}),
      },
      attribution: 'AUTHOR',
      confidence: 'HIGH',
      status: 'OK',
      provenance: 'the sender of the message',
    })
  }
  return out
}
