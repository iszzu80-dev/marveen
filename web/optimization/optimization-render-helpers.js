// Optimization dashboard -- shared, null-safe rendering helpers.
window.Optimization = window.Optimization || {}

;(function () {
  const BADGE_VALUES = new Set([
    'measured',
    'estimated',
    'unknown',
    'available',
    'degraded',
    'limited',
    'blocked',
    'ok',
    'warning',
    'critical',
  ])

  function statusBadge(confidenceOrState) {
    const value = BADGE_VALUES.has(confidenceOrState) ? confidenceOrState : 'unknown'
    return `<span class="opt-badge opt-badge-${value}">${t('optimization.badge.' + value)}</span>`
  }

  function formatHuf(value) {
    if (!Number.isFinite(value)) return t('optimization.no_data')
    return new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 }).format(value) + ' Ft'
  }

  function formatPercent(fraction) {
    if (!Number.isFinite(fraction)) return t('optimization.no_data')
    return new Intl.NumberFormat('hu-HU', {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(fraction)
  }

  function emptyState(messageKey) {
    return `<div class="overview-stat opt-empty-state"><p>${t(messageKey)}</p></div>`
  }

  window.Optimization.RenderHelpers = {
    statusBadge,
    formatHuf,
    formatPercent,
    emptyState,
  }
})()
