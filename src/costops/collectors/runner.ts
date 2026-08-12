// CostOps v0.3 -- collector runner. Deterministic, no LLM.
//
// Loads a collector's normalized lines, upserts them into cost_line_items as
// confidence='provider_api' (idempotent by dedup_key, NEVER overwriting the
// manual/estimate rows -- they have a different dedup_key), and records an
// import_runs row. On error it DELETES NOTHING and records a sanitized failure.
// Secrets never enter the DB, logs, or the returned result.

import type Database from 'better-sqlite3'
import type { ProviderCollector, CollectOpts, NormalizedCostLine, ImportRunResult, ImportStatus, ShapeNode, DryRunReport } from './types.js'
import { buildDbImportLockContext, withImportLock } from './import-durability.js'
import { isPeriodClosed } from '../period-close.js'

/**
 * The failure CLASSES a collector run can be in (C-3).
 *
 * WHY A CLOSED SET. `error_code` was `String(e.code ?? e.status ?? e.name ??
 * 'error')` — whatever shape the exception that happened to escape had. So the
 * same outage arrived as `ETIMEDOUT`, `ECONNRESET`, `AbortError`, `529` or
 * `FetchError` depending on which layer noticed it first, and "has this provider
 * been failing the same way for a week?" was not a question the ledger could
 * answer. §17 wants failures to be comparable over time; free text is not.
 *
 * The RAW code is still kept alongside — the class is for counting, the code is
 * for debugging, and neither replaces the other.
 */
export const COLLECTOR_ERROR_CLASSES = [
  /** Credentials rejected or missing. Needs a human with the vault. */
  'auth',
  /** The provider asked us to slow down. Retrying later is the fix. */
  'rate_limited',
  /** No answer in time. */
  'timeout',
  /** Could not reach the provider at all. */
  'network',
  /** The provider answered, and the answer was a server-side failure. */
  'provider_error',
  /** The provider answered something we could not parse or did not expect. */
  'bad_response',
  /** Missing or invalid local configuration — not the provider's fault. */
  'config',
  /** Genuinely unclassified. Kept honest rather than folded into a neighbour. */
  'unknown',
] as const
export type CollectorErrorClass = typeof COLLECTOR_ERROR_CLASSES[number]

/** HTTP status → class. Ranges, not a list, so an unseen 4xx/5xx still lands
 *  somewhere truthful rather than in `unknown`. */
function classFromStatus(status: number): CollectorErrorClass | null {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'provider_error'
  if (status >= 400) return 'bad_response'
  return null
}

/**
 * Put a thrown thing into one of the classes above.
 *
 * Order matters: the HTTP status is the most reliable signal when present, then
 * the node error code, then the name, and only then the message text. Message
 * matching is last on purpose — it is the signal most likely to change under us
 * when a provider rewords something.
 */
export function classifyCollectorError(err: unknown): CollectorErrorClass {
  const e = err as { code?: string; name?: string; message?: string; status?: number }
  if (typeof e?.status === 'number') {
    const fromStatus = classFromStatus(e.status)
    if (fromStatus) return fromStatus
  }
  const code = String(e?.code ?? '').toUpperCase()
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) {
    return 'network'
  }
  const name = String(e?.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  if (name === 'SyntaxError' || name === 'TypeError') return 'bad_response'
  const msg = String(e?.message ?? '').toLowerCase()
  if (/\b(401|403|unauthori[sz]ed|forbidden|invalid api key|no api key|missing (api )?key)\b/.test(msg)) return 'auth'
  // "auth failed" / "authentication failed" — the phrasing several providers
  // actually use, and the one the existing redaction test happens to carry.
  if (/\bauth(entication)?\s+(failed|error)\b/.test(msg)) return 'auth'
  if (/\b(429|rate.?limit|too many requests|quota exceeded)\b/.test(msg)) return 'rate_limited'
  if (/\b(timed? ?out|timeout)\b/.test(msg)) return 'timeout'
  if (/\b(econnrefused|network|dns|unreachable)\b/.test(msg)) return 'network'
  if (/\b(not configured|missing config|no config)\b/.test(msg)) return 'config'
  return 'unknown'
}

/** Redact anything that looks like a key/token before it can reach a log/DB.
 *
 *  `errorClass` is the C-3 addition; `code` and `message` are unchanged, so
 *  every existing caller keeps working and nothing that was already recorded
 *  changes meaning. */
export function sanitizeError(
  err: unknown,
): { code: string; message: string; errorClass: CollectorErrorClass } {
  const e = err as { code?: string; name?: string; message?: string; status?: number }
  const code = String(e?.code ?? e?.status ?? e?.name ?? 'error').slice(0, 40)
  let msg = String(e?.message ?? 'collector error').slice(0, 300)
  msg = msg
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/(x-api-key|authorization|bearer)\s*[:=]\s*\S+/gi, '$1 ***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***')
  return { code, message: msg, errorClass: classifyCollectorError(err) }
}

/** The UTC month a line is charged to, as `YYYY-MM`.
 *
 *  UTC to match `monthWindow` (ledger.ts): the close status is keyed by the
 *  month the ledger means, and deriving it in local time would put a line into
 *  a different month than every other query in this subsystem. */
export function chargeMonthKey(billingPeriodStart: number): string {
  const d = new Date(billingPeriodStart * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface UpsertOutcome {
  /** Lines written. */
  imported: number
  /** Lines refused because their month is CLOSED, per closed month. */
  refusedByClosedPeriod: Record<string, number>
}

/**
 * Write the collector's lines — skipping any whose month is CLOSED (C-1).
 *
 * WHY THIS GUARD IS HERE AND WAS NOT. §23 AC-9 is "a closed month does not
 * change silently", and `checkPeriodWritable`'s own docstring names the three
 * paths it is for: "manual entry, email ingest, COLLECTOR UPSERT". Two of the
 * three call it. The collector path — the one that runs BY ITSELF on a
 * schedule, with nobody watching — never did:
 *
 *     $ grep -rn "checkPeriodWritable" src/costops/collectors/
 *     (no matches)
 *
 * So the one write path that needed no human to trigger it was the one that
 * could rewrite a closed month.
 *
 * PER LINE, NOT PER RUN. A sync window straddles a month boundary constantly —
 * a run on the 1st fetches yesterday too. Refusing the whole run would throw
 * away legitimate current-month data because of a closed previous month;
 * refusing per line keeps what may be kept and reports the rest. That partial
 * outcome is what `ImportStatus.partial` was declared for.
 *
 * NOT AN ERROR. A closed month refusing a write is the system working. The
 * caller turns it into `partial`, and the corrections path (createCorrection)
 * is how a closed month is legitimately changed.
 */
function upsertProviderLines(
  db: Database.Database, lines: NormalizedCostLine[], now: number,
): UpsertOutcome {
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, account_ref, currency, active, created_at, updated_at)
    VALUES (@id, @id, @provider, 'usage', NULL, @currency, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at, actual_source)
    VALUES
      (@source_id, @start, @end, 'usage', @source_id,
       @usage_type, @quantity, @unit, @amount, NULL, @currency,
       @confidence, @freshness, @source_ref, @dedup_key, @now, 'provider_api')
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, currency=excluded.currency,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness,
      source_ref=excluded.source_ref, usage_type=excluded.usage_type,
      actual_source=excluded.actual_source
  `)
  // Closed-month lookups are cached per run: a sync returns hundreds of lines
  // and they all land in one or two months, so asking the DB per line would be
  // hundreds of identical queries inside the write transaction.
  const closedByMonth = new Map<string, boolean>()
  const monthIsClosed = (month: string): boolean => {
    const cached = closedByMonth.get(month)
    if (cached !== undefined) return cached
    const closed = isPeriodClosed(db, month)
    closedByMonth.set(month, closed)
    return closed
  }

  const refusedByClosedPeriod: Record<string, number> = {}
  const tx = db.transaction((ls: NormalizedCostLine[]) => {
    let n = 0
    for (const l of ls) {
      const month = chargeMonthKey(l.billing_period_start)
      if (monthIsClosed(month)) {
        refusedByClosedPeriod[month] = (refusedByClosedPeriod[month] ?? 0) + 1
        continue
      }
      upsertSource.run({ id: l.service, provider: l.provider, currency: l.currency, now })
      upsertLine.run({
        source_id: l.service, start: l.billing_period_start, end: l.billing_period_end,
        usage_type: l.usage_type ?? null, quantity: l.quantity ?? null, unit: l.unit ?? null,
        amount: l.amount, currency: l.currency, confidence: l.confidence,
        freshness: l.data_freshness_at, source_ref: l.raw_ref_hash ?? null, dedup_key: l.dedup_key, now,
      })
      n++
    }
    return n
  })
  return { imported: tx(lines), refusedByClosedPeriod }
}

/**
 * Describe a value's STRUCTURE only -- types, object keys, and array lengths.
 * NEVER includes a scalar value, so no secret / account id / invoice ref / raw
 * provider datum can leak through it. Depth-bounded to stay finite.
 */
export function describeShape(value: unknown, depth = 0): ShapeNode {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, of: value.length ? describeShape(value[0], depth + 1) : 'undefined' }
  }
  const t = typeof value
  if (t === 'string') return 'string'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'object') {
    const keys: Record<string, ShapeNode> = {}
    if (depth < 6) for (const k of Object.keys(value as Record<string, unknown>)) {
      keys[k] = describeShape((value as Record<string, unknown>)[k], depth + 1)
    }
    return { type: 'object', keys }
  }
  return 'undefined' // functions/symbols are not represented
}

export interface RunCollectorArgs {
  db: Database.Database
  collector: ProviderCollector
  opts: CollectOpts
  now: number
  // v0.5: optional sanitized per-run detail JSON (breakdown) stored on import_runs.
  // MUST be secret-free and contain no raw account/service IDs (type/plan labels only).
  detailJson?: string
}

export interface DryRunArgs {
  db: Database.Database
  collector: ProviderCollector
  opts: CollectOpts
  now: number
  // If true (default), record an audit row in import_runs with status='dry_run'
  // and imported_count=0 (NO cost line, NO secret, NO raw provider datum). If
  // false, persist nothing at all.
  recordRun?: boolean
}

/**
 * DRY-RUN a collector: fetch + normalize exactly like a real run, but write NO
 * provider_api cost_line_items. It returns the planned normalized lines, their
 * dedup_keys, and a sanitized SHAPE of the provider response (types only). The
 * only optional write is a status='dry_run' import_runs audit row (count 0).
 * Secret-free by construction: raw responses and secrets never reach the DB,
 * the log, or the returned report.
 */
export async function dryRunCollector(args: DryRunArgs): Promise<DryRunReport> {
  const { db, collector, opts, now } = args
  const recordRun = args.recordRun !== false
  let status: 'dry_run' | 'error' = 'dry_run'
  let plannedLines: NormalizedCostLine[] = []
  let responseShape: ShapeNode | null = null
  let errorCode: string | null = null
  let errorMsg: string | null = null
  let freshness: number | null = null
  try {
    if (collector.collectRaw) {
      const { raw, lines } = await collector.collectRaw(opts)
      responseShape = describeShape(raw)   // types only -- never values
      plannedLines = lines
    } else {
      // No raw access on this collector -> lines only, shape unavailable.
      plannedLines = await collector.collect(opts)
      responseShape = null
    }
    freshness = plannedLines.reduce((m, l) => Math.max(m, l.data_freshness_at), 0) || now
  } catch (err) {
    status = 'error'
    const s = sanitizeError(err)
    errorCode = s.code
    errorMsg = s.message
  }
  // CRITICAL: no provider_api cost_line_items are ever written in a dry-run.
  // Optionally leave a clearly-marked audit trail (no cost, no secret, no raw).
  if (recordRun) {
    db.prepare(`
      INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status,
        period_start, period_end, imported_count, error_code, error_message_sanitized, data_freshness_at)
      VALUES (@provider, @collector, @started, @finished, @status, @ps, @pe, 0, @ecode, @emsg, @fresh)
    `).run({
      provider: collector.provider, collector: collector.collectorName,
      started: now, finished: now, status,
      ps: opts.periodStart, pe: opts.periodEnd,
      ecode: errorCode, emsg: errorMsg, fresh: freshness,
    })
  }
  return {
    provider: collector.provider, collectorName: collector.collectorName,
    status, plannedLines, dedupKeys: plannedLines.map(l => l.dedup_key),
    responseShape, wouldImportCount: plannedLines.length,
    errorCode, errorMessageSanitized: errorMsg,
  }
}

/**
 * Run a collector end to end and record an import_runs row. Never throws on a
 * collector error -- it records a sanitized failure and imports nothing. Returns
 * the run result (also secret-free).
 *
 * Phase 1 (GAP-07): wrapped in a per-provider import lock -- a concurrent
 * call for the SAME provider (e.g. a manual "sync now" racing the scheduled
 * one) never runs; it records a 'locked' row and returns immediately,
 * touching no data. Different providers never block each other (the lock is
 * per-provider, not global).
 */
export async function runCollector(args: RunCollectorArgs): Promise<ImportRunResult> {
  const { db, collector, opts, now } = args
  const insertRun = db.prepare(`
    INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status,
      period_start, period_end, imported_count, error_code, error_message_sanitized, data_freshness_at, detail_json)
    VALUES (@provider, @collector, @started, @finished, @status,
      @ps, @pe, @count, @ecode, @emsg, @fresh, @detail)
  `)

  const lockResult = await withImportLock(buildDbImportLockContext(db), collector.provider, now, async () => {
    let status: ImportStatus = 'ok'
    let importedCount = 0
    let errorCode: string | null = null
    let errorMsg: string | null = null
    let freshness: number | null = null
    try {
      const lines = await collector.collect(opts)
      const outcome = upsertProviderLines(db, lines, now)
      importedCount = outcome.imported
      // PARTIAL, AND FOR THE FIRST TIME SOMETHING WRITES IT (C-2).
      //
      // `ImportStatus` has declared 'partial' and 'rate_limited' since it was
      // written, `lifecycle.ts` types them, and `ledger.ts`'s last-failure query
      // filters on them — but no producer ever emitted either, so that filter
      // could never match and §23 AC-12 ("collectors tolerate partial failure")
      // was not observable from the outside.
      //
      // A run that wrote some of its lines and refused others is exactly what
      // the word means, and now it says so instead of reporting a clean 'ok'
      // over a silently shorter import.
      const refusedMonths = Object.keys(outcome.refusedByClosedPeriod)
      if (refusedMonths.length > 0) {
        const refusedCount = refusedMonths.reduce(
          (sum, m) => sum + outcome.refusedByClosedPeriod[m], 0)
        status = 'partial'
        // Not `sanitizeError` shaped: nothing here came from a provider, so
        // there is nothing to redact, and a real reason beats a generic code.
        errorCode = 'period_closed'
        errorMsg = `${refusedCount} line(s) not imported: month(s) ${refusedMonths.sort().join(', ')} are closed — use a correction`
      }
      freshness = lines.reduce((m, l) => Math.max(m, l.data_freshness_at), 0) || now
    } catch (err) {
      const s = sanitizeError(err)
      // RATE LIMITING IS NOT A FAILURE TO FIX (C-2, second half). `ImportStatus`
      // has carried 'rate_limited' from the start with no producer, so a
      // throttled provider was recorded as `error` — the same word as a broken
      // credential or a crashed parser. One needs a human, the other needs the
      // next scheduled run. The class decides, so a 429 from any layer lands the
      // same way.
      status = s.errorClass === 'rate_limited' ? 'rate_limited' : 'error'
      // The CLASS goes in the code column, the raw code into the message, so the
      // ledger can count comparable things while nobody loses the detail.
      errorCode = s.errorClass
      errorMsg = `${s.code}: ${s.message}`.slice(0, 300)
      // IMPORTANT: delete nothing. Last good data stays.
    }
    return { status, importedCount, errorCode, errorMsg, freshness }
  })

  if (!lockResult.ok) {
    insertRun.run({
      provider: collector.provider, collector: collector.collectorName,
      started: now, finished: now, status: 'locked' as ImportStatus,
      ps: opts.periodStart, pe: opts.periodEnd, count: 0,
      ecode: null, emsg: 'a concurrent sync for this provider was already running', fresh: null, detail: null,
    })
    return {
      provider: collector.provider, collectorName: collector.collectorName,
      status: 'locked', importedCount: 0, errorCode: null, errorMessageSanitized: 'a concurrent sync for this provider was already running', dataFreshnessAt: null,
    }
  }

  const { status, importedCount, errorCode, errorMsg, freshness } = lockResult.result
  insertRun.run({
    provider: collector.provider, collector: collector.collectorName,
    started: now, finished: now, status,
    ps: opts.periodStart, pe: opts.periodEnd, count: importedCount,
    ecode: errorCode, emsg: errorMsg, fresh: freshness, detail: args.detailJson ?? null,
  })
  return {
    provider: collector.provider, collectorName: collector.collectorName,
    status, importedCount, errorCode, errorMessageSanitized: errorMsg, dataFreshnessAt: freshness,
  }
}
