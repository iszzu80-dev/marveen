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

interface DeepSeekBalanceInfo { currency?: string; total_balance?: string | number }
interface DeepSeekBalanceResp { is_available?: boolean; balance_infos?: DeepSeekBalanceInfo[] }

/** Extract the USD total balance from the /user/balance response (0 if absent). */
export function parseDeepSeekBalanceUsd(raw: unknown): number {
  const r = (raw && typeof raw === 'object') ? raw as DeepSeekBalanceResp : {}
  const infos = Array.isArray(r.balance_infos) ? r.balance_infos : []
  const usd = infos.find(i => (i.currency || '').toUpperCase() === 'USD') || infos[0]
  if (!usd) return 0
  const v = typeof usd.total_balance === 'number' ? usd.total_balance : parseFloat(String(usd.total_balance ?? ''))
  return isFinite(v) ? v : 0
}

export const DEEPSEEK_VAULT_SECRET_ID = 'DEEPSEEK_API_KEY'

/**
 * LIVE read-only sync: read the prepaid balance, record a snapshot, derive MTD
 * spend from this month's balance drops, and upsert a provider line +
 * import_runs row. Injected deps let tests stub the key, fetcher, fx and clock.
 */
export async function syncDeepSeekBalance(
  db: import('better-sqlite3').Database,
  now: number,
  deps: {
    httpGetJson?: import('./types.js').HttpGetJson
    apiKey?: string | null
    fxUsdHuf?: number
  } = {},
): Promise<{ ok: boolean; provider: string; status: string; imported_count: number; balance_usd?: number; mtd_spend_usd?: number; error?: string; period?: string }> {
  const { monthWindow } = await import('../ledger.js')
  const { sanitizeError } = await import('./runner.js')
  let apiKey = deps.apiKey
  if (apiKey === undefined) {
    try { const { getSecret } = await import('../../web/vault.js'); apiKey = getSecret(DEEPSEEK_VAULT_SECRET_ID) } catch { apiKey = null }
  }
  const w = monthWindow(now)
  if (!apiKey) {
    recordRun(db, 'error', 0, w, now, 'no DeepSeek key in vault')
    return { ok: false, provider: 'deepseek', status: 'error', imported_count: 0, error: `no DeepSeek key in vault (${DEEPSEEK_VAULT_SECRET_ID})`, period: w.key }
  }
  let fxUsdHuf = deps.fxUsdHuf
  if (fxUsdHuf === undefined) {
    try { const { loadRenderPricing } = await import('./render.js'); fxUsdHuf = loadRenderPricing().pricing.fx_usd_huf || 0 } catch { fxUsdHuf = 0 }
  }
  const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'GET', headers }); if (!r.ok) throw new Error(`deepseek api ${r.status}`); return r.json()
  })
  let balanceUsd: number
  try {
    const raw = await httpGetJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${apiKey}` })
    balanceUsd = parseDeepSeekBalanceUsd(raw)
  } catch (err) {
    const s = sanitizeError(err)
    recordRun(db, 'error', 0, w, now, s.message)
    return { ok: false, provider: 'deepseek', status: 'error', imported_count: 0, error: s.code, period: w.key }
  }
  // record the snapshot, then derive MTD spend from this-month snapshots (asc)
  db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',?,?)`).run(balanceUsd, now)
  const rows = db.prepare(
    `SELECT balance, captured_at FROM provider_balance_snapshots WHERE provider='deepseek' AND captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC`,
  ).all(w.start, w.end) as Array<{ balance: number; captured_at: number }>
  const mtdSpendUsd = deriveMtdSpend(rows.map(r => ({ balance: r.balance, captured_at: r.captured_at })))
  const amountHuf = Math.round(mtdSpendUsd * (fxUsdHuf || 0) * 100) / 100

  // upsert the provider line (usage actual, derived) for deepseek-api
  upsertLine(db, {
    source: DEEPSEEK_API_SOURCE, provider: 'deepseek', start: w.start, end: w.end,
    amount: amountHuf, confidence: 'provider_api', freshness: now,
    dedup_key: `provider|deepseek|${DEEPSEEK_API_SOURCE}|${w.key}|provider_api`, now,
  })
  recordRun(db, 'ok', 1, w, now, null)
  upsertDeepSeekEntitlement(db, balanceUsd, now)
  return { ok: true, provider: 'deepseek', status: 'ok', imported_count: 1, balance_usd: balanceUsd, mtd_spend_usd: mtdSpendUsd, period: w.key }
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

function upsertDeepSeekEntitlement(db: import('better-sqlite3').Database, balanceUsd: number, now: number): void {
  db.prepare(`
    INSERT INTO entitlements
      (provider, product, plan_name, billing_period, entitlement_type,
       included_limit, included_unit, usage_to_date, remaining, usage_pct, reset_at,
       usage_source, usage_confidence, status, dedup_key, last_updated, created_at)
    VALUES
      ('deepseek', 'deepseek-api', 'prepaid', 'ongoing', 'prepaid_balance',
       NULL, 'USD', NULL, @remaining, NULL, NULL,
       'provider_api', 'actual', @status, 'deepseek|prepaid_balance', @now, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      remaining = excluded.remaining,
      status = excluded.status,
      last_updated = excluded.last_updated
  `).run({ remaining: balanceUsd, status: statusForDeepSeekBalance(balanceUsd), now })
}

function upsertLine(db: import('better-sqlite3').Database, a: { source: string; provider: string; start: number; end: number; amount: number; confidence: string; freshness: number; dedup_key: string; now: number }): void {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id,@id,@provider,'usage','HUF',1,@now,@now)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, updated_at=excluded.updated_at`).run({ id: a.source, provider: a.provider, now: a.now })
  db.prepare(`INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name, usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency, confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES (@source,@start,@end,'usage',@source,NULL,NULL,NULL,@amount,NULL,'HUF',@confidence,@freshness,NULL,@dedup_key,@now)
    ON CONFLICT(dedup_key) DO UPDATE SET billed_cost=excluded.billed_cost, confidence=excluded.confidence, data_freshness=excluded.data_freshness`).run(a)
}

function recordRun(db: import('better-sqlite3').Database, status: string, count: number, w: { start: number; end: number }, now: number, errMsg: string | null): void {
  db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, period_start, period_end, imported_count, error_code, error_message_sanitized, data_freshness_at)
    VALUES ('deepseek','deepseek-balance',@now,@now,@status,@ps,@pe,@count,@ec,@em,@now)`).run({
    now, status, ps: w.start, pe: w.end, count, ec: status === 'error' ? 'balance_error' : null, em: errMsg,
  })
}
