import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import { linkCaseSource, caseThreadIds, getCaseDossier } from '../cos/case-sources.js'
import { linkDocumentsByCaseIdentifier } from '../cos/case-source-backfill.js'
import { createCase } from '../cos/case-store.js'
import { casesMissingThreadText } from '../cos/gmail-thread-read.js'
import { resolveEmailThread } from '../cos/progression-resolver.js'
import { pickReplyThread } from '../cos/followup-autodraft.js'
import { buildCaseContext } from '../cos/context-builder.js'

const NOW = 1_788_400_000
const DAY = 86_400

const T1 = '19ea76492ebe4281'
const T2 = '19fc98f3bb35598c'

const newCase = (id: string, title = id) =>
  createCase(getDb(), { caseId: id, title, caseType: 'ADMIN', status: 'NEW', actor: 'test' } as never, NOW - DAY)

const linkThread = (caseId: string, threadId: string, ns: 'personal' | 'zst' = 'personal') =>
  linkCaseSource(getDb(), {
    namespace: ns, caseId, sourceType: 'GMAIL_THREAD', sourceRef: threadId,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'source_references JSON', discoveredBy: 'test',
  }, NOW)

const storeThreadDoc = (caseId: string, threadId: string) =>
  getDb().prepare(
    `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
       mime_type, sha256, doc_kind, sensitivity, external_share_allowed, created_at, updated_at)
     VALUES (@id, 'personal', @caseId, 'email', @threadId, @fn, 'text/plain', @id, 'email_thread',
       'PERSONAL', 0, @now, @now)`,
  ).run({ id: `doc-${caseId}-${threadId}`, caseId, threadId, fn: `thread-${threadId}.txt`, now: NOW })

describe('the thread set a consumer sees is the graph, not element zero', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  it('caseThreadIds returns every canonical thread', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    expect(caseThreadIds(getDb(), 'personal', 'umbrella').threadIds).toEqual([T1, T2])
  })

  it('a legacy column entry the graph has not got is unioned in AND reported', () => {
    linkThread('umbrella', T1)
    getDb().prepare(`UPDATE personal_cases SET gmail_thread_ids=? WHERE case_id='umbrella'`)
      .run(JSON.stringify([T2]))
    const set = caseThreadIds(getDb(), 'personal', 'umbrella')
    expect(set.threadIds.sort()).toEqual([T1, T2].sort())
    expect(set.fromGraph).toEqual([T1])
    // Not silently absorbed: a consumer or an audit can see the graph is behind.
    expect(set.legacyOnly).toEqual([T2])
  })

  it('a malformed legacy column does not destroy the graph answer', () => {
    linkThread('umbrella', T1)
    getDb().prepare(`UPDATE personal_cases SET gmail_thread_ids='not json' WHERE case_id='umbrella'`).run()
    expect(caseThreadIds(getDb(), 'personal', 'umbrella').threadIds).toEqual([T1])
  })
})

describe('THREAD FETCH: the queue asks the missing question per thread, not per case', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  it('a case with two threads yields TWO fetch jobs', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    expect(casesMissingThreadText(getDb()).map((r) => r.thread_id).sort()).toEqual([T1, T2].sort())
  })

  it('storing ONE thread does not retire the other -- the old bug, asserted', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    storeThreadDoc('umbrella', T1)
    expect(casesMissingThreadText(getDb()).map((r) => r.thread_id)).toEqual([T2])
  })

  it('a case whose threads are ALL stored drops out of the queue', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    storeThreadDoc('umbrella', T1); storeThreadDoc('umbrella', T2)
    expect(casesMissingThreadText(getDb())).toEqual([])
  })

  it('one abandoned thread does not retire the case, only that thread', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    // The failures table is created lazily by the recorder, so a fresh store
    // does not have it. That absence is exactly what the production fallback
    // handles; here we want the WITH-failures path, so create it.
    getDb().exec(
      `CREATE TABLE IF NOT EXISTS cos_thread_fetch_failures (
         case_id TEXT NOT NULL, thread_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
         last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (case_id, thread_id))`)
    getDb().prepare(
      `INSERT INTO cos_thread_fetch_failures (case_id, thread_id, attempts, last_error, updated_at)
       VALUES ('umbrella', @t, 99, 'gone', @now)`,
    ).run({ t: T1, now: NOW })
    expect(casesMissingThreadText(getDb()).map((r) => r.thread_id)).toEqual([T2])
  })

  it('a legacy-column-only case is still fetched, so nothing regresses', () => {
    getDb().prepare(`UPDATE personal_cases SET gmail_thread_ids=? WHERE case_id='umbrella'`)
      .run(JSON.stringify([T1]))
    expect(casesMissingThreadText(getDb()).map((r) => r.thread_id)).toEqual([T1])
  })
})

describe('EVIDENCE CONTEXT: resolveEmailThread reads all the case threads', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  const ingestMessage = (threadId: string, messageId: string) => {
    getDb().prepare(
      `INSERT OR IGNORE INTO email_processing_batches
         (batch_id, gmail_account_id, cursor_after, status, created_at, updated_at)
       VALUES ('b1', 'private', 'c1', 'OPEN', @now, @now)`,
    ).run({ now: NOW })
    getDb().prepare(
      `INSERT INTO email_processing (gmail_account_id, message_id, thread_id, batch_id, status, case_id, created_at, updated_at)
       VALUES ('private', @m, @t, 'b1', 'LOCAL_APPLIED', 'umbrella', @now, @now)`,
    ).run({ m: messageId, t: threadId, now: NOW })
  }

  it('messages from BOTH threads reach the resolution', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    ingestMessage(T1, 'msg-a'); ingestMessage(T2, 'msg-b')
    const r = resolveEmailThread(getDb(), 'personal', 'umbrella')
    expect(r.thread_ids.sort()).toEqual([T1, T2].sort())
    expect(r.messages.map((m) => m.message_id).sort()).toEqual(['msg-a', 'msg-b'])
    expect(r.has_history).toBe(true)
  })

  it('and it finds them for a case whose column is EMPTY -- every Sheet-migrated case', () => {
    linkThread('umbrella', T1)
    ingestMessage(T1, 'msg-a')
    expect(getDb().prepare(`SELECT gmail_thread_ids FROM personal_cases WHERE case_id='umbrella'`)
      .get()).toEqual({ gmail_thread_ids: null })
    expect(resolveEmailThread(getDb(), 'personal', 'umbrella').messages).toHaveLength(1)
  })
})

describe('FOLLOW-UP: which thread the letter goes into is decided, not defaulted', () => {
  beforeEach(() => {
    initDatabase(':memory:'); newCase('umbrella')
    getDb().prepare(
      `INSERT OR IGNORE INTO email_processing_batches
         (batch_id, gmail_account_id, cursor_after, status, created_at, updated_at)
       VALUES ('b1', 'private', 'c1', 'OPEN', @now, @now)`,
    ).run({ now: NOW })
  })

  const ingestAt = (threadId: string, messageId: string, at: number) =>
    getDb().prepare(
      `INSERT INTO email_processing (gmail_account_id, message_id, thread_id, batch_id, status, case_id, created_at, updated_at)
       VALUES ('private', @m, @t, 'b1', 'LOCAL_APPLIED', 'umbrella', @at, @at)`,
    ).run({ m: messageId, t: threadId, at })

  it('one thread needs no tie-break', () => {
    linkThread('umbrella', T1)
    expect(pickReplyThread(getDb(), 'umbrella').threadId).toBe(T1)
  })

  it('with several threads, the one with the most recent known message wins', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    ingestAt(T1, 'old', NOW - 10 * DAY)
    ingestAt(T2, 'new', NOW - DAY)
    expect(pickReplyThread(getDb(), 'umbrella').threadId).toBe(T2)
  })

  it('several threads and NOTHING to separate them is refused, not guessed', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    const pick = pickReplyThread(getDb(), 'umbrella')
    expect(pick.threadId).toBeUndefined()
    expect(pick.code).toBe('ambiguous_thread')
    expect(pick.reason).toMatch(/nem talalgatunk|nem találgatunk/)
  })

  it('a dead tie is refused too', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    ingestAt(T1, 'a', NOW - DAY); ingestAt(T2, 'b', NOW - DAY)
    expect(pickReplyThread(getDb(), 'umbrella').code).toBe('ambiguous_thread')
  })

  it('no thread at all is still "no prior conversation"', () => {
    expect(pickReplyThread(getDb(), 'umbrella').code).toBe('no_prior_conversation')
  })
})

describe('READER CONTEXT: the dossier reaches the Reader, candidates do not', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  it('every canonical link is an item, carrying its method and evidence', () => {
    linkThread('umbrella', T1)
    const ctx = buildCaseContext(getDb(), 'personal', 'umbrella', NOW)
    const sources = ctx.items.filter((i) => i.kind === 'CASE_SOURCE')
    expect(sources).toHaveLength(1)
    expect(sources[0].provenance.reference).toBe(`GMAIL_THREAD:${T1}`)
    expect(sources[0].content).toContain('EXPLICIT_RELATION')
    expect(sources[0].content).toContain('source_references JSON')
  })

  it('a CANDIDATE link is NOT an item -- it is named in `excluded`', () => {
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'umbrella', sourceType: 'GMAIL_THREAD', sourceRef: T2,
      linkMethod: 'SEMANTIC_CANDIDATE', confidence: 0.9, ...{ evidence: 'similar subject', discoveredBy: 'test' },
    }, NOW)
    const ctx = buildCaseContext(getDb(), 'personal', 'umbrella', NOW)
    expect(ctx.items.filter((i) => i.kind === 'CASE_SOURCE')).toEqual([])
    expect(ctx.excluded.some((e) => e.reference === `GMAIL_THREAD:${T2}`
      && /candidate link, not established/.test(e.reason))).toBe(true)
  })
})

describe('a case id in a filename is a link, and the file keeps its own case too', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    newCase('PRI-HOME-2026-005', 'Medence WPC')
    newCase('case-iszzu80-19fcbd3b431aa3c0', 'Ajanlatkeres')
  })

  const photo = (id: string, caseId: string, filename: string) =>
    getDb().prepare(
      `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
         mime_type, sha256, doc_kind, sensitivity, external_share_allowed, created_at, updated_at)
       VALUES (@id, 'personal', @caseId, 'email', 'x', @fn, 'image/jpeg', @id, 'photo', 'PERSONAL', 0, @now, @now)`,
    ).run({ id, caseId, fn: filename, now: NOW })

  it('the umbrella case gains the photo its filename names', () => {
    photo('doc-1', 'case-iszzu80-19fcbd3b431aa3c0', 'PRI-HOME-2026-005_20260621_medenceoldal_1.jpg')
    const counts = linkDocumentsByCaseIdentifier(getDb(), 'personal', NOW)
    expect(counts.created).toBe(1)
    const d = getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005')
    expect(d.byType.DOCUMENT).toEqual(['doc-1'])
    expect(d.canonical[0].linkMethod).toBe('DETERMINISTIC_IDENTIFIER')
    expect(d.canonical[0].evidence).toContain('PRI-HOME-2026-005')
    // NOTHING WAS MOVED: the row still names the case the mail arrived on.
    expect(getDb().prepare(`SELECT case_id FROM cos_documents WHERE document_id='doc-1'`).get())
      .toEqual({ case_id: 'case-iszzu80-19fcbd3b431aa3c0' })
  })

  it('a filename that merely CONTAINS the id inside a longer token does not match', () => {
    photo('doc-2', 'case-iszzu80-19fcbd3b431aa3c0', 'PRI-HOME-2026-0051x.jpg')
    expect(linkDocumentsByCaseIdentifier(getDb(), 'personal', NOW).created).toBe(0)
    expect(getCaseDossier(getDb(), 'personal', 'PRI-HOME-2026-005').canonical).toEqual([])
  })

  it('a document already filed under the named case gains nothing', () => {
    photo('doc-3', 'PRI-HOME-2026-005', 'PRI-HOME-2026-005_a.jpg')
    expect(linkDocumentsByCaseIdentifier(getDb(), 'personal', NOW).created).toBe(0)
  })

  it('re-running creates nothing new', () => {
    photo('doc-4', 'case-iszzu80-19fcbd3b431aa3c0', 'PRI-HOME-2026-005_b.jpg')
    expect(linkDocumentsByCaseIdentifier(getDb(), 'personal', NOW).created).toBe(1)
    expect(linkDocumentsByCaseIdentifier(getDb(), 'personal', NOW + DAY).created).toBe(0)
  })
})

describe('the Reader is handed the dossier documents, not only the column ones', () => {
  beforeEach(() => {
    initDatabase(':memory:'); newCase('umbrella'); newCase('sibling')
  })

  const doc = (id: string, caseId: string, filename: string) =>
    getDb().prepare(
      `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
         mime_type, sha256, doc_kind, extracted_text, sensitivity, external_share_allowed, created_at, updated_at)
       VALUES (@id, 'personal', @caseId, 'email', 'x', @fn, 'text/plain', @id, 'other', @txt,
         'PERSONAL', 0, @now, @now)`,
    ).run({ id, caseId, fn: filename, txt: `content of ${id}`, now: NOW })

  const docRefs = (caseId: string) =>
    buildCaseContext(getDb(), 'personal', caseId, NOW).items
      .filter((i) => i.kind === 'DOCUMENT').map((i) => i.provenance.reference).sort()

  it('a document linked ONLY by the graph reaches the context, with its content', () => {
    doc('doc-own', 'umbrella', 'own.txt')
    doc('doc-linked', 'sibling', 'PRI-HOME-2026-005_photo.jpg')
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'umbrella', sourceType: 'DOCUMENT', sourceRef: 'doc-linked',
      linkMethod: 'DETERMINISTIC_IDENTIFIER',
      evidence: 'filename names the case', discoveredBy: 'test',
    }, NOW)
    expect(docRefs('umbrella')).toEqual(['doc-linked', 'doc-own'])
    const linked = buildCaseContext(getDb(), 'personal', 'umbrella', NOW).items
      .find((i) => i.provenance.reference === 'doc-linked')!
    expect(linked.content).toContain('content of doc-linked')
    // ...and the sibling keeps its own document. Nothing was moved.
    expect(docRefs('sibling')).toEqual(['doc-linked'])
  })

  it('a CANDIDATE document link does not bring content into the context', () => {
    doc('doc-guess', 'sibling', 'maybe.txt')
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'umbrella', sourceType: 'DOCUMENT', sourceRef: 'doc-guess',
      linkMethod: 'SEMANTIC_CANDIDATE', evidence: 'looks related', discoveredBy: 'test',
    }, NOW)
    expect(docRefs('umbrella')).toEqual([])
  })

  it('a graph link cannot pull a document across the namespace boundary', () => {
    getDb().prepare(
      `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
         mime_type, sha256, doc_kind, sensitivity, external_share_allowed, created_at, updated_at)
       VALUES ('doc-zst', 'zst', 'sibling', 'email', 'x', 'z.txt', 'text/plain', 'h', 'other',
         'ZST_INTERNAL', 0, @now, @now)`,
    ).run({ now: NOW })
    linkCaseSource(getDb(), {
      namespace: 'personal', caseId: 'umbrella', sourceType: 'DOCUMENT', sourceRef: 'doc-zst',
      linkMethod: 'DETERMINISTIC_IDENTIFIER', evidence: 'id match', discoveredBy: 'test',
    }, NOW)
    expect(docRefs('umbrella')).toEqual([])
  })
})

describe('the relation map survives a full packet', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  it('the dossier is not the half that falls off the end when documents arrive', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    // Fill the packet well past its 40-item bound with documents.
    for (let n = 0; n < 60; n++) {
      const id = `doc-${n}`
      getDb().prepare(
        `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
           mime_type, sha256, doc_kind, extracted_text, sensitivity, external_share_allowed, created_at, updated_at)
         VALUES (@id, 'personal', 'umbrella', 'email', 'x', @fn, 'text/plain', @id, 'other', 'x',
           'PERSONAL', 0, @now, @now)`,
      ).run({ id, fn: `${id}.txt`, now: NOW })
    }
    const ctx = buildCaseContext(getDb(), 'personal', 'umbrella', NOW)
    const sources = ctx.items.filter((i) => i.kind === 'CASE_SOURCE')
    expect(sources.map((i) => i.provenance.reference).sort())
      .toEqual([`GMAIL_THREAD:${T1}`, `GMAIL_THREAD:${T2}`].sort())
    // The bound still bites -- it is a real bound, and the drop is still named.
    expect(ctx.items.length).toBeLessThanOrEqual(40)
    expect(ctx.excluded.some((e) => /over the 40-item context bound/.test(e.reason))).toBe(true)
  })
})

describe('the map does not eat the territory', () => {
  beforeEach(() => { initDatabase(':memory:'); newCase('umbrella') })

  it('many linked documents cost ONE map line, and the content still arrives', () => {
    linkThread('umbrella', T1); linkThread('umbrella', T2)
    for (let n = 0; n < 22; n++) {
      const id = `doc-${n}`
      getDb().prepare(
        `INSERT INTO cos_documents (document_id, namespace, case_id, source, source_ref, filename,
           mime_type, sha256, doc_kind, extracted_text, sensitivity, external_share_allowed, created_at, updated_at)
         VALUES (@id, 'personal', 'umbrella', 'email', 'x', @fn, 'text/plain', @id, 'other', @txt,
           'PERSONAL', 0, @now, @now)`,
      ).run({ id, fn: `${id}.txt`, txt: `content ${id}`, now: NOW })
      linkCaseSource(getDb(), {
        namespace: 'personal', caseId: 'umbrella', sourceType: 'DOCUMENT', sourceRef: id,
        linkMethod: 'DETERMINISTIC_IDENTIFIER', evidence: 'filename names the case', discoveredBy: 'test',
      }, NOW)
    }
    const ctx = buildCaseContext(getDb(), 'personal', 'umbrella', NOW)
    const sources = ctx.items.filter((i) => i.kind === 'CASE_SOURCE')
    // Both threads named individually; the 22 documents as ONE line.
    expect(sources.filter((i) => i.provenance.reference.startsWith('GMAIL_THREAD:'))).toHaveLength(2)
    const summary = sources.find((i) => i.provenance.reference === 'DOCUMENT:x22')!
    expect(summary.content).toContain('22 document(s)')
    expect(summary.content).toContain('DETERMINISTIC_IDENTIFIER')
    // ...and the documents themselves still arrive, with content.
    const docItems = ctx.items.filter((i) => i.kind === 'DOCUMENT')
    expect(docItems.length).toBeGreaterThan(10)
    expect(docItems[0].content).toContain('content doc-')
  })
})
