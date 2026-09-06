// WHERE CLAIMS LIVE, and why this is not a truth store.
//
// Owner, Priority 2, 2026-09-04: "Ne legyen új truth store. A claim azt mondja:
// EZ A FORRÁS ezt állítja, nem azt, hogy ez az igazság."
//
// So this table holds OBSERVATIONS ABOUT SOURCES. Two sources quoting different
// prices produce two rows, both correct, and there is no column in which one of
// them could be marked as winning. Conflict resolution is Priority 3 and lives
// elsewhere; a `preferred` or `supersedes` column added here would move it into
// the evidence layer, where it could never be re-examined.
//
// Deleting every row costs nothing but a re-extraction. That is the test a
// non-truth store has to pass, and it is the same test the attention ledger and
// the semantic candidate table pass.
//
// THREE INVARIANTS FROM THE OWNER, and each is enforced rather than described:
//
//   REPROCESSING IS IDEMPOTENT. The same extractor over the same source
//   refreshes rows in place. A scheduled re-run cannot grow the table.
//
//   AN EXTRACTOR-VERSION CHANGE NEVER OVERWRITES SILENTLY. A new version writes
//   NEW rows beside the old ones, because a different set of rules produced a
//   different opinion and erasing the old one destroys the comparison. Exactly
//   the lesson the attention ledger learned the same day, in the other
//   direction: there, a recipe change silently invented news; here it would
//   silently destroy evidence.
//
//   SOURCE_TIME != DISPLAY_TIME. `source_timestamp` is the source's own instant,
//   stored as an epoch and never rewritten. No rendered string is stored, no
//   local-time copy is kept, and nothing about display enters a claim's
//   identity -- so re-rendering the same claim in another zone cannot make it
//   look like a different or a changed claim. The renderer is at the bottom of
//   this file and it is the only thing here that knows what a timezone is.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { APP_TZ } from '../../config.js'
import type { StructuredClaim } from './claim-types.js'

export function initClaimStoreSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS structured_claims (
      claim_id          TEXT PRIMARY KEY,
      namespace         TEXT NOT NULL,
      /* The dossier this was read FOR. Not an owner: the same source can be
         read for two dossiers and produce two rows, and neither is the truth
         about the other. */
      case_id           TEXT NOT NULL,

      claim_type        TEXT NOT NULL,
      field             TEXT,
      normalized_value  TEXT NOT NULL,
      normalized_unit   TEXT,
      /* VERBATIM. Kept so a reader can check the normalisation instead of
         trusting it, and so a mis-normalisation is recoverable without going
         back to the mail. */
      original_value    TEXT NOT NULL,

      source_id         TEXT NOT NULL,
      source_type       TEXT NOT NULL,
      /* THE SOURCE'S OWN INSTANT, epoch seconds. Never a rendered string, never
         a local-time copy. Display is computed at read time from this. */
      source_timestamp  INTEGER NOT NULL,
      channel           TEXT,

      /* WHICH PART of the source, precisely enough to go and look. */
      span_kind         TEXT NOT NULL,
      span_start        INTEGER NOT NULL,
      span_end          INTEGER NOT NULL,
      span_marker       TEXT,

      attribution_status TEXT NOT NULL,
      /* Filled only where proven. NEVER equal to source_id: a message id says
         where we read something, a party says who said it, and a store that let
         those be the same value would make "the message asserted it"
         expressible. */
      asserted_by       TEXT,
      /* PRESENTATION, NOT IDENTITY. The sender's display name when the envelope
         carried one, kept apart from asserted_by so that a name the sender
         types into a mail client can never become the party a claim binds to.
         Owner, 2026-09-05: the principal is the normalised full address; the
         display name may travel beside it and must not stand in for it.

         NOT called *_display, and the reason is a guard rather than taste: a
         standing test forbids any column whose name matches /display/, because
         SOURCE_TIME != DISPLAY_TIME and a stored rendered time is the failure
         that invariant exists to catch. That guard is a name-shaped proxy and it
         would have gone red for a column that holds no time at all. Renaming the
         column keeps the guard exactly as strong as it was; widening the guard to
         admit this column would have traded a real protection for a convenience. */
      asserted_by_name TEXT,

      confidence        TEXT NOT NULL,
      extraction_status TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      provenance        TEXT NOT NULL,

      /* OUR bookkeeping, kept apart from the source's clock so the two can
         never be confused for one another.

         The column is last_changed_at, NOT last_seen_at, and the rename is the fix rather
         than the decoration. The first cut bumped a "last seen" column on every
         row of every run, so an unchanged re-extraction wrote 113 durable
         UPDATEs and moved a timestamp on all of them -- and a timestamp that
         moves without a change is precisely the watermark a downstream reader
         mistakes for one. Measured before it was believed: content digests were
         identical across two runs, and the column moved anyway.

         Now nothing is written unless something actually differs, so this
         column answers "when did this claim last change" and cannot answer
         anything else. */
      first_seen_at     INTEGER NOT NULL,
      last_changed_at   INTEGER NOT NULL,

      CHECK (namespace IN ('personal','zst')),
      CHECK (asserted_by IS NULL OR asserted_by <> source_id)
    )
  `)
  // ADDITIVE MIGRATION, because CREATE TABLE IF NOT EXISTS is silent about a
  // table that already exists with an older shape. A store created before a
  // column was added keeps the old shape for ever, and the first INSERT naming
  // the new column fails at runtime -- loudly, but only in front of whoever runs
  // it next, which on a scheduled path is nobody.
  //
  // Only ever ADD, and only nullable columns: this may not rewrite or drop
  // anything. A migration that can destroy is one somebody has to be brave to
  // run, and this one runs on every single write.
  const held = new Set(
    (db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>)
      .map((c) => c.name),
  )
  for (const [col, decl] of [['asserted_by_name', 'TEXT']] as const) {
    if (!held.has(col)) db.exec(`ALTER TABLE structured_claims ADD COLUMN ${col} ${decl}`)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_case
             ON structured_claims(namespace, case_id, claim_type)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_source
             ON structured_claims(source_id)`)
}

/**
 * A claim's identity: what was said, about which field, read from where.
 *
 * `extractor_version` IS PART OF IT, deliberately. That is what makes a version
 * bump write new rows instead of overwriting -- the owner's "extractor-version
 * change ne írjon felül némán claimet", expressed as a key rather than as a
 * rule somebody has to remember.
 *
 * The normalised VALUE is not part of the identity. If the same rule reads the
 * same span and gets a different answer, that is a correction to one claim, not
 * a second claim -- and an identity keyed on the value would leave the old,
 * wrong row sitting beside the new one for ever.
 *
 * NOTHING ABOUT DISPLAY enters this. No formatted date, no local time, no
 * rendered amount: re-rendering a claim in another zone must not be capable of
 * making it look like a different claim.
 */
/**
 * The separator between identity fields, written as an ESCAPE and never as a
 * raw byte. NUL is the right separator -- no field can contain it, so no pair
 * of field values can be joined into the same string two ways. But a literal
 * NUL in the source makes the whole FILE binary to grep, git diff and every
 * acceptance gate that reads source text, and this is the one file those gates
 * most need to be able to read. The byte hashed is identical either way.
 */
const FIELD_SEP = '\u0000'

export function claimId(c: StructuredClaim, caseId: string): string {
  const parts = [
    caseId, c.claimType, c.field ?? '',
    // SOURCE TYPE AND SOURCE ID TOGETHER, never the id alone. Gmail gives a
    // thread the id of its first message, so a dossier holding both holds two
    // DIFFERENT sources under one id string. Keyed on the id alone their claims
    // collided: on 2026-09-05, thirteen of the thread's claims matched rows the
    // message had just written, were counted "unchanged" and were dropped --
    // the store choosing one source over another with no column in which to say
    // so, and surfacing as a healthy-looking idempotence counter.
    c.source.sourceType, c.source.sourceId,
    c.span.segmentKind, String(c.span.start), String(c.span.end),
    c.extractorVersion,
  ]
  return `clm:${createHash('sha256').update(parts.join(FIELD_SEP)).digest('hex').slice(0, 32)}`
}

export interface RecordClaimsResult {
  /** Claims not previously held under this identity. */
  written: number
  /** Held, and something about them actually differs. */
  changed: number
  /** Held and byte-identical: NO durable write of any kind. This is the number
   *  a scheduled re-run should report for everything, and it is a stronger
   *  statement than "we updated them all harmlessly" -- there is no update to
   *  be harmless about. */
  unchanged: number
}

/**
 * Persist claims for one dossier.
 *
 * Idempotent per identity: re-running the same extractor over the same sources
 * updates in place. The value, confidence, status and provenance are refreshed
 * because a rule may have been corrected within the same version; `first_seen_at`
 * never moves, so how long we have held a claim stays true.
 */
export function recordClaims(
  db: Database.Database,
  namespace: 'personal' | 'zst',
  caseId: string,
  claims: readonly StructuredClaim[],
  now: number,
): RecordClaimsResult {
  initClaimStoreSchema(db)

  // THE FIELDS THAT MAKE A CLAIM WHAT IT IS. Everything a re-extraction could
  // legitimately correct, and nothing else -- the two bookkeeping timestamps are
  // deliberately absent, because comparing a row against itself on a column that
  // moves every run would make every claim look changed.
  const current = db.prepare(`
    SELECT normalized_value, normalized_unit, original_value, confidence,
           extraction_status, provenance, attribution_status, asserted_by,
           asserted_by_name, extractor_version, span_kind, span_start, span_end
      FROM structured_claims WHERE claim_id = ?
  `)
  const insert = db.prepare(`
    INSERT INTO structured_claims
      (claim_id, namespace, case_id, claim_type, field, normalized_value,
       normalized_unit, original_value, source_id, source_type, source_timestamp,
       channel, span_kind, span_start, span_end, span_marker,
       attribution_status, asserted_by, asserted_by_name, confidence,
       extraction_status, extractor_version, provenance,
       first_seen_at, last_changed_at)
    VALUES (@claimId, @namespace, @caseId, @claimType, @field, @normalizedValue,
            @normalizedUnit, @originalValue, @sourceId, @sourceType, @sourceTimestamp,
            @channel, @spanKind, @spanStart, @spanEnd, @spanMarker,
            @attributionStatus, @assertedBy, @assertedByName, @confidence,
            @extractionStatus, @extractorVersion, @provenance, @now, @now)
  `)
  const update = db.prepare(`
    UPDATE structured_claims SET
      normalized_value = @normalizedValue, normalized_unit = @normalizedUnit,
      original_value = @originalValue, confidence = @confidence,
      extraction_status = @extractionStatus, provenance = @provenance,
      attribution_status = @attributionStatus, asserted_by = @assertedBy,
      asserted_by_name = @assertedByName,
      last_changed_at = @now
    WHERE claim_id = @claimId
  `)

  let written = 0, changed = 0, unchanged = 0
  db.transaction(() => {
    for (const c of claims) {
      const id = claimId(c, caseId)
      const row = current.get(id) as Record<string, unknown> | undefined
      const params = {
        claimId: id, namespace, caseId,
        claimType: c.claimType, field: c.field,
        normalizedValue: c.normalizedValue, normalizedUnit: c.normalizedUnit,
        originalValue: c.originalValue,
        sourceId: c.source.sourceId, sourceType: c.source.sourceType,
        sourceTimestamp: c.source.sourceTimestamp, channel: c.source.channel ?? null,
        spanKind: c.span.segmentKind, spanStart: c.span.start, spanEnd: c.span.end,
        spanMarker: c.span.marker,
        attributionStatus: c.attributionStatus, assertedBy: c.assertedBy,
        assertedByName: c.assertedByName,
        confidence: c.confidence, extractionStatus: c.status,
        extractorVersion: c.extractorVersion, provenance: c.provenance,
        now,
      }
      if (!row) { insert.run(params); written += 1; continue }

      const same =
        row.normalized_value === c.normalizedValue
        && (row.normalized_unit ?? null) === c.normalizedUnit
        && row.original_value === c.originalValue
        && row.confidence === c.confidence
        && row.extraction_status === c.status
        && row.provenance === c.provenance
        && row.attribution_status === c.attributionStatus
        && (row.asserted_by ?? null) === c.assertedBy
        && (row.asserted_by_name ?? null) === c.assertedByName
        && row.extractor_version === c.extractorVersion
        && row.span_kind === c.span.segmentKind
        && row.span_start === c.span.start
        && row.span_end === c.span.end
      // NO WRITE AT ALL when nothing differs. Not a cheaper write, not a
      // harmless one: none.
      if (same) { unchanged += 1; continue }
      update.run(params)
      changed += 1
    }
  })()
  return { written, changed, unchanged }
}

export interface StoredClaim {
  claimId: string
  claimType: string
  field: string | null
  normalizedValue: string
  normalizedUnit: string | null
  originalValue: string
  sourceId: string
  sourceType: string
  sourceTimestamp: number
  spanKind: string
  attributionStatus: string
  assertedBy: string | null
  /** Presentation only. Never the party. */
  assertedByName: string | null
  confidence: string
  extractionStatus: string
  extractorVersion: string
  provenance: string
}

/**
 * Every claim a dossier holds for one field, from every source, in the order
 * the sources spoke.
 *
 * ORDERED BY TIME, NOT BY RANK, and that is the whole discipline of this
 * function. Sorting by confidence would be a winner in all but name: whoever
 * reads the first row would be reading a preference nobody declared. Two prices
 * come back as two rows and the caller is left to see that for itself.
 */
export function claimsForField(
  db: Database.Database, namespace: string, caseId: string,
  claimType: string, field?: string | null,
): StoredClaim[] {
  initClaimStoreSchema(db)
  const rows = db.prepare(`
    SELECT claim_id, claim_type, field, normalized_value, normalized_unit,
           original_value, source_id, source_type, source_timestamp, span_kind,
           attribution_status, asserted_by, asserted_by_name, confidence,
           extraction_status, extractor_version, provenance
      FROM structured_claims
     WHERE namespace = ? AND case_id = ? AND claim_type = ?
       ${field === undefined ? '' : field === null ? 'AND field IS NULL' : 'AND field = ?'}
     ORDER BY source_timestamp ASC, source_id ASC
  `).all(...(field === undefined || field === null
    ? [namespace, caseId, claimType]
    : [namespace, caseId, claimType, field])) as Array<Record<string, unknown>>

  return rows.map((r) => ({
    claimId: r.claim_id as string,
    claimType: r.claim_type as string,
    field: (r.field as string | null) ?? null,
    normalizedValue: r.normalized_value as string,
    normalizedUnit: (r.normalized_unit as string | null) ?? null,
    originalValue: r.original_value as string,
    sourceId: r.source_id as string,
    sourceType: r.source_type as string,
    sourceTimestamp: r.source_timestamp as number,
    assertedByName: (r.asserted_by_name as string | null) ?? null,
    spanKind: r.span_kind as string,
    attributionStatus: r.attribution_status as string,
    assertedBy: (r.asserted_by as string | null) ?? null,
    confidence: r.confidence as string,
    extractionStatus: r.extraction_status as string,
    extractorVersion: r.extractor_version as string,
    provenance: r.provenance as string,
  }))
}

/**
 * SOURCE_TIME != DISPLAY_TIME, and this function is the whole of the display
 * side.
 *
 * Owner invariant 2026-09-04, written after I mis-stated a UTC mail timestamp
 * as local time in a report: the stored value keeps its own provenance, the
 * human rendering is computed explicitly in the application zone, and the
 * converted string never goes back into the record. Nothing here is stored,
 * nothing here enters a claim id, and nothing here can produce a change event.
 *
 * The zone is `APP_TZ` -- the same explicitly-configured zone the release gate
 * proves is Europe/Budapest and not a host default.
 */
export function displayTime(sourceTimestamp: number): string {
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(sourceTimestamp * 1000))
}
