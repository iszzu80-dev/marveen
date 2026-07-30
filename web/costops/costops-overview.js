// CostOps Command Center -- Áttekintés nézet (UI-1 card #2 + #3).
// Renders: cost-position hero, monthly trend, Figyelmet igényel (GET /api/costs/alerts),
// Top költségforrások, Adatbizalom (summary.confidence_breakdown directly -- no client-side
// recompute, per UI-1 GO instruction), Top megtakarítási lehetőség (GET /api/costs/recommendations).
window.Costops = window.Costops || {}

;(function () {
  const C = () => window.Costops.Charts
  const esc = (s) => window.Costops.Charts.esc(s)
  const fmtHuf = (n) => window.Costops.Charts.fmtHuf(n)

  function pct(n) { return Math.round((Number(n) || 0) * 100) }

  function confidenceColorClass(key) {
    const k = String(key || '').toLowerCase()
    if (k.includes('actual') || k === 'provider_api' || k === 'measured' || k === 'high') return 'cc-ok'
    if (k.includes('manual')) return 'cc-neutral'
    if (k.includes('estimate') || k === 'medium') return 'cc-warn'
    if (k.includes('stale') || k.includes('no_api') || k === 'low') return 'cc-over'
    return 'cc-muted-seg'
  }

  function humanizeKey(key) {
    return String(key || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }

  // ---- Figyelmet igényel: per-type formatter -----------------------------------------------
  // Alert `type` is an open string (src/costops/alerts-store.ts), not a closed enum -- these are
  // the types actually observed live (store/claudeclaw.db, 2026-07-15). Anything else falls back
  // to a generic, still-safe rendering instead of throwing.
  function describeAlert(a) {
    const ev = a.evidence || {}
    switch (a.type) {
      case 'balance_exhaustion':
        return {
          title: `${esc(ev.provider)} egyenleg kifogy ~${Math.max(0, Math.round(ev.days_ahead))} nap múlva`,
          impact: null,
          impactLabel: `${ev.remaining} ${esc(ev.currency)} maradt`,
        }
      case 'manual_provider_variance':
        return {
          title: `Kézi és provider-adat eltérés (${esc(ev.provider)})`,
          impact: Math.abs(ev.variance || 0),
          impactLabel: `${fmtHuf(Math.abs(ev.variance || 0))} eltérés`,
        }
      case 'unusual_spend_growth':
        return {
          title: `Szokatlan költségnövekedés (${esc(ev.key)})`,
          impact: Math.max(0, (ev.current_amount || 0) - (ev.baseline_amount || 0)),
          impactLabel: `+${Math.round(ev.growth_pct || 0)}% a korábbi átlaghoz képest`,
        }
      default:
        return { title: `${esc(a.type)}`, impact: null, impactLabel: '' }
    }
  }

  const SEVERITY_RANK = { critical: 0, high: 1, warning: 2, medium: 3, low: 4, info: 5 }
  function rankAlert(a) {
    const d = describeAlert(a)
    return [SEVERITY_RANK[a.severity] ?? 9, -(d.impact || 0), -a.last_seen]
  }
  function cmpTuple(x, y) { for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] - y[i] } return 0 }

  function renderAttention(alerts) {
    if (!alerts.length) return '<div class="cc-muted">Nincs figyelmet igénylő tétel.</div>'
    const top = alerts.slice().sort((a, b) => cmpTuple(rankAlert(a), rankAlert(b))).slice(0, 5)
    return top.map((a) => {
      const d = describeAlert(a)
      return `
        <div class="cc-attn-row cc-sev-${esc(a.severity)} cc-bar-clickable" data-drawer-type="alert" data-drawer-id="${esc(a.dedup_key)}" tabindex="0" role="button">
          <div class="cc-attn-sev">${esc(a.severity)}</div>
          <div class="cc-attn-body">
            <div class="cc-attn-title">${d.title}</div>
            ${d.impactLabel ? `<div class="cc-attn-sub">${esc(d.impactLabel)}</div>` : ''}
          </div>
        </div>`
    }).join('')
  }

  function renderSavings(recs) {
    if (!recs.length) return '<div class="cc-muted">Nincs jelenleg nyitott megtakarítási ajánlás.</div>'
    // Show what exists -- do not pad to 3 (UI-1 GO instruction).
    const top = recs.slice().sort((a, b) => (b.estimated_monthly_saving || 0) - (a.estimated_monthly_saving || 0)).slice(0, 3)
    const total = top.reduce((s, r) => s + (r.estimated_monthly_saving || 0), 0)
    return `
      <div class="cc-savings-total">${fmtHuf(total)}/hó</div>
      ${top.map((r) => `
        <div class="cc-savings-row cc-bar-clickable" data-drawer-type="recommendation" data-drawer-id="${esc(r.dedup_key)}" tabindex="0" role="button">
          <div class="cc-savings-label">${esc(r.type.replace(/_/g, ' '))}</div>
          <div class="cc-savings-value">${fmtHuf(r.estimated_monthly_saving)}/hó</div>
        </div>`).join('')}`
  }

  function renderTopSources(allSources) {
    const sorted = (allSources || []).slice().sort((a, b) => (b.spend || 0) - (a.spend || 0)).slice(0, 5)
    if (!sorted.length) return '<div class="cc-muted">Nincs forrás.</div>'
    const max = Math.max(1, ...sorted.map((s) => s.spend || 0))
    return sorted.map((s) => C().barRow({
      label: s.name || s.source_id, value: s.spend, max,
      sub: s.forecast_month_end != null ? `forecast ${fmtHuf(s.forecast_month_end)}` : undefined,
    })).join('')
  }

  function renderDataTrust(confidenceBreakdown) {
    const segments = Object.keys(confidenceBreakdown || {}).map((k) => ({
      label: humanizeKey(k), value: confidenceBreakdown[k], colorClass: confidenceColorClass(k),
    }))
    return C().segmentedBar(segments)
  }

  // ---- P2-C: ELŐFIZETÉS / KAPACITÁS ---------------------------------------------------------
  // Every figure arrives as { value, confidence, freshness, blocker, unit }. A null value is
  // rendered as "nincs adat" WITH its blocker as the tooltip -- never as 0, because a 0 that
  // means "measured zero" and a 0 that means "we cannot see it" look identical on a dashboard
  // and are opposite facts. Confidence is always shown next to the number, so a manual reading
  // never sits on screen looking like a live measurement.
  const CONFIDENCE_LABEL = {
    measured: 'mért',
    manual: 'kézi',
    inferred: 'következtetett',
    unknown: 'nincs adat',
  }

  function confidenceBadge(conf) {
    const cls = conf === 'measured' ? 'cc-ok' : conf === 'manual' ? 'cc-neutral' : conf === 'inferred' ? 'cc-warn' : 'cc-muted-seg'
    return `<span class="cc-conf-badge ${cls}">${esc(CONFIDENCE_LABEL[conf] || conf)}</span>`
  }

  function freshnessLabel(fr) {
    if (!fr || fr.as_of == null) return 'nincs megfigyelés'
    const mins = Math.floor((fr.age_seconds || 0) / 60)
    const human = mins < 60 ? mins + ' perc' : mins < 1440 ? Math.floor(mins / 60) + ' óra' : Math.floor(mins / 1440) + ' nap'
    return (fr.stale ? 'ELAVULT · ' : '') + human
  }

  // Renders a percentage figure, or an explicit no-data cell carrying the reason.
  function figurePct(f) {
    if (!f || f.value == null) {
      return `<span class="cc-muted" title="${esc((f && f.blocker) || 'nincs adat')}">nincs adat</span> ${confidenceBadge('unknown')}`
    }
    return `<span class="cc-cap-value">${pct(f.value)}%</span> ${confidenceBadge(f.confidence)}`
  }

  function figureCount(f) {
    if (!f || f.value == null) {
      return `<span class="cc-muted" title="${esc((f && f.blocker) || 'nincs adat')}">nincs adat</span> ${confidenceBadge('unknown')}`
    }
    return `<span class="cc-cap-value">${esc(String(f.value))}</span> ${confidenceBadge(f.confidence)}`
  }

  function renderCapacity(payload) {
    const cap = payload && payload.capacity
    const rows = (cap && cap.subscriptions) || []
    if (!rows.length) {
      const why = (cap && cap.notes && cap.notes[0]) || 'Nincs konfigurált előfizetés.'
      return `<div class="cc-muted">${esc(why)}</div>`
    }
    const body = rows.map((s) => {
      const bc = s.billing_cycle || {}
      const cycle = [
        bc.period && bc.period !== 'unknown' ? bc.period : 'ciklus: nincs megadva',
        bc.next_renewal ? 'megújul ' + bc.next_renewal : null,
        bc.paid_until ? 'fizetve ' + bc.paid_until : null,
        bc.past_due ? 'LEJÁRT' : null,
      ].filter(Boolean).join(' · ')
      return `
        <div class="cc-cap-row">
          <div class="cc-cap-head">
            <span class="cc-cap-name">${esc(s.name)}</span>
            <span class="cc-cap-status cc-sev-${esc(s.status)}">${esc(s.status)}</span>
            <span class="cc-cap-sub">${esc(cycle)}</span>
          </div>
          <div class="cc-cap-grid">
            <div class="cc-cap-cell"><div class="cc-cap-label">Felhasználva</div><div>${figurePct(s.usage)}</div>
              <div class="cc-cap-fresh">${esc(freshnessLabel(s.usage && s.usage.freshness))}</div></div>
            <div class="cc-cap-cell"><div class="cc-cap-label">Kihasználatlan</div><div>${figurePct(s.unused_capacity)}</div></div>
            <div class="cc-cap-cell"><div class="cc-cap-label">Túlfolyás</div><div>${figurePct(s.overflow)}</div></div>
            <div class="cc-cap-cell"><div class="cc-cap-label">Blokkolt munka</div><div>${figureCount(s.blocked_work)}</div></div>
            <div class="cc-cap-cell"><div class="cc-cap-label">API-ra tolt munka</div><div>${figureCount(s.work_pushed_to_api)}</div></div>
          </div>
        </div>`
    }).join('')
    const notes = (cap.notes || []).map((n) => `<div class="cc-cap-note">${esc(n)}</div>`).join('')
    return body + notes
  }

  function renderHero(summary) {
    const b = summary.budget
    const forecastPct = b ? pct(b.operational_forecast_pct) : null
    const mom = summary.month_over_month_delta
    const momLabel = mom == null ? '' : `${mom >= 0 ? '+' : ''}${fmtHuf(mom)} MoM`
    return `
      <div class="cc-hero">
        <div class="cc-hero-title">${esc(summary.month)} KÖLTSÉGPOZÍCIÓ</div>
        <div class="cc-hero-row">
          <div class="cc-hero-metric">
            <div class="cc-hero-value">${fmtHuf(summary.operational_spend)}</div>
            <div class="cc-hero-label">Aktuális költés${momLabel ? ' · ' + esc(momLabel) : ''}</div>
          </div>
          <div class="cc-hero-metric">
            <div class="cc-hero-value">${fmtHuf(summary.operational_forecast_month_end)}</div>
            <div class="cc-hero-label">Hónap végi forecast${b ? ` · ${forecastPct}% a budgetből` : ''}</div>
          </div>
        </div>
        ${b ? `
          <div class="cc-hero-budget-label">Budget: ${fmtHuf(b.amount)}</div>
          <div class="cc-bar-track cc-hero-budget-track">
            <div class="cc-bar-fill ${b.status === 'hard' ? 'cc-over' : b.status === 'warning' ? 'cc-warn' : 'cc-ok'}" style="width:${Math.min(100, pct(b.operational_used_pct))}%"></div>
          </div>` : '<div class="cc-muted">Nincs beállított budget.</div>'}
      </div>`
  }

  async function render(root, month) {
    root.innerHTML = '<div class="cc-loading">Betöltés...</div>'
    let summary, period, alerts, recommendations, subscriptions
    try {
      [summary, period, alerts, recommendations, subscriptions] = await Promise.all([
        window.Costops.Api.summary(month),
        window.Costops.Api.period(6, month),
        window.Costops.Api.alerts('active').catch(() => ({ alerts: [] })),
        window.Costops.Api.recommendations('open').catch(() => ({ recommendations: [] })),
        // P2-C: capacity must never take the whole Áttekintés down with it.
        window.Costops.Api.subscriptions().catch(() => null),
      ])
    } catch (e) {
      root.innerHTML = `<div class="cc-error">Betöltés sikertelen: ${esc(e.message)}</div>`
      return
    }

    root.innerHTML = `
      ${renderHero(summary)}
      <div class="cc-section">
        <div class="cc-section-title">KUMULÁLT KÖLTSÉGTREND (havi)</div>
        ${C().monthlyTrend(period.months || [])}
      </div>
      <div class="cc-grid-2">
        <div class="cc-section">
          <div class="cc-section-title">FIGYELMET IGÉNYEL</div>
          ${renderAttention(alerts.alerts || [])}
        </div>
        <div class="cc-section">
          <div class="cc-section-title">TOP KÖLTSÉGFORRÁSOK</div>
          ${renderTopSources(summary.all_sources)}
        </div>
      </div>
      <div class="cc-section">
        <div class="cc-section-title">ELŐFIZETÉS / KAPACITÁS</div>
        ${renderCapacity(subscriptions)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">ADATBIZALOM</div>
        ${renderDataTrust(summary.confidence_breakdown)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">TOP MEGTAKARÍTÁSI LEHETŐSÉG</div>
        ${renderSavings(recommendations.recommendations || [])}
      </div>`

    root.querySelectorAll('[data-drawer-type]').forEach((el) => {
      el.addEventListener('click', () => window.Costops.State.openDrawer(el.dataset.drawerType, el.dataset.drawerId))
    })
  }

  window.Costops.Overview = { render }
})()
