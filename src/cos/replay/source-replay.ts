// Stage 2H-A — HISTORICAL SOURCE REPLAY (Istvan, 2026-08-18).
//
// This surface does not reconstruct cases. It proves only what the immutable
// corpus can actually derive: connector identity -> domain, message and thread
// identity, provider time, direction, and the body / attachment-manifest
// digests. Everything downstream of the triage verdict stays NOT_REPLAYABLE, and
// the absence of a production case on a thread is NOT a mismatch — 2215 of the
// 2280 threads have no case, and that is what the corpus looks like, not a defect.
//
// The one field production also holds and the corpus can genuinely re-derive is
// the DOMAIN: it is fixed by connector identity, never by content. That is the
// comparison this surface makes.

import { createHash } from 'node:crypto'
import { classifyScope } from '../scope-gate.js'
import type { CosDomain } from '../temporal-facts.js'
import type { ProductionCaseSnapshot, ReplayCorpus, ReplayMessage } from './types.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Exactly the facts the corpus can derive, and nothing else. */
export interface SourceDerivedRecord {
  messageId: string
  threadId: string
  domain: CosDomain
  sourceAccountId: string
  occurredAt: number
  direction: 'INBOUND' | 'SENT'
  bodyDigest: string
  attachmentManifestDigest: string
}

export type CutoffAlignment =
  | 'WITHIN_CORPUS_CUTOFF'
  | 'POST_CUTOFF_PRODUCTION_STATE'
  | 'CUTOFF_ALIGNMENT_UNKNOWN'

export interface SourceReplayFinding {
  kind: 'DOMAIN_MISMATCH' | 'UNDERIVABLE_SOURCE_FACT' | 'SECURITY_BLOCKED_BY_PRODUCTION_GATE' | 'CROSS_DOMAIN_MOVE_EXCLUDED'
  threadId: string | null
  messageId: string | null
  productionCaseId: string | null
  detail: string
}

export interface SourceReplayReport {
  corpusManifestHash: string
  anchorStart: number
  anchorEnd: number
  productionSnapshotCapturedAt: number
  inputMessages: number
  threadCount: number
  /** the deterministic digest of every source-derived record */
  sourceRecordDigest: string
  domainComparisons: {
    /** threads a production case claims AND the corpus contains */
    eligible: number
    compared: number
    matched: number
    mismatched: number
    /** production rows whose state is newer than the corpus cutoff */
    postCutoff: number
    /** production cases whose namespace was deliberately moved after intake */
    crossDomainMoveExcluded: number
  }
  /** threads with no production case at all: coverage, never a mismatch */
  threadsWithoutProductionCase: number
  /** messages the production scope gate deliberately refused. A demonstrated
   *  fail-closed verdict is a RESULT, not an underivable fact -- counting it as
   *  UNKNOWN would report the gate working as a hole in the corpus. */
  securityBlocked: number
  notReplayableFields: string[]
  unknown: number
  findings: SourceReplayFinding[]
  outcome: 'PASS' | 'FAIL'
}

/** Hash of the corpus as an input: identity, time, direction and digests of every
 *  message, in a stable order. Two runs quoting different manifest hashes were
 *  not replaying the same corpus, whatever else they agree on. */
export function corpusManifestHash(corpus: ReplayCorpus): string {
  const rows = corpus.messages
    .map(m => [
      m.sourceAccountId, m.messageId, m.threadId, String(m.occurredAt), m.direction,
      sha(m.bodyText ?? ''),
      sha(JSON.stringify((m.attachments ?? []).map(a => [a.filename, a.mimeType ?? null, a.sha256 ?? null, a.sizeBytes ?? null]))),
    ].join('|'))
    .sort()
  return sha(`${corpus.anchorStart}|${corpus.anchorEnd}|${rows.length}\n${rows.join('\n')}`)
}

function attachmentManifestDigest(m: ReplayMessage): string {
  return sha(JSON.stringify((m.attachments ?? []).map(a => ({
    filename: a.filename, mimeType: a.mimeType ?? null, sha256: a.sha256 ?? null, sizeBytes: a.sizeBytes ?? null,
  }))))
}

/** Stage 2H-B: decide, per production row, whether its state can be aligned with
 *  the corpus cutoff at all. An undecidable row STOPS the run; quietly filtering
 *  it would turn an unknown into a pass. */
export function cutoffAlignment(
  row: { createdAt?: number | null; updatedAt?: number | null },
  anchorEnd: number,
): CutoffAlignment {
  const created = row.createdAt ?? null
  const updated = row.updatedAt ?? null
  if (created == null && updated == null) return 'CUTOFF_ALIGNMENT_UNKNOWN'
  const newest = Math.max(created ?? 0, updated ?? 0)
  if (newest <= 0) return 'CUTOFF_ALIGNMENT_UNKNOWN'
  return newest > anchorEnd ? 'POST_CUTOFF_PRODUCTION_STATE' : 'WITHIN_CORPUS_CUTOFF'
}

export interface SourceReplayInput {
  corpus: ReplayCorpus
  productionCases: readonly ProductionCaseSnapshot[]
  productionSnapshotCapturedAt: number
  /** per production caseId, the timestamps used for cutoff alignment */
  caseTimestamps?: Readonly<Record<string, { createdAt?: number | null; updatedAt?: number | null }>>
  /** cases whose namespace was changed by an explicit move, with the ledger
   *  evidence that says so. Supplied, never inferred from an identifier. */
  crossDomainMoves?: ReadonlyArray<{ caseId: string; evidence: string }>
}

export function runHistoricalSourceReplay(input: SourceReplayInput): SourceReplayReport {
  const { corpus } = input
  const findings: SourceReplayFinding[] = []
  const records: SourceDerivedRecord[] = []
  let unknown = 0
  let securityBlocked = 0
  const movedById = new Map((input.crossDomainMoves ?? []).map(m => [m.caseId, m.evidence]))

  for (const m of corpus.messages) {
    const scope = classifyScope({
      text: `${m.subject ?? ''}\n${m.bodyText ?? ''}`,
      accountId: m.sourceAccountId, corporateAccounts: ['zst'],
    })
    if (!scope.target) {
      // The gate refused, on purpose. That is an outcome the replay reproduced,
      // not a fact it failed to derive.
      securityBlocked += 1
      findings.push({
        kind: 'SECURITY_BLOCKED_BY_PRODUCTION_GATE', threadId: m.threadId ?? null, messageId: m.messageId ?? null,
        productionCaseId: null, detail: 'the production scope gate fail-closed on this message',
      })
      continue
    }
    if (!Number.isFinite(m.occurredAt) || !m.messageId || !m.threadId) {
      unknown += 1
      findings.push({
        kind: 'UNDERIVABLE_SOURCE_FACT', threadId: m.threadId ?? null, messageId: m.messageId ?? null,
        productionCaseId: null, detail: 'identity or provider time is missing',
      })
      continue
    }
    records.push({
      messageId: m.messageId, threadId: m.threadId, domain: scope.target,
      sourceAccountId: m.sourceAccountId, occurredAt: m.occurredAt, direction: m.direction,
      bodyDigest: sha(m.bodyText ?? ''), attachmentManifestDigest: attachmentManifestDigest(m),
    })
  }

  const domainByThread = new Map<string, CosDomain>()
  for (const r of records) domainByThread.set(r.threadId, r.domain)

  let eligible = 0, compared = 0, matched = 0, mismatched = 0, postCutoff = 0, crossDomainMoveExcluded = 0
  const claimedThreads = new Set<string>()
  for (const c of input.productionCases) {
    for (const threadId of c.threadIds) {
      if (!domainByThread.has(threadId)) continue
      claimedThreads.add(threadId)
      eligible += 1
      const align = cutoffAlignment(input.caseTimestamps?.[c.caseId] ?? {}, corpus.anchorEnd)
      if (align === 'CUTOFF_ALIGNMENT_UNKNOWN') {
        throw new Error(
          `CUTOFF_ALIGNMENT_UNKNOWN: production case ${c.caseId} carries no usable created_at/updated_at, so its `
          + 'state cannot be aligned with the corpus cutoff. Refusing to filter it silently.')
      }
      if (align === 'POST_CUTOFF_PRODUCTION_STATE') { postCutoff += 1; continue }
      const moveEvidence = movedById.get(c.caseId)
      if (moveEvidence) {
        crossDomainMoveExcluded += 1
        findings.push({
          kind: 'CROSS_DOMAIN_MOVE_EXCLUDED', threadId, messageId: null, productionCaseId: c.caseId,
          detail: `the case was deliberately moved between namespaces; connector identity and post-move domain are `
            + `different things. Ledger evidence: ${moveEvidence}`,
        })
        continue
      }
      compared += 1
      const replayDomain = domainByThread.get(threadId)!
      if (replayDomain === c.domain) matched += 1
      else {
        mismatched += 1
        findings.push({
          kind: 'DOMAIN_MISMATCH', threadId, messageId: null, productionCaseId: c.caseId,
          detail: `connector identity derives '${replayDomain}', production case holds '${c.domain}'`,
        })
      }
    }
  }

  // Thread count is a CORPUS fact. Deriving it from the records would have made
  // a gate refusal look like a thread that does not exist.
  const threadIds = new Set(corpus.messages.map(m => m.threadId))
  const projection = records
    .map(r => [r.messageId, r.threadId, r.domain, r.sourceAccountId, String(r.occurredAt), r.direction, r.bodyDigest, r.attachmentManifestDigest].join('|'))
    .sort()

  return {
    corpusManifestHash: corpusManifestHash(corpus),
    anchorStart: corpus.anchorStart,
    anchorEnd: corpus.anchorEnd,
    productionSnapshotCapturedAt: input.productionSnapshotCapturedAt,
    inputMessages: corpus.messages.length,
    threadCount: threadIds.size,
    sourceRecordDigest: sha(projection.join('\n')),
    domainComparisons: { eligible, compared, matched, mismatched, postCutoff, crossDomainMoveExcluded },
    threadsWithoutProductionCase: threadIds.size - claimedThreads.size,
    securityBlocked,
    notReplayableFields: ['caseType', 'title', 'actionable', 'priority', 'workspace', 'declaredSensitivity'],
    unknown,
    findings,
    outcome: unknown === 0 && mismatched === 0 ? 'PASS' : 'FAIL',
  }
}
