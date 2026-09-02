import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions } from '../cos/owner-question.js'
import { evaluatePreQuestionEvidence } from '../cos/pre-question-evidence.js'
import {
  classifyExtraction, isTrustedExtraction, effectiveExtractionState,
  MIN_LETTER_RATIO,
} from '../cos/document-extraction.js'

// THE PRE-QUESTION EVIDENCE GATE — positive and negative controls.
//
// The live failure: question QADBD asked for "the text of the attached
// documents" and held a channel slot for twenty-two days, while the contract
// had been extracted the same day and summarised into the case's own
// description. The reader looked at ONE column, found NULL, and asked.
//
// The negative controls matter as much as the positive one. A gate that
// suppresses too eagerly produces a SILENT failure -- a question the owner
// needed and never saw -- so every test below that asserts "still asks" is
// guarding the direction that cannot be noticed from outside.

const NOW = 1_700_000_000
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

function seedCase(caseId: string, ask: string): void {
  const db = getDb()
  createCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, NOW)
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, NOW, NOW)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'teny', source: 'e' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }], uncertainty: [], confidence: 0.7,
  }
  db.prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet),
        JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }), NOW)
}

function addDocument(caseId: string, over: {
  text?: string | null; state?: string | null; filename?: string
} = {}): string {
  const db = getDb()
  const id = `doc-${caseId}-${Math.random().toString(16).slice(2, 8)}`
  db.prepare(
    `INSERT INTO cos_documents
       (document_id, namespace, case_id, source, source_ref, filename, mime_type,
        byte_size, sha256, stored_path, doc_kind, extracted_text, extraction_state,
        sensitivity, external_share_allowed, received_at, created_at, updated_at)
     VALUES (?, 'personal', ?, 'email', 'ref', ?, 'application/pdf',
             10, ?, '/dev/null', 'other', ?, ?, 'UNKNOWN', 0, ?, ?, ?)`,
  ).run(id, caseId, over.filename ?? 'szerzodes.docx', id,
        over.text ?? null, over.state ?? null, NOW, NOW, NOW)
  return id
}

/** Real prose — what a good extraction looks like. */
const GOOD_TEXT = [
  'TERMINATION OF AGENCY CONTRACT. The agreement is made between General',
  'Mechatronics Ltd and ZST Radio Kft. The parties are terminating the agency',
  'agreement with common will. The commission fee of the remaining sixty percent',
  'will be issued and paid after delivery, when the buyer has paid the remaining',
  'balance of the purchase price stated in the order.',
].join(' ')

/** What the live PDF actually produced: mostly punctuation and short noise. */
const GARBAGE_TEXT = ('\\(\\) /F1 12 Tf 0 g BT [( )] TJ ET Q q 1 0 0 1 0 0 cm /X1 Do Q ').repeat(80)

describe('document extraction quality', () => {
  it('POSITIVE: prose is EXTRACTED_VALID and trusted', () => {
    const q = classifyExtraction(GOOD_TEXT)
    expect(q.state).toBe('EXTRACTED_VALID')
    expect(q.letterRatio).toBeGreaterThan(MIN_LETTER_RATIO)
    expect(isTrustedExtraction(q.state)).toBe(true)
  })

  it('NEGATIVE: a garbage extraction never becomes trusted evidence', () => {
    const q = classifyExtraction(GARBAGE_TEXT)
    expect(q.state).toBe('EXTRACTION_LOW_QUALITY')
    expect(q.letterRatio).toBeLessThan(MIN_LETTER_RATIO)
    expect(isTrustedExtraction(q.state)).toBe(false)
  })

  it('NEGATIVE: raw binary that survived a lossy decode is caught by its NUL bytes', () => {
    // The live symptom: SQLite reported length() 672 for 853,370 characters,
    // because length() stops at the first NUL. Long enough and wordy enough to
    // pass every other check.
    const withNuls = `${GOOD_TEXT}\u0000\u0000${GOOD_TEXT}`
    expect(classifyExtraction(withNuls).state).toBe('EXTRACTION_LOW_QUALITY')
  })

  it('empty is NOT_ATTEMPTED, which is a different fact from a failed attempt', () => {
    expect(classifyExtraction(null).state).toBe('NOT_ATTEMPTED')
    expect(classifyExtraction('   ').state).toBe('NOT_ATTEMPTED')
  })

  it('a legacy row with no stored state is classified from its own text, not assumed valid', () => {
    expect(effectiveExtractionState(null, GOOD_TEXT)).toBe('EXTRACTED_VALID')
    expect(effectiveExtractionState(null, GARBAGE_TEXT)).toBe('EXTRACTION_LOW_QUALITY')
    // An explicitly stored state always wins over re-derivation.
    expect(effectiveExtractionState('EXTRACTION_FAILED', GOOD_TEXT)).toBe('EXTRACTION_FAILED')
  })
})

describe('pre-question evidence gate', () => {
  beforeEach(() => { initDatabase(':memory:') })

  const REQ = 'A csatolt dokumentumok szövege — kiolvasott szöveg nélkül nem lehet megállapítani az ügy tartalmát'

  it('POSITIVE: the QADBD shape — a trusted extraction answers the requirement, so no question goes out', () => {
    seedCase('C-DOC', REQ)
    addDocument('C-DOC', { text: GOOD_TEXT, state: 'EXTRACTED_VALID' })

    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-DOC', requirements: [REQ],
    })
    expect(v.suppress).toBe(true)
    expect(v.verdicts[0].hits[0].surface).toBe('DOCUMENT_TEXT')

    const r = askPendingOwnerQuestions(getDb(), { now: NOW, channel: { channel: CHANNEL, target: CHAT } })
    expect(r.asked).toBe(0)
    expect(r.answeredByEvidence).toBe(1)
    expect(r.answeredByEvidenceDetail[0].caseId).toBe('C-DOC')
    // And it is NOT silent: the suppression names the surface that answered.
    expect(r.answeredByEvidenceDetail[0].surfaces).toContain('DOCUMENT_TEXT')
  })

  it('NEGATIVE: a LOW_QUALITY extraction does not answer it — the question still goes out', () => {
    seedCase('C-BAD', REQ)
    addDocument('C-BAD', { text: GARBAGE_TEXT, state: 'EXTRACTION_LOW_QUALITY' })

    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-BAD', requirements: [REQ],
    })
    expect(v.suppress).toBe(false)
    expect(v.verdicts[0].reason).toContain('none with a trusted extraction')

    const r = askPendingOwnerQuestions(getDb(), { now: NOW, channel: { channel: CHANNEL, target: CHAT } })
    expect(r.asked).toBe(1)
    expect(r.answeredByEvidence).toBe(0)
  })

  it('NEGATIVE: a document with no extraction attempt does not answer it', () => {
    seedCase('C-NONE', REQ)
    addDocument('C-NONE', { text: null, state: null })
    expect(evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-NONE', requirements: [REQ],
    }).suppress).toBe(false)
  })

  it('NEGATIVE: a requirement the gate does not recognise is always asked', () => {
    // The safe direction. An unrecognised shape must never be treated as
    // resolved, because a wrong suppression is invisible from outside.
    const req = 'Istvan dontese, hogy melyik szallodat valasztjuk Valenciaban'
    seedCase('C-UNK', req)
    addDocument('C-UNK', { text: GOOD_TEXT, state: 'EXTRACTED_VALID' })
    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-UNK', requirements: [req],
    })
    expect(v.suppress).toBe(false)
    expect(v.verdicts[0].reason).toContain('no resolver recognised')
  })

  it('NEGATIVE: the gate never crosses a namespace', () => {
    seedCase('C-NS', REQ)
    // The document is filed under zst; the case is personal.
    getDb().prepare(
      `INSERT INTO cos_documents
         (document_id, namespace, case_id, source, source_ref, filename, mime_type,
          byte_size, sha256, stored_path, doc_kind, extracted_text, extraction_state,
          sensitivity, external_share_allowed, received_at, created_at, updated_at)
       VALUES ('doc-foreign','zst','C-NS','email','r','x.docx','application/pdf',
               10,'sha-foreign','/dev/null','other', ?, 'EXTRACTED_VALID','UNKNOWN',0,?,?,?)`,
    ).run(GOOD_TEXT, NOW, NOW, NOW)
    expect(evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-NS', requirements: [REQ],
    }).suppress).toBe(false)
  })


  it('REGRESSION (live, 2026-09-02): "átvétele és ellenőrzése" is an ACTION, not a request for text we hold', () => {
    // Caught by measuring the gate against the live store before it shipped.
    // The first vocabulary matched the bare word "dokumentum" and suppressed
    // this, which would have silently removed a real obligation from his queue:
    // the document is on a government portal we cannot reach, and only he can
    // collect it. A stored email thread about the notification is not the deed.
    const req = "A Tárhelyen érkezett NAV 'Adózói rendelkezés' dokumentum átvétele és ellenőrzése."
    seedCase('C-NAV', req)
    addDocument('C-NAV', { text: GOOD_TEXT, state: 'EXTRACTED_VALID', filename: 'thread.txt' })
    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-NAV', requirements: [req],
    })
    expect(v.suppress).toBe(false)
    expect(v.verdicts[0].reason).toContain('no resolver recognised')
  })

  it('a document-CONTENT request still needs both halves: the noun and the ask for its text', () => {
    seedCase('C-HALF', 'A csatolt dokumentum')       // noun only, no content word
    addDocument('C-HALF', { text: GOOD_TEXT, state: 'EXTRACTED_VALID' })
    expect(evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-HALF', requirements: ['A csatolt dokumentum'],
    }).suppress).toBe(false)
  })

  it('suppression is all-or-nothing: one unresolved requirement still asks', () => {
    seedCase('C-MIX', REQ)
    addDocument('C-MIX', { text: GOOD_TEXT, state: 'EXTRACTED_VALID' })
    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-MIX',
      requirements: [REQ, 'Istvan dontese a koltsegkeretrol'],
    })
    expect(v.suppress).toBe(false)
    expect(v.verdicts.filter(x => x.resolved)).toHaveLength(1)
  })

  it('does not build a second truth store: the verdict REFERENCES the row, it does not copy the fact', () => {
    seedCase('C-REF', REQ)
    const docId = addDocument('C-REF', { text: GOOD_TEXT, state: 'EXTRACTED_VALID' })
    const v = evaluatePreQuestionEvidence(getDb(), {
      namespace: 'personal', caseId: 'C-REF', requirements: [REQ],
    })
    expect(v.verdicts[0].hits[0].reference).toBe(docId)
    // Nothing was written anywhere by evaluating.
    const docs = getDb().prepare(`SELECT COUNT(*) c FROM cos_documents`).get() as { c: number }
    expect(docs.c).toBe(1)
  })
})
