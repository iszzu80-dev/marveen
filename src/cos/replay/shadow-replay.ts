// Clean Replay & Reconciliation Gate v1.0 — deterministic SHADOW replay.
//
// SAFETY: this module knows only the shadow Database handle passed by the caller.
// It has no Gmail writer, executor, approval or production DB import. The replay
// corpus is immutable input. Every thread touched in the anchor window is fully
// expanded from the corpus before projection.

import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { classifyScope } from '../scope-gate.js'
import { classifyActionability } from '../actionability.js'
import { extractTemporalClaims } from '../temporal-consistency-gate.js'
import type {
  ReplayCorpus, ReplayMessage, ReplayCaseProjection, ReplayTemporalProjection,
} from './types.js'

export interface ReplayRunSummary {
  runId: string
  anchorStart: number
  anchorEnd: number
  inputMessages: number
  touchedThreads: number
  replayedMessages: number
  projectedCases: number
  temporalFacts: number
  scopeReviewCases: number
  orphanCases: number
  outcome: 'PASS' | 'FAIL'
  reasons: string[]
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex') }

export function ensureShadowReplaySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_runs (
      run_id TEXT PRIMARY KEY,
      anchor_start INTEGER NOT NULL,
      anchor_end INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replay_messages (
      message_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      source_account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      attachment_manifest_hash TEXT NOT NULL,
      PRIMARY KEY(run_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_replay_messages_thread ON replay_messages(run_id, thread_id, occurred_at);
    CREATE TABLE IF NOT EXISTS replay_cases (
      replay_case_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      case_type TEXT NOT NULL,
      status TEXT NOT NULL,
      next_action TEXT,
      next_action_owner TEXT,
      waiting_on TEXT,
      due_at INTEGER,
      follow_up_at INTEGER,
      next_wake_at INTEGER,
      scope_needs_review INTEGER NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      latest_source_at INTEGER NOT NULL,
      actionability_class TEXT NOT NULL,
      actionability_valid INTEGER NOT NULL,
      PRIMARY KEY(run_id, replay_case_id),
      UNIQUE(run_id, domain, thread_id)
    );
    CREATE TABLE IF NOT EXISTS replay_temporal_facts (
      replay_fact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      replay_case_id TEXT NOT NULL,
      fact_kind TEXT NOT NULL,
      occurs_at INTEGER NOT NULL,
      raw_text TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'UNVERIFIED',
      UNIQUE(run_id, replay_case_id, fact_kind, occurs_at, source_message_id)
    );
  `)
}

/** Return all messages for threads that had at least one event in the anchor window. */
export function expandTouchedThreads(corpus: ReplayCorpus): ReplayMessage[] {
  if (corpus.anchorEnd <= corpus.anchorStart) throw new Error('replay anchorEnd must be after anchorStart')
  const touched = new Set(corpus.messages
    .filter(m => m.occurredAt >= corpus.anchorStart && m.occurredAt < corpus.anchorEnd)
    .map(m => m.threadId))
  return corpus.messages
    .filter(m => touched.has(m.threadId))
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt || a.messageId.localeCompare(b.messageId))
}

function inferCaseType(text: string): string {
  const t = text.toLowerCase()
  if (/invoice|számla|szamla|fizet/.test(t)) return 'INVOICE_INCOMING'
  if (/contract|szerződés|szerzodes|felmond|üzletrész|uzletresz/.test(t)) return 'CONTRACT'
  if (/booking|foglal|repül|repulo|hotel|autóbér|autober|hertz|sixt/.test(t)) return 'TRAVEL'
  if (/kert|medence|javít|javit|szerelő|szerelo|garancia/.test(t)) return 'HOME_REPAIR'
  if (/könyvel|konyvel|adó|ado|nav/.test(t)) return 'ACCOUNTING'
  return 'ADMIN'
}

function projectThread(messages: ReplayMessage[]): { caseProjection: ReplayCaseProjection; temporal: ReplayTemporalProjection[] } {
  if (!messages.length) throw new Error('cannot project empty thread')
  const ordered = messages.slice().sort((a, b) => a.occurredAt - b.occurredAt || a.messageId.localeCompare(b.messageId))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const joined = ordered.map(m => `${m.subject}\n${m.bodyText}`).join('\n---\n')

  // Automatic domain is fixed by connector identity, never by content.
  const scope = classifyScope({ text: joined, accountId: first.sourceAccountId, corporateAccounts: ['zst'] })
  if (!scope.target) throw new Error(`security-blocked thread ${first.threadId}`)
  const domain = scope.target
  const replayCaseId = `replay:${domain}:${sha(`${domain}:${first.threadId}`).slice(0, 24)}`

  let status: string
  let nextAction: string | null
  let nextActionOwner: string | null
  let waitingOn: string | null
  let followUpAt: number | null = null
  if (last.direction === 'SENT') {
    status = 'WAITING_EXTERNAL'
    nextAction = 'Check for reply; evaluate response and decide the next step'
    nextActionOwner = 'SYSTEM'
    waitingOn = last.to?.[0] ?? last.from ?? 'EXTERNAL_OTHER'
    followUpAt = last.occurredAt + 3 * 86400
  } else {
    status = 'READY'
    nextAction = 'Review latest inbound source and decide or execute the next concrete step'
    nextActionOwner = 'ISTVAN'
    waitingOn = null
  }

  const projection: ReplayCaseProjection = {
    replayCaseId, domain, threadId: first.threadId,
    title: last.subject || first.subject || '(no subject)',
    caseType: inferCaseType(joined), status,
    nextAction, nextActionOwner, waitingOn,
    dueAt: null, followUpAt, nextWakeAt: null,
    scopeNeedsReview: scope.needsReview,
    sourceMessageIds: ordered.map(m => m.messageId), latestSourceAt: last.occurredAt,
  }

  const temporal: ReplayTemporalProjection[] = []
  for (const m of ordered) {
    for (const c of extractTemporalClaims(`${m.subject}\n${m.bodyText}`, `gmail:${m.messageId}`)) {
      temporal.push({ replayCaseId, kind: c.kind, occursAt: c.occursAt, raw: c.raw, sourceMessageId: m.messageId, verification: 'UNVERIFIED' })
    }
  }
  return { caseProjection: projection, temporal }
}

export function runShadowReplay(
  shadowDb: Database.Database,
  corpus: ReplayCorpus,
  runId: string = randomUUID(),
): ReplayRunSummary {
  ensureShadowReplaySchema(shadowDb)
  const replayed = expandTouchedThreads(corpus)
  const byThread = new Map<string, ReplayMessage[]>()
  for (const m of replayed) {
    const l = byThread.get(m.threadId) ?? []; l.push(m); byThread.set(m.threadId, l)
  }

  const projections: ReplayCaseProjection[] = []
  const temporal: ReplayTemporalProjection[] = []
  const reasons: string[] = []
  let scopeReviewCases = 0
  let orphanCases = 0

  shadowDb.transaction(() => {
    for (const m of replayed) {
      const attachmentManifest = JSON.stringify((m.attachments ?? []).map(a => ({ filename: a.filename, mimeType: a.mimeType ?? null, sha256: a.sha256 ?? null, sizeBytes: a.sizeBytes ?? null })))
      shadowDb.prepare(`
        INSERT OR IGNORE INTO replay_messages
          (message_id, run_id, source_account_id, thread_id, direction, occurred_at, subject, body_hash, attachment_manifest_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(m.messageId, runId, m.sourceAccountId, m.threadId, m.direction, m.occurredAt, m.subject, sha(m.bodyText), sha(attachmentManifest))
    }

    for (const [threadId, messages] of byThread) {
      try {
        const p = projectThread(messages)
        projections.push(p.caseProjection); temporal.push(...p.temporal)
        if (p.caseProjection.scopeNeedsReview) scopeReviewCases++
        const a = classifyActionability({
          status: p.caseProjection.status, nextAction: p.caseProjection.nextAction,
          nextActionOwner: p.caseProjection.nextActionOwner, waitingOn: p.caseProjection.waitingOn,
          dueAt: p.caseProjection.dueAt, followUpAt: p.caseProjection.followUpAt, nextWakeAt: p.caseProjection.nextWakeAt,
        })
        if (!a.valid || a.classification === 'ORPHAN') orphanCases++
        shadowDb.prepare(`
          INSERT INTO replay_cases
            (replay_case_id, run_id, domain, thread_id, title, case_type, status,
             next_action, next_action_owner, waiting_on, due_at, follow_up_at, next_wake_at,
             scope_needs_review, source_message_ids_json, latest_source_at,
             actionability_class, actionability_valid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          p.caseProjection.replayCaseId, runId, p.caseProjection.domain, threadId,
          p.caseProjection.title, p.caseProjection.caseType, p.caseProjection.status,
          p.caseProjection.nextAction, p.caseProjection.nextActionOwner, p.caseProjection.waitingOn,
          p.caseProjection.dueAt, p.caseProjection.followUpAt, p.caseProjection.nextWakeAt,
          p.caseProjection.scopeNeedsReview ? 1 : 0, JSON.stringify(p.caseProjection.sourceMessageIds),
          p.caseProjection.latestSourceAt, a.classification, a.valid ? 1 : 0,
        )
        for (const f of p.temporal) {
          const factId = `rf:${sha(`${runId}:${f.replayCaseId}:${f.kind}:${f.occursAt}:${f.sourceMessageId}`).slice(0, 28)}`
          shadowDb.prepare(`
            INSERT OR IGNORE INTO replay_temporal_facts
              (replay_fact_id, run_id, replay_case_id, fact_kind, occurs_at, raw_text, source_message_id, verification)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(factId, runId, f.replayCaseId, f.kind, f.occursAt, f.raw, f.sourceMessageId, f.verification)
        }
      } catch (err) {
        reasons.push(`thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const summary: ReplayRunSummary = {
      runId, anchorStart: corpus.anchorStart, anchorEnd: corpus.anchorEnd,
      inputMessages: corpus.messages.length, touchedThreads: byThread.size,
      replayedMessages: replayed.length, projectedCases: projections.length,
      temporalFacts: temporal.length, scopeReviewCases, orphanCases,
      outcome: reasons.length || orphanCases ? 'FAIL' : 'PASS', reasons,
    }
    shadowDb.prepare(`INSERT INTO replay_runs (run_id, anchor_start, anchor_end, generated_at, outcome, summary_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, corpus.anchorStart, corpus.anchorEnd, corpus.generatedAt, summary.outcome, JSON.stringify(summary))
  })()

  return {
    runId, anchorStart: corpus.anchorStart, anchorEnd: corpus.anchorEnd,
    inputMessages: corpus.messages.length, touchedThreads: byThread.size,
    replayedMessages: replayed.length, projectedCases: projections.length,
    temporalFacts: temporal.length, scopeReviewCases, orphanCases,
    outcome: reasons.length || orphanCases ? 'FAIL' : 'PASS', reasons,
  }
}
