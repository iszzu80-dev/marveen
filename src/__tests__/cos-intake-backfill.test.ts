// THE BACKFILL, AND MOSTLY WHAT IT REFUSES.
//
// A backfill that quietly does slightly more than asked is how a repair becomes
// an incident, so the owner's six constraints are the subject here and the happy
// path is one test among many. Each refusal is paired with the case that proves
// the refusal is a decision and not a permanent no.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { linkCaseSource, getCaseDossier, markSourceContentUnavailable } from '../cos/case-sources.js'
import {
  runBackfill, backfillThread, backfillCandidates, BACKFILL_BATCH_PREFIX,
} from '../cos/intake-backfill.js'

const NOW = 1_700_000_000

function claimed(caseId: string, threadId: string, ns: 'personal' | 'zst' = 'personal', makeCase = true): void {
  if (makeCase && ns === 'personal') {
    createCase(getDb(), { caseId, title: caseId, caseType: 'HOME_REPAIR', status: 'READY' } as any, NOW)
  }
  linkCaseSource(getDb(), {
    namespace: ns, caseId, sourceType: 'GMAIL_THREAD', sourceRef: threadId,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'sheet migration', discoveredBy: 'fixture',
  }, NOW)
}

const fetcher = (map: Record<string, Array<{ id: string }>>) =>
  vi.fn(async (t: string) => map[t] ?? [])

const rows = (): Array<{ message_id: string; batch_id: string; status: string; case_id: string }> =>
  getDb().prepare('SELECT message_id, batch_id, status, case_id FROM email_processing').all() as never

describe('the happy path: a claimed thread the intake never saw', () => {
  beforeEach(() => { initDatabase(':memory:'); claimed('PRI-1', 'thread-a') })

  it('HEADLINE: every message becomes evidence on the case that already claimed the thread', async () => {
    const r = await runBackfill(getDb(), 'personal',
      fetcher({ 'thread-a': [{ id: 'm1' }, { id: 'm2' }] }), 10, NOW)

    expect(r.threads[0]?.outcome).toBe('BACKFILLED')
    expect(r.totals).toMatchObject({ fetched: 2, written: 2, duplicates: 0, BACKFILLED: 1 })
    expect(rows().map((x) => x.message_id).sort()).toEqual(['m1', 'm2'])
    expect(getCaseDossier(getDb(), 'personal', 'PRI-1').canonical.map((s) => s.sourceRef))
      .toEqual(expect.arrayContaining(['m1', 'm2']))
  })

  it('a backfilled row is NOT mistakable for a triaged one', async () => {
    // The distinction is the whole provenance story: nobody judged these
    // messages actionable, then or now. If the batch id did not say so, the
    // only record of how they arrived would be somebody's memory.
    await runBackfill(getDb(), 'personal', fetcher({ 'thread-a': [{ id: 'm1' }] }), 10, NOW)
    expect(rows()[0]?.batch_id.startsWith(BACKFILL_BATCH_PREFIX)).toBe(true)
    expect(getCaseDossier(getDb(), 'personal', 'PRI-1').canonical
      .find((s) => s.sourceRef === 'm1')?.evidence).toMatch(/NOT triaged/)
  })

  it('the thread stops being a candidate once it is backfilled', async () => {
    expect(backfillCandidates(getDb(), 'personal', 10).map((c) => c.threadId)).toEqual(['thread-a'])
    await runBackfill(getDb(), 'personal', fetcher({ 'thread-a': [{ id: 'm1' }] }), 10, NOW)
    expect(backfillCandidates(getDb(), 'personal', 10)).toEqual([])
  })

  it('running it twice writes nothing the second time and says so', async () => {
    const f = fetcher({ 'thread-a': [{ id: 'm1' }] })
    await runBackfill(getDb(), 'personal', f, 10, NOW)
    // The thread is no longer a candidate, so drive the second pass directly at
    // the same thread — the duplicate counter has to be real, not incidental.
    const again = await backfillThread(getDb(), 'personal',
      { threadId: 'thread-a', caseIds: ['PRI-1'], contentUnavailable: false }, f, NOW)
    expect(again.outcome).toBe('ALREADY_COMPLETE')
    expect(again).toMatchObject({ written: 0, duplicates: 1 })
    expect(rows()).toHaveLength(1)
  })

  it('the limit is a bound, not a suggestion', async () => {
    claimed('PRI-2', 'thread-b'); claimed('PRI-3', 'thread-c')
    const f = fetcher({ 'thread-a': [{ id: 'a' }], 'thread-b': [{ id: 'b' }], 'thread-c': [{ id: 'c' }] })
    const r = await runBackfill(getDb(), 'personal', f, 2, NOW)
    expect(r.examined).toBe(2)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('constraint 5: it never merges cases', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    claimed('PRI-1', 'shared-thread')
    claimed('PRI-2', 'shared-thread')
  })

  it('HEADLINE: two claimants means nothing is written and both are named', async () => {
    const f = fetcher({ 'shared-thread': [{ id: 'm1' }] })
    const r = await runBackfill(getDb(), 'personal', f, 10, NOW)
    expect(r.threads[0]?.outcome).toBe('AMBIGUOUS_CASE_RELATION')
    expect(r.threads[0]?.otherClaimants.sort()).toEqual(['PRI-1', 'PRI-2'])
    expect(rows()).toHaveLength(0)
    expect(f, 'and the mailbox is not even asked').not.toHaveBeenCalled()
  })

  it('the claimants are re-read at write time, not taken from the candidate list', async () => {
    // A candidate list is a snapshot. A second claim added after it was built is
    // exactly the moment when writing to the stale winner does the most damage.
    const c = { threadId: 'solo', caseIds: ['PRI-1'], contentUnavailable: false }
    claimed('PRI-1', 'solo', 'personal', false) // PRI-1 already exists from beforeEach
    claimed('PRI-9', 'solo')
    const r = await backfillThread(getDb(), 'personal', c, fetcher({ solo: [{ id: 'm1' }] }), NOW)
    expect(r.outcome).toBe('AMBIGUOUS_CASE_RELATION')
  })

  it('MIRROR: one claimant is written, or the refusal above proves only that it never writes', async () => {
    claimed('PRI-3', 'solo-thread')
    const r = await backfillThread(getDb(), 'personal',
      { threadId: 'solo-thread', caseIds: ['PRI-3'], contentUnavailable: false },
      fetcher({ 'solo-thread': [{ id: 'm1' }] }), NOW)
    expect(r.outcome).toBe('BACKFILLED')
  })
})

describe('constraint 4: it never opens a case', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a thread claimed by a case that does not exist is refused, not created', async () => {
    claimed('GHOST-1', 'orphan-thread', 'personal', false) // link, no case row
    const before = getDb().prepare('SELECT COUNT(*) n FROM personal_cases').get() as { n: number }
    const r = await runBackfill(getDb(), 'personal', fetcher({ 'orphan-thread': [{ id: 'm1' }] }), 10, NOW)
    expect(r.threads[0]?.outcome).toBe('NAMESPACE_MISMATCH')
    expect(r.threads[0]?.detail).toContain('personal_cases')
    const after = getDb().prepare('SELECT COUNT(*) n FROM personal_cases').get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(rows()).toHaveLength(0)
  })

  it('a personal-namespace link to a ZST-only case reads as a namespace mismatch', async () => {
    // The migration wrote relations directly, so a case id landing in the wrong
    // namespace is a real shape here, not a hypothetical one.
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'ZST-ONLY-1', sourceType: 'GMAIL_THREAD',
      sourceRef: 'zst-thread', linkMethod: 'EXPLICIT_RELATION',
      evidence: 'fixture', discoveredBy: 'fixture',
    }, NOW)
    const r = await runBackfill(getDb(), 'personal', fetcher({ 'zst-thread': [{ id: 'm1' }] }), 10, NOW)
    expect(r.threads[0]?.outcome).toBe('NAMESPACE_MISMATCH')
  })
})

describe('a source that is gone keeps its relation', () => {
  beforeEach(() => { initDatabase(':memory:'); claimed('PRI-1', 'thread-404') })

  it('HEADLINE: a 404 marks the thread unavailable and leaves the link standing', async () => {
    const f = vi.fn(async () => { throw new Error('thread fetch failed: 404') })
    const r = await runBackfill(getDb(), 'personal', f, 10, NOW)
    expect(r.threads[0]?.outcome).toBe('CONTENT_UNAVAILABLE')
    const d = getCaseDossier(getDb(), 'personal', 'PRI-1')
    expect(d.unavailable.map((s) => s.sourceRef)).toContain('thread-404')
    expect(d.canonical.map((s) => s.sourceRef), 'still canonical, not demoted')
      .toContain('thread-404')
  })

  it('a 401 is NOT a 404: "could not ask" stays retryable', async () => {
    // Collapsing these would retire a live conversation over a token refresh,
    // and the relation would carry a permanent lie about the mailbox.
    const f = vi.fn(async () => { throw new Error('token refresh failed: 401') })
    const r = await runBackfill(getDb(), 'personal', f, 10, NOW)
    expect(r.threads[0]?.outcome).toBe('FETCH_FAILED')
    expect(getCaseDossier(getDb(), 'personal', 'PRI-1').unavailable).toHaveLength(0)
    expect(backfillCandidates(getDb(), 'personal', 10).map((c) => c.threadId)).toContain('thread-404')
  })

  it('an EMPTY thread is not a 404 either', async () => {
    const r = await runBackfill(getDb(), 'personal', fetcher({}), 10, NOW)
    expect(r.threads[0]?.outcome).toBe('FETCH_FAILED')
    expect(getCaseDossier(getDb(), 'personal', 'PRI-1').unavailable).toHaveLength(0)
  })

  it('a thread already known to be gone is not fetched again', async () => {
    markSourceContentUnavailable(getDb(), {
      namespace: 'personal', caseId: 'PRI-1', sourceType: 'GMAIL_THREAD',
      sourceRef: 'thread-404', note: 'known gone',
    }, NOW)
    const f = fetcher({ 'thread-404': [{ id: 'm1' }] })
    const r = await runBackfill(getDb(), 'personal', f, 10, NOW)
    expect(r.threads[0]?.outcome).toBe('CONTENT_UNAVAILABLE')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('the report answers what the owner asked to be measured', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: fetched, written, duplicates and every outcome are counted separately', async () => {
    claimed('PRI-1', 't1'); claimed('PRI-2', 't2')
    claimed('PRI-3', 't3'); claimed('PRI-4', 't3') // ambiguous
    await runBackfill(getDb(), 'personal', fetcher({ t1: [{ id: 'a' }] }), 10, NOW)

    const r = await runBackfill(getDb(), 'personal', fetcher({
      t2: [{ id: 'b' }, { id: 'a' }], // 'a' already written by the first run
      t3: [{ id: 'c' }],
    }), 10, NOW)

    expect(r.totals.BACKFILLED).toBe(1)
    expect(r.totals.AMBIGUOUS_CASE_RELATION).toBe(1)
    expect(r.totals).toMatchObject({ fetched: 2, written: 1, duplicates: 1 })
  })

  it('elapsed time is measured per thread, so a slow mailbox is visible', async () => {
    claimed('PRI-1', 't1')
    let t = 0
    const clock = () => (t += 500)
    const r = await backfillThread(getDb(), 'personal',
      { threadId: 't1', caseIds: ['PRI-1'], contentUnavailable: false },
      fetcher({ t1: [{ id: 'a' }] }), NOW, clock)
    expect(r.elapsedMs).toBeGreaterThan(0)
  })
})
