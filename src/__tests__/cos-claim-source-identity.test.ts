// THE TWO DEFECTS THE 2026-09-05 LIVE ACCEPTANCE FOUND, held red-able.
//
// Both were invisible to a green suite because both concerned data the tests
// never supplied: a source id shared by two source kinds, and a From header
// with no display name. Every assertion here fails against the code as it stood
// before the fix.

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  initClaimStoreSchema, recordClaims, claimId, claimsForField,
} from '../cos/claims/claim-store.js'
import {
  extractPoolClaims, senderPrincipal, senderDisplayName, organisationFromAddress,
} from '../cos/claims/pool-claims.js'

const CASE = 'PRI-HOME-2026-005'
const TS = Date.UTC(2026, 8, 4, 9, 49, 0) / 1000
// The real collision from the live dossier: in Gmail a thread carries the id of
// its first message, so this one string names two different sources.
const SHARED_ID = '1a06b64b5236d570'
const BODY = 'A PLYCOMP112X C pozíció bruttó ára 69 130 Ft.'

describe('a source is its KIND and its id, never the id alone', () => {
  it('the same id under two source types yields different claim ids', () => {
    const asMessage = extractPoolClaims({
      sourceId: SHARED_ID, sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    })
    const asThread = extractPoolClaims({
      sourceId: SHARED_ID, sourceType: 'GMAIL_THREAD', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    })
    expect(asMessage.length).toBeGreaterThan(0)
    expect(asMessage).toHaveLength(asThread.length)

    const mine = asMessage.map((c) => claimId(c, CASE))
    const theirs = asThread.map((c) => claimId(c, CASE))
    // Identical text, identical spans, identical everything except the KIND of
    // source. Keyed on the id alone every one of these collided.
    expect(mine.filter((id) => theirs.includes(id))).toEqual([])
    expect(new Set([...mine, ...theirs]).size).toBe(mine.length + theirs.length)
  })

  it('both sources survive persistence, and neither is chosen over the other', () => {
    const db = new Database(':memory:')
    initClaimStoreSchema(db)
    const one = extractPoolClaims({
      sourceId: SHARED_ID, sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    })
    const two = extractPoolClaims({
      sourceId: SHARED_ID, sourceType: 'GMAIL_THREAD', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    })
    const r = recordClaims(db, 'personal', CASE, [...one, ...two], 1_000)

    // THE NUMBER THAT USED TO LIE. Before the fix this reported a pile of
    // "unchanged" on a first write into an EMPTY table, which is not a thing
    // that can happen honestly -- there was nothing to be unchanged from.
    expect(r.unchanged).toBe(0)
    expect(r.written).toBe(one.length + two.length)

    const kinds = db.prepare(
      `SELECT source_type, COUNT(*) n FROM structured_claims
        WHERE case_id=? AND source_id=? GROUP BY 1 ORDER BY 1`,
    ).all(CASE, SHARED_ID) as Array<{ source_type: string; n: number }>
    expect(kinds).toEqual([
      { source_type: 'GMAIL_MESSAGE', n: one.length },
      { source_type: 'GMAIL_THREAD', n: two.length },
    ])

    // And the readback shows both, side by side, with nothing marking a winner.
    const prices = claimsForField(db, 'personal', CASE, 'PACKAGE_PRICE', 'gross')
      .filter((c) => c.normalizedValue !== '')
    expect(prices.map((p) => p.sourceType).sort())
      .toEqual(['GMAIL_MESSAGE', 'GMAIL_THREAD'])
    db.close()
  })
})

describe('the asserter is an address, and an envelope is not an organisation', () => {
  it('a From with no display name asserts the full address, never the domain', () => {
    expect(senderPrincipal('iszzu80@gmail.com')).toBe('iszzu80@gmail.com')
    expect(senderPrincipal('"István Szabó" <iszzu80@gmail.com>')).toBe('iszzu80@gmail.com')
    expect(senderPrincipal('ISZZU80@Gmail.COM')).toBe('iszzu80@gmail.com')
    expect(senderPrincipal('no address here')).toBeNull()
  })

  it('the display name travels beside the principal and never as it', () => {
    expect(senderDisplayName('"Krisztian Kállai" <kkallai@fluidra.com>')).toBe('Krisztian Kállai')
    expect(senderDisplayName('iszzu80@gmail.com')).toBeNull()
  })

  it('no claim from a bare-address sender is ever asserted by a domain', () => {
    const claims = extractPoolClaims({
      sourceId: 'msg-owner', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: 'iszzu80@gmail.com', text: BODY,
    })
    const asserters = new Set(claims.map((c) => c.assertedBy).filter((a) => a !== null))
    expect(asserters.has('gmail.com')).toBe(false)
    expect([...asserters]).toEqual(['iszzu80@gmail.com'])
  })

  it('a consumer mailbox evidences no organisation, and says so', () => {
    expect(organisationFromAddress('iszzu80@gmail.com')).toBeNull()
    expect(organisationFromAddress('someone@freemail.hu')).toBeNull()
    expect(organisationFromAddress('kkallai@fluidra.com')).toBe('fluidra.com')

    const v = extractPoolClaims({
      sourceId: 'msg-owner', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: 'iszzu80@gmail.com', text: BODY,
    }).filter((c) => c.claimType === 'VENDOR_IDENTITY')
    expect(v).toHaveLength(1)
    // Recorded as looked-for-and-absent, not as a vendor called gmail.com. The
    // difference is the whole point: silence would read as "no rule ran".
    expect(v[0].normalizedValue).toBe('')
    expect(v[0].status).toBe('NO_CUE')
    expect(v[0].provenance).toContain('consumer mailbox provider')
  })

  it('a corporate sender evidences its organisation, and is not the person', () => {
    const v = extractPoolClaims({
      sourceId: 'msg-vendor', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    }).filter((c) => c.claimType === 'VENDOR_IDENTITY')
    expect(v).toHaveLength(1)
    expect(v[0].normalizedValue).toBe('fluidra.com')
    // The old rule put the PERSON here. A person is not an organisation.
    expect(v[0].normalizedValue).not.toBe('Krisztian Kállai')
    expect(v[0].assertedBy).toBe('kkallai@fluidra.com')
    expect(v[0].assertedByName).toBe('Krisztian Kállai')
    expect(v[0].status).toBe('EXTRACTED_VALID')
  })

  it('a quoted segment still carries no asserter at all', () => {
    const claims = extractPoolClaims({
      sourceId: 'msg-reply', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>',
      // The marker is one the live dossier actually produced, read back out of
      // the store rather than invented: a quote header a test writes but real
      // mail never sends would prove the attribution rule against nothing.
      text: `Rendben.\n\nFeladó: "István Szabó" <iszzu80@gmail.com>\n\n${BODY}`,
    })
    const quoted = claims.filter((c) => c.attributionStatus === 'QUOTED_ORIGIN_UNRESOLVED')
    expect(quoted.length).toBeGreaterThan(0)
    expect(quoted.every((c) => c.assertedBy === null)).toBe(true)
    expect(quoted.every((c) => c.assertedByName === null)).toBe(true)
  })
})

describe('a store created under the older shape converges', () => {
  it('an existing table gains the new column instead of failing on first write', () => {
    const db = new Database(':memory:')
    // The pre-fix shape, exactly as the live store held it on 2026-09-05:
    // CREATE TABLE IF NOT EXISTS would have looked at this and done nothing.
    db.exec(`
      CREATE TABLE structured_claims (
        claim_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, case_id TEXT NOT NULL,
        claim_type TEXT NOT NULL, field TEXT, normalized_value TEXT NOT NULL,
        normalized_unit TEXT, original_value TEXT NOT NULL, source_id TEXT NOT NULL,
        source_type TEXT NOT NULL, source_timestamp INTEGER NOT NULL, channel TEXT,
        span_kind TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL,
        span_marker TEXT, attribution_status TEXT NOT NULL, asserted_by TEXT,
        confidence TEXT NOT NULL, extraction_status TEXT NOT NULL,
        extractor_version TEXT NOT NULL, provenance TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL, last_changed_at INTEGER NOT NULL)`)
    const before = (db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>)
    expect(before.map((c) => c.name)).not.toContain('asserted_by_name')

    const claims = extractPoolClaims({
      sourceId: 'msg-x', sourceType: 'GMAIL_MESSAGE', sourceTimestamp: TS,
      from: '"Krisztian Kállai" <kkallai@fluidra.com>', text: BODY,
    })
    expect(() => recordClaims(db, 'personal', CASE, claims, 1_000)).not.toThrow()

    const after = (db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>)
    expect(after.map((c) => c.name)).toContain('asserted_by_name')
    const row = db.prepare(
      `SELECT asserted_by, asserted_by_name FROM structured_claims WHERE claim_type='VENDOR_IDENTITY'`,
    ).get() as { asserted_by: string; asserted_by_name: string }
    expect(row.asserted_by).toBe('kkallai@fluidra.com')
    expect(row.asserted_by_name).toBe('Krisztian Kállai')
    db.close()
  })
})
