// CostOps Command Center -- shared, dependency-free chart primitives (plain HTML/CSS, no
// canvas/SVG library). Matches this repo's existing convention (app.js builds markup via string
// templates throughout) rather than introducing a charting dependency for UI-1's simple needs.
window.Costops = window.Costops || {}

;(function () {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function fmtHuf(n) {
    const v = Math.round(Number(n) || 0)
    return v.toLocaleString('hu-HU') + ' Ft'
  }

  // Single horizontal bar row: label | bar (width = value/max) | formatted value.
  function barRow({ label, value, max, colorClass, sub }) {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
    return `
      <div class="cc-bar-row">
        <div class="cc-bar-label" title="${esc(label)}">${esc(label)}</div>
        <div class="cc-bar-track"><div class="cc-bar-fill ${colorClass || ''}" style="width:${pct}%"></div></div>
        <div class="cc-bar-value">${fmtHuf(value)}${sub ? `<span class="cc-bar-sub">${esc(sub)}</span>` : ''}</div>
      </div>`
  }

  // Monthly trend (bar-per-month). Honest label: the backend (GET /api/costs/period) is
  // month-granular only -- there is no daily/weekly within-month series today (UI-0 audit
  // section 11.2, a flagged missing-API-contract gap), so this renders a monthly trend, not the
  // spec's exact daily-cumulative-within-month chart.
  function monthlyTrend(months) {
    const valid = (months || []).filter((m) => !m.no_data)
    const max = Math.max(1, ...valid.map((m) => m.operational_spend || 0))
    const bars = (months || []).map((m) => {
      const h = m.no_data ? 0 : Math.max(2, Math.round(((m.operational_spend || 0) / max) * 100))
      return `
        <div class="cc-trend-col" title="${esc(m.month)}: ${m.no_data ? 'nincs adat' : fmtHuf(m.operational_spend)}">
          <div class="cc-trend-bar-track"><div class="cc-trend-bar ${m.no_data ? 'cc-trend-nodata' : ''}" style="height:${h}%"></div></div>
          <div class="cc-trend-label">${esc(m.month.slice(5))}</div>
        </div>`
    }).join('')
    return `<div class="cc-trend-chart">${bars}</div>`
  }

  // 100%-stacked segmented bar (adatbizalom / confidence_breakdown).
  function segmentedBar(segments) {
    const total = segments.reduce((s, seg) => s + (seg.value || 0), 0)
    if (total <= 0) return '<div class="cc-muted">Nincs adat</div>'
    const parts = segments
      .filter((seg) => seg.value > 0)
      .map((seg) => `<div class="cc-seg ${seg.colorClass || ''}" style="width:${(seg.value / total) * 100}%" title="${esc(seg.label)}: ${Math.round((seg.value / total) * 100)}%"></div>`)
      .join('')
    const legend = segments.map((seg) => `<span class="cc-seg-legend"><i class="cc-seg-dot ${seg.colorClass || ''}"></i>${esc(seg.label)} ${total > 0 ? Math.round((seg.value / total) * 100) : 0}%</span>`).join('')
    return `<div class="cc-segbar">${parts}</div><div class="cc-segbar-legend">${legend}</div>`
  }

  window.Costops.Charts = { barRow, monthlyTrend, segmentedBar, fmtHuf, esc }
})()
