// Optimization dashboard -- compact executive overview.
window.Optimization = window.Optimization || {}

;(function () {
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
  const H = () => window.Optimization.RenderHelpers

  const SYSTEM_BADGE_VARIANTS = {
    ok: 'ok',
    observation: 'warning',
    attention_needed: 'critical',
    partially_disabled: 'warning',
    disabled: 'unknown',
  }

  function labeledBadge(variant, label) {
    const badge = H().statusBadge(variant)
    return badge.slice(0, badge.indexOf('>') + 1) + esc(label) + '</span>'
  }

  function systemBadge(state) {
    const key = {
      ok: 'optimization.status.ok',
      observation: 'optimization.status.observation',
      attention_needed: 'optimization.status.attention_needed',
      partially_disabled: 'optimization.status.partially_disabled',
      disabled: 'optimization.status.disabled',
    }[state] || 'optimization.badge.unknown'
    return labeledBadge(SYSTEM_BADGE_VARIANTS[state] || 'unknown', t(key))
  }

  function confidenceBadge(confidence) {
    if (confidence === 'manual' || confidence === 'inferred') {
      return labeledBadge('estimated', t('optimization.badge.' + confidence))
    }
    return H().statusBadge(confidence)
  }

  function severityBadge(severity) {
    const variant = severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'available'
    return labeledBadge(variant, t('optimization.severity.' + (severity || 'info')))
  }

  function verdictBadge(verdict) {
    const variant = verdict === 'INSUFFICIENT_EVIDENCE'
      ? 'blocked'
      : verdict === 'NO_DECISION'
        ? 'unknown'
        : verdict === 'KEEP'
          ? 'ok'
          : 'warning'
    return labeledBadge(variant, t('optimization.verdict.' + String(verdict || 'unknown').toLowerCase()))
  }

  function figurePercent(figure) {
    if (!figure || figure.confidence === 'unknown' || !Number.isFinite(figure.value)) {
      return {
        value: esc(figure?.blocker || t('optimization.no_data')),
        badge: confidenceBadge('unknown'),
      }
    }
    return {
      value: esc(H().formatPercent(figure.value)),
      badge: confidenceBadge(figure.confidence),
    }
  }

  function capacityRisk(summary) {
    if (!summary.capacity?.available || !summary.capacity.report) {
      return {
        value: esc(summary.capacity?.blocker || t('optimization.no_data')),
        badge: confidenceBadge('unknown'),
        detail: '',
        blocked: true,
      }
    }

    const subscriptions = summary.capacity.report.subscriptions || []
    const knownOverflow = subscriptions
      .filter((item) => item.overflow?.confidence !== 'unknown' && Number.isFinite(item.overflow?.value))
      .sort((a, b) => b.overflow.value - a.overflow.value)[0]
    const knownUsage = subscriptions
      .filter((item) => item.usage?.confidence !== 'unknown' && Number.isFinite(item.usage?.value))
      .sort((a, b) => b.usage.value - a.usage.value)[0]
    const selected = knownOverflow?.overflow?.value > 0
      ? { subscription: knownOverflow, figure: knownOverflow.overflow, labelKey: 'optimization.overview.capacity_overflow' }
      : knownUsage
        ? { subscription: knownUsage, figure: knownUsage.usage, labelKey: 'optimization.overview.capacity_usage' }
        : null

    if (!selected) {
      const blocker = subscriptions
        .map((item) => item.usage?.blocker || item.overflow?.blocker)
        .find(Boolean)
      return {
        value: esc(blocker || t('optimization.no_data')),
        badge: confidenceBadge('unknown'),
        detail: '',
        blocked: true,
      }
    }

    return {
      value: esc(H().formatPercent(selected.figure.value)),
      badge: confidenceBadge(selected.figure.confidence),
      detail: esc(t(selected.labelKey, { name: selected.subscription.name })),
    }
  }

  function benchmarkKpi(summary) {
    if (!summary.benchmark?.available || !summary.benchmark.pack) {
      return {
        value: esc(summary.benchmark?.blocker || t('optimization.no_data')),
        detail: '',
        blocked: true,
      }
    }
    const group = (summary.benchmark.pack.groups || [])
      .filter((item) => Number.isFinite(item.marginalCostPerTask))
      .sort((a, b) => b.acceptedTasks - a.acceptedTasks)[0]
    if (!group) {
      return {
        value: esc(t('optimization.no_data')),
        detail: esc(t('optimization.overview.benchmark_no_measured_group')),
      }
    }
    return {
      value: esc(H().formatHuf(group.marginalCostPerTask)),
      detail: esc(t('optimization.overview.benchmark_group', {
        period: group.period,
        tasks: group.acceptedTasks,
      })),
    }
  }

  function attentionHtml(items) {
    if (!items.length) return H().emptyState('optimization.attention.none')
    return items.map((item) => `
      <div class="cc-attn-row">
        <div>${severityBadge(item.severity)}</div>
        <div class="cc-attn-body">
          <div class="cc-attn-title">${esc(item.title)}</div>
          <div class="cc-attn-sub">${esc(item.explanation)}</div>
          <div class="cc-attn-sub">${esc(item.action)}</div>
        </div>
      </div>`).join('')
  }

  function capacityFigure(labelKey, figure) {
    const rendered = figurePercent(figure)
    return `
      <div class="cc-drawer-row">
        <span>${esc(t(labelKey))}</span>
        <span>${rendered.value} ${rendered.badge}</span>
      </div>`
  }

  function capacityHtml(summary) {
    if (!summary.capacity?.available || !summary.capacity.report) {
      return H().emptyState('optimization.overview.capacity_unavailable')
        + `<p class="cc-muted">${esc(summary.capacity?.blocker || t('optimization.no_data'))}</p>`
    }
    const subscriptions = summary.capacity.report.subscriptions || []
    if (!subscriptions.length) return H().emptyState('optimization.overview.capacity_none')
    return subscriptions.map((subscription) => `
      <div class="overview-card">
        <div class="overview-card-head">
          <strong>${esc(subscription.name)}</strong>
          <span class="cc-muted">${esc(subscription.provider)}</span>
        </div>
        ${capacityFigure('optimization.overview.capacity_usage_label', subscription.usage)}
        ${capacityFigure('optimization.overview.capacity_unused_label', subscription.unused_capacity)}
        ${capacityFigure('optimization.overview.capacity_overflow_label', subscription.overflow)}
      </div>`).join('')
  }

  function routingHtml(summary) {
    const fallbackAgents = summary.routing?.agents_on_fallback || []
    const routingAvailable = summary.routing?.available !== false
    const runtime = summary.runtime_routing_config || {}
    return `
      <div class="overview-card">
        <div class="cc-drawer-row">
          <span>${esc(t('optimization.overview.fallback_agents'))}</span>
          <strong>${routingAvailable ? fallbackAgents.length : esc(t('optimization.no_data'))}</strong>
        </div>
        <p class="cc-muted">${!routingAvailable
          ? esc(summary.routing?.blocker || t('optimization.no_data'))
          : fallbackAgents.length
            ? fallbackAgents.map(esc).join(', ')
            : esc(t('optimization.overview.fallback_none'))}</p>
        <div class="cc-drawer-row">
          <span>${esc(t('optimization.overview.runtime_enabled'))}</span>
          <span>${esc(t(runtime.enabled ? 'optimization.common.yes' : 'optimization.common.no'))}</span>
        </div>
        <div class="cc-drawer-row">
          <span>${esc(t('optimization.overview.candidate_count'))}</span>
          <span>${Number.isFinite(runtime.candidate_count) ? runtime.candidate_count : esc(t('optimization.no_data'))}</span>
        </div>
        <div class="cc-drawer-row">
          <span>${esc(t('optimization.overview.trusted_candidate_count'))}</span>
          <span>${Number.isFinite(runtime.trusted_candidate_count) ? runtime.trusted_candidate_count : esc(t('optimization.no_data'))}</span>
        </div>
        <button class="btn-secondary" type="button" data-go-routing>${esc(t('optimization.overview.go_routing'))}</button>
      </div>`
  }

  function recommendationHtml(topRecommendation) {
    if (!topRecommendation?.available || !topRecommendation.recommendation) {
      return H().emptyState('optimization.overview.top_recommendation_none')
        + `<p class="cc-muted">${esc(topRecommendation?.blocker || t('optimization.no_data'))}</p>`
    }
    const recommendation = topRecommendation.recommendation
    return `
      <div class="overview-card">
        <div class="cc-drawer-row">
          <strong>${esc(recommendation.package_id)}</strong>
          <span>${verdictBadge(recommendation.verdict)}</span>
        </div>
        <div class="cc-drawer-row">
          <span>${esc(t('optimization.overview.confidence'))}</span>
          <span>${confidenceBadge(recommendation.confidence)}</span>
        </div>
        ${recommendation.blocker ? `<p class="cc-muted">${esc(recommendation.blocker)}</p>` : ''}
        <button class="btn-secondary" type="button" data-review-recommendation>${esc(t('optimization.overview.review'))}</button>
      </div>`
  }

  async function render(bodyEl) {
    bodyEl.dataset.optimizationView = 'overview'
    bodyEl.innerHTML = `<div class="cc-loading">${esc(t('optimization.loading'))}</div>`

    try {
      const summary = await window.Optimization.Api.summary()
      if (bodyEl.dataset.optimizationView !== 'overview') return
      window.Optimization.Shell.setStatusFromSummary(summary)

      const risk = capacityRisk(summary)
      const benchmark = benchmarkKpi(summary)
      // The original mockup's acceptance-quality KPI is deliberately omitted:
      // OptimizationSummary exposes no acceptance or retry-trend field today.
      bodyEl.innerHTML = `
        <div class="opt-kpi-grid">
          <div class="opt-kpi-card">
            <div class="overview-stat-label">${esc(t('optimization.overview.system_state'))}</div>
            <div>${systemBadge(summary.system_state)}</div>
            <div class="overview-stat-sub">${esc(t('optimization.overview.active_modules', {
              active: Number.isFinite(summary.active_module_count) ? summary.active_module_count : t('optimization.no_data'),
              total: 7,
            }))}</div>
          </div>
          <div class="opt-kpi-card cc-bar-clickable" role="button" tabindex="0" data-go-decisions>
            <div class="overview-stat-label">${esc(t('optimization.overview.decisions_waiting'))}</div>
            <div class="overview-stat-value">${Array.isArray(summary.attention_queue) ? summary.attention_queue.length : esc(t('optimization.no_data'))}</div>
            <div class="overview-stat-sub">${esc(t('optimization.overview.open_decisions'))}</div>
          </div>
          <div class="opt-kpi-card">
            <div class="overview-stat-label">${esc(t('optimization.overview.capacity_risk'))}</div>
            <div class="overview-stat-value${risk.blocked ? ' is-muted' : ''}">${risk.value}</div>
            <div class="overview-stat-sub">${risk.badge} ${risk.detail}</div>
          </div>
          <div class="opt-kpi-card">
            <div class="overview-stat-label">${esc(t('optimization.overview.cost_per_accepted_task'))}</div>
            <div class="overview-stat-value${benchmark.blocked ? ' is-muted' : ''}">${benchmark.value}</div>
            <div class="overview-stat-sub">${benchmark.detail}</div>
          </div>
        </div>

        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.overview.attention_title'))}</div>
          ${attentionHtml(summary.attention_queue || [])}
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.overview.capacity_title'))}</div>
          ${capacityHtml(summary)}
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.overview.routing_title'))}</div>
          ${routingHtml(summary)}
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.overview.top_recommendation_title'))}</div>
          ${recommendationHtml(summary.top_recommendation)}
        </div>`

      bodyEl.querySelector('[data-go-decisions]')?.addEventListener('click', () => {
        window.Optimization.State.setView('decisions')
      })
      bodyEl.querySelector('[data-review-recommendation]')?.addEventListener('click', () => {
        window.Optimization.State.setView('decisions')
      })
      bodyEl.querySelector('[data-go-routing]')?.addEventListener('click', () => {
        window.Optimization.State.setView('routing')
      })
    } catch (error) {
      if (bodyEl.dataset.optimizationView !== 'overview') return
      bodyEl.innerHTML = `<div class="cc-error">${esc(t('optimization.error_with_message', {
        message: error instanceof Error ? error.message : String(error),
      }))}</div>`
    }
  }

  window.Optimization.Overview = { render }
})()
