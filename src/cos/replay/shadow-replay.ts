// Clean Replay & Reconciliation Gate v1.0 — deterministic SHADOW replay.
//
// SAFETY: this module knows only the shadow Database handle passed by the caller.
// It has no Gmail writer, executor, approval or production DB import. The replay
// corpus is immutable input. Every thread touched in the anchor window is fully
// expanded from the corpus before projection.
//
// Stage 2H (Istvan, 2026-08-18): this module MUST NOT contain a content->type
// classifier. It used to carry a private `inferCaseType` regex, and that single
// function was what made the parity gap invisible: production gates extraction
// on the caseType decided at intake by the triaging agent, so a shadow that
// invents its own type fires the gate on a DIFFERENT set of threads and then
// reports the resulting silence as agreement. A caseType now enters this module
// exactly one way — a named production case lends it through a
// ProductionAuthorityOverlay — and everything derived from it is labelled
// CONDITIONAL_ON_PRODUCTION_TYPE. Without an overlay the triage-derived fields
// are absent, which is the honest value: NOT_REPLAYABLE.

import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { classifyScope } from '../scope-gate.js'
import { classifyActionability } from '../actionability.js'
import { extractTemporalClaims } from '../temporal-consistency-gate.js'
// The production operational projection, imported — not re-implemented. A second
// copy of this rule would be a second answer, and the parity report would then
// be measuring the copy.
import { projectZstOperationalIntake } from '../zst-operational-projector.js'
import type {
  ReplayCorpus, ReplayMessage, ReplayCaseProjection, ReplayTemporalProjection,
  ProductionAuthorityOverlay,
} from './types.js'

export interface ReplayRunSummary {
  runId: string
  anchorStart: number
  anchorEnd: number
  inputMessages: number
  touchedThreads: number
  replayedMessages: number
  projectedCases: number
  /** of the projected cases, the ones an overlay lent a type to */
  conditionalCases: number
  historicalOnlyCases: number
  temporalFacts: number
  scopeReviewCases: number
  orphanCases: number
  outcome: 'PASS' | 'FAIL'
  reasons: string[]
}

export interface ShadowReplayOptions {
  /** Production types lent per thread. Their presence is the ONLY thing that
   *  turns the operational projection on for a thread. */
  overlays?: readonly ProductionAuthorityOverlay[]
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex') }

/** Bumped when the replay_cases shape changes. A shadow DB written by an older
 *  build must fail loudly rather than take a NULL into a NOT NULL column, or
 *  worse, keep a guessed case_type from a previous shape and let it be read back
 *  as if this build had produced it. */
export const SHADOW_REPLAY_SCHEMA_VERSION = 2

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
      projection_authority TEXT NOT NULL,
      production_case_id TEXT,
      title TEXT,
      case_type TEXT,
      status TEXT,
      next_action TEXT,
      next_action_owner TEXT,
      waiting_on TEXT,
      due_at INTEGER,
      follow_up_at INTEGER,
      next_wake_at INTEGER,
      scope_needs_review INTEGER NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      latest_source_at INTEGER NOT NULL,
      actionability_class TEXT,
      actionability_valid INTEGER,
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
  // CREATE TABLE IF NOT EXISTS is a no-op against an older table, so the shape
  // is asserted AFTER the exec, not assumed by it.
  const cols = new Set((db.prepare(`PRAGMA table_info(replay_cases)`).all() as Array<{ name: string }>).map(r => r.name))
  for (const required of ['projection_authority', 'production_case_id']) {
    if (!cols.has(required)) {
      throw new Error(
        `SHADOW_REPLAY_SCHEMA_STALE: replay_cases predates schema v${SHADOW_REPLAY_SCHEMA_VERSION} `
        + `(missing ${required}). Recreate the shadow database; an old shadow row may still hold a `
        + `content-guessed case_type and must not be read back as this build's output.`)
    }
  }
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

function projectThread(
  messages: ReplayMessage[],
  overlay: ProductionAuthorityOverlay | null,
): { caseProjection: ReplayCaseProjection; temporal: ReplayTemporalProjection[] } {
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

  // No overlay: the triage verdict and everything downstream of it is absent.
  // Absent is the measurement. A default status here would be a guess wearing a
  // projection's clothes, and the reconciliation would compare it as if it meant
  // something.
  let projection: ReplayCaseProjection = {
    replayCaseId, domain, threadId: first.threadId,
    projectionAuthority: 'HISTORICAL_SOURCE_REPLAY',
    productionCaseId: null,
    title: null, caseType: null, status: null,
    nextAction: null, nextActionOwner: null, waitingOn: null,
    dueAt: null, followUpAt: null, nextWakeAt: null,
    scopeNeedsReview: scope.needsReview,
    sourceMessageIds: ordered.map(m => m.messageId), latestSourceAt: last.occurredAt,
  }

  if (overlay) {
    if (domain !== 'zst') {
      // The seam, named rather than papered over: `projectZstOperationalIntake`
      // is the only production operational projector in the tree. There is no
      // personal-domain equivalent to import, and writing one here would be the
      // shadow-specific reimplementation this rebuild exists to remove.
      throw new Error(
        `SEAM_BLOCKED thread ${first.threadId}: a production authority overlay was supplied for domain `
        + `'${domain}', but the only production operational projector is ZST `
        + `(projectZstOperationalIntake). Copying it into the replay would make the parity report measure `
        + `the copy.`)
    }
    const operational = projectZstOperationalIntake({
      caseType: overlay.caseType,
      direction: last.direction === 'SENT' ? 'OUTBOUND' : 'INBOUND',
      subject: last.subject,
      body: joined,
      from: last.from ?? '',
      to: last.to?.[0],
      occurredAt: last.occurredAt,
    })
    projection = {
      ...projection,
      projectionAuthority: 'CONDITIONAL_ON_PRODUCTION_TYPE',
      productionCaseId: overlay.productionCaseId,
      caseType: overlay.caseType,
      status: operational.status,
      nextAction: operational.nextAction,
      nextActionOwner: operational.nextActionOwner,
      waitingOn: operational.waitingOn,
      followUpAt: operational.followUpAt,
      // due_at and next_wake_at are not set by production intake either; the
      // deadline layer writes temporal facts, UNVERIFIED, and nothing here
      // promotes one to a binding scalar.
      dueAt: null, nextWakeAt: null,
      // title stays null: the overlay lends the TYPE. Production's title is the
      // other half of the same triage verdict, and no overlay lends it.
      title: null,
    }
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
  options: ShadowReplayOptions = {},
): ReplayRunSummary {
  ensureShadowReplaySchema(shadowDb)
  const overlayByThread = new Map<string, ProductionAuthorityOverlay>()
  for (const o of options.overlays ?? []) {
    const prior = overlayByThread.get(o.threadId)
    if (prior && (prior.caseType !== o.caseType || prior.productionCaseId !== o.productionCaseId)) {
      throw new Error(
        `CONFLICTING_OVERLAY thread ${o.threadId}: ${prior.productionCaseId}/${prior.caseType} vs `
        + `${o.productionCaseId}/${o.caseType}. Two production cases claiming one thread is a mapping `
        + `question, not a type to pick between.`)
    }
    overlayByThread.set(o.threadId, o)
  }

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
  let conditionalCases = 0

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
        const p = projectThread(messages, overlayByThread.get(threadId) ?? null)
        projections.push(p.caseProjection); temporal.push(...p.temporal)
        if (p.caseProjection.scopeNeedsReview) scopeReviewCases++
        const conditional = p.caseProjection.projectionAuthority === 'CONDITIONAL_ON_PRODUCTION_TYPE'
        if (conditional) conditionalCases++

        // Actionability judges an operational projection. A historical replay
        // produced none, so classifying it would report ORPHAN for every thread
        // in the corpus and turn a correct absence into a red run.
        const a = conditional
          ? classifyActionability({
            status: p.caseProjection.status ?? '', nextAction: p.caseProjection.nextAction,
            nextActionOwner: p.caseProjection.nextActionOwner, waitingOn: p.caseProjection.waitingOn,
            dueAt: p.caseProjection.dueAt, followUpAt: p.caseProjection.followUpAt, nextWakeAt: p.caseProjection.nextWakeAt,
          })
          : null
        if (a && (!a.valid || a.classification === 'ORPHAN')) orphanCases++
        shadowDb.prepare(`
          INSERT INTO replay_cases
            (replay_case_id, run_id, domain, thread_id, projection_authority, production_case_id,
             title, case_type, status,
             next_action, next_action_owner, waiting_on, due_at, follow_up_at, next_wake_at,
             scope_needs_review, source_message_ids_json, latest_source_at,
             actionability_class, actionability_valid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          p.caseProjection.replayCaseId, runId, p.caseProjection.domain, threadId,
          p.caseProjection.projectionAuthority, p.caseProjection.productionCaseId,
          p.caseProjection.title, p.caseProjection.caseType, p.caseProjection.status,
          p.caseProjection.nextAction, p.caseProjection.nextActionOwner, p.caseProjection.waitingOn,
          p.caseProjection.dueAt, p.caseProjection.followUpAt, p.caseProjection.nextWakeAt,
          p.caseProjection.scopeNeedsReview ? 1 : 0, JSON.stringify(p.caseProjection.sourceMessageIds),
          p.caseProjection.latestSourceAt, a ? a.classification : null, a ? (a.valid ? 1 : 0) : null,
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

    const summary = buildSummary()
    shadowDb.prepare(`INSERT INTO replay_runs (run_id, anchor_start, anchor_end, generated_at, outcome, summary_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, corpus.anchorStart, corpus.anchorEnd, corpus.generatedAt, summary.outcome, JSON.stringify(summary))
  })()

  function buildSummary(): ReplayRunSummary {
    return {
      runId, anchorStart: corpus.anchorStart, anchorEnd: corpus.anchorEnd,
      inputMessages: corpus.messages.length, touchedThreads: byThread.size,
      replayedMessages: replayed.length, projectedCases: projections.length,
      conditionalCases, historicalOnlyCases: projections.length - conditionalCases,
      temporalFacts: temporal.length, scopeReviewCases, orphanCases,
      outcome: reasons.length || orphanCases ? 'FAIL' : 'PASS', reasons,
    }
  }

  return buildSummary()
}

/** Read a run's projections back out of the shadow DB in the shape the
 *  reconciliation consumes. Lives here so a caller cannot rebuild the row->object
 *  mapping by hand and quietly drop `projectionAuthority` — which is the field
 *  that decides whether a conditional comparison may be attempted at all. */
export function readReplayProjections(db: Database.Database, runId: string): ReplayCaseProjection[] {
  const rows = db.prepare(`SELECT * FROM replay_cases WHERE run_id=? ORDER BY thread_id`).all(runId) as Array<Record<string, unknown>>
  return rows.map(x => ({
    replayCaseId: String(x.replay_case_id),
    domain: x.domain as ReplayCaseProjection['domain'],
    threadId: String(x.thread_id),
    projectionAuthority: x.projection_authority as ReplayCaseProjection['projectionAuthority'],
    productionCaseId: x.production_case_id == null ? null : String(x.production_case_id),
    title: x.title == null ? null : String(x.title),
    caseType: x.case_type == null ? null : String(x.case_type),
    status: x.status == null ? null : String(x.status),
    nextAction: x.next_action == null ? null : String(x.next_action),
    nextActionOwner: x.next_action_owner == null ? null : String(x.next_action_owner),
    waitingOn: x.waiting_on == null ? null : String(x.waiting_on),
    dueAt: x.due_at == null ? null : Number(x.due_at),
    followUpAt: x.follow_up_at == null ? null : Number(x.follow_up_at),
    nextWakeAt: x.next_wake_at == null ? null : Number(x.next_wake_at),
    scopeNeedsReview: !!x.scope_needs_review,
    sourceMessageIds: JSON.parse(String(x.source_message_ids_json)) as string[],
    latestSourceAt: Number(x.latest_source_at),
  }))
}
