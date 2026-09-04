// THE CLAIM STORE'S INVARIANTS, each asserted as behaviour.
//
// Owner, Priority 2, 2026-09-04:
//   source_id != asserted_by
//   authored and quoted content never merge
//   reprocessing is idempotent
//   an extractor-version change must not silently overwrite a claim
//   email and documents use the same claim model
//   a claim is still not canonical truth
//   SOURCE_TIME != DISPLAY_TIME

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  initClaimStoreSchema, recordClaims, claimsForField, claimId, displayTime,
} from '../cos/claims/claim-store.js'
import { extractPoolClaims } from '../cos/claims/pool-claims.js'
import type { StructuredClaim } from '../cos/claims/claim-types.js'

const NOW = Date.UTC(2026, 8, 4, 20, 0, 0) / 1000
const KALLAI_TS = Date.UTC(2026, 8, 4, 13, 1, 35) / 1000
const CASE = 'PRI-HOME-2026-005'

function claim(over: Partial<StructuredClaim> = {}): StructuredClaim {
  return {
    claimType: 'PACKAGE_PRICE', field: 'gross',
    normalizedValue: '69130', normalizedUnit: 'HUF', originalValue: '69 130 Ft',
    source: { sourceId: 'msg-1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS },
    span: { segmentKind: 'AUTHORED', start: 0, end: 40, marker: null },
    attributionStatus: 'AUTHOR_ASSERTED',
    assertedBy: 'fluidra.com',
    confidence: 'HIGH', status: 'EXTRACTED_VALID',
    provenance: 'an amount stands after a gross-price cue',
    extractorVersion: 'pool-lexical-v2-segments',
    ...over,
  }
}

describe('the store keeps observations, not truths', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initClaimStoreSchema(db) })

  it('HEADLINE: two sources, two prices, and NO winner', () => {
    // The Priority 3 boundary, asserted as a property of the store rather than
    // as an intention. Both rows come back; nothing marks either as preferred.
    recordClaims(db, 'personal', CASE, [
      claim({ source: { sourceId: 'fluidra-1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS } }),
      claim({
        normalizedValue: '74900', originalValue: '74 900 Ft',
        source: { sourceId: 'piscinarium-1', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS + 3600 },
      }),
    ], NOW)

    const rows = claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.normalizedValue)).toEqual(['69130', '74900'])
    // Ordered by when the SOURCE spoke, never by rank: sorting by confidence
    // would be a winner in all but name, since whoever reads row one is
    // reading a preference nobody declared.
    expect(rows[0].sourceTimestamp).toBeLessThan(rows[1].sourceTimestamp)

    const cols = db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>
    for (const c of cols) {
      expect(c.name).not.toMatch(/preferred|winner|supersed|resolved_value|correct/i)
    }
  })

  it('deleting every row costs a re-extraction and nothing else', () => {
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    db.exec(`DELETE FROM structured_claims`)
    expect(claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')).toEqual([])
    const again = recordClaims(db, 'personal', CASE, [claim()], NOW + 60)
    expect(again.written).toBe(1)
  })
})

describe('reprocessing', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initClaimStoreSchema(db) })

  it('is idempotent: the same run twice writes nothing the second time', () => {
    const first = recordClaims(db, 'personal', CASE, [claim()], NOW)
    expect(first).toEqual({ written: 1, refreshed: 0 })
    const second = recordClaims(db, 'personal', CASE, [claim()], NOW + 600)
    expect(second).toEqual({ written: 0, refreshed: 1 })
    expect(claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')).toHaveLength(1)
  })

  it('keeps first_seen_at while moving last_seen_at', () => {
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    recordClaims(db, 'personal', CASE, [claim()], NOW + 600)
    const row = db.prepare(
      `SELECT first_seen_at, last_seen_at FROM structured_claims`,
    ).get() as { first_seen_at: number; last_seen_at: number }
    expect(row.first_seen_at).toBe(NOW)
    expect(row.last_seen_at).toBe(NOW + 600)
  })

  it('HEADLINE: a NEW extractor version does not overwrite the old claim', () => {
    // The owner's rule, and the direction matters. The attention ledger learned
    // the same lesson the other way round the same day: there a recipe change
    // silently invented news; here it would silently destroy evidence.
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    const v2 = recordClaims(db, 'personal', CASE, [
      claim({ extractorVersion: 'pool-lexical-v3', normalizedValue: '69131' }),
    ], NOW + 600)

    expect(v2.written).toBe(1)
    const rows = claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.extractorVersion).sort())
      .toEqual(['pool-lexical-v2-segments', 'pool-lexical-v3'])
  })

  it('a corrected value under the SAME version replaces, not accumulates', () => {
    // The other half of the identity rule. If the same rule reads the same span
    // and gets a different answer, that is a correction to one claim -- an
    // identity keyed on the value would leave the wrong row beside the right one.
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    recordClaims(db, 'personal', CASE, [claim({ normalizedValue: '69131' })], NOW + 60)
    const rows = claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')
    expect(rows).toHaveLength(1)
    expect(rows[0].normalizedValue).toBe('69131')
  })

  it('the same text read from a different SEGMENT is a different claim', () => {
    // authored and quoted must never merge: they are different assertions about
    // who said it, even when the words are identical.
    recordClaims(db, 'personal', CASE, [
      claim(),
      claim({
        span: { segmentKind: 'QUOTED', start: 40, end: 90, marker: 'Feladó:' },
        attributionStatus: 'QUOTED_ORIGIN_UNRESOLVED', assertedBy: null,
      }),
    ], NOW)
    const rows = claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.spanKind).sort()).toEqual(['AUTHORED', 'QUOTED'])
  })
})

describe('the identity of a claim', () => {
  it('does not move when only the value changes', () => {
    expect(claimId(claim({ normalizedValue: 'X' }), CASE))
      .toBe(claimId(claim({ normalizedValue: 'Y' }), CASE))
  })

  it('moves when the extractor version changes', () => {
    expect(claimId(claim({ extractorVersion: 'v9' }), CASE))
      .not.toBe(claimId(claim(), CASE))
  })

  it('moves when the segment changes', () => {
    expect(claimId(claim({ span: { segmentKind: 'QUOTED', start: 0, end: 40, marker: null } }), CASE))
      .not.toBe(claimId(claim(), CASE))
  })
})

describe('SOURCE_TIME != DISPLAY_TIME', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initClaimStoreSchema(db) })

  it('the stored timestamp is the source instant, unrendered', () => {
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    const row = db.prepare(`SELECT source_timestamp FROM structured_claims`)
      .get() as { source_timestamp: number }
    expect(row.source_timestamp).toBe(KALLAI_TS)
    expect(typeof row.source_timestamp).toBe('number')
  })

  it('no rendered or localised time is stored anywhere', () => {
    recordClaims(db, 'personal', CASE, [claim()], NOW)
    const cols = db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>
    for (const c of cols) expect(c.name).not.toMatch(/display|local_time|formatted|rendered/i)
  })

  it('display is computed in the app zone, and 13:01 UTC reads as 15:01', () => {
    // The mistake this invariant came from: I reported a 20:34 UTC mail
    // timestamp as though it were local, and told the owner it was half past
    // midnight when it was half past ten.
    expect(displayTime(KALLAI_TS)).toContain('15:01')
  })

  it('rendering a claim cannot change its identity', () => {
    const before = claimId(claim(), CASE)
    displayTime(KALLAI_TS)
    expect(claimId(claim(), CASE)).toBe(before)
  })
})

describe('the store refuses a claim that asserts itself', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initClaimStoreSchema(db) })

  it('assertedBy may never equal source_id, at the database level', () => {
    // Enforced by a CHECK as well as by the extractor: a store that permits it
    // makes "the message asserted it" expressible, which is the confusion the
    // whole attribution model exists to prevent.
    expect(() => db.prepare(`
      INSERT INTO structured_claims
        (claim_id, namespace, case_id, claim_type, field, normalized_value,
         normalized_unit, original_value, source_id, source_type, source_timestamp,
         channel, span_kind, span_start, span_end, span_marker,
         attribution_status, asserted_by, confidence, extraction_status,
         extractor_version, provenance, first_seen_at, last_seen_at)
      VALUES ('x','personal',?,'PACKAGE_PRICE','gross','1','HUF','1 Ft',
              'msg-1','GMAIL_MESSAGE',1,NULL,'AUTHORED',0,1,NULL,
              'AUTHOR_ASSERTED','msg-1','HIGH','EXTRACTED_VALID','v1','p',1,1)
    `).run(CASE)).toThrow(/CHECK/i)
  })

  it('and the extractor refuses to build one', () => {
    expect(() => extractPoolClaims({
      sourceId: 'fluidra.com', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: KALLAI_TS,
      from: 'billing@fluidra.com', text: 'A bruttó ár 69 130 Ft.',
    })).toThrow(/assertedBy must not equal sourceId/)
  })
})
