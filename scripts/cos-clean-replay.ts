#!/usr/bin/env npx tsx
// Clean Replay v1.0 operator CLI.
// Writes ONLY the explicitly supplied shadow SQLite file and report file.
// There is intentionally no --apply, --prod-db or outbound option.

import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runShadowReplay } from '../src/cos/replay/shadow-replay.js'
import { reconcileReplay } from '../src/cos/replay/reconcile.js'
import { buildZstMigrationBatches, buildZstMigrationCandidates } from '../src/cos/replay/zst-migration-plan.js'
import type { ProductionCaseSnapshot, ReplayCaseProjection, ReplayCorpus, ZstLegacyCaseInput } from '../src/cos/replay/types.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function required(name: string): string {
  const v = arg(name)
  if (!v) throw new Error(`missing required ${name}`)
  return resolve(v)
}
function json<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }

const sourcePath = required('--source')
const shadowPath = required('--shadow')
const reportPath = required('--report')
const prodSnapshotPath = arg('--production-snapshot')
const zstLegacyPath = arg('--zst-legacy-snapshot')

if (shadowPath === sourcePath || shadowPath === prodSnapshotPath || shadowPath === zstLegacyPath) {
  throw new Error('shadow path must be a distinct output; refusing to overwrite an input')
}

const corpus = json<ReplayCorpus>(sourcePath)
const shadow = new Database(shadowPath)
try {
  shadow.pragma('journal_mode = WAL')
  const replay = runShadowReplay(shadow, corpus)

  const rows = shadow.prepare(`SELECT * FROM replay_cases WHERE run_id=? ORDER BY thread_id`).all(replay.runId) as Array<Record<string, unknown>>
  const projections: ReplayCaseProjection[] = rows.map(r => ({
    replayCaseId: String(r.replay_case_id), domain: r.domain as 'personal' | 'zst', threadId: String(r.thread_id),
    title: String(r.title), caseType: String(r.case_type), status: String(r.status),
    nextAction: r.next_action as string | null, nextActionOwner: r.next_action_owner as string | null,
    waitingOn: r.waiting_on as string | null, dueAt: r.due_at as number | null,
    followUpAt: r.follow_up_at as number | null, nextWakeAt: r.next_wake_at as number | null,
    scopeNeedsReview: Number(r.scope_needs_review) === 1,
    sourceMessageIds: JSON.parse(String(r.source_message_ids_json)) as string[], latestSourceAt: Number(r.latest_source_at),
  }))

  const reconciliation = prodSnapshotPath
    ? reconcileReplay(replay.runId, projections, json<ProductionCaseSnapshot[]>(resolve(prodSnapshotPath)))
    : null

  const zstMigration = zstLegacyPath ? (() => {
    const candidates = buildZstMigrationCandidates(json<ZstLegacyCaseInput[]>(resolve(zstLegacyPath)))
    return { candidates, batches: buildZstMigrationBatches(candidates) }
  })() : null

  const report = {
    generatedAt: Math.floor(Date.now() / 1000),
    safety: {
      shadowOnly: true, productionWrites: false, externalWrites: false,
      autoApplyAllowed: false, note: 'All repairs and migration proposals require explicit review.',
    },
    replay, reconciliation, zstMigration,
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (replay.outcome !== 'PASS' || (reconciliation && (reconciliation.summary.p0 > 0 || reconciliation.summary.p1 > 0))) process.exitCode = 2
} finally {
  shadow.close()
}
