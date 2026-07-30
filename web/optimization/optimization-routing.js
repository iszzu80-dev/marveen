// Optimization dashboard -- per-agent routing and read-only decision preview.
window.Optimization = window.Optimization || {}

;(function () {
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
  const H = () => window.Optimization.RenderHelpers
  let renderSequence = 0

  function labeledBadge(variant, label) {
    const badge = H().statusBadge(variant)
    return badge.slice(0, badge.indexOf('>') + 1) + esc(label) + '</span>'
  }

  function routingStateBadge(state) {
    const variant = state === 'primary'
      ? 'ok'
      : state === 'fallback'
        ? 'warning'
        : state === 'static_mode'
          ? 'unknown'
          : 'blocked'
    const normalized = ['primary', 'fallback', 'static_mode', 'unknown'].includes(state) ? state : 'unknown'
    return labeledBadge(variant, t('optimization.routing.state.' + normalized))
  }

  function actionBadge(action) {
    const variant = action === 'stay_primary'
      ? 'ok'
      : action === 'fallback'
        ? 'warning'
        : action === 'no_eligible_fallback' || action === 'ceiling_reached'
          ? 'blocked'
          : 'unknown'
    const known = [
      'stay_primary',
      'hold_current_overlay',
      'fallback',
      'no_eligible_fallback',
      'ceiling_reached',
    ].includes(action)
    return labeledBadge(variant, t('optimization.routing.action.' + (known ? action : 'unknown')))
  }

  function responseError(response) {
    if (response?.body?.error) return String(response.body.error)
    return t('optimization.http_error', { status: response?.status ?? t('optimization.no_data') })
  }

  function rowsHtml(rows) {
    if (!rows.length) {
      return `<tr><td colspan="6">${H().emptyState('optimization.routing.none')}</td></tr>`
    }
    return rows.map((row) => `
      <tr>
        <td>${esc(row.agent)}</td>
        <td>${esc(row.configured_primary)}</td>
        <td>${esc(row.runtime_model)}</td>
        <td>${H().statusBadge(row.capacity_state)}</td>
        <td>${routingStateBadge(row.routing_state)}</td>
        <td>${esc(row.fallback_reason || t('optimization.routing.no_fallback_reason'))}</td>
      </tr>`).join('')
  }

  function agentOptions(agents) {
    if (!agents.length) return `<option value="">${esc(t('optimization.routing.no_agents'))}</option>`
    return agents.map((agent) => `<option value="${esc(agent)}">${esc(agent)}</option>`).join('')
  }

  async function render(bodyEl) {
    const sequence = ++renderSequence
    bodyEl.dataset.optimizationView = 'routing'
    bodyEl.innerHTML = `<div class="cc-loading">${esc(t('optimization.loading'))}</div>`

    try {
      const initialRows = await window.Optimization.Api.routing()
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
      const agents = [...new Set((initialRows || []).map((row) => row.agent).filter(Boolean))]
      bodyEl.innerHTML = `
        <div class="cc-controls">
          <label>
            ${esc(t('optimization.routing.filter_agent'))}
            <input class="cc-input" type="text" data-filter-agent>
          </label>
          <label>
            ${esc(t('optimization.routing.filter_state'))}
            <select class="cc-input" data-filter-state>
              <option value="">${esc(t('optimization.common.all'))}</option>
              <option value="primary">${esc(t('optimization.routing.state.primary'))}</option>
              <option value="fallback">${esc(t('optimization.routing.state.fallback'))}</option>
              <option value="static_mode">${esc(t('optimization.routing.state.static_mode'))}</option>
              <option value="unknown">${esc(t('optimization.routing.state.unknown'))}</option>
            </select>
          </label>
          <label>
            <span>${esc(t('optimization.routing.filter_problematic'))}</span>
            <input type="checkbox" data-filter-problematic>
          </label>
        </div>
        <div class="cc-table-wrap">
          <table class="opt-table">
            <thead>
              <tr>
                <th>${esc(t('optimization.routing.column.agent'))}</th>
                <th>${esc(t('optimization.routing.column.configured_primary'))}</th>
                <th>${esc(t('optimization.routing.column.runtime_model'))}</th>
                <th>${esc(t('optimization.routing.column.capacity_state'))}</th>
                <th>${esc(t('optimization.routing.column.routing_state'))}</th>
                <th>${esc(t('optimization.routing.column.fallback_reason'))}</th>
              </tr>
            </thead>
            <tbody data-routing-rows>${rowsHtml(initialRows || [])}</tbody>
          </table>
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.routing.preview_title'))}</div>
          <p class="cc-muted">${esc(t('optimization.routing.preview_readonly_note'))}</p>
          <div class="cc-controls">
            <label>
              ${esc(t('optimization.routing.preview_agent'))}
              <select class="cc-input" data-preview-agent ${agents.length ? '' : 'disabled'}>
                ${agentOptions(agents)}
              </select>
            </label>
            <button class="btn-secondary" type="button" data-preview-button ${agents.length ? '' : 'disabled'}>
              ${esc(t('optimization.routing.preview_button'))}
            </button>
          </div>
          <div data-preview-result>${H().emptyState('optimization.routing.preview_empty')}</div>
        </div>`

      const agentInput = bodyEl.querySelector('[data-filter-agent]')
      const stateSelect = bodyEl.querySelector('[data-filter-state]')
      const problematicInput = bodyEl.querySelector('[data-filter-problematic]')
      const rowsEl = bodyEl.querySelector('[data-routing-rows]')
      let requestSequence = 0
      let debounceTimer = null

      async function refetchRows() {
        const request = ++requestSequence
        rowsEl.innerHTML = `<tr><td colspan="6" class="cc-loading">${esc(t('optimization.loading'))}</td></tr>`
        try {
          const rows = await window.Optimization.Api.routing({
            agent: agentInput.value.trim(),
            state: stateSelect.value,
            problematicOnly: problematicInput.checked,
          })
          if (request !== requestSequence || sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
          rowsEl.innerHTML = rowsHtml(rows || [])
        } catch (error) {
          if (request !== requestSequence || sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
          rowsEl.innerHTML = `<tr><td colspan="6" class="cc-error">${esc(t('optimization.error_with_message', {
            message: error instanceof Error ? error.message : String(error),
          }))}</td></tr>`
        }
      }

      agentInput.addEventListener('input', () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(refetchRows, 300)
      })
      stateSelect.addEventListener('change', refetchRows)
      problematicInput.addEventListener('change', refetchRows)

      bodyEl.querySelector('[data-preview-button]')?.addEventListener('click', async () => {
        const agent = bodyEl.querySelector('[data-preview-agent]').value
        const resultEl = bodyEl.querySelector('[data-preview-result]')
        resultEl.innerHTML = `<div class="cc-loading">${esc(t('optimization.loading'))}</div>`
        try {
          const response = await window.Optimization.Api.routingPreview(agent)
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
          if (!response.ok) throw new Error(responseError(response))
          const preview = response.body
          resultEl.innerHTML = `
            <div class="overview-card">
              <div class="cc-drawer-row">
                <span>${esc(t('optimization.routing.preview_action'))}</span>
                <span>${actionBadge(preview.decision?.action)}</span>
              </div>
              <div class="cc-drawer-row">
                <span>${esc(t('optimization.routing.preview_would_change'))}</span>
                <strong>${esc(t(preview.would_change ? 'optimization.common.yes' : 'optimization.common.no'))}</strong>
              </div>
              <p class="cc-muted">${esc(preview.note)}</p>
            </div>`
        } catch (error) {
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
          resultEl.innerHTML = `<div class="cc-error">${esc(t('optimization.error_with_message', {
            message: error instanceof Error ? error.message : String(error),
          }))}</div>`
        }
      })
    } catch (error) {
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'routing') return
      bodyEl.innerHTML = `<div class="cc-error">${esc(t('optimization.error_with_message', {
        message: error instanceof Error ? error.message : String(error),
      }))}</div>`
    }
  }

  window.Optimization.Routing = { render }
})()
