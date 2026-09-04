// THE DOSSIER RUN: sources in, claims persisted, nothing decided.
//
// The one place the three halves meet -- traversal, extraction, persistence --
// and the place where it would be easiest to quietly add a fourth. It does not
// compare claims, does not pick a value, does not draft anything, does not
// research, and writes no canonical case fact. Those are Priority 3 and the
// owner has named them individually; the absence of each is a property of this
// file that a reader can check by reading it.

import type Database from 'better-sqlite3'
import { extractPoolClaims } from './pool-claims.js'
import { recordClaims } from './claim-store.js'
import { dossierSources, documentText, type SourceText } from './dossier-traversal.js'
import type { StructuredClaim } from './claim-types.js'

/** Text for a Gmail source. Supplied by the caller because this module does no
 *  I/O; returning null means "not available", which is a normal outcome. */
export type GmailTextLoader = (
  sourceId: string, sourceType: 'GMAIL_MESSAGE' | 'GMAIL_THREAD',
) => SourceText | null

export interface DossierExtractionResult {
  caseId: string
  sourcesSeen: number
  /** Sources that yielded text and were read. */
  sourcesRead: number
  /** Sources with no text available: an image with no OCR, a Gmail body the
   *  caller could not fetch. Counted, never silent -- a run that read three of
   *  twenty sources and reported only its claims would look complete. */
  sourcesWithoutText: number
  claimsWritten: number
  claimsRefreshed: number
  /** Per-source failures, with the reason. An extraction that throws on one
   *  mail must not lose the other nineteen, and must not hide that it did. */
  failures: Array<{ sourceId: string; reason: string }>
}

/**
 * Read a whole dossier into claims.
 *
 * Idempotent by construction: `recordClaims` keys on the claim's identity, so a
 * second run over unchanged sources refreshes rows and writes none. That is
 * what makes this safe to schedule, and the result reports both numbers so
 * "nothing changed" is visible rather than assumed.
 */
export function extractDossierClaims(
  db: Database.Database,
  namespace: 'personal' | 'zst',
  rootCaseId: string,
  loadGmailText: GmailTextLoader,
  now: number,
): DossierExtractionResult {
  const sources = dossierSources(db, namespace, rootCaseId)
  const result: DossierExtractionResult = {
    caseId: rootCaseId, sourcesSeen: sources.length, sourcesRead: 0,
    sourcesWithoutText: 0, claimsWritten: 0, claimsRefreshed: 0, failures: [],
  }
  const all: StructuredClaim[] = []

  for (const s of sources) {
    let loaded: SourceText | null = null
    try {
      loaded = s.sourceType === 'DOCUMENT'
        ? documentText(db, s.sourceId)
        : s.sourceType === 'CASE' ? null : loadGmailText(s.sourceId, s.sourceType)
    } catch (e) {
      result.failures.push({
        sourceId: s.sourceId,
        reason: e instanceof Error ? e.message : String(e),
      })
      continue
    }
    if (!loaded) { result.sourcesWithoutText += 1; continue }

    result.sourcesRead += 1
    all.push(...extractPoolClaims({
      sourceId: s.sourceId,
      sourceType: s.sourceType,
      sourceTimestamp: loaded.timestamp,
      text: loaded.text,
      ...(loaded.from ? { from: loaded.from } : {}),
      ...(loaded.truncated ? { truncated: true } : {}),
    }))
  }

  const written = recordClaims(db, namespace, rootCaseId, all, now)
  result.claimsWritten = written.written
  result.claimsRefreshed = written.refreshed
  return result
}
