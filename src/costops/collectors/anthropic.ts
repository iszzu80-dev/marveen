// CostOps v0.3 -- Anthropic cost collector (LIVE-READY, but no live call in PR1).
//
// The mapper is a PURE function tested offline against a fixture. collect()
// builds the request and calls the INJECTED httpGetJson, so no network happens
// unless a real fetcher is passed after explicit approval. The Admin API key is
// received via opts.secret (from the Vault) and is NEVER logged.
//
// NOTE: the exact Anthropic Admin cost_report field names must be verified on
// the first approved live dry-run; the fixture + mapper here are a matched pair
// modelling the documented shape (time buckets -> per-line cost results in USD).

import { createHash } from 'node:crypto'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from './types.js'

const ANTHROPIC_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report'
const ANTHROPIC_VERSION = '2023-06-01'
// All Anthropic API usage reconciles against this source (matches the v0.1
// manual/estimate line 'anthropic-api' so estimate and actual share a source).
const ANTHROPIC_API_SOURCE = 'anthropic-api'

function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

interface AnthropicCostResult {
  currency?: string
  amount?: number | string
  cost_type?: string
  model?: string
  service?: string
  description?: string
}
interface AnthropicCostBucket {
  starting_at?: string
  ending_at?: string
  results?: AnthropicCostResult[]
}
interface AnthropicCostReport {
  data?: AnthropicCostBucket[]
  has_more?: boolean
  next_page?: string | null
}

// COS-OPS-H5: the cost_report API pages in daily buckets, so a month with many
// days spans several pages. A well-behaved report fits in a handful; a cursor
// that never terminates within this bound means a broken/looping API, and the
// run must FAIL (throw -> runCollector records status='error', imports nothing)
// rather than silently book the pages fetched so far as the month's actual.
const MAX_COST_REPORT_PAGES = 40

/**
 * PURE mapper: Anthropic cost_report -> a single aggregated provider_api line
 * for the anthropic-api source for the requested period. USD amounts are
 * converted to HUF via fxUsdHuf. Deterministic; no I/O. Returns [] if nothing.
 */
export function mapAnthropicCostReport(
  raw: unknown,
  opts: { periodStart: number; periodEnd: number; fxUsdHuf: number; idSalt: string; now: number },
): NormalizedCostLine[] {
  const report = (raw && typeof raw === 'object') ? raw as AnthropicCostReport : {}
  const buckets = Array.isArray(report.data) ? report.data : []
  let usdTotal = 0
  let any = false
  for (const b of buckets) {
    for (const r of (Array.isArray(b.results) ? b.results : [])) {
      const amt = typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount ?? ''))
      if (!isFinite(amt)) continue
      // report may already be in the account currency; treat as USD only when labelled USD (default).
      const cur = (r.currency || 'USD').toUpperCase()
      usdTotal += cur === 'USD' ? amt : amt // v0.1: assume USD; non-USD handled at live-verify time
      any = true
    }
  }
  if (!any) return []
  // Card 23912ca4 / COS-OPS-H4: a zero/unconfigured fxUsdHuf must never
  // fabricate a 0 HUF line -- that would read as "Anthropic cost this month:
  // nothing" with provider_api confidence, outranking the real manual estimate
  // in the reconcile. The real cost is unknown-in-HUF, not zero. No line at
  // all until a real rate exists (idempotent dedup_key means a later re-run
  // with a real rate fills this in). Guarded here too, not only in the sync
  // wrapper, so a future direct caller of this pure mapper cannot bypass it.
  if (!(opts.fxUsdHuf > 0)) return []
  const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7)
  const amountHuf = Math.round(usdTotal * opts.fxUsdHuf * 100) / 100
  return [{
    provider: 'anthropic',
    service: ANTHROPIC_API_SOURCE,
    billing_period_start: opts.periodStart,
    billing_period_end: opts.periodEnd,
    amount: amountHuf,
    currency: 'HUF',
    confidence: 'provider_api',
    usage_type: 'api_usage',
    quantity: null,
    unit: null,
    data_freshness_at: opts.now,
    raw_ref_hash: hashRef(opts.idSalt, `anthropic-cost-report|${monthKey}`),
    dedup_key: `provider|anthropic|${ANTHROPIC_API_SOURCE}|${monthKey}|provider_api`,
  }]
}

export const anthropicCollector: ProviderCollector = {
  provider: 'anthropic',
  collectorName: 'anthropic-cost-report',
  // READ the cost report and return BOTH the raw response and the normalized
  // lines. The raw is used ONLY to describe its shape in a dry-run (never
  // persisted, never logged). The secret is used only as the auth header.
  //
  // COS-OPS-H5: the report pages in daily buckets (has_more/next_page), so a
  // month with many days only had its FIRST page imported as the authoritative
  // provider_api actual -- a silent monthly under-count that then won the
  // reconcile against the correct manual estimate. The cursor is now followed
  // (next_page passed back as the `page` query param) until has_more is false;
  // an unterminated or cursor-less continuation throws, failing the whole run
  // instead of importing a partial total.
  async collectRaw(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }> {
    const startIso = new Date(opts.periodStart * 1000).toISOString()
    const endIso = new Date(opts.periodEnd * 1000).toISOString()
    const baseUrl = `${ANTHROPIC_COST_URL}?starting_at=${encodeURIComponent(startIso)}&ending_at=${encodeURIComponent(endIso)}`
    // secret used ONLY as the auth header; never logged.
    const headers = {
      'x-api-key': opts.secret,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    }
    const buckets: AnthropicCostBucket[] = []
    let cursor: string | null = null
    for (let pageNo = 1; ; pageNo++) {
      if (pageNo > MAX_COST_REPORT_PAGES) {
        throw new Error(`anthropic cost_report pagination exceeded ${MAX_COST_REPORT_PAGES} pages -- aborting rather than importing a partial month`)
      }
      const url = cursor ? `${baseUrl}&page=${encodeURIComponent(cursor)}` : baseUrl
      const rawPage = await opts.httpGetJson(url, headers)
      const page = (rawPage && typeof rawPage === 'object') ? rawPage as AnthropicCostReport : {}
      if (Array.isArray(page.data)) buckets.push(...page.data)
      if (!page.has_more) break
      if (!page.next_page) {
        throw new Error('anthropic cost_report has_more=true without a next_page cursor -- aborting rather than importing a partial month')
      }
      cursor = page.next_page
    }
    // All pages merged into one report-shaped raw (same keys as a single page,
    // so the dry-run shape description stays representative).
    const raw: AnthropicCostReport = { data: buckets, has_more: false }
    const lines = mapAnthropicCostReport(raw, {
      periodStart: opts.periodStart, periodEnd: opts.periodEnd,
      fxUsdHuf: opts.fxUsdHuf, idSalt: opts.idSalt, now: opts.now,
    })
    return { raw, lines }
  },
  async collect(opts: CollectOpts): Promise<NormalizedCostLine[]> {
    return (await this.collectRaw!(opts)).lines
  },
}

/**
 * Vault secret id for the Anthropic ADMIN API key (organisation cost report).
 * This is NOT the key any agent runs on -- the Admin API needs an admin-scoped
 * key, which a normal API key cannot substitute for.
 */
export const ANTHROPIC_VAULT_SECRET_ID = 'anthropic_admin_key'

/**
 * P2-C: LIVE read-only Anthropic cost-report sync.
 *
 * The collector above shipped with the mapper, the fixture and the request
 * builder -- and ZERO call sites, in production or in a scheduler. It was dead
 * code, which is the same defect P2-A already paid a gate cycle for
 * (correlateTokenUsageToDispatches had storage but no invocation). This wrapper is
 * the call site, mirroring syncOpenAiCollector exactly.
 *
 * When no admin key is in the Vault this returns a precise, non-secret blocker and
 * imports NOTHING -- it never falls back to a guess. Note also what this does NOT
 * provide: cost is not capacity. Claude quota/usage has no API at all; that gap is
 * handled honestly in anthropic-usage.ts.
 */
export async function syncAnthropicCostReport(
  db: import('better-sqlite3').Database,
  now: number,
  deps: { httpGetJson?: import('./types.js').HttpGetJson; apiKey?: string | null; fxUsdHuf?: number } = {},
): Promise<{ ok: boolean; provider: string; status: string; imported_count: number; error?: string; period?: string }> {
  const { runCollector } = await import('./runner.js')
  const { monthWindow } = await import('../ledger.js')
  let apiKey = deps.apiKey
  if (apiKey === undefined) {
    try {
      const { getSecret } = await import('../../web/vault.js')
      apiKey = getSecret(ANTHROPIC_VAULT_SECRET_ID)
    } catch { apiKey = null }
  }
  if (!apiKey) {
    return {
      ok: false, provider: 'anthropic', status: 'error', imported_count: 0,
      error: `no Anthropic admin key in vault (${ANTHROPIC_VAULT_SECRET_ID})`,
    }
  }
  let fxUsdHuf = deps.fxUsdHuf
  if (fxUsdHuf === undefined) {
    // COS-OPS-M6: the rate comes from the provider-neutral fx config, NOT from
    // the Render plan-pricing file it used to be read out of -- an fx rate was
    // never a Render fact, and reading it from there meant cleaning up the
    // dead Render config silently zeroed this collector's conversion (the
    // teeth behind COS-OPS-H4). fx-config.ts already seeds itself one-time
    // from the legacy fx_usd_huf, so a configured rate is not lost. Dynamic
    // import to match syncOpenAiCollector exactly and keep this module's
    // static import graph free of the config layer.
    try {
      const { loadFxRates } = await import('../fx-config.js')
      fxUsdHuf = loadFxRates().rates.USD ?? 0
    } catch { fxUsdHuf = 0 }
  }
  // Card 23912ca4 / COS-OPS-H4: fail fast with an explicit blocker instead of
  // silently storing a fabricated 0 HUF line (the mapper also guards this on
  // its own, but the point of failing HERE is the actionable error message).
  // This guard originally landed on the OpenAI collector only; anthropic and
  // github kept fabricating 0-HUF provider_api lines that outranked the real
  // manual estimates.
  if (!(fxUsdHuf > 0)) {
    return {
      ok: false, provider: 'anthropic', status: 'error', imported_count: 0,
      error: 'USD->HUF rate is not configured (store/costops-fx.json) -- costs were NOT converted or stored; set the rate and re-run',
    }
  }
  const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'GET', headers })
    if (!r.ok) throw new Error(`anthropic admin api ${r.status}`)
    return r.json()
  })
  const w = monthWindow(now)
  const opts = { periodStart: w.start, periodEnd: w.end, secret: apiKey, fxUsdHuf, idSalt: 'anthropic-salt', httpGetJson, now }
  const res = await runCollector({ db, collector: anthropicCollector, opts, now })
  return {
    ok: res.status === 'ok', provider: 'anthropic', status: res.status,
    imported_count: res.importedCount, error: res.errorMessageSanitized || undefined, period: w.key,
  }
}
