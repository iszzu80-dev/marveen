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
  fingerprintOf, identityChanged, reconcileFingerprintRecipe, recordSurfaced,
  loadLedger, FINGERPRINT_ALGO, type LedgerRow,
} from '../cos/intelligence/reader.js'
import type { AttentionItem } from '../cos/intelligence/attention.js'
import { caseAttentionFor, caseAttentionToAttention } from '../cos/intelligence/case-attention.js'

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
    expect(reconcileFingerprintRecipe(db, 'zst', ledger, [item()], { write: true }).adopted).toBe(1)

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

    reconcileFingerprintRecipe(db, 'zst', loadLedger(db, 'zst'), [item()], { write: true }).adopted
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
    reconcileFingerprintRecipe(db, 'zst', ledger, [item()], { write: true }).adopted

    // Asserted on the VALUES, not through identityChanged: an un-updated row
    // still answers "not changed" (its recipe is stale), so going through the
    // comparison would pass whether the map was updated or not.
    const inMemory = ledger.get('case-attention:zst:zst-1')!
    expect(inMemory.fingerprint_algo).toBe(FINGERPRINT_ALGO)
    expect(inMemory.fingerprint).toBe(fingerprintOf(item()))
  })

  it('AND AFTER adoption a real change is seen again -- the silence has an end', () => {
    // The failure this guards is worse than the one it replaces: adopting and
    // then never comparing again would mute the case permanently, invisibly.
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old', fingerprint_algo = NULL`,
    ).run()

    const ledger = loadLedger(db, 'zst')
    reconcileFingerprintRecipe(db, 'zst', ledger, [item()], { write: true }).adopted

    const moved = item({
      provenance: [{ source: 'CASE_EVENT', ref: 'ev-new', observedAt: T0 }],
    })
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, moved)).toBe(true)
  })

  it('adopts nothing when every row is already current', () => {
    recordSurfaced(db, 'zst', [item()], T0 - 86_400)
    expect(reconcileFingerprintRecipe(db, 'zst', loadLedger(db, 'zst'), [item()], { write: true }).adopted).toBe(0)
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
    expect(reconcileFingerprintRecipe(db, 'zst', loadLedger(db, 'zst'), [item()], { write: true }).adopted).toBe(1)
  })
})

// THE OTHER DIRECTION, and it is the one that would have been silent.
//
// Taking the digest over provenance ALONE looked right and lost a real change:
// a case whose status moves without its `updated_at` moving is a different
// claim, and nothing would have said so. A missed change argues with nobody.
// So producers name their semantic facts in `changeKey`, and these pin both
// halves against the same producer.
describe('the semantic core still moves the fingerprint', () => {
  const CASE = {
    case_id: 'z2', title: 'valaszd ki', description: 'no sender',
    status: 'AWAITING_SELECTION', due_at: null, waiting_on: null,
    related_document_ids: '[]', updated_at: T0 - 40 * 86_400, created_at: T0 - 60 * 86_400,
  }
  const at = (row: Record<string, unknown>, now: number) =>
    caseAttentionToAttention(caseAttentionFor(row as never, 'zst', now)!, now)

  it('a status change with a FROZEN timestamp is still seen', () => {
    const before = at(CASE, T0)
    const after = at({ ...CASE, status: 'AWAITING_APPROVAL' }, T0)
    expect(after.element.changeKey).not.toBe(before.element.changeKey)
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before))
  })

  it('but the clock moving on a frozen row is not', () => {
    // Same row, read a year apart. The rendered sentence may differ; the
    // identity may not.
    const early = at(CASE, T0)
    const late = at(CASE, T0 + 365 * 86_400)
    expect(late.element.changeKey).toBe(early.element.changeKey)
    expect(fingerprintOf(late)).toBe(fingerprintOf(early))
  })

  it('a deadline is news when SET and news when it PASSES -- then never again', () => {
    const due = T0 + 2 * 86_400
    const noDeadline = at({ ...CASE, status: 'READY' }, T0)
    const withDeadline = at({ ...CASE, status: 'READY', due_at: due }, T0)
    expect(fingerprintOf(withDeadline)).not.toBe(fingerprintOf(noDeadline))

    // Crossing the deadline is a real transition -- the case stops being merely
    // stale and becomes overdue -- so it moves the identity ONCE.
    const justOverdue = at({ ...CASE, status: 'READY', due_at: due }, due + 60)
    expect(fingerprintOf(justOverdue)).not.toBe(fingerprintOf(withDeadline))

    // And then it stops. This is the half that was broken in production: an
    // overdue case re-announcing itself every night as it got more overdue.
    for (const later of [1, 3, 30, 400]) {
      const aged = at({ ...CASE, status: 'READY', due_at: due }, due + later * 86_400)
      expect(fingerprintOf(aged)).toBe(fingerprintOf(justOverdue))
    }
  })

  it('re-wording a REAL element changes nothing -- prose is not identity', () => {
    // The guard that matters most and is easiest to lose: it must stay true for
    // an element built by an actual producer, not only for the synthetic ones
    // above. If the rendered sentence ever leaks back into the change key, this
    // is what says so -- while the wording happens to be stable today, so no
    // vantage-point test would notice.
    const real = at(CASE, T0)
    const reworded = {
      ...real,
      element: { ...real.element, statement: 'ENTIRELY DIFFERENT WORDS, same facts' },
    } as typeof real
    expect(fingerprintOf(reworded)).toBe(fingerprintOf(real))
  })

  it('renaming the case is not a change -- the title is presentation', () => {
    // The one field that reaches the digest line without meaning anything about
    // the case's state, which makes it the probe for "did prose get into the
    // identity". A case that is renamed has not moved, and must not announce
    // itself as though it had.
    const renamed = at({ ...CASE, title: 'a completely different title' }, T0)
    const original = at(CASE, T0)
    expect(renamed.element.statement).not.toBe(original.element.statement)
    expect(fingerprintOf(renamed)).toBe(fingerprintOf(original))
  })

  it('the change key carries no rendered time at any vantage point', () => {
    // Behavioural rather than a regex over the string: what matters is that no
    // vantage point produces a different key for the same row.
    const keys = new Set(
      [0, 1, 7, 30, 365].map((d) => at(CASE, T0 + d * 86_400).element.changeKey),
    )
    expect(keys.size).toBe(1)
  })
})

// MIGRATION SAFETY. Owner ruling, 2026-09-04, after reading the first cut:
//
//   "OLD RECIPE -> SILENT ADOPT csak akkor mehet, ha a régi fingerprint
//    létrejötte / utolsó értékelése óta NEM történt valódi canonical
//    case/evidence változás."
//
// The hole it closes: adoption that does not ask whether anything happened will
// write a current digest over an incomparable one and take a real change with
// it. Nobody is told, no counter moves, and the case simply stops having
// changed. That is the quietest failure this module can have, and it would have
// been introduced by the fix for a loud one.
describe('a recipe migration must not swallow a real change', () => {
  let db: Database.Database

  /** Must match the case id `item()` builds, or the event log lookup silently
   *  finds nothing and every negative control passes for the wrong reason. */
  const CASE = 'zst-1'
  const SPOKE_AT = T0 - 3 * 86_400

  /** An element whose evidence is OLDER than the last time we spoke: nothing
   *  has happened since. */
  const still = () => item({
    provenance: [{ source: 'CASE', ref: CASE, observedAt: SPOKE_AT - 86_400 }],
  })

  /** The same element, with evidence filed AFTER we last spoke. */
  const moved = () => item({
    provenance: [{ source: 'CASE_EVENT', ref: 'ev-new', observedAt: SPOKE_AT + 3600 }],
  })

  /** A row sitting on the old recipe, last spoken at SPOKE_AT. */
  function legacyRow(): void {
    recordSurfaced(db, 'zst', [still()], SPOKE_AT)
    db.prepare(
      `UPDATE intelligence_surfaced SET fingerprint = 'old-recipe-digest', fingerprint_algo = NULL`,
    ).run()
  }

  /** The case's own log says it moved, without any provenance moving. */
  function caseEvent(at: number): void {
    db.exec(`CREATE TABLE IF NOT EXISTS zst_case_events (
      case_id TEXT, case_version INTEGER, actor TEXT, event_type TEXT,
      reason TEXT, created_at INTEGER)`)
    db.prepare(
      `INSERT INTO zst_case_events (case_id,case_version,actor,event_type,reason,created_at)
       VALUES (?,1,'test','STATUS_CHANGED','supplier answered',?)`,
    ).run(CASE, at)
  }

  beforeEach(() => {
    db = new Database(':memory:')
    initIntelligenceReaderSchema(db)
  })

  it('POSITIVE: nothing happened -> silent adoption, zero notification', () => {
    legacyRow()
    const ledger = loadLedger(db, 'zst')
    const r = reconcileFingerprintRecipe(db, 'zst', ledger, [still()], { write: true })

    expect(r).toEqual({ adopted: 1, withheld: 0 })
    // Silent: nothing to say about it afterwards.
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, still())).toBe(false)
    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    expect(after.fingerprint_algo).toBe(FINGERPRINT_ALGO)
    expect(after.fingerprint).toBe(fingerprintOf(still()))
  })

  it('POSITIVE: and the utterance counters are untouched', () => {
    legacyRow()
    const before = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    reconcileFingerprintRecipe(db, 'zst', loadLedger(db, 'zst'), [still()], { write: true })
    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    expect(after.times_surfaced).toBe(before.times_surfaced)
    expect(after.last_surfaced_at).toBe(before.last_surfaced_at)
    expect(after.first_surfaced_at).toBe(before.first_surfaced_at)
  })

  it('NEGATIVE: new EVIDENCE since we last spoke -> not adopted, still visible', () => {
    legacyRow()
    const ledger = loadLedger(db, 'zst')
    const r = reconcileFingerprintRecipe(db, 'zst', ledger, [moved()], { write: true })

    expect(r).toEqual({ adopted: 0, withheld: 1 })
    // The change survives the migration.
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, moved())).toBe(true)
    // And the row was left alone, so nothing was written over.
    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    expect(after.fingerprint).toBe('old-recipe-digest')
    expect(after.fingerprint_algo).toBe(null)
  })

  it('NEGATIVE: the CASE LOG moved, with provenance frozen -> still visible', () => {
    // The witness that provenance alone cannot provide: a status transition
    // that leaves the row's own timestamp untouched.
    legacyRow()
    caseEvent(SPOKE_AT + 3600)
    const ledger = loadLedger(db, 'zst')
    const r = reconcileFingerprintRecipe(db, 'zst', ledger, [still()], { write: true })

    expect(r).toEqual({ adopted: 0, withheld: 1 })
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, still())).toBe(true)
  })

  it('an event from BEFORE we last spoke is not a reason to withhold', () => {
    // The boundary, in the direction that would make the migration never finish.
    legacyRow()
    caseEvent(SPOKE_AT - 3600)
    const r = reconcileFingerprintRecipe(
      db, 'zst', loadLedger(db, 'zst'), [still()], { write: true })
    expect(r).toEqual({ adopted: 1, withheld: 0 })
  })

  it('a rehearsal classifies without writing', () => {
    legacyRow()
    const r = reconcileFingerprintRecipe(
      db, 'zst', loadLedger(db, 'zst'), [still()], { write: false })
    expect(r).toEqual({ adopted: 1, withheld: 0 })
    // Nothing on disk moved.
    const after = loadLedger(db, 'zst').get('case-attention:zst:zst-1')!
    expect(after.fingerprint).toBe('old-recipe-digest')
    expect(after.fingerprint_algo).toBe(null)
  })

  it('a rehearsal still SEES a withheld change, so a dry run reads true', () => {
    legacyRow()
    const ledger = loadLedger(db, 'zst')
    reconcileFingerprintRecipe(db, 'zst', ledger, [moved()], { write: false })
    expect(identityChanged(ledger.get('case-attention:zst:zst-1')!, moved())).toBe(true)
  })

  it('mixed population: each row is judged on its own case', () => {
    // The whole population is reconciled, and one moving case must not drag the
    // still ones along with it, nor be adopted along with them.
    legacyRow()
    const other = {
      ...still(),
      element: { ...still().element, id: 'case-attention:zst:zst-2', caseId: 'zst-2' },
    } as ReturnType<typeof still>
    recordSurfaced(db, 'zst', [other], SPOKE_AT)
    db.prepare(`UPDATE intelligence_surfaced SET fingerprint='old2', fingerprint_algo=NULL
                 WHERE element_id='case-attention:zst:zst-2'`).run()
    caseEvent(SPOKE_AT + 3600) // moves zst-1 only; zst-2 has been still

    const movedOne = moved()
    const r = reconcileFingerprintRecipe(
      db, 'zst', loadLedger(db, 'zst'), [movedOne, other], { write: true })
    expect(r).toEqual({ adopted: 1, withheld: 1 })
  })
})
