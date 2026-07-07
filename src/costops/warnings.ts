// CostOps v0.7 -- deterministic warnings.
//
// Pure derivation from an already-computed CostSummary + subscription
// lifecycle + a direct read-only query for pending_permission sources. No
// LLM, no network, no new writes. Every rule is a plain threshold check --
// same warning inputs always produce the same warnings array.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import type { CostSummary } from './ledger.js'
import { monthWindow } from './ledger.js'
import type { SubscriptionLifecycle } from './subscriptions.js'

export type WarningSeverity = 'low' | 'medium' | 'high'

// v0.7/v2 typed extension (card bea78483). Additive on top of the original
// {code,severity,provider,message,detail} shape -- every existing rule keeps
// working, these fields are populated wherever meaningful and left undefined
// otherwise (never fabricated, e.g. a warning with no natural threshold has
// no `threshold` field rather than a made-up one).
export type WarningType = 'cost' | 'quota' | 'expiry' | 'access'
export type WarningConfidence = 'measured' | 'estimated' | 'manual' | 'no_api_or_no_access'

export interface CostWarning {
  code: string
  severity: WarningSeverity
  provider: string
  message: string
  detail?: unknown
  warning_type: WarningType
  category: string       // 'hosting' | 'ai' | 'productivity' | 'domains' | 'budget' | 'other'
  action?: string         // human next-step suggestion
  threshold?: number
  current_value?: number
  unit?: string           // '%' | 'day' | 'HUF' | ...
  due_date?: string       // ISO date -- expected charge/renewal
  reset_date?: string     // ISO date/datetime -- quota reset
  expiry_date?: string    // ISO date -- cert/domain expiry
  source: string          // 'ledger' | 'config' | 'render_api' | 'workspace_alert' | 'tls' | 'rdap'
  confidence: WarningConfidence
}

// Card bea78483's UI drill-down mapping: Render->hosting, Claude/DeepSeek/Google
// AI->ai, Google Workspace->productivity, Domain/SSL->domains. Shared by every
// rule so old and new warnings categorize consistently.
export function categoryForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'render' || p === 'vercel' || p === 'cloudflare') return 'hosting'
  if (p === 'anthropic' || p === 'openai' || p === 'deepseek' || p === 'google-ai') return 'ai'
  if (p === 'google-workspace' || p === 'workspace') return 'productivity'
  if (p === 'domain' || p === 'ssl' || p === 'dns') return 'domains'
  if (p === 'all') return 'budget'
  return 'other'
}

// A provider/source change or manual-fallback share below this fraction of
// operational spend is noise, not a warning -- keeps the list actionable.
const MATERIAL_FRACTION = 0.15

export function getWarnings(
  db: Database.Database,
  _config: CostOpsConfig,
  now: number,
  summary: CostSummary,
  subscriptions: SubscriptionLifecycle[],
): CostWarning[] {
  const warnings: CostWarning[] = []

  // 1. forecast vs budget -- reuse the already-computed budget.status (operational-based).
  if (summary.budget && summary.budget.status !== 'ok') {
    warnings.push({
      code: 'forecast_over_budget',
      severity: summary.budget.status === 'hard' ? 'high' : 'medium',
      provider: 'all',
      message: summary.budget.status === 'hard'
        ? `Havi büdzsé túllépve vagy azon: ${Math.round(summary.budget.operational_used_pct * 100)}% elköltve.`
        : `Előrejelzés a büdzsé ${Math.round(summary.budget.operational_forecast_pct * 100)}%-át éri el hónap végére.`,
      detail: { used_pct: summary.budget.operational_used_pct, forecast_pct: summary.budget.operational_forecast_pct, threshold: summary.budget.warning_threshold },
      warning_type: 'cost', category: 'budget', source: 'ledger', confidence: 'measured',
      threshold: Math.round(summary.budget.warning_threshold * 100), current_value: Math.round(summary.budget.operational_used_pct * 100), unit: '%',
      action: summary.budget.status === 'hard' ? 'Csökkentsd a költést vagy emeld a büdzsét.' : 'Kövesd a hónap hátralévő részét, közel a limithez.',
    })
  }

  // 2. provider sync stale / failed.
  for (const p of summary.provider_sync) {
    if (p.status === 'failed') {
      warnings.push({
        code: 'provider_sync_failed', severity: 'medium', provider: p.provider,
        message: `${p.provider} szinkron sikertelen (${p.error_code ?? 'ismeretlen hiba'}).`,
        detail: { last_success: p.last_success, error_code: p.error_code },
        warning_type: 'access', category: categoryForProvider(p.provider), source: 'ledger', confidence: 'measured',
        action: 'Ellenőrizd a szolgáltató API-kulcsát/jogosultságát.',
      })
    } else if (p.stale) {
      warnings.push({
        code: 'provider_sync_stale', severity: 'low', provider: p.provider,
        message: `${p.provider} adat elavult (${Math.round((p.data_age_secs ?? 0) / 86400)} napja nem szinkronizált).`,
        detail: { data_age_secs: p.data_age_secs, last_sync: p.last_sync },
        warning_type: 'access', category: categoryForProvider(p.provider), source: 'ledger', confidence: 'measured',
        current_value: Math.round((p.data_age_secs ?? 0) / 86400), unit: 'day',
      })
    }
  }

  // 3. expected invoice missing -- a subscription past its next charge date with no update.
  for (const s of subscriptions) {
    if (s.past_due) {
      warnings.push({
        code: 'expected_invoice_missing', severity: 'medium', provider: s.provider,
        message: `${s.name}: várt számla/díjterhelés (${s.next_renewal}) elmúlt, nincs friss adat.`,
        detail: { subscription_id: s.id, next_renewal: s.next_renewal, days_overdue: s.days_until_next_date !== null ? -s.days_until_next_date : null },
        warning_type: 'expiry', category: categoryForProvider(s.provider), source: 'config', confidence: 'manual',
        due_date: s.next_renewal, current_value: s.days_until_next_date !== null ? -s.days_until_next_date : undefined, unit: 'day',
      })
    }
  }

  // 4. high-cost provider still on manual fallback (material share of operational spend).
  const totalOp = summary.operational_spend || 0
  if (totalOp > 0) {
    for (const src of summary.all_sources) {
      const isFallback = src.confidence === 'manual' || src.confidence === 'estimate'
      if (isFallback && src.spend / totalOp >= MATERIAL_FRACTION) {
        warnings.push({
          code: 'high_cost_manual_fallback', severity: 'low', provider: src.provider,
          message: `${src.name}: a költség jelentős hányada (${Math.round((src.spend / totalOp) * 100)}%) kézi/becsült adaton alapul, nincs valódi számla/API forrás.`,
          detail: { source_id: src.source_id, spend: src.spend, share: Math.round((src.spend / totalOp) * 100) / 100 },
          warning_type: 'cost', category: categoryForProvider(src.provider), source: 'ledger', confidence: 'estimated',
          current_value: Math.round((src.spend / totalOp) * 100), threshold: Math.round(MATERIAL_FRACTION * 100), unit: '%',
        })
      }
    }
  }

  // 5. plan estimate materially differs from actual/manual (Render render_plan block).
  if (summary.render_plan) {
    const base = summary.render_plan.manual_estimate || summary.render_plan.plan_estimate_total || 1
    if (Math.abs(summary.render_plan.variance) / base >= MATERIAL_FRACTION) {
      warnings.push({
        code: 'plan_estimate_variance', severity: 'low', provider: 'render',
        message: `Render terv-alapú becslés (${summary.render_plan.plan_estimate_total}) jelentősen eltér a kézi becsléstől (${summary.render_plan.manual_estimate}).`,
        detail: { plan_estimate_total: summary.render_plan.plan_estimate_total, manual_estimate: summary.render_plan.manual_estimate, variance: summary.render_plan.variance },
        warning_type: 'cost', category: 'hosting', source: 'ledger', confidence: 'estimated',
        current_value: summary.render_plan.plan_estimate_total, unit: summary.render_plan.currency,
      })
    }
  }

  // 6. invoice amount materially changed vs previous month, per provider.
  if (summary.previous_month) {
    const prevByProvider = new Map(summary.previous_month.by_provider.map(p => [p.provider, p.spend]))
    for (const cur of summary.operational.provider_breakdown) {
      const prev = prevByProvider.get(cur.provider)
      if (prev !== undefined && prev > 0 && Math.abs(cur.spend - prev) / prev >= MATERIAL_FRACTION) {
        warnings.push({
          code: 'invoice_amount_changed', severity: 'low', provider: cur.provider,
          message: `${cur.provider}: ${prev} -> ${cur.spend} (${Math.round(((cur.spend - prev) / prev) * 100)}% változás az előző hónaphoz képest).`,
          detail: { previous: prev, current: cur.spend },
          warning_type: 'cost', category: categoryForProvider(cur.provider), source: 'ledger', confidence: 'measured',
          current_value: cur.spend, unit: summary.currency,
        })
      }
    }
  }

  // 7. billing_access_needed -- a tracked provider whose cost cannot currently be read
  // (v0.7 AWS addendum: confidence='pending_permission', never fabricated as 0/manual).
  const win = monthWindow(now, summary.month)
  const pendingRows = db.prepare(`
    SELECT DISTINCT cs.id as source_id, cs.name, cs.provider
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.confidence = 'pending_permission'
      AND cli.charge_period_start < @end AND cli.charge_period_end > @start
  `).all({ start: win.start, end: win.end }) as Array<{ source_id: string; name: string; provider: string }>
  for (const p of pendingRows) {
    warnings.push({
      code: 'billing_access_needed', severity: 'medium', provider: p.provider,
      message: `${p.name}: a valós költség nem olvasható ki (hiányzó jogosultság a szolgáltató számlázási API-jához). Nincs kitalált összeg.`,
      detail: { source_id: p.source_id },
      warning_type: 'access', category: categoryForProvider(p.provider), source: 'config', confidence: 'no_api_or_no_access',
      action: 'Adj IAM/API jogosultságot a számlázási adathoz, vagy add meg kézzel az összeget.',
    })
  }

  // 8. Render spend-limit -- Render has no public billing API (verified live,
  // see render-no-public-billing-api). Always pending, never fabricated;
  // low-severity so it sits in the drill-down, not the top actionable list.
  warnings.push({
    code: 'render_spend_limit_unknown', severity: 'low', provider: 'render',
    message: 'Render költési limit nem lekérdezhető (nincs publikus billing API).',
    warning_type: 'quota', category: 'hosting', source: 'config', confidence: 'no_api_or_no_access',
    action: 'Kövesd kézzel a Render dashboardon (Settings -> Billing).',
  })

  // 9. Claude Max weekly limit -- no official usage API; only manually visible
  // (agent tmux panes show a rolling %/reset time). Always pending.
  warnings.push({
    code: 'claude_max_weekly_limit_unknown', severity: 'low', provider: 'anthropic',
    message: 'Claude Max heti limit nem lekérdezhető API-n -- az ágens paneleken (X% / HH:mm reset) manuálisan látható.',
    warning_type: 'quota', category: 'ai', source: 'config', confidence: 'no_api_or_no_access',
  })

  // 10. DeepSeek prepaid balance -- the collector's balance endpoint DOES exist
  // (live, read-only). % remaining is derived vs the highest balance snapshot
  // seen (a proxy for the last top-up) -- never a fabricated absolute limit.
  // Silent when healthy or when there's no snapshot history yet to compare.
  const dsRows = db.prepare(`SELECT balance, captured_at FROM provider_balance_snapshots WHERE provider = 'deepseek' ORDER BY captured_at DESC`).all() as Array<{ balance: number; captured_at: number }>
  if (dsRows.length === 0) {
    warnings.push({
      code: 'deepseek_balance_unknown', severity: 'low', provider: 'deepseek',
      message: 'DeepSeek egyenleg még nincs rögzítve (nincs korábbi snapshot az arány kiszámításához).',
      warning_type: 'quota', category: 'ai', source: 'config', confidence: 'no_api_or_no_access',
    })
  } else {
    const latest = dsRows[0].balance
    const peak = Math.max(...dsRows.map(r => r.balance))
    if (peak > 0) {
      const pct = Math.round((latest / peak) * 10000) / 100
      const severity = pct <= 5 ? 'high' : pct <= 15 ? 'medium' : pct <= 30 ? 'low' : null
      if (severity) {
        warnings.push({
          code: 'deepseek_balance_low', severity, provider: 'deepseek',
          message: `DeepSeek előre fizetett egyenleg alacsony: ${pct}% a legutóbbi feltöltéshez képest.`,
          detail: { latest_balance: latest, peak_balance: peak },
          warning_type: 'quota', category: 'ai', source: 'ledger', confidence: 'estimated',
          current_value: pct, threshold: 30, unit: '%',
          action: 'Töltsd fel a DeepSeek egyenleget.',
        })
      }
    }
  }

  return warnings
}
