// CostOps -- DeepSeek cost collector (LIVE, read-only, prepaid-balance based).
//
// DeepSeek exposes remaining prepaid BALANCE (GET /user/balance), not per-period
// cost. So month-to-date spend is derived from the balance DROP across snapshots:
// each sync records a snapshot, and MTD spend = the sum of decreases between
// consecutive this-month snapshots (increases are top-ups and are ignored, so a
// mid-month top-up does not distort spend). The API key comes from the Vault and
// is NEVER logged. Pure GET, no provider-side write.
//
// First sync of a month just records the baseline (spend 0 until a later sync
// shows a drop). This is a provider_usage_actual signal (API-observed), an
// upgrade over a manual DeepSeek estimate.

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEEPSEEK_API_SOURCE = 'deepseek-api'

export interface BalanceSnapshot { balance: number; captured_at: number }

/**
 * PURE: month-to-date spend in the balance currency, from ascending-by-time
 * snapshots. Sums only the DROPS between consecutive snapshots (a rise is a
 * top-up, ignored). Deterministic; no I/O.
 */
export function deriveMtdSpend(snapshotsAsc: BalanceSnapshot[]): number {
  let spend = 0
  for (let i = 1; i < snapshotsAsc.length; i++) {
    const drop = snapshotsAsc[i - 1].balance - snapshotsAsc[i].balance
    if (drop > 0) spend += drop
  }
  return Math.round(spend * 10000) / 10000
}

/**
 * PURE (COS-OPS-M1): the peak balance observed SINCE the last top-up, from
 * ascending-by-time snapshots. A RISE between consecutive snapshots marks a
 * top-up (the same drop/rise discipline deriveMtdSpend uses); the peak is the
 * highest balance at-or-after the last such rise. With no rise ever observed
 * the whole history belongs to one funding period, so the all-time max IS the
 * last top-up's level. Null for an empty history (never a fabricated number).
 *
 * This is what "usage % of the last top-up" must divide by: the old all-time
 * MAX pinned usage_pct near-critical forever once the account cruised low
 * after a small top-up ($50 history + $5 top-up + $4 current read as 92%
 * consumed instead of the real 20%).
 */
export function peakSinceLastTopUp(snapshotsAsc: BalanceSnapshot[]): number | null {
  if (snapshotsAsc.length === 0) return null
  let lastRiseIdx = 0
  for (let i = 1; i < snapshotsAsc.length; i++) {
    if (snapshotsAsc[i].balance > snapshotsAsc[i - 1].balance) lastRiseIdx = i
  }
  let peak = snapshotsAsc[lastRiseIdx].balance
  for (let i = lastRiseIdx + 1; i < snapshotsAsc.length; i++) {
    if (snapshotsAsc[i].balance > peak) peak = snapshotsAsc[i].balance
  }
  return peak
}

// Card ef6c6a2c (spec section 5, "will the quota fill?" -- inverted here to "will the
// prepaid balance run OUT?"): extrapolates a daily burn rate from ALL historical snapshots
// (not just this month -- a longer window gives a steadier rate than a fresh month with only
// 1-2 points), reusing deriveMtdSpend's drop-summing logic (it's period-agnostic despite the
// name -- ignoring top-ups/rises is exactly right for a burn-rate calculation too, not just MTD).
// Returns null (never a fabricated date) whenever the input can't support a trustworthy
// extrapolation: fewer than 2 snapshots, less than a day of history (a same-day rate is too
// noisy to project weeks out), or no net spend observed (zero or net-positive balance change
// -- there's no "running out" to forecast).
const MIN_FORECAST_SPAN_SECONDS = 86400

export function forecastDeepSeekExhaustion(snapshotsAsc: BalanceSnapshot[], now: number): number | null {
  if (snapshotsAsc.length < 2) return null
  const first = snapshotsAsc[0]
  const last = snapshotsAsc[snapshotsAsc.length - 1]
  const spanSeconds = last.captured_at - first.captured_at
  if (spanSeconds < MIN_FORECAST_SPAN_SECONDS) return null
  const totalSpend = deriveMtdSpend(snapshotsAsc)
  if (totalSpend <= 0) return null
  const dailyBurn = totalSpend / (spanSeconds / 86400)
  if (!isFinite(dailyBurn) || dailyBurn <= 0) return null
  const daysToZero = last.balance / dailyBurn
  if (!isFinite(daysToZero) || daysToZero < 0) return null
  return Math.floor(now + daysToZero * 86400)
}

interface DeepSeekBalanceInfo { currency?: string; total_balance?: string | number }
interface DeepSeekBalanceResp { is_available?: boolean; balance_infos?: DeepSeekBalanceInfo[] }

/**
 * Extract the USD total balance from the /user/balance response.
 *
 * COS-OPS-H2: an absent/unparseable balance_infos (or is_available:false) used
 * to parse as 0 -- a REAL-looking snapshot. deriveMtdSpend then booked the
 * drop-to-zero as genuine spend for the rest of the month (and the next good
 * reading was ignored as a "top-up"), permanently poisoning MTD spend and the
 * exhaustion forecast off a single malformed-but-200 response. Now returns
 * null for anything that isn't a recognizable, available balance -- "the
 * balance is unknown", never a fabricated $0 -- and the caller records an
 * error run WITHOUT writing a snapshot.
 */
export function parseDeepSeekBalanceUsd(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as DeepSeekBalanceResp
  // Explicit provider-side "not available" -- the numbers alongside it are not a live balance.
  if (r.is_available === false) return null
  const infos = Array.isArray(r.balance_infos) ? r.balance_infos : []
  const usd = infos.find(i => (i.currency || '').toUpperCase() === 'USD') || infos[0]
  if (!usd) return null
  const v = typeof usd.total_balance === 'number' ? usd.total_balance : parseFloat(String(usd.total_balance ?? ''))
  return isFinite(v) ? v : null
}

export const DEEPSEEK_VAULT_SECRET_ID = 'DEEPSEEK_API_KEY'

export interface DeepSeekSyncResult {
  ok: boolean
  provider: string
  status: string
  imported_count: number
  balance_usd?: number
  mtd_spend_usd?: number
  error?: string
  period?: string
}

/**
 * LIVE read-only sync: read the prepaid balance, record a snapshot, derive MTD
 * spend from this month's balance drops, and upsert a provider line +
 * import_runs row. Injected deps let tests stub the key, fetcher, fx and clock.
 *
 * COS-OPS-M4: the whole sync body runs under the same per-provider import lock
 * runCollector gives every other collector (import-durability.ts) -- a manual
 * "sync now" racing the scheduled tick short-circuits with status 'locked' and
 * performs NO fetch and NO write. The line/run writes go through the shared
 * runner helpers (upsertProviderLines/recordImportRun) instead of local copies.
 */
export async function syncDeepSeekBalance(
  db: import('better-sqlite3').Database,
  now: number,
  deps: {
    httpGetJson?: import('./types.js').HttpGetJson
    apiKey?: string | null
    fxUsdHuf?: number
  } = {},
): Promise<DeepSeekSyncResult> {
  const { monthWindow } = await import('../ledger.js')
  const { sanitizeError, recordImportRun, upsertProviderLines } = await import('./runner.js')
  const { withImportLock, buildDbImportLockContext } = await import('./import-durability.js')
  const w = monthWindow(now)
  const record = (status: string, count: number, errMsg: string | null): void => recordImportRun(db, {
    provider: 'deepseek', collectorName: 'deepseek-balance',
    status: status as import('./types.js').ImportStatus, now, importedCount: count,
    periodStart: w.start, periodEnd: w.end,
    errorCode: status === 'error' ? 'balance_error' : null, errorMessage: errMsg,
    freshness: status === 'locked' ? null : now,
  })

  const lockResult = await withImportLock(buildDbImportLockContext(db), 'deepseek', now, async (): Promise<DeepSeekSyncResult> => {
    let apiKey = deps.apiKey
    if (apiKey === undefined) {
      try { const { getSecret } = await import('../../web/vault.js'); apiKey = getSecret(DEEPSEEK_VAULT_SECRET_ID) } catch { apiKey = null }
    }
    if (!apiKey) {
      record('error', 0, 'no DeepSeek key in vault')
      return { ok: false, provider: 'deepseek', status: 'error', imported_count: 0, error: `no DeepSeek key in vault (${DEEPSEEK_VAULT_SECRET_ID})`, period: w.key }
    }
    let fxUsdHuf = deps.fxUsdHuf
    if (fxUsdHuf === undefined) {
      // COS-OPS-M6: the provider-neutral fx config is the rate's home -- this
      // used to read the Render plan-pricing file's fx_usd_huf, so a cleanup of
      // the dead Render config would have zeroed the USD->HUF conversion here
      // without a word. fx-config.ts seeds itself once from that legacy value,
      // so nothing already configured is lost. Same dynamic-import shape as the
      // rest of this sync body (and syncOpenAiCollector).
      try { const { loadFxRates } = await import('../fx-config.js'); fxUsdHuf = loadFxRates().rates.USD ?? 0 } catch { fxUsdHuf = 0 }
    }
    const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
      const r = await fetch(url, { method: 'GET', headers }); if (!r.ok) throw new Error(`deepseek api ${r.status}`); return r.json()
    })
    let balanceUsd: number | null
    try {
      const raw = await httpGetJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${apiKey}` })
      balanceUsd = parseDeepSeekBalanceUsd(raw)
    } catch (err) {
      const s = sanitizeError(err)
      record('error', 0, s.message)
      return { ok: false, provider: 'deepseek', status: 'error', imported_count: 0, error: s.code, period: w.key }
    }
    // COS-OPS-H2: a 200 whose body isn't a recognizable, available balance is an
    // ERROR run, not a $0 snapshot -- writing a fabricated 0 here would book the
    // whole remaining balance as MTD spend (deriveMtdSpend counts the drop) and
    // ignore the next good reading as a "top-up". No snapshot, no line, no
    // entitlement touch; last good data stays.
    if (balanceUsd == null) {
      record('error', 0, 'unrecognizable /user/balance response (or is_available=false) -- balance unknown, no snapshot recorded')
      return { ok: false, provider: 'deepseek', status: 'error', imported_count: 0, error: 'unrecognizable balance response', period: w.key }
    }
    // record the snapshot, then derive MTD spend from this-month snapshots (asc)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',?,?)`).run(balanceUsd, now)
    const rows = db.prepare(
      `SELECT balance, captured_at FROM provider_balance_snapshots WHERE provider='deepseek' AND captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC`,
    ).all(w.start, w.end) as Array<{ balance: number; captured_at: number }>
    const mtdSpendUsd = deriveMtdSpend(rows.map(r => ({ balance: r.balance, captured_at: r.captured_at })))
    const amountHuf = Math.round(mtdSpendUsd * (fxUsdHuf || 0) * 100) / 100

    // upsert the provider line (usage actual, derived) for deepseek-api, through the
    // shared runner writer (COS-OPS-M4 -- was a hand-rolled local copy).
    // Card a1552362: this is a real USD->HUF conversion (mtdSpendUsd * fxUsdHuf) but the line
    // never retained original_amount/original_currency/fx_rate -- unlike email-ingest.ts's
    // equivalent conversion, which does. Only set when a rate was actually available (fxUsdHuf >
    // 0); a 0 rate means amountHuf is already 0 and there's nothing real to retain.
    upsertProviderLines(db, [{
      provider: 'deepseek', service: DEEPSEEK_API_SOURCE,
      billing_period_start: w.start, billing_period_end: w.end,
      amount: amountHuf, currency: 'HUF', confidence: 'provider_api',
      data_freshness_at: now,
      dedup_key: `provider|deepseek|${DEEPSEEK_API_SOURCE}|${w.key}|provider_api`,
      original_amount: fxUsdHuf ? mtdSpendUsd : null,
      original_currency: fxUsdHuf ? 'USD' : null,
      fx_rate: fxUsdHuf ? fxUsdHuf : null,
      fx_date: fxUsdHuf ? now : null,
    }], now)
    record('ok', 1, null)
    // Forecast uses ALL-time snapshots (not the this-month-only window above) -- a steadier
    // burn-rate base, especially right after a month boundary when the MTD window has only 1-2
    // points of its own.
    const allRows = db.prepare(
      `SELECT balance, captured_at FROM provider_balance_snapshots WHERE provider='deepseek' ORDER BY captured_at ASC`,
    ).all() as Array<{ balance: number; captured_at: number }>
    const exhaustionAt = forecastDeepSeekExhaustion(allRows, now)
    upsertDeepSeekEntitlement(db, balanceUsd, exhaustionAt, now)
    return { ok: true, provider: 'deepseek', status: 'ok', imported_count: 1, balance_usd: balanceUsd, mtd_spend_usd: mtdSpendUsd, period: w.key }
  })

  if (!lockResult.ok) {
    record('locked', 0, 'a concurrent sync for this provider was already running')
    return { ok: false, provider: 'deepseek', status: 'locked', imported_count: 0, error: 'a concurrent sync for this provider was already running', period: w.key }
  }
  return lockResult.result
}

// Card ef6c6a2c (spec section 4): DeepSeek prepaid balance is one of the named
// subscription/limit-usage rows -- a distinct cost-control dimension from the
// derived cost-line above. Prepaid balance has no period/reset or fixed
// included_limit (unlike a weekly/monthly quota), so included_limit/usage_pct/
// reset_at stay null; `remaining` IS the live balance. Status is a plain
// absolute-dollar heuristic (not the spec's 70/80/90/100% usage-of-limit
// thresholds, which don't apply to an unbounded prepaid balance) -- disclosed,
// not presented as the same rule. Single row per provider (dedup_key has no
// period component), upserted on every sync.
function statusForDeepSeekBalance(balanceUsd: number): string {
  if (balanceUsd < 1) return 'critical'
  if (balanceUsd < 3) return 'warning'
  return 'ok'
}

function upsertDeepSeekEntitlement(db: import('better-sqlite3').Database, balanceUsd: number, forecastExhaustionAt: number | null, now: number): void {
  db.prepare(`
    INSERT INTO entitlements
      (provider, product, plan_name, billing_period, entitlement_type,
       included_limit, included_unit, usage_to_date, remaining, usage_pct, reset_at,
       usage_source, usage_confidence, forecast_exhaustion_at, status, dedup_key, last_updated, created_at)
    VALUES
      ('deepseek', 'deepseek-api', 'prepaid', 'ongoing', 'prepaid_balance',
       NULL, 'USD', NULL, @remaining, NULL, NULL,
       'provider_api', 'actual', @forecastExhaustionAt, @status, 'deepseek|prepaid_balance', @now, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      remaining = excluded.remaining,
      status = excluded.status,
      forecast_exhaustion_at = excluded.forecast_exhaustion_at,
      last_updated = excluded.last_updated
  `).run({ remaining: balanceUsd, status: statusForDeepSeekBalance(balanceUsd), forecastExhaustionAt, now })
}

// COS-OPS-M4: the former hand-rolled upsertLine()/recordRun() copies were folded
// into the shared runner helpers (runner.ts upsertProviderLines/recordImportRun)
// -- one guarded writer for every collector, so fixes like the actual_source
// stamping (card 7d086cd3 F1) and fx provenance (card a1552362) can never drift
// per-collector again.
