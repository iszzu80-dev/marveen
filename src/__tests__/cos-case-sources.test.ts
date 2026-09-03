import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import {
  linkCaseSource, promoteCaseSource, rejectCaseSource, getCaseDossier,
  findCasesForSource, threadsForCase, caseSourceLinkId,
} from '../cos/case-sources.js'
import { backfillCaseSources } from '../cos/case-source-backfill.js'
import { createCase } from '../cos/case-store.js'

const NOW = 1_788_400_000
const DAY = 86_400

const newCase = (id: string, title = id) =>
  createCase(getDb(), { caseId: id, title, caseType: 'ADMIN', status: 'NEW', actor: 'test' } as never, NOW - DAY)

const ev = (s: string) => ({ evidence: s, discoveredBy: 'test' })

describe('a guess never becomes a fact by being written down', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('c1') })

  it('a semantic candidate lands as CANDIDATE, however confident it claims to be', () => {
    const r = linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'SEMANTIC_CANDIDATE', confidence: 0.99, ...ev('subject and body read like the same matter'),
    }, NOW)
    expect(r.state).toBe('CANDIDATE')
    // ...and the dossier does not hand it to a consumer as an established fact.
    const d = getCaseDossier(getDb(), 'personal', 'c1')
    expect(d.canonical).toEqual([])
    expect(d.byType.GMAIL_THREAD).toEqual([])
    expect(d.candidates.map((l) => l.sourceRef)).toEqual(['19fc98f3bb35598c'])
  })

  it('a stored relation lands as CANONICAL, because a fact was already recorded', () => {
    const r = linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'EXPLICIT_RELATION', ...ev('personal_cases.gmail_thread_ids'),
    }, NOW)
    expect(r.state).toBe('CANONICAL')
    expect(getCaseDossier(getDb(), 'personal', 'c1').byType.GMAIL_THREAD).toEqual(['19fc98f3bb35598c'])
  })

  it('a link with no evidence is refused, because nobody could check it later', () => {
    expect(() => linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'DOCUMENT', sourceRef: 'doc-1',
      linkMethod: 'EXPLICIT_RELATION', evidence: '   ', discoveredBy: 'test',
    }, NOW)).toThrow(/evidence is required/)
    expect(getCaseDossier(getDb(), 'personal', 'c1').canonical).toEqual([])
  })
})

describe('the same discovery, run twice, is one link', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('c1') })

  const write = (at: number) => linkCaseSource(getDb(), {
    namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
    linkMethod: 'EXPLICIT_RELATION', ...ev('gmail_thread_ids'),
  }, at)

  it('created once, unchanged after, and the link keeps the date it was FIRST seen', () => {
    expect(write(NOW).outcome).toBe('CREATED')
    expect(write(NOW + DAY).outcome).toBe('UNCHANGED')
    const links = getCaseDossier(getDb(), 'personal', 'c1').canonical
    expect(links).toHaveLength(1)
    expect(links[0].firstSeenAt).toBe(NOW)
    expect(links[0].updatedAt).toBe(NOW + DAY)
  })

  it('the id is derived from the pair, so two runs cannot disagree about it', () => {
    expect(caseSourceLinkId('personal', 'c1', 'GMAIL_THREAD', 'x'))
      .toBe(caseSourceLinkId('personal', 'c1', 'GMAIL_THREAD', 'x'))
    expect(caseSourceLinkId('personal', 'c1', 'GMAIL_THREAD', 'x'))
      .not.toBe(caseSourceLinkId('personal', 'c2', 'GMAIL_THREAD', 'x'))
  })
})

describe('a candidate is decided, not drifted into', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('c1') })

  const guess = () => linkCaseSource(getDb(), {
    namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
    linkMethod: 'SEMANTIC_CANDIDATE', confidence: 0.8, ...ev('reads like the same matter'),
  }, NOW)

  it('a promotion records WHO decided, and refuses to be anonymous', () => {
    const { linkId } = guess()
    expect(() => promoteCaseSource(getDb(), linkId, '  ', NOW)).toThrow(/decidedBy is required/)
    const l = promoteCaseSource(getDb(), linkId, 'istvan', NOW, 'same pool matter')
    expect(l.linkState).toBe('CANONICAL')
    expect(l.linkMethod).toBe('OWNER_CONFIRMED')
    expect(l.decidedBy).toBe('istvan')
    expect(l.decidedAt).toBe(NOW)
  })

  it('a rejected guess is not re-proposed by the next run of the same guesser', () => {
    const { linkId } = guess()
    rejectCaseSource(getDb(), linkId, 'istvan', NOW, 'different matter entirely')
    const again = guess()
    expect(again.outcome).toBe('HELD_BY_REJECTION')
    expect(again.state).toBe('REJECTED')
    const d = getCaseDossier(getDb(), 'personal', 'c1')
    expect(d.canonical).toEqual([])
    expect(d.candidates).toEqual([])
    expect(d.rejected).toHaveLength(1)
  })

  it('but EVIDENCE overrides a rejection, and says out loud that it did', () => {
    const { linkId } = guess()
    rejectCaseSource(getDb(), linkId, 'istvan', NOW, 'looked wrong')
    const proven = linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'EXPLICIT_RELATION', ...ev('outbound_ledger: we sent into this thread from this case'),
    }, NOW + DAY)
    expect(proven.outcome).toBe('UPGRADED')
    expect(proven.state).toBe('CANONICAL')
    // The overturned decision is not erased. A person can see it happened.
    expect(getCaseDossier(getDb(), 'personal', 'c1').canonical[0].decisionNote)
      .toMatch(/overrode an earlier REJECTED decision/)
  })

  it('a candidate proven by a deterministic pass is upgraded without asking anyone', () => {
    guess()
    const proven = linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'DETERMINISTIC_IDENTIFIER', ...ev('order number 236-43 appears in both'),
    }, NOW + DAY)
    expect(proven.outcome).toBe('UPGRADED')
    expect(getCaseDossier(getDb(), 'personal', 'c1').candidates).toEqual([])
  })

  it('promotion refuses a link that is not a candidate', () => {
    const { linkId } = linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'c1', sourceType: 'DOCUMENT', sourceRef: 'doc-1',
      linkMethod: 'EXPLICIT_RELATION', ...ev('cos_documents.case_id'),
    }, NOW)
    expect(() => promoteCaseSource(getDb(), linkId, 'istvan', NOW)).toThrow(/no CANDIDATE link/)
  })
})

describe('the two arities the single column could not express', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella'); newCase('offer'); newCase('supplier') })

  it('ONE CASE, MANY THREADS -- the shape gmail_thread_ids never once held', () => {
    for (const t of ['19ea76492ebe4281', '19fc98f3bb35598c', '1a065a4ad9539b9f']) {
      linkCaseSource(getDb(), {
        namespace: 'personal', caseId: 'umbrella', sourceType: 'GMAIL_THREAD', sourceRef: t,
        linkMethod: 'EXPLICIT_RELATION', ...ev('source_references JSON'),
      }, NOW)
    }
    expect(threadsForCase(getDb(), 'personal', 'umbrella'))
      .toEqual(['19ea76492ebe4281', '19fc98f3bb35598c', '1a065a4ad9539b9f'])
  })

  it('ONE THREAD, MANY CASES -- asked from the thread, which is the direction a reply arrives from', () => {
    for (const c of ['umbrella', 'offer', 'supplier']) {
      linkCaseSource(getDb(), {
        namespace: 'personal', caseId: c, sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
        linkMethod: 'EXPLICIT_RELATION', ...ev('email_processing row carries case_id'),
      }, NOW)
    }
    expect(findCasesForSource(getDb(), 'personal', 'GMAIL_THREAD', '19fc98f3bb35598c')
      .map((l) => l.caseId).sort()).toEqual(['offer', 'supplier', 'umbrella'])
  })

  it('a candidate does not answer the reverse lookup unless it is asked for', () => {
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'offer', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'SEMANTIC_CANDIDATE', ...ev('similar subject'),
    }, NOW)
    expect(findCasesForSource(getDb(), 'personal', 'GMAIL_THREAD', '19fc98f3bb35598c')).toEqual([])
    expect(findCasesForSource(getDb(), 'personal', 'GMAIL_THREAD', '19fc98f3bb35598c',
      { includeCandidates: true }).map((l) => l.caseId)).toEqual(['offer'])
  })

  it('namespaces do not see each other', () => {
    linkCaseSource(getDb(), {
      namespace: 'zst', caseId: 'umbrella', sourceType: 'GMAIL_THREAD', sourceRef: '19fc98f3bb35598c',
      linkMethod: 'EXPLICIT_RELATION', ...ev('zst side'),
    }, NOW)
    expect(getCaseDossier(getDb(), 'personal', 'umbrella').canonical).toEqual([])
    expect(getCaseDossier(getDb(), 'zst', 'umbrella').canonical).toHaveLength(1)
  })
})

describe('the backfill recovers links that were stored where nothing reads', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    newCase('PRI-HOME-2026-005', 'Medence WPC-elemek csereje')
    newCase('PRI-HOME-2026-002')
  })

  /** The live shape, exactly: two thread ids in ONE semicolon-joined string,
   *  inside a JSON blob, in a column called source_references. */
  const sheetBlob = (threads: string[]) => JSON.stringify({
    sheet_case_id: 'PRI-HOME-2026-005',
    email_thread_ids: threads,
    drive_folder_url: 'https://drive.google.com/drive/folders/abc123',
    calendar_event_ids: [],
  })

  it('splits a semicolon-joined cell into the two threads it always contained', () => {
    getDb().prepare(`UPDATE personal_cases SET source_references=? WHERE case_id='PRI-HOME-2026-005'`)
      .run(sheetBlob(['19ea76492ebe4281;19fc98f3bb35598c']))
    const counts = backfillCaseSources(getDb(), 'personal', NOW)
    expect(threadsForCase(getDb(), 'personal', 'PRI-HOME-2026-005').sort())
      .toEqual(['19ea76492ebe4281', '19fc98f3bb35598c'])
    expect(counts.bySource['sheet_blob.email_thread_ids']).toBe(2)
    // The Drive folder is part of the dossier too -- it was in the same blob.
    expect(getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005').byType.EXTERNAL_URL)
      .toEqual(['https://drive.google.com/drive/folders/abc123'])
  })

  it('every link it writes carries the field it came from', () => {
    getDb().prepare(`UPDATE personal_cases SET source_references=? WHERE case_id='PRI-HOME-2026-005'`)
      .run(sheetBlob(['19ea76492ebe4281']))
    backfillCaseSources(getDb(), 'personal', NOW)
    const l = getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005').canonical
      .find((x) => x.sourceType === 'GMAIL_THREAD')!
    expect(l.linkMethod).toBe('EXPLICIT_RELATION')
    expect(l.evidence).toContain('source_references')
    expect(l.evidence).toContain('email_thread_ids')
  })

  it('a ref that does not look like a Gmail id is REPORTED, not linked', () => {
    getDb().prepare(`UPDATE personal_cases SET source_references=? WHERE case_id='PRI-HOME-2026-005'`)
      .run(sheetBlob(['see the Piscinarium mail', '19fc98f3bb35598c']))
    const counts = backfillCaseSources(getDb(), 'personal', NOW)
    expect(threadsForCase(getDb(), 'personal', 'PRI-HOME-2026-005')).toEqual(['19fc98f3bb35598c'])
    expect(counts.unrecognised.map((u) => u.value)).toEqual(['see', 'the', 'Piscinarium', 'mail'])
  })

  it('runs twice without creating a second copy of anything', () => {
    getDb().prepare(`UPDATE personal_cases SET gmail_thread_ids=? WHERE case_id='PRI-HOME-2026-002'`)
      .run(JSON.stringify(['19f6b4c9ddbcc174']))
    const first = backfillCaseSources(getDb(), 'personal', NOW)
    const second = backfillCaseSources(getDb(), 'personal', NOW + DAY)
    expect(first.created).toBeGreaterThan(0)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(first.created)
    expect(getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-002').canonical).toHaveLength(1)
  })

  it('a dry run writes nothing and still counts what it would have written', () => {
    getDb().prepare(`UPDATE personal_cases SET gmail_thread_ids=? WHERE case_id='PRI-HOME-2026-002'`)
      .run(JSON.stringify(['19f6b4c9ddbcc174']))
    const dry = backfillCaseSources(getDb(), 'personal', NOW, { dryRun: true })
    expect(dry.created).toBe(1)
    expect(getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-002').canonical).toEqual([])
    // ...and the wet run then reports the same number, which is what makes the
    // dry run worth reading.
    expect(backfillCaseSources(getDb(), 'personal', NOW).created).toBe(1)
  })

  it('the parent relation becomes a readable link, not a column nobody joins', () => {
    getDb().prepare(`UPDATE personal_cases SET parent_case_id='PRI-HOME-2026-005' WHERE case_id='PRI-HOME-2026-002'`).run()
    backfillCaseSources(getDb(), 'personal', NOW)
    expect(getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-002').byType.CASE)
      .toEqual(['PRI-HOME-2026-005'])
  })
})
