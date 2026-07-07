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

export interface CostWarning {
  code: string
  severity: WarningSeverity
  provider: string
  message: string
  detail?: unknown
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
    })
  }

  // 2. provider sync stale / failed.
  for (const p of summary.provider_sync) {
    if (p.status === 'failed') {
      warnings.push({
        code: 'provider_sync_failed', severity: 'medium', provider: p.provider,
        message: `${p.provider} szinkron sikertelen (${p.error_code ?? 'ismeretlen hiba'}).`,
        detail: { last_success: p.last_success, error_code: p.error_code },
      })
    } else if (p.stale) {
      warnings.push({
        code: 'provider_sync_stale', severity: 'low', provider: p.provider,
        message: `${p.provider} adat elavult (${Math.round((p.data_age_secs ?? 0) / 86400)} napja nem szinkronizált).`,
        detail: { data_age_secs: p.data_age_secs, last_sync: p.last_sync },
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
    })
  }

  return warnings
}
