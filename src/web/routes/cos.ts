// LOCAL-FORK: cos seam (keep on rebase). Read-only Mission Control API for the
// Personal Chief of Staff (COS) case store. Serves the "Ma" (today) and
// "Ügyek" (all active) views from personal_cases. Read-only by design: this
// route never mutates a case — writes go through the domain-command layer
// (src/cos/case-store.ts), not the dashboard.
//
// Auth is centralized in src/web.ts (requiresAuth gates all /api/*), so every
// /api/cos/* path here is already Bearer-protected; no auth code needed.

import { json, readBody } from '../http-helpers.js'
import { getDb } from '../../db.js'
import { listActiveCases, listTodayCases } from '../../cos/case-store.js'
import { listActiveZstCases, listTodayZstCases } from '../../cos/zst-case-store.js'
import { dueZstItems } from '../../cos/zst-watch.js'
import { ingestTriagedEmail, type TriagedEmail } from '../../cos/triage-bridge.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../../cos/zst-intake.js'
import { validateSkillMd, validateSkillPermissions } from '../../cos/skill-permission-validator.js'
import { getMissionControlProgressionView, runProgressionCycle } from '../../cos/progression-pipeline.js'
import { storeDocument, documentsForCase, readDocumentBytes } from '../../cos/cos-documents.js'
import { evaluateOutputFloors, breachedFloors } from '../../cos/output-floor.js'
import { runDailyReconcile } from '../../cos/reconcile.js'
import { APP_TZ } from '../../config.js'
import type { RouteContext } from './types.js'

// End of "today" in the app timezone, as a Unix-seconds horizon. Computed from
// the wall clock in APP_TZ so a case due later today is included but tomorrow's
// is not. Falls back to now+24h if the timezone math is unavailable.
export function endOfTodaySec(now: Date): number {
  try {
    // Seconds elapsed into the current local day (APP_TZ), then seconds left
    // until local midnight. No offset arithmetic, no DST edge cases.
    const [h, m, s] = new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(now).split(':').map(Number)
    const secsIntoDay = h * 3600 + m * 60 + s
    return Math.floor(now.getTime() / 1000) + (86400 - secsIntoDay) - 1 // local 23:59:59
  } catch {
    return Math.floor(now.getTime() / 1000) + 86400
  }
}

// Deep-compare two JSON strings by parsing and re-serializing — normalizes
// whitespace / key ordering so drift in serialization doesn't look like a
// changed question.
function deepJsonEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
  } catch {
    return a === b
  }
}

export async function tryHandleCos(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // The email-triage → COS intake bridge. The triage heartbeat POSTs a real
  // candidate here (with its verdict) to open/update a case. Idempotent per
  // (account, message). This is the ONLY /api/cos/* write path — the mutation
  // is confined to the intake domain logic.
  if (path === '/api/cos/intake' && method === 'POST') {
    let input: TriagedEmail
    try { input = JSON.parse((await readBody(req)).toString()) as TriagedEmail }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!input?.accountId || !input?.messageId || !input?.subject) {
      json(res, { error: 'accountId, messageId, subject required' }, 400); return true
    }
    // Route by account (connector identity = scope boundary): the ZST company
    // mailbox becomes a zst_case; everything else a personal_case. The two
    // namespaces never mix, at the source.
    const now = Math.floor(Date.now() / 1000)
    const result = input.accountId === 'zst'
      ? ingestTriagedZstEmail(getDb(), input as unknown as ZstTriagedEmail, now)
      : ingestTriagedEmail(getDb(), input, now)
    json(res, result)
    return true
  }

  // Document inlet (P2): the single HTTP door into the unified document store, used
  // by the email-triage heartbeat (Python) and later the Telegram flow to hand a
  // downloaded attachment/image to storeDocument. Accepts base64 content + metadata;
  // the store content-addresses it locally and links it to the case. Read/store only
  // — never sends. Sensitivity-first: absent sensitivity stays UNKNOWN (not shareable).
  if (path === '/api/cos/documents' && method === 'POST') {
    let b: {
      namespace?: string; caseId?: string; source?: string; sourceRef?: string
      filename?: string; mimeType?: string; contentBase64?: string; sensitivity?: string
      docKind?: string; externalShareAllowed?: boolean
    }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (b.namespace !== 'personal' && b.namespace !== 'zst') {
      json(res, { error: "namespace must be 'personal' or 'zst'" }, 400); return true
    }
    if (!b.source || !b.contentBase64) {
      json(res, { error: 'source and contentBase64 required' }, 400); return true
    }
    let bytes: Buffer
    try { bytes = Buffer.from(b.contentBase64, 'base64') }
    catch { json(res, { error: 'contentBase64 not decodable' }, 400); return true }
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
      json(res, { error: 'content empty or over 25MB' }, 400); return true
    }
    try {
      const r = storeDocument(getDb(), {
        namespace: b.namespace, caseId: b.caseId ?? null, source: b.source as never,
        sourceRef: b.sourceRef, filename: b.filename, mimeType: b.mimeType, bytes,
        sensitivity: b.sensitivity, docKind: b.docKind, externalShareAllowed: b.externalShareAllowed,
      })
      json(res, r)
    } catch (e) {
      json(res, { error: String((e as Error).message) }, 400)
    }
    return true
  }

  // #5c: validate a skill's declared permissions before it is written/run. Accepts
  // either a raw SKILL.md (`{skillMd}`) or a parsed decl (`{permissions, sensitiveApproved}`).
  if (path === '/api/cos/skill-validate' && method === 'POST') {
    let input: { skillMd?: string; permissions?: string[]; sensitiveApproved?: boolean }
    try { input = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    const result = typeof input?.skillMd === 'string'
      ? validateSkillMd(input.skillMd)
      : validateSkillPermissions({ permissions: input?.permissions, sensitiveApproved: input?.sensitiveApproved })
    json(res, result)
    return true
  }

  if (path === '/api/cos/cases' && method === 'GET') {
    const cases = listActiveCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  // ZST Corporate Case Engine read views (Slice 0). Read-only, separate
  // namespace (zst_cases) — mirrors the personal cases/today endpoints. Writes
  // go through src/cos/zst-case-store.ts, never the dashboard.
  if (path === '/api/cos/zst-cases' && method === 'GET') {
    const cases = listActiveZstCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/zst-today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayZstCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  // ZST proactive due-item runner (contracts/licenses/obligations/opportunities).
  if (path === '/api/cos/zst-due' && method === 'GET') {
    json(res, dueZstItems(getDb()))
    return true
  }

  // ZST business-surface counts (invoices, contracts, vendors, licenses, etc.).
  if (path === '/api/cos/zst-business' && method === 'GET') {
    const db = getDb()
    const c = (t: string) => scalar(db, `SELECT COUNT(*) n FROM ${t}`)
    json(res, {
      invoices: c('zst_invoices'), accounting_packages: c('zst_accounting_packages'),
      bank_transactions: c('zst_bank_transactions'), contracts: c('zst_contracts'),
      obligations: c('zst_obligations'), vendors: c('zst_vendors'), licenses: c('zst_licenses'),
      partners: c('zst_partners'), opportunities: c('zst_opportunities'), products: c('zst_products'),
      procurement_radar: c('zst_procurement_radar_items'), escalations: c('zst_product_escalations'),
      outbound: c('zst_outbound_ledger'),
    })
    return true
  }

  if (path === '/api/cos/outbound' && method === 'GET') {
    const outbound = listOutbound(getDb())
    json(res, { outbound, count: outbound.length })
    return true
  }

  if (path === '/api/cos/campaigns' && method === 'GET') {
    const campaigns = listCampaignsSummary(getDb())
    json(res, { campaigns, count: campaigns.length })
    return true
  }

  if (path === '/api/cos/radar' && method === 'GET') {
    const radar = listRadarSummary(getDb())
    json(res, { radar, count: radar.length })
    return true
  }

  if (path === '/api/cos/monitoring' && method === 'GET') {
    json(res, listMonitoring(getDb()))
    return true
  }

  if (path === '/api/cos/analytics' && method === 'GET') {
    json(res, listAnalytics(getDb()))
    return true
  }

  // Progression layer Mission Control view (card 52250c7f). Read-only — the
  // progression engine writes state; this endpoint only returns it for the UI.
  if (path === '/api/cos/progression' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const domain = (q.get('domain') || 'personal') as 'personal' | 'zst'
    if (domain !== 'personal' && domain !== 'zst') {
      json(res, { error: 'domain must be personal or zst' }, 400); return true
    }
    const view = getMissionControlProgressionView(getDb(), domain)
    json(res, view)
    return true
  }

  // Owner action (card 9193eedd): the control writes an event, not state.
  // Inserts into *_case_events, then runs ONE progression cycle so the UI
  // gets instant feedback instead of a 5-minute wait. Idempotent per key.
  // POST /api/cos/cases/:domain/:caseId/owner-action
  if (method === 'POST' && path.startsWith('/api/cos/cases/') && path.endsWith('/owner-action')) {
    const inner = path.slice('/api/cos/cases/'.length, -'/owner-action'.length)
    const slash = inner.indexOf('/')
    if (slash < 0) { json(res, { error: 'invalid path' }, 400); return true }
    const domain = inner.slice(0, slash) as 'personal' | 'zst'
    const caseId = inner.slice(slash + 1)
    if (domain !== 'personal' && domain !== 'zst') {
      json(res, { error: 'domain must be personal or zst' }, 400); return true
    }
    if (!caseId) { json(res, { error: 'caseId required' }, 400); return true }

    let body: {
      eventType?: string; choice?: string; text?: string
      sourceReference?: string; caseVersion?: number; idempotencyKey?: string
      externalEffectAck?: boolean; decision?: string; nextBestAction?: string | null
    }
    try { body = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }

    const {
      eventType, choice, text, sourceReference, caseVersion, idempotencyKey,
      externalEffectAck,
    } = body
    if (!eventType || !sourceReference || caseVersion == null || !idempotencyKey) {
      json(res, { error: 'eventType, sourceReference, caseVersion, idempotencyKey required' }, 400)
      return true
    }
    const validTypes = ['OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION']
    if (!validTypes.includes(eventType)) {
      json(res, { error: `eventType must be one of ${validTypes.join(', ')}` }, 400); return true
    }

    const db = getDb()
    const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
    const now = Math.floor(Date.now() / 1000)

    // Idempotency guard: same key → no second event, return first result.
    const existing = db.prepare(
      `SELECT event_id FROM ${eventsTable}
       WHERE case_id = ? AND json_extract(payload, '$.idempotency_key') = ?`
    ).get(caseId, idempotencyKey) as { event_id: number } | undefined
    if (existing) {
      json(res, { ok: true, eventId: existing.event_id, duplicate: true })
      return true
    }

    // Question-staleness guard (card 9193eedd follow-up #2):
    // Every heartbeat writes a new run row with a new progression_run_id, even
    // when the question hasn't changed — so comparing run IDs is the same bug
    // as comparing case_version, wearing a different field name.
    //
    // A question is identified by its CONTENT: the decision type plus what is
    // being asked (next_best_action_json). If both are unchanged, the answer
    // is current no matter how many heartbeats fired. 409 only when the case
    // genuinely moved on: a different decision, or a different step.
    const QUESTION_DECISIONS = ['REQUEST_DECISION', 'ASK_INFORMATION', 'RECOVERY_REQUIRED', 'WAIT_EXTERNAL']
    const latestQuestionRun = db.prepare(
      `SELECT r.progression_run_id, r.decision, s.next_best_action_json
       FROM case_progression_runs r
       LEFT JOIN case_progression_state s ON s.domain = r.domain AND s.case_id = r.case_id
       WHERE r.domain = ? AND r.case_id = ?
         AND r.decision IN (${QUESTION_DECISIONS.map(() => '?').join(',')})
       ORDER BY r.started_at DESC LIMIT 1`
    ).get(domain, caseId, ...QUESTION_DECISIONS) as {
      progression_run_id: string; decision: string; next_best_action_json: string | null
    } | undefined

    if (!latestQuestionRun) {
      json(res, { error: 'no active question for this case' }, 404); return true
    }

    // Content-based staleness: the frontend sends the decision + nextBestAction
    // it displayed. If both match the current state, the question is unchanged.
    const sameDecision = body.decision === latestQuestionRun.decision
    const sameNba = deepJsonEqual(body.nextBestAction ?? null, latestQuestionRun.next_best_action_json ?? null)
    if (!sameDecision || !sameNba) {
      json(res, {
        error: 'question_stale',
        currentSourceReference: latestQuestionRun.progression_run_id,
        currentDecision: latestQuestionRun.decision,
        currentNextBestAction: latestQuestionRun.next_best_action_json ?? null,
      }, 409)
      return true
    }

    // Build payload + reason.
    const payload = JSON.stringify({
      choice: choice ?? null,
      text: text ?? null,
      idempotency_key: idempotencyKey,
      external_effect_ack: externalEffectAck === true,
    })
    const reason = choice || text || eventType

    // Insert the event.
    const insertResult = db.prepare(
      `INSERT INTO ${eventsTable}
       (case_id, case_version, actor, source_system, source_reference,
        event_type, previous_status, new_status, reason, payload, correlation_id, created_at)
       VALUES (?, ?, 'istvan', 'mission_control', ?, ?, NULL, NULL, ?, ?, ?, ?)`
    ).run(caseId, caseVersion, sourceReference, eventType, reason, payload,
      `${caseId}:${sourceReference}`, now)

    // Run ONE progression cycle for instant feedback.
    let progressionResult: { newDecision: string | null; newNextBestAction: string | null }
    try {
      const pr = runProgressionCycle(db, domain, caseId, now, {
        triggerType: 'MANUAL',
        triggerReference: sourceReference,
      })
      // Read new state.
      const newState = db.prepare(
        `SELECT decision, next_best_action_json
         FROM case_progression_runs
         WHERE domain = ? AND case_id = ?
         ORDER BY started_at DESC LIMIT 1`
      ).get(domain, caseId) as { decision: string | null; next_best_action_json: string | null } | undefined
      progressionResult = {
        newDecision: newState?.decision ?? null,
        newNextBestAction: newState?.next_best_action_json ?? null,
      }
    } catch (e) {
      // Engine failure doesn't roll back the event — the event is already
      // committed; the next scheduled cycle will process it.
      progressionResult = { newDecision: null, newNextBestAction: null }
    }

    json(res, {
      ok: true,
      eventId: Number(insertResult.lastInsertRowid),
      progressionRan: true,
      ...progressionResult,
    })
    return true
  }

  // Card 3d9d62b1: per-case events (timeline). Read-only — the events table is
  // append-only by trigger, so this can never mutate. Query param: case_id + namespace.
  if (path === '/api/cos/events' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const caseId = q.get('case_id')
    const ns = q.get('namespace') || 'personal'
    if (!caseId) { json(res, { error: 'case_id required' }, 400); return true }
    const table = ns === 'zst' ? 'zst_case_events' : 'personal_case_events'
    const events = getDb().prepare(
      `SELECT event_id, case_version, actor, event_type, previous_status, new_status,
              reason, payload, correlation_id, created_at
       FROM ${table} WHERE case_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(caseId)
    json(res, { events, count: events.length })
    return true
  }

  // Card 3d9d62b1: per-case documents (attached files). Read-only.
  // Query param: case_id + namespace.
  if (path === '/api/cos/documents' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const caseId = q.get('case_id')
    const ns = (q.get('namespace') || 'personal') as 'personal' | 'zst'
    if (!caseId) { json(res, { error: 'case_id required' }, 400); return true }
    if (ns !== 'personal' && ns !== 'zst') { json(res, { error: 'namespace must be personal or zst' }, 400); return true }
    const docs = documentsForCase(getDb(), ns, caseId)
    json(res, { documents: docs, count: docs.length })
    return true
  }

  // Card 3d9d62b1: download a stored document file by id. Read-only — serves
  // the raw bytes from the content-addressed store with the correct MIME type.
  // The document id is the only required param; the server resolves namespace +
  // stored_path from the DB row and integrity-checks the bytes.
  if (path === '/api/cos/document-file' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const docId = q.get('doc_id')
    if (!docId) { json(res, { error: 'doc_id required' }, 400); return true }
    try {
      const buf = readDocumentBytes(getDb(), docId)
      const row = getDb().prepare(
        `SELECT filename, mime_type FROM cos_documents WHERE document_id = ?`
      ).get(docId) as { filename: string | null; mime_type: string | null } | undefined
      const mime = row?.mime_type || 'application/octet-stream'
      const fname = row?.filename || docId
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': 'inline; filename="' + encodeURIComponent(fname) + '"',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=3600',
      })
      res.end(buf)
    } catch (e) {
      json(res, { error: (e as Error).message }, 404)
    }
    return true
  }

  return false
}

/** GROUP BY helper → {value: count}. */
function countBy(db: ReturnType<typeof getDb>, sql: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of db.prepare(sql).all() as Array<{ k: string; n: number }>) out[r.k] = r.n
  return out
}
function scalar(db: ReturnType<typeof getDb>, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0
}

/**
 * COS analytics roll-up (#5d): aggregate counts over cases, the price radar, and
 * campaigns/outbound. Read-only, cheap GROUP BYs — the "campaign/radar analytics"
 * the spec §F names, plus a case overview.
 */
export function listAnalytics(db: ReturnType<typeof getDb>): {
  cases: { total: number; byStatus: Record<string, number>; bySensitivity: Record<string, number> }
  radar: { total: number; byStatus: Record<string, number>; observations: number; hits: number; notifications: number }
  campaigns: { total: number; byStatus: Record<string, number> }
  outbound: { total: number; byStatus: Record<string, number> }
} {
  return {
    cases: {
      total: scalar(db, `SELECT COUNT(*) n FROM personal_cases WHERE archived_at IS NULL`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY status`),
      bySensitivity: countBy(db, `SELECT sensitivity k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY sensitivity`),
    },
    radar: {
      total: scalar(db, `SELECT COUNT(*) n FROM radar_items`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM radar_items GROUP BY status`),
      observations: scalar(db, `SELECT COUNT(*) n FROM radar_observations`),
      hits: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE status='HIT'`),
      notifications: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE last_notified_at IS NOT NULL`),
    },
    campaigns: {
      total: scalar(db, `SELECT COUNT(*) n FROM campaigns`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM campaigns GROUP BY status`),
    },
    outbound: {
      total: scalar(db, `SELECT COUNT(*) n FROM outbound_ledger`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM outbound_ledger GROUP BY status`),
    },
  }
}

// Read-only summaries for the Mission Control views. Exported so they are unit-
// testable against a seeded DB (the route wrapper is not).

export function listOutbound(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT ledger_id, case_id, action_type, sequence_number, status, external_ref, attempt, updated_at
     FROM outbound_ledger ORDER BY created_at DESC LIMIT 50`
  ).all()
}

export function listCampaignsSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT c.campaign_id, c.case_id, c.campaign_type, c.status, c.version, c.allows_free_text,
        (SELECT COUNT(*) FROM campaign_approvals a WHERE a.campaign_id=c.campaign_id AND a.status='APPROVED'
           AND a.campaign_version=c.version) AS approved_current
     FROM campaigns c ORDER BY c.updated_at DESC LIMIT 50`
  ).all()
}

export function listRadarSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT r.radar_id, r.case_id, r.kind, r.label, r.target_price, r.currency, r.status,
        r.best_seen_price, r.next_check_at,
        (SELECT best_price FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_price,
        (SELECT observed_at FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_at
     FROM radar_items r ORDER BY r.updated_at DESC LIMIT 50`
  ).all()
}

/**
 * Operational monitoring for the Mission Control "Monitoring" view (#5b): the
 * connector-health matrix, an outbound-status roll-up with the rows that need a
 * HUMAN (RECOVERY_REQUIRED / FAILED_TERMINAL — the executor never auto-resolves
 * these), send-quota usage, and the OUTPUT FLOORS.
 *
 * The floors answer the question the rest of this function cannot: not "did
 * something go wrong?" but "did anything happen at all?". Every surface here
 * reports on work that exists; a pipeline producing nothing has no rows to
 * report, and so reads as calm. That is precisely how the 2026-08-09 failures
 * stayed invisible for three days. `breached` is surfaced separately so a zero
 * cannot be scrolled past.
 *
 * `alerts` is the SAME reconcile the daily job runs (§19 + §14). One source, two
 * surfaces: if the Mission Control view and the 07:00 report could disagree,
 * you would eventually trust the quieter one.
 */
export function listMonitoring(db: ReturnType<typeof getDb>): {
  connectors: unknown[]; outboundHealth: { byStatus: Record<string, number>; needsAttention: unknown[] }
  quotas: unknown[]; outputFloors: unknown[]; breached: unknown[]
  alerts: { findings: unknown[]; counts: Record<string, number>; clean: boolean }
} {
  const connectors = db.prepare(
    `SELECT connector_id, kind, mode, status, consecutive_failures, last_ok_at, last_error_at, last_error
     FROM connector_health ORDER BY connector_id`
  ).all()
  const statusRows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM outbound_ledger GROUP BY status`
  ).all() as Array<{ status: string; n: number }>
  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status] = r.n
  const needsAttention = db.prepare(
    `SELECT ledger_id, case_id, action_type, status, last_error, updated_at
     FROM outbound_ledger WHERE status IN ('RECOVERY_REQUIRED','FAILED_TERMINAL')
     ORDER BY updated_at DESC LIMIT 50`
  ).all()
  const quotas = db.prepare(
    `SELECT quota_key, used_count, max_count, window_sec, window_start FROM send_quotas ORDER BY quota_key`
  ).all()
  const outputFloors = evaluateOutputFloors(db)
  const rec = runDailyReconcile(db)
  return { connectors, outboundHealth: { byStatus, needsAttention }, quotas,
    outputFloors, breached: breachedFloors(outputFloors),
    alerts: { findings: rec.findings, counts: rec.counts, clean: rec.clean } }
}
