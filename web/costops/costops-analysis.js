// CostOps Command Center -- Elemzés nézet (UI-2 cards #5-6-8).
// Chart aggregates by the selected Bontás dimension (provider/source_type/confidence -- NOT a
// client-invented "category" map, see GROUP_OPTIONS comment below); the detail table stays
// source-granular per spec 5.5 regardless of the chart's grouping. Chart-bar click and
// table-row click both set the same filter chip (analyze.filters), matching spec 5.4.
window.Costops = window.Costops || {}

;(function () {
  const C = () => window.Costops.Charts
  const esc = (s) => window.Costops.Charts.esc(s)
  const fmtHuf = (n) => window.Costops.Charts.fmtHuf(n)

  const PERIOD_OPTIONS = [
    { value: '1', label: 'Aktuális hónap' },
    { value: '3', label: 'Utolsó 3 hónap' },
    { value: '6', label: 'Utolsó 6 hónap' },
    { value: '12', label: 'Utolsó 12 hónap' },
  ]

  // 'category' intentionally excluded: the backend has no category concept (only source_type),
  // and inventing a client-side provider->category map is the exact anti-pattern the UI-0 audit
  // flagged in the old costs-v2 view (CAT()). If/when a real category field lands, add it here.
  const GROUP_OPTIONS = [
    { value: 'provider', label: 'Provider' },
    { value: 'source_type', label: 'Szolgáltatástípus' },
    { value: 'confidence', label: 'Provenance' },
  ]

  const COMPARE_OPTIONS = [
    { value: 'none', label: 'Nincs' },
    { value: 'prev_month', label: 'Előző hónap' },
    { value: 'budget', label: 'Budget' },
    { value: 'forecast_vs_actual', label: 'Forecast vs actual' },
  ]

  function groupKeyOf(source, group) {
    if (group === 'provider') return source.provider || 'ismeretlen'
    if (group === 'source_type') return source.source_type || 'egyéb'
    return source.confidence || 'ismeretlen'
  }

  // Applies every active filter chip EXCEPT (optionally) one dimension -- used to keep the chart
  // and the table showing consistent totals when a filter from a DIFFERENT dimension than the
  // current Bontás group is active (e.g. filtered by provider while grouped by source_type).
  function applyFilters(sources, filters, excludeGroup) {
    let rows = sources || []
    Object.keys(filters || {}).forEach((g) => {
      if (g === excludeGroup) return
      rows = rows.filter((s) => groupKeyOf(s, g) === filters[g])
    })
    return rows
  }

  function aggregateByGroup(allSources, group) {
    const map = new Map()
    ;(allSources || []).forEach((s) => {
      const key = groupKeyOf(s, group)
      const row = map.get(key) || { key, spend: 0, forecast: 0 }
      row.spend += s.spend || 0
      row.forecast += s.forecast_month_end || 0
      map.set(key, row)
    })
    return Array.from(map.values()).sort((a, b) => b.spend - a.spend)
  }

  function humanize(s) { return String(s || '').replace(/_/g, ' ') }

  function controlsHtml(state) {
    const opt = (list, current) => list.map((o) => `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
    const compareDisabledNote = state.analyze.group !== 'provider' && state.analyze.compare === 'prev_month'
      ? '<div class="cc-muted" style="margin-top:4px">Havi összehasonlítás ma csak provider-bontásnál elérhető (a backend nem tárol havi historikus bontást szolgáltatástípus/provenance szerint).</div>'
      : ''
    return `
      <div class="cc-controls">
        <label>Időszak <select id="ccAnalyzePeriod">${opt(PERIOD_OPTIONS, state.analyze.period)}</select></label>
        <label>Bontás <select id="ccAnalyzeGroup">${opt(GROUP_OPTIONS, state.analyze.group)}</select></label>
        <label>Összehasonlítás <select id="ccAnalyzeCompare">${opt(COMPARE_OPTIONS, state.analyze.compare)}</select></label>
      </div>
      ${compareDisabledNote}`
  }

  function chipsHtml(filters) {
    const keys = Object.keys(filters || {})
    if (!keys.length) return ''
    const chips = keys.map((k) => `<span class="cc-chip" data-chip-key="${esc(k)}">${esc(humanize(filters[k]))} <button class="cc-chip-x" data-chip-remove="${esc(k)}">×</button></span>`).join('')
    return `<div class="cc-chips">${chips}<button class="cc-chip-clear" id="ccClearFilters">Minden szűrő törlése</button></div>`
  }

  function chartHtml(state, summary, period) {
    const group = state.analyze.group
    const compare = state.analyze.compare
    const scoped = applyFilters(summary.all_sources, state.analyze.filters, group)
    const groups = aggregateByGroup(scoped, group)
    const max = Math.max(1, ...groups.map((g) => g.spend))
    const filterVal = state.analyze.filters[group]

    if (compare === 'prev_month' && group === 'provider') {
      // period.previous is a full MonthlyPeriod (getPeriodTrend, period.ts), distinct from
      // /api/costs/summary's own separately-shaped previous_month field -- verified both
      // shapes directly in period.ts/ledger.ts rather than assuming they match.
      const prevByProvider = new Map((period.previous?.provider_breakdown || []).map((p) => [p.provider, p.spend]))
      const max2 = Math.max(1, ...groups.map((g) => Math.max(g.spend, prevByProvider.get(g.key) || 0)))
      return groups.map((g) => C().pairedBarRow({
        label: g.key, current: g.spend, previous: prevByProvider.get(g.key) || 0, max: max2,
        filterKey: g.key, active: filterVal === g.key,
      })).join('')
    }
    if (compare === 'budget') return '' // rendered separately, see renderBudgetPanel
    if (compare === 'forecast_vs_actual') return '' // rendered separately, see renderForecastPanel
    return groups.map((g) => C().barRow({
      label: g.key, value: g.spend, max, filterKey: g.key, active: filterVal === g.key,
    })).join('')
  }

  function renderBudgetPanel(budgets) {
    if (!budgets || !budgets.length) return '<div class="cc-muted">Nincs beállított budget.</div>'
    return budgets.map((b) => `
      <div class="cc-bar-row">
        <div class="cc-bar-label" title="${esc(b.name || b.id)}">${esc(b.name || b.id)}</div>
        <div class="cc-bar-track"><div class="cc-bar-fill ${b.status === 'hard' ? 'cc-over' : b.status === 'warning' ? 'cc-warn' : 'cc-ok'}" style="width:${Math.min(100, Math.round((b.used_pct || 0) * 100))}%"></div></div>
        <div class="cc-bar-value">${fmtHuf(b.current_spend)} / ${fmtHuf(b.amount)}</div>
      </div>`).join('')
  }

  function renderForecastPanel(snapshots) {
    if (!snapshots || !snapshots.length) return '<div class="cc-muted">Nincs forecast-snapshot ehhez a hónaphoz.</div>'
    const rows = snapshots.slice(0, 20).map((s) => `
      <tr>
        <td>${esc(s.source_id)}</td><td>${esc(s.method)}</td>
        <td class="cc-num">${fmtHuf(s.forecast_amount)}</td>
        <td class="cc-num">${s.actual_amount != null ? fmtHuf(s.actual_amount) : '–'}</td>
        <td class="cc-num">${s.forecast_error_percent != null ? Math.round(s.forecast_error_percent) + '%' : '–'}</td>
      </tr>`).join('')
    return `<table class="cc-table"><thead><tr><th>Forrás</th><th>Módszer</th><th>Forecast</th><th>Actual</th><th>Hiba %</th></tr></thead><tbody>${rows}</tbody></table>`
  }

  function tableHtml(sources, inventoryBySourceId, reconciliationBySourceId, filters) {
    const rows = applyFilters(sources, filters, null)
    if (!rows.length) return '<div class="cc-muted">Nincs a szűrésnek megfelelő forrás.</div>'
    const trs = rows.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0)).map((s) => {
      const inv = inventoryBySourceId.get(s.source_id)
      const rec = reconciliationBySourceId.get(s.source_id)
      return `
        <tr class="cc-table-row" data-source-id="${esc(s.source_id)}" tabindex="0" role="button">
          <td>${esc(s.name || s.source_id)}</td>
          <td>${esc(s.provider)}</td>
          <td>${esc(humanize(s.source_type))}</td>
          <td class="cc-num">${fmtHuf(s.spend)}</td>
          <td class="cc-num">${s.forecast_month_end != null ? fmtHuf(s.forecast_month_end) : '–'}</td>
          <td>${esc(humanize(s.confidence))}</td>
          <td>${inv ? esc(inv.freshness) : '–'}</td>
          <td>${rec ? esc(rec.status) : '–'}</td>
        </tr>`
    }).join('')
    return `
      <table class="cc-table">
        <thead><tr><th>Forrás</th><th>Provider</th><th>Típus</th><th>Költés</th><th>Forecast</th><th>Provenance</th><th>Freshness</th><th>Reconciliation</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`
  }

  function exportBarHtml(month) {
    const links = [
      ['source-inventory', 'Source inventory'],
      ['provider-summary', 'Provider summary'],
      ['category-summary', 'Category summary'],
      ['reconciliation', 'Reconciliation'],
    ]
    return `<div class="cc-export-bar">${links.map(([kind, label]) =>
      `<a class="cc-export-link" href="${window.Costops.Api.exportUrl(kind, { month })}" download>${esc(label)} (CSV)</a>`).join('')}</div>`
  }

  function wireEvents(root, state) {
    root.querySelector('#ccAnalyzePeriod')?.addEventListener('change', (e) => window.Costops.State.setAnalyze({ period: e.target.value }, true))
    root.querySelector('#ccAnalyzeGroup')?.addEventListener('change', (e) => window.Costops.State.setAnalyze({ group: e.target.value }, true))
    root.querySelector('#ccAnalyzeCompare')?.addEventListener('change', (e) => window.Costops.State.setAnalyze({ compare: e.target.value }, true))
    root.querySelector('#ccClearFilters')?.addEventListener('click', () => window.Costops.State.setAnalyze({ filters: {} }, false))
    root.querySelectorAll('[data-chip-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = Object.assign({}, state.analyze.filters)
        delete next[btn.dataset.chipRemove]
        window.Costops.State.setAnalyze({ filters: next }, false)
      })
    })
    root.querySelectorAll('[data-filter-value]').forEach((el) => {
      el.addEventListener('click', () => {
        const group = state.analyze.group
        const val = el.dataset.filterValue
        const next = Object.assign({}, state.analyze.filters)
        if (next[group] === val) delete next[group] // click active bar again -> clear
        else next[group] = val
        window.Costops.State.setAnalyze({ filters: next }, false)
      })
    })
    root.querySelectorAll('[data-source-id]').forEach((tr) => {
      tr.addEventListener('click', () => window.Costops.State.openDrawer('source', tr.dataset.sourceId))
    })
  }

  async function render(root, month) {
    const state = window.Costops.State.get()
    root.innerHTML = '<div class="cc-loading">Betöltés...</div>'
    let summary, period, inventory, reconciliation, budgets, forecasts
    try {
      [summary, period, inventory, reconciliation] = await Promise.all([
        window.Costops.Api.summary(month),
        window.Costops.Api.period(state.analyze.period, month),
        window.Costops.Api.sourceInventory().catch(() => ({ sources: [] })),
        window.Costops.Api.reconciliation(month).catch(() => ({ reconciliation: [] })),
      ])
      if (state.analyze.compare === 'budget') budgets = (await window.Costops.Api.budgets(month).catch(() => [])) || []
      if (state.analyze.compare === 'forecast_vs_actual') forecasts = (await window.Costops.Api.forecastSnapshots(month).catch(() => ({ snapshots: [] }))).snapshots || []
    } catch (e) {
      root.innerHTML = `<div class="cc-error">Betöltés sikertelen: ${esc(e.message)}</div>`
      return
    }

    const invBySource = new Map((inventory.sources || []).map((s) => [s.source_id, s]))
    const recBySource = new Map((reconciliation.reconciliation || []).map((r) => [r.source_id, r]))

    root.innerHTML = `
      ${controlsHtml(state)}
      ${chipsHtml(state.analyze.filters)}
      <div class="cc-section">
        <div class="cc-section-title">GRAFIKON</div>
        ${state.analyze.compare === 'budget' ? renderBudgetPanel(budgets)
          : state.analyze.compare === 'forecast_vs_actual' ? renderForecastPanel(forecasts)
          : chartHtml(state, summary, period)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">RÉSZLETES TÁBLA</div>
        ${exportBarHtml(month)}
        <div class="cc-table-wrap">${tableHtml(summary.all_sources, invBySource, recBySource, state.analyze.filters)}</div>
      </div>`
    wireEvents(root, state)
  }

  window.Costops.Analysis = { render }
})()
