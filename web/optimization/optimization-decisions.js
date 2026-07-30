// Optimization dashboard -- recommendation evidence and local decision workflow.
window.Optimization = window.Optimization || {}

;(function () {
  // Known limitation: no authenticated operator identity is plumbed into this
  // frontend yet, so audit events use one explicit, stable actor label.
  const DECISION_ACTOR = 'dashboard-operator'
  const STATUSES = [
    'new',
    'viewed',
    'accepted',
    'rejected',
    'deferred',
    'canary_needed',
    'executed',
    'expired',
    'insufficient_evidence',
  ]
  const TERMINAL_STATUSES = new Set(['rejected', 'executed', 'expired'])
  const NO_ACCEPT_VERDICTS = new Set(['NO_DECISION', 'INSUFFICIENT_EVIDENCE'])
  let renderSequence = 0

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
  const H = () => window.Optimization.RenderHelpers

  function labeledBadge(variant, label) {
    const badge = H().statusBadge(variant)
    return badge.slice(0, badge.indexOf('>') + 1) + esc(label) + '</span>'
  }

  function verdictBadge(verdict) {
    const variant = verdict === 'INSUFFICIENT_EVIDENCE'
      ? 'blocked'
      : verdict === 'NO_DECISION'
        ? 'unknown'
        : verdict === 'KEEP'
          ? 'ok'
          : 'warning'
    const known = [
      'KEEP',
      'UPGRADE',
      'DOWNGRADE',
      'CANCEL',
      'ADD',
      'ENABLE_USAGE_CREDIT',
      'REBALANCE',
      'NO_DECISION',
      'INSUFFICIENT_EVIDENCE',
    ].includes(verdict)
    return labeledBadge(variant, t('optimization.verdict.' + (known ? verdict.toLowerCase() : 'unknown')))
  }

  function decisionStatusBadge(status) {
    const variant = status === 'accepted' || status === 'executed'
      ? 'ok'
      : status === 'rejected' || status === 'expired'
        ? 'blocked'
        : status === 'new' || status === 'viewed'
          ? 'available'
          : status === 'insufficient_evidence'
            ? 'unknown'
            : 'warning'
    const normalized = STATUSES.includes(status) ? status : 'missing'
    return labeledBadge(variant, t('optimization.decisions.status.' + normalized))
  }

  function responseError(response) {
    if (response?.body?.error) return String(response.body.error)
    return t('optimization.http_error', { status: response?.status ?? t('optimization.no_data') })
  }

  function evidenceLabel(label) {
    if (label === 'price_huf') return t('optimization.evidence.price_huf')
    return label
  }

  function evidenceValue(figure) {
    if (!figure || figure.confidence === 'unknown' || !Number.isFinite(figure.value)) {
      return esc(figure?.blocker || t('optimization.no_data'))
    }
    if (String(figure.currency || '').toUpperCase() === 'HUF') {
      return esc(H().formatHuf(figure.value))
    }
    if (/percent|percentage|fraction|_rate$/i.test(figure.label || '')) {
      return esc(H().formatPercent(figure.value))
    }
    return esc(
      new Intl.NumberFormat(window._lang === 'en' ? 'en-US' : 'hu-HU').format(figure.value)
      + (figure.currency ? ' ' + figure.currency : ''),
    )
  }

  function evidenceHtml(evidence) {
    if (!evidence.length) return H().emptyState('optimization.decisions.evidence_none')
    return `
      <ul>
        ${evidence.map((figure) => `
          <li>
            <strong>${esc(evidenceLabel(figure.label))}:</strong>
            ${evidenceValue(figure)}
            ${H().statusBadge(figure.confidence)}
            ${figure.confidence !== 'unknown' && figure.blocker ? `<span class="cc-muted">${esc(figure.blocker)}</span>` : ''}
          </li>`).join('')}
      </ul>`
  }

  function availableActions(recommendation, decision) {
    const status = decision?.status
    if (!status || TERMINAL_STATUSES.has(status)) return []
    const actions = []
    if (status === 'new' || status === 'deferred' || status === 'canary_needed') {
      actions.push('viewed')
    }
    if (!NO_ACCEPT_VERDICTS.has(recommendation.verdict) && status !== 'accepted') {
      actions.push('accepted')
    }
    if (status !== 'rejected') actions.push('rejected')
    if (status !== 'deferred') actions.push('deferred')
    if (status !== 'canary_needed') actions.push('canary_needed')
    return actions
  }

  function actionButtons(recommendation, decision) {
    const actions = availableActions(recommendation, decision)
    if (!actions.length) {
      return `<p class="cc-muted">${esc(t('optimization.decisions.no_actions'))}</p>`
    }
    return `
      <div class="cc-close-action">
        ${actions.map((status) => `
          <button
            class="${status === 'rejected' ? 'btn-danger' : 'btn-secondary'}"
            type="button"
            data-decision-action="${status}"
            data-package-id="${esc(recommendation.package_id)}"
          >${esc(t('optimization.decisions.action.' + status))}</button>`).join('')}
      </div>`
  }

  function recommendationCard(recommendation, decision) {
    const manualExternalAction = !['KEEP', 'NO_DECISION', 'INSUFFICIENT_EVIDENCE'].includes(recommendation.verdict)
    return `
      <div class="overview-card" data-recommendation-card="${esc(recommendation.package_id)}">
        <div class="cc-close-header">
          ${verdictBadge(recommendation.verdict)}
          <strong>${esc(recommendation.package_id)}</strong>
          ${H().statusBadge(recommendation.confidence)}
          ${decisionStatusBadge(decision?.status)}
        </div>
        ${recommendation.blocker ? `<p class="cc-muted">${esc(recommendation.blocker)}</p>` : ''}
        <div>
          <strong>${esc(t('optimization.decisions.evidence_title'))}</strong>
          ${evidenceHtml(recommendation.evidence || [])}
        </div>
        ${manualExternalAction
          ? `<p class="cc-error">${esc(t('optimization.decisions.manual_external_action_note'))}</p>`
          : ''}
        ${actionButtons(recommendation, decision)}
      </div>`
  }

  function filterOptions(selected) {
    return `
      <option value="" ${selected === '' ? 'selected' : ''}>${esc(t('optimization.common.all'))}</option>
      ${STATUSES.map((status) => `
        <option value="${status}" ${selected === status ? 'selected' : ''}>
          ${esc(t('optimization.decisions.status.' + status))}
        </option>`).join('')}`
  }

  async function render(bodyEl, selectedStatus = '') {
    const sequence = ++renderSequence
    bodyEl.dataset.optimizationView = 'decisions'
    bodyEl.innerHTML = `<div class="cc-loading">${esc(t('optimization.loading'))}</div>`

    try {
      const result = await window.Optimization.Api.recommendations(selectedStatus || undefined)
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'decisions') return
      const recommendations = result.recommendations || []
      const decisions = result.decisions || []
      const decisionsByPackage = new Map(decisions.map((decision) => [decision.package_id, decision]))
      // The backend filters only `decisions`; `recommendations` remains the full,
      // fresh portfolio so a selected status must be joined/filtered client-side.
      const visibleRecommendations = selectedStatus
        ? recommendations.filter((recommendation) => decisionsByPackage.has(recommendation.package_id))
        : recommendations

      bodyEl.innerHTML = `
        <div class="cc-controls">
          <label>
            ${esc(t('optimization.decisions.filter_status'))}
            <select class="cc-input" data-status-filter>${filterOptions(selectedStatus)}</select>
          </label>
        </div>
        <p class="cc-muted">${esc(t('optimization.decisions.local_only_note'))}</p>
        <div data-recommendation-list>
          ${visibleRecommendations.length
            ? visibleRecommendations.map((recommendation) =>
                recommendationCard(recommendation, decisionsByPackage.get(recommendation.package_id))).join('')
            : H().emptyState('optimization.decisions.none')}
        </div>`

      bodyEl.querySelector('[data-status-filter]').addEventListener('change', (event) => {
        render(bodyEl, event.target.value)
      })
      bodyEl.querySelectorAll('[data-decision-action]').forEach((button) => {
        button.addEventListener('click', async () => {
          const packageId = button.dataset.packageId
          const newStatus = button.dataset.decisionAction
          let note
          let deferredUntil

          if (newStatus === 'deferred') {
            const answer = window.prompt(t('optimization.decisions.defer_prompt'), '')
            if (answer === null) return
            const trimmed = answer.trim()
            if (trimmed) {
              if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
                window.alert(t('optimization.decisions.defer_invalid'))
                return
              }
              deferredUntil = Number(trimmed)
              note = trimmed
            }
          }

          const confirmed = window.confirm(t('optimization.decisions.confirm_action', {
            action: t('optimization.decisions.action.' + newStatus),
            package: packageId,
          }))
          if (!confirmed) return

          bodyEl.querySelectorAll('[data-decision-action]').forEach((item) => { item.disabled = true })
          try {
            const response = await window.Optimization.Api.decide(
              packageId,
              newStatus,
              DECISION_ACTOR,
              note,
              deferredUntil,
            )
            if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'decisions') return
            if (!response.ok) throw new Error(responseError(response))
            window.alert(t('optimization.decisions.action_success', {
              package: packageId,
              status: t('optimization.decisions.status.' + newStatus),
            }))
            await render(bodyEl, selectedStatus)
          } catch (error) {
            if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'decisions') return
            window.alert(t('optimization.error_with_message', {
              message: error instanceof Error ? error.message : String(error),
            }))
            bodyEl.querySelectorAll('[data-decision-action]').forEach((item) => { item.disabled = false })
          }
        })
      })
    } catch (error) {
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'decisions') return
      bodyEl.innerHTML = `<div class="cc-error">${esc(t('optimization.error_with_message', {
        message: error instanceof Error ? error.message : String(error),
      }))}</div>`
    }
  }

  window.Optimization.Decisions = { render }
})()
