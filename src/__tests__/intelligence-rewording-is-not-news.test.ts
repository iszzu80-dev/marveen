// A CHANGE OF WORDS IS NOT A CHANGE IN THE WORLD.
//
// The sibling of the ageing invariant, and it was found the same way: by reading
// the live board after shipping the fix for the first one.
//
// WHAT HAPPENED, 2026-09-04. The ageing fix re-worded every attention statement
// ("open and untouched for 26 days" -> "open and untouched since 2026-08-09")
// and the digest still hashed the rendered statement. So the cutover invalidated
// all 163 stored fingerprints at once, and the reader -- correctly, by its own
// rule -- read each one as "new evidence changed what it says". 96 matched items
// at three per run is roughly a month of daily notifications announcing changes
// to cases that had not moved since August.
//
// Measured, not supposed: after the cutover run, the item that had spoken
// carried a fingerprint matching the new wording, and two items that had not yet
// spoken still carried digests of the old wording, which is precisely the
// half-migrated state that produces the drip.
//
// THE RULE THIS PINS. Owner, same day: "CHANGE / IDENTITY: csak stabil, absolute
// facts. URGENCY / RANKING: olvashatja az aktuális időt." A fingerprint is
// identity, so it is taken over the facts an element rests on -- which rows, and
// when each said what it said -- never over the sentence we render from them.
//
// Two properties, and they have to hold together. Re-wording must be invisible;
// a genuinely new or moved row must still be seen. A test for either one alone
// passes on a constant.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initIntelligenceReaderSchema } from '../cos/schema.js'
import {
  fingerprintOf, identityChanged, adoptStaleFingerprints, recordSurfaced,
  loadLedger, FINGERPRINT_ALGO, type LedgerRow,
} from '../cos/intelligence/reader.js'
import type { AttentionItem } from '../cos/intelligence/attention.js'

const T0 = Date.UTC(2027, 2, 3, 9, 0, 0) / 1000

/** One attention item. `statement` is presentation; `provenance` is the fact. */
function item(over: {
  statement?: string
  provenance?: Array<{ source: string; ref: string; observedAt: number }>
  band?: string
} = {}): AttentionItem {
  return {
    band: (over.band ?? 'INFORMATIONAL') as AttentionItem['band'],
    score: 1,
    why: 'test',
    element: {
      id: 'case-attention:zst:zst-1',
      kind: 'INFERENCE',
      caseId: 'zst-1',
      namespace: 'zst',
      statement: over.statement ?? 'open and untouched since 2026-08-09',
      provenance: (over.provenance ?? [
        { source: 'CASE', ref: 'zst-1', observedAt: T0 - 86_400 },
      ]) as never,
      confidence: 'HIGH',
      ageSeconds: 0,
      contradiction: { state: 'NONE' },
    },
  } as unknown as AttentionItem
}

describe('re-wording is not news', () => {
  it('the same facts under different words produce the same fingerprint', () => {
    const before = item({ statement: 'open and untouched for 26 days' })
    const after = item({ statement: 'open and untouched since 2026-08-09' })
    // The exact pair that broke production.
    expect(fingerprintOf(after)).toBe(fingerprintOf(before))
  })

  it('a differently phrased overdue line is likewise the same fingerprint', () => {
    // The SECOND instance of the ageing bug lived on this branch, so it gets its
    // own case rather than being assumed covered by the first.
    const a = item({ statement: 'a stated deadline passed 3 days ago' })
    const b = item({ statement: 'a stated deadline passed on 2026-09-01' })
    expect(fingerprintOf(b)).toBe(fingerprintOf(a))
  })

  it('BUT new evidence still moves it -- an added row', () => {
    const before = item()
    const after = item({
      provenance: [
        { source: 'CASE', ref: 'zst-1', observedAt: T0 - 86_400 },
        { source: 'CASE_EVENT', ref: 'ev-9', observedAt: T0 },
      ],
    })
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before))
  })

  it('BUT new evidence still moves it -- the same row, observed later', () => {
    const before = item()
    const after = item({
      provenance: [{ source: 'CASE', ref: 'zst-1', observedAt: T0 }],
    })
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before))
  })

  it('a rising band still moves it', () => {
    expect(fingerprintOf(item({ band: 'SAFETY' })))
      .not.toBe(fingerprintOf(item({ band: 'INFORMATIONAL' })))
  })

  it('provenance arriving in a different order is not a change', () => {
    const p = [
      { source: 'CASE', ref: 'zst-1', observedAt: T0 - 86_400 },
      { source: 'CASE_EVENT', ref: 'ev-9', observedAt: T0 },
    ]
    expect(fingerprintOf(item({ provenance: [...p].reverse() })))
      .toBe(fingerprintOf(item({ provenance: p })))
  })
})

describe('a digest under an older recipe is adopted, never announced', () => {
  let db: Database.Database

  const ledgerRow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
    element_id: 'case-attention:zst:zst-1',
    band: 'INFORMATIONAL',
    fingerprint: 'deadbeefdeadbeef', // a digest of the OLD wording
    first_surfaced_at: T0 - 5 * 86_400,
    last_surfaced_at: T0 - 86_400,
    times_surfaced: 4,
    fingerprint_algo: null, // written before the column existed
    ...over,
  })

  beforeEach(() => {
    db = new Database(':memory:')
    initIntelligenceReaderSchema(db)
  })

  it('does not read as changed', () => {
    // Without the recipe check this is the production storm: a stale digest
    // differs from the current one, so every case reads as changed.
    expect(identityChanged(ledgerRow(), item())).toBe(false)
  })

  it('a row on the CURRENT recipe is still compared normally', () => {
    // The negative control. If the guard above were unconditional, this would
    // fail -- which is what makes the one above mean something.
    const stale = ledgerRow({ fingerprint_algo: FINGERPRINT_ALGO })
    expect(identityChanged(stale, item())).toBe(true)

    const current = ledgerRow({
      fingerprint_algo: FINGERPRINT_ALGO,
      fingerprint: fingerprintOf(item()),
    })
    expect(identityChanged(current, item())).toBe(false)
  })

  it('adoption rewrites the digest and stamps the recipe', () => {
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()

    const ledger = loadLedger(db, 'zst')
    expect(adoptStaleFingerprints(db, 'zst', ledger, [item()])).toBe(1)

    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    expect(after.fingerprint_algo).toBe(FINGERPRINT_ALGO)
    expect(after.fingerprint).toBe(fingerprintOf(item()))
  })

  it('adoption touches NO clock: it is not an utterance', () => {
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()
    const before = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!

    adoptStaleFingerprints(db, 'zst', loadLedger(db, 'zst'), [item()])
    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!

    expect(after.first_surfaced_at).toBe(before.first_surfaced_at)
    expect(after.last_surfaced_at).toBe(before.last_surfaced_at)
    expect(after.times_surfaced).toBe(before.times_surfaced)
  })

  it('adoption updates the ledger it was handed, so later comparisons agree', () => {
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()

    const ledger = loadLedger(db, 'zst')
    adoptStaleFingerprints(db, 'zst', ledger, [item()])
    // Same map object the caller keeps using for the rest of the run.
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, item())).toBe(false)
  })

  it('AND AFTER adoption a real change is seen again -- the silence has an end', () => {
    // The failure this guards is worse than the one it replaces: adopting and
    // then never comparing again would mute the case permanently, invisibly.
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()

    const ledger = loadLedger(db, 'zst')
    adoptStaleFingerprints(db, 'zst', ledger, [item()])

    const moved = item({
      provenance: [{ source: 'CASE_EVENT', ref: 'ev-new', observedAt: T0 }],
    })
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, moved)).toBe(true)
  })

  it('adopts nothing when every row is already current', () => {
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    expect(adoptStaleFingerprints(db, 'zst', loadLedger(db, 'zst'), [item()])).toBe(0)
  })

  it('adopts a QUIET item, not only one that is about to speak', () => {
    // The whole reason adoption runs over the evaluated population. An item left
    // on an old recipe can never be found to have changed, and nothing would
    // report that.
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()
    // Passed in as part of the population; nothing here marks it as speaking.
    expect(adoptStaleFingerprints(db, 'zst', loadLedger(db, 'zst'), [item()])).toBe(1)
  })
})
