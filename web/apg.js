// APG 0.4 Lean UI -- additive dashboard integrations.
window.Apg = window.Apg || {}

;(function (Apg) {
  const DISPLAY_STATES = ['clarification', 'evidence_needed', 'executing', 'verifying', 'decision_needed', 'blocked', 'accepted', 'off']

  const STAT_DEFS = [
    { key: 'active', labelKey: 'apg.overview.active', severity: 'info' },
    { key: 'evidence_needed', labelKey: 'apg.overview.evidence_needed', severity: 'warning' },
    { key: 'decision_needed', labelKey: 'apg.overview.decision_needed', severity: 'warning' },
    { key: 'blocked', labelKey: 'apg.overview.blocked', severity: 'danger' },
    { key: 'verifying', labelKey: 'apg.overview.verifying', severity: 'info' },
    { key: 'accepted_today', labelKey: 'apg.overview.accepted_today', severity: 'success' },
  ]

  const QUICK_FILTERS = [
    { id: 'attention', labelKey: 'apg.kanban.filter.attention' },
    { id: 'decision', labelKey: 'apg.kanban.filter.decision' },
    { id: 'blocked', labelKey: 'apg.kanban.filter.blocked' },
    { id: 'verifying', labelKey: 'apg.kanban.filter.verifying' },
    { id: 'done-not-accepted', labelKey: 'apg.kanban.filter.done_not_accepted' },
  ]

  const activeKanbanFilters = new Set()
  let latestKanbanItems = []
  let mounted = false
  let kanbanRequestSequence = 0
  let cardDetailRequestSequence = 0
  let overviewRequestSequence = 0
  let activityRequestSequence = 0
  let approvalsRequestSequence = 0

  function html(value) {
    return escapeHtml(String(value ?? ''))
  }

  function attr(value) {
    return escapeAttr(String(value ?? ''))
  }

  function translated(key, params) {
    return html(t(key, params))
  }

  function stateLabel(state) {
    const key = DISPLAY_STATES.includes(state) ? state : 'off'
    return t(`apg.state.${key}`)
  }

  function severityForState(state) {
    if (state === 'blocked') return 'danger'
    if (state === 'decision_needed' || state === 'evidence_needed') return 'warning'
    if (state === 'accepted') return 'success'
    if (state === 'verifying' || state === 'executing') return 'info'
    return 'muted'
  }

  function severityForClaim(status) {
    if (status === 'VERIFIED_CURRENT' || status === 'VERIFIED_HISTORICAL') return 'success'
    if (status === 'CONFLICTING_EVIDENCE' || status === 'BLOCKED_FROM_USE') return 'danger'
    if (status === 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED') return 'warning'
    return 'muted'
  }

  function formatAge(seconds) {
    const value = Math.max(0, Number(seconds) || 0)
    if (value < 60) return 'most'
    if (value < 3600) return `${Math.floor(value / 60)} perc`
    if (value < 86400) return `${Math.floor(value / 3600)} óra`
    return `${Math.floor(value / 86400)} nap`
  }

  function formatDate(value) {
    if (!value) return ''
    const date = typeof value === 'number'
      ? new Date(value < 1000000000000 ? value * 1000 : value)
      : new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  }

  function truncate(value, maxLength) {
    const text = String(value ?? '')
    return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text
  }

  async function fetchJson(url, options) {
    let response
    try {
      response = await fetch(url, options)
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`)
      error.status = response.status
      error.data = data
      throw error
    }
    return data
  }

  // Enforcement toggle cache, refreshed from /api/apg/summary.
  let enforcementState = {
    mode: 'off',
    require_claim_receipt: false,
    require_independent_acceptance: false,
    require_owner_decision: false,
    block_unaccepted_archive: false,
  }

  Apg.refreshEnforcement = async function refreshEnforcement() {
    try {
      const summary = await fetchJson('/api/apg/summary')
      enforcementState = {
        mode: summary.mode || 'off',
        require_claim_receipt: summary.apg_require_claim_receipt === true,
        require_independent_acceptance: summary.apg_require_independent_acceptance === true,
        require_owner_decision: summary.apg_require_owner_decision === true,
        block_unaccepted_archive: summary.apg_block_unaccepted_archive === true,
      }
    } catch { /* keep last-known state on fetch failure */ }
  }

  function retryBanner() {
    return `
      <div class="apg-degraded apg-severity-danger">
        <span>${translated('apg.common.degraded')}</span>
        <button type="button" class="apg-retry-btn">${translated('apg.common.retry')}</button>
      </div>`
  }

  function bindRetry(container, retry) {
    container.querySelector('.apg-retry-btn')?.addEventListener('click', retry)
  }

  function overviewAttentionHtml(items) {
    if (!items.length) {
      return `<p class="apg-empty">${translated('apg.overview.empty')}</p>`
    }
    return `
      <div class="apg-attention-list">
        ${items.slice(0, 5).map((item) => {
          const severity = severityForState(item.display_state)
          return `
            <button type="button" class="apg-attention-row" data-work-item-id="${attr(item.work_item_id)}" data-kanban-card-id="${attr(item.kanban_card_id || '')}">
              <span class="apg-attention-main">
                <span class="apg-attention-title">${html(item.title)}</span>
                <span class="apg-state-pill apg-severity-${severity}">${html(stateLabel(item.display_state))}</span>
              </span>
              <span class="apg-attention-reason">${html(item.reason)}</span>
              <span class="apg-attention-next">${html(item.next_action)}</span>
              <span class="apg-attention-age">${html(formatAge(item.age_seconds))}</span>
            </button>`
        }).join('')}
      </div>`
  }

  Apg.renderOverview = async function renderOverview() {
    const container = document.getElementById('apgOverviewSection')
    if (!container) return
    const requestSequence = ++overviewRequestSequence
    container.innerHTML = `<p class="apg-loading">${translated('apg.common.loading')}</p>`

    try {
      const summary = await fetchJson('/api/apg/summary')
      if (requestSequence !== overviewRequestSequence) return
      if (summary.mode === 'off' || summary.apg_ui_overview_enabled === false) {
        container.innerHTML = ''
        container.hidden = true
        return
      }
      container.hidden = false
      if (summary.projection_error) {
        container.innerHTML = retryBanner(Apg.renderOverview)
        bindRetry(container, Apg.renderOverview)
        return
      }

      const counts = summary.counts || {}
      const hasCounts = STAT_DEFS.some((stat) => Number(counts[stat.key]) > 0)
      const statsHtml = hasCounts
        ? `<div class="apg-stat-strip">${STAT_DEFS.map((stat) => `
            <div class="apg-stat-chip apg-severity-${stat.severity}">
              <span class="apg-stat-value">${html(Number(counts[stat.key]) || 0)}</span>
              <span class="apg-stat-label">${translated(stat.labelKey)}</span>
            </div>`).join('')}</div>`
        : `<p class="apg-empty">${translated('apg.overview.no_active_work')}</p>`

      container.innerHTML = `
        <div class="apg-section-heading">
          <div>
            <h2>${translated('apg.overview.title')}</h2>
            <p>${translated('apg.overview.subtitle')}</p>
          </div>
          <span class="apg-mode-chip">${html(summary.mode)}</span>
        </div>
        ${statsHtml}
        <h3 class="apg-subheading">${translated('apg.overview.attention')}</h3>
        ${overviewAttentionHtml(Array.isArray(summary.attention_items) ? summary.attention_items : [])}`

      container.querySelectorAll('.apg-attention-row').forEach((row) => {
        row.addEventListener('click', () => {
          Apg.openWorkItemDetail(row.dataset.workItemId, row.dataset.kanbanCardId || null)
        })
      })
    } catch {
      if (requestSequence !== overviewRequestSequence) return
      container.hidden = false
      container.innerHTML = retryBanner(Apg.renderOverview)
      bindRetry(container, Apg.renderOverview)
    }
  }

  function ensureWorkItemOverlay() {
    let overlay = document.getElementById('apgWorkItemOverlay')
    if (overlay) return overlay
    overlay = document.createElement('div')
    overlay.id = 'apgWorkItemOverlay'
    overlay.className = 'modal-overlay apg-work-item-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <div class="modal-header">
          <h2 id="apgWorkItemTitle">APG</h2>
          <button type="button" class="modal-close apg-work-item-close" aria-label="${attr(t('apg.common.close'))}">&times;</button>
        </div>
        <div class="modal-body" id="apgWorkItemBody"></div>
      </div>`
    document.body.appendChild(overlay)
    const close = () => {
      overlay.classList.remove('active')
      document.body.style.overflow = ''
    }
    overlay.querySelector('.apg-work-item-close').addEventListener('click', close)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close()
    })
    return overlay
  }

  function detailList(items, renderItem, emptyKey) {
    if (!items.length) return `<p class="apg-empty">${translated(emptyKey)}</p>`
    return `<ul class="apg-detail-list">${items.slice(0, 5).map(renderItem).join('')}</ul>`
  }

  Apg.openWorkItemDetail = async function openWorkItemDetail(workItemId, kanbanCardId) {
    if (!workItemId) return
    const overlay = ensureWorkItemOverlay()
    const title = overlay.querySelector('#apgWorkItemTitle')
    const body = overlay.querySelector('#apgWorkItemBody')
    title.textContent = 'APG'
    body.innerHTML = `<p class="apg-loading">${translated('apg.common.loading')}</p>`
    overlay.classList.add('active')
    document.body.style.overflow = 'hidden'

    try {
      const detail = await fetchJson(`/api/apg/work-items/${encodeURIComponent(workItemId)}`)
      if (detail.error) throw new Error(detail.error)
      title.textContent = detail.title || 'APG'
      const claims = Array.isArray(detail.claims) ? detail.claims : []
      const events = Array.isArray(detail.events) ? detail.events : []
      body.innerHTML = `
        <div class="apg-detail-summary">
          <span class="apg-state-pill apg-severity-${severityForState(detail.display_state)}">${html(stateLabel(detail.display_state))}</span>
          <span class="apg-mode-chip">${html(detail.effective_mode)}</span>
          <span class="apg-risk">${translated('apg.detail.risk')}: ${html(detail.risk)}</span>
        </div>
        <p class="apg-next-action"><strong>${translated('apg.detail.next_action')}:</strong> ${html(detail.next_action)}</p>
        <dl class="apg-definition-list">
          <dt>${translated('apg.detail.goal')}</dt><dd>${html(detail.goal || '—')}</dd>
          <dt>${translated('apg.detail.scope')}</dt><dd>${html(detail.scope || kanbanCardId || '—')}</dd>
        </dl>
        <div class="apg-detail-actions">
          <button type="button" class="btn-primary btn-compact apg-request-decision-btn"
                  data-work-item-id="${attr(workItemId)}"
                  data-kanban-card-id="${attr(kanbanCardId || '')}">
            ${translated('apg.detail.request_decision')}
          </button>
          <span class="apg-decision-message" id="apgWorkItemDecisionMsg" hidden></span>
        </div>
        <div class="apg-detail-columns">
          <section>
            <h3>${translated('apg.detail.claims')}</h3>
            ${detailList(claims, (claim) => `
              <li>
                <span class="apg-state-pill apg-severity-${severityForClaim(claim.status)}">${html(claim.status)}</span>
                <span>${html(claim.text)}</span>
                <small>${html(claim.allowed_wording)}</small>
              </li>`, 'apg.detail.no_claims')}
          </section>
          <section>
            <h3>${translated('apg.detail.events')}</h3>
            ${detailList(events, (event) => `
              <li class="${event.error ? 'apg-event-error' : ''}">
                <span>${html(formatDate(event.at))}</span>
                <strong>${html(event.type)}</strong>
                <small>${html(event.summary)}</small>
              </li>`, 'apg.detail.no_events')}
          </section>
        </div>`

    // Wire the "Request Owner Decision" button (item 4: Approvals linkage).
    body.querySelector('.apg-request-decision-btn')?.addEventListener('click', async function () {
      const btn = this
      const msgEl = body.querySelector('#apgWorkItemDecisionMsg')
      btn.disabled = true
      if (msgEl) { msgEl.hidden = true }
      try {
        const desc = `${detail.title || workItemId}: ${detail.next_action || 'owner decision required'}`
        const res = await fetchJson('/api/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: 'dashboard',
            category: 'apg_decision',
            action_description: desc,
            action_payload: JSON.stringify({
              work_item_id: workItemId,
              kanban_card_id: kanbanCardId || null,
              display_state: detail.display_state,
              risk: detail.risk,
            }),
          }),
        })
        if (msgEl) {
          msgEl.hidden = false
          msgEl.className = 'apg-decision-message apg-severity-success'
          msgEl.textContent = t('apg.detail.decision_created')
        }
        // Refresh the Approvals page if it's visible so the new card appears.
        if (typeof loadApprovalsPage === 'function' && !document.getElementById('approvalsPage')?.hidden) {
          await loadApprovalsPage()
          await Apg.onApprovalsRendered()
        }
      } catch (error) {
        if (msgEl) {
          msgEl.hidden = false
          msgEl.className = 'apg-decision-message apg-severity-danger'
          msgEl.textContent = error.message
        }
      } finally {
        btn.disabled = false
      }
    })
    } catch (error) {
      body.innerHTML = `
        <div class="apg-degraded apg-severity-danger">
          <span>${translated('apg.common.unavailable', { msg: error.message })}</span>
          <button type="button" class="apg-retry-btn">${translated('apg.common.retry')}</button>
        </div>`
      body.querySelector('.apg-retry-btn')?.addEventListener('click', () => {
        Apg.openWorkItemDetail(workItemId, kanbanCardId)
      })
    }
  }

  function kanbanCardsData() {
    return typeof kanbanCards !== 'undefined' && Array.isArray(kanbanCards) ? kanbanCards : []
  }

  function clearApgKanbanUi() {
    document.querySelectorAll('.apg-kanban-badge').forEach((badge) => badge.remove())
    document.querySelectorAll('.kanban-card[data-id]').forEach((card) => { card.hidden = false })
    const row = document.getElementById('kanbanQuickFilters')
    if (row) {
      row.querySelectorAll('.apg-quick-filter, .apg-kanban-unavailable').forEach((chip) => chip.remove())
      delete row.dataset.apgFiltersInjected
    }
  }

  function kanbanItemMatchesFilter(item, filterId) {
    const card = kanbanCardsData().find((candidate) => candidate.id === item.kanban_card_id)
    if (filterId === 'attention') {
      return Boolean(item.attention_reason)
        || item.display_state === 'clarification'
        || item.display_state === 'evidence_needed'
    }
    if (filterId === 'decision') return item.display_state === 'decision_needed'
    if (filterId === 'blocked') return item.display_state === 'blocked'
    if (filterId === 'verifying') return item.display_state === 'verifying'
    if (filterId === 'done-not-accepted') {
      return card?.status === 'done'
        && (item.acceptance_status === 'produced' || item.acceptance_status === 'verifying')
    }
    return false
  }

  function applyKanbanVisibilityFilter() {
    let visibleCardIds = null
    if (activeKanbanFilters.size) {
      visibleCardIds = new Set()
      for (const item of latestKanbanItems) {
        if (!item.kanban_card_id) continue
        if ([...activeKanbanFilters].some((filterId) => kanbanItemMatchesFilter(item, filterId))) {
          visibleCardIds.add(String(item.kanban_card_id))
        }
      }
    }
    document.querySelectorAll('.kanban-card[data-id]').forEach((card) => {
      card.hidden = visibleCardIds ? !visibleCardIds.has(card.dataset.id) : false
    })
  }

  function injectKanbanQuickFilters() {
    const row = document.getElementById('kanbanQuickFilters')
    if (!row) return
    if (row.dataset.apgFiltersInjected && !row.querySelector('.apg-quick-filter')) {
      delete row.dataset.apgFiltersInjected
    }
    if (row.dataset.apgFiltersInjected) return

    for (const filter of QUICK_FILTERS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'apg-quick-filter'
      button.dataset.apgFilter = filter.id
      button.textContent = t(filter.labelKey)
      button.classList.toggle('active', activeKanbanFilters.has(filter.id))
      button.addEventListener('click', () => {
        if (activeKanbanFilters.has(filter.id)) activeKanbanFilters.delete(filter.id)
        else activeKanbanFilters.add(filter.id)
        row.querySelectorAll('.apg-quick-filter').forEach((chip) => {
          chip.classList.toggle('active', activeKanbanFilters.has(chip.dataset.apgFilter))
        })
        applyKanbanVisibilityFilter()
      })
      row.appendChild(button)
    }
    row.dataset.apgFiltersInjected = 'true'
  }

  function showKanbanUnavailable(retry) {
    clearApgKanbanUi()
    const row = document.getElementById('kanbanQuickFilters')
    if (!row) return
    const message = document.createElement('span')
    message.className = 'apg-kanban-unavailable apg-severity-danger'
    message.textContent = t('apg.common.unavailable_short')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'apg-retry-btn'
    button.textContent = t('apg.common.retry')
    button.addEventListener('click', retry)
    message.appendChild(button)
    row.appendChild(message)
  }

  function appendKanbanBadges(items) {
    document.querySelectorAll('.apg-kanban-badge').forEach((badge) => badge.remove())
    const cards = kanbanCardsData()
    for (const item of items) {
      if (item.kanban_card_id == null) continue
      const cardElement = document.querySelector(
        `.kanban-card[data-id="${CSS.escape(String(item.kanban_card_id))}"]`
      )
      const footer = cardElement?.querySelector('.kanban-card-footer')
      if (!footer) continue

      const card = cards.find((candidate) => candidate.id === item.kanban_card_id)
      let label = t('apg.kanban.badge.label', { state: stateLabel(item.display_state) })
      let severity = severityForState(item.display_state)
      if (item.acceptance_status === 'accepted') {
        label = t('apg.kanban.badge.accepted')
        severity = 'success'
      } else if (
        card?.status === 'done'
        && (item.acceptance_status === 'produced' || item.acceptance_status === 'verifying')
      ) {
        label = t('apg.kanban.badge.done_not_accepted')
        severity = 'warning'
      }

      const badge = document.createElement('button')
      badge.type = 'button'
      badge.className = `apg-kanban-badge apg-severity-${severity}`
      badge.dataset.workItemId = item.id
      badge.innerHTML = `
        <span class="apg-kanban-badge-state">${html(label)}</span>
        <span class="apg-kanban-badge-next" title="${attr(item.next_action)}">${html(truncate(item.next_action, 40))}</span>`
      badge.addEventListener('click', (event) => {
        event.stopPropagation()
        Apg.openWorkItemDetail(item.id, item.kanban_card_id)
      })
      footer.appendChild(badge)
    }
  }

  Apg.onKanbanRendered = async function onKanbanRendered() {
    const requestSequence = ++kanbanRequestSequence
    try {
      const summary = await fetchJson('/api/apg/summary')
      if (requestSequence !== kanbanRequestSequence) return
      if (summary.mode === 'off' || summary.enabled === false || summary.apg_ui_kanban_enabled === false) {
        latestKanbanItems = []
        activeKanbanFilters.clear()
        clearApgKanbanUi()
        return
      }
      if (summary.projection_error) throw new Error(summary.projection_error)

      const result = await fetchJson('/api/apg/work-items?limit=500')
      if (requestSequence !== kanbanRequestSequence) return
      if (result.error) throw new Error(result.error)
      latestKanbanItems = Array.isArray(result.items) ? result.items : []
      appendKanbanBadges(latestKanbanItems)
      injectKanbanQuickFilters()
      applyKanbanVisibilityFilter()
    } catch {
      if (requestSequence !== kanbanRequestSequence) return
      showKanbanUnavailable(Apg.onKanbanRendered)
    }
  }

  function cardDetailError(container, retry, message) {
    container.hidden = false
    container.innerHTML = `
      <section class="apg-card-detail-section">
        <div class="apg-degraded apg-severity-danger">
          <span>${message ? translated('apg.common.unavailable', { msg: message }) : translated('apg.common.unavailable_short')}</span>
          <button type="button" class="apg-retry-btn">${translated('apg.common.retry')}</button>
        </div>
      </section>`
    container.querySelector('.apg-retry-btn')?.addEventListener('click', retry)
  }

  Apg.onKanbanCardOpened = async function onKanbanCardOpened(cardId) {
    const container = document.getElementById('cardDetailApgPanel')
    if (!container || !cardId) return
    const requestSequence = ++cardDetailRequestSequence
    container.hidden = true
    container.innerHTML = `
      <section class="apg-card-detail-section">
        <p class="apg-loading">${translated('apg.common.loading')}</p>
      </section>`

    try {
      const result = await fetchJson(
        `/api/apg/work-items?kanban_card_id=${encodeURIComponent(cardId)}&limit=1`
      )
      if (requestSequence !== cardDetailRequestSequence) return
      if (result.error) throw new Error(result.error)
      const item = Array.isArray(result.items) ? result.items[0] : null
      if (!item || item.effective_mode === 'off') {
        container.innerHTML = ''
        container.hidden = true
        return
      }

      container.hidden = false
      const detail = await fetchJson(`/api/apg/work-items/${encodeURIComponent(item.id)}`)
      if (requestSequence !== cardDetailRequestSequence) return
      if (detail.error) throw new Error(detail.error)
      if (detail.effective_mode === 'off') {
        container.innerHTML = ''
        container.hidden = true
        return
      }
      // Evidence toggle (APG_UI_EVIDENCE): when off, hide claims/events/source-ids
      // but still show APG state header (mode, risk, next action).
      let evidenceEnabled = true
      try {
        const summary = await fetchJson('/api/apg/summary')
        if (requestSequence !== cardDetailRequestSequence) return
        evidenceEnabled = summary.apg_ui_evidence_enabled !== false
      } catch { /* keep default true on fetch failure */ }

      const claims = Array.isArray(detail.claims) ? detail.claims : []
      const events = Array.isArray(detail.events)
        ? [...detail.events].sort((a, b) => new Date(a.at) - new Date(b.at))
        : []
      const sourceIds = Array.isArray(detail.source_ids) ? detail.source_ids : []

      container.innerHTML = `
        <section class="apg-card-detail-section">
          <div class="apg-card-detail-heading">
            <strong>APG 0.4 Lean · ${html(stateLabel(detail.display_state))}</strong>
            <span class="apg-mode-chip">${html(detail.effective_mode)}</span>
            <span class="apg-risk">${translated('apg.detail.risk')}: ${html(detail.risk)}</span>
          </div>
          <p class="apg-next-action">${html(detail.next_action)}</p>
          ${evidenceEnabled ? `<details>
            <summary>${translated('apg.detail.technical_details')}</summary>
            <div class="apg-technical-grid">
              <section>
                <h5>${translated('apg.detail.claims')}</h5>
                ${claims.length ? `<ul>${claims.map((claim) => `
                  <li>
                    <span class="apg-state-pill apg-severity-${severityForClaim(claim.status)}">${html(claim.status)}</span>
                    <span>${html(claim.allowed_wording)}</span>
                  </li>`).join('')}</ul>` : `<p class="apg-empty">${translated('apg.detail.no_claims')}</p>`}
              </section>
              <section>
                <h5>${translated('apg.detail.events')}</h5>
                ${events.length ? `<ul>${events.map((event) => `
                  <li class="${event.error ? 'apg-event-error' : ''}">
                    <time>${html(formatDate(event.at))}</time>
                    <span>${html(event.summary)}</span>
                  </li>`).join('')}</ul>` : `<p class="apg-empty">${translated('apg.detail.no_events')}</p>`}
              </section>
              <section>
                <h5>${translated('apg.detail.source_ids')}</h5>
                ${sourceIds.length ? `<ul class="apg-source-ids">${sourceIds.map((id) => `<li>${html(id)}</li>`).join('')}</ul>` : `<p class="apg-empty">${translated('apg.detail.no_source_ids')}</p>`}
              </section>
            </div>
          </details>` : ''}
        </section>`
    } catch (error) {
      if (requestSequence !== cardDetailRequestSequence) return
      cardDetailError(
        container,
        () => Apg.onKanbanCardOpened(cardId),
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  function approvalsData() {
    return typeof _approvalsAll !== 'undefined' && Array.isArray(_approvalsAll)
      ? _approvalsAll
      : []
  }

  function decisionLabel(action) {
    const keys = {
      accept: 'apg.approvals.action.accept',
      request_evidence: 'apg.approvals.action.request_evidence',
      return_for_fix: 'apg.approvals.action.return_for_fix',
      block: 'apg.approvals.action.block',
    }
    return keys[action] ? t(keys[action]) : action
  }

  function showDecisionMessage(approvalId, message, danger) {
    const container = document.getElementById('apgApprovalsSection')
    const card = [...(container?.querySelectorAll('.apg-decision-card') || [])]
      .find((candidate) => candidate.dataset.approvalId === approvalId)
    const target = card?.querySelector('.apg-decision-message')
    if (!target) return
    target.hidden = false
    target.className = `apg-decision-message apg-severity-${danger ? 'danger' : 'success'}`
    target.textContent = message
  }

  async function submitDecision(approvalId, action, button) {
    let note
    if (action === 'block') {
      note = window.prompt(t('apg.approvals.block_prompt'))
      if (note == null) return
      note = note.trim()
      if (!note) {
        window.alert(t('apg.approvals.block_required'))
        return
      }
      if (!window.confirm(t('apg.approvals.block_confirm'))) return
    } else if (!window.confirm(t('apg.approvals.confirm_generic', { action: decisionLabel(action) }))) {
      return
    }

    const card = button.closest('.apg-decision-card')
    card?.querySelectorAll('button').forEach((candidate) => { candidate.disabled = true })
    try {
      const data = await fetchJson(
        `/api/apg/approvals/${encodeURIComponent(approvalId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(note ? { note } : {}),
            idempotency_key: crypto.randomUUID(),
          }),
        }
      )
      showDecisionMessage(approvalId, t('apg.approvals.saved'), false)
      if (typeof loadApprovalsPage === 'function') await loadApprovalsPage()
      await Apg.onApprovalsRendered()
      return data
    } catch (error) {
      if (error.status === 409) {
        const data = error.data || {}
        const resolution = [data.resolved_by, formatDate(data.resolved_at)].filter(Boolean).join(' · ')
        showDecisionMessage(
          approvalId,
          `${data.error || error.message}${resolution ? ' · ' + resolution : ''}`,
          true
        )
      } else {
        showDecisionMessage(approvalId, t('apg.common.unavailable', { msg: error.message }), true)
      }
    } finally {
      card?.querySelectorAll('button').forEach((candidate) => { candidate.disabled = false })
    }
  }

  Apg.onApprovalsRendered = async function onApprovalsRendered() {
    const container = document.getElementById('apgApprovalsSection')
    if (!container) return
    const requestSequence = ++approvalsRequestSequence

    // Backward compat (spec 22): APG_MODE=off must leave the DOM as if this
    // module were absent -- without this check, an empty "APG döntések"
    // section would still render (and be un-hidden) even with APG fully off.
    let mode
    try {
      const summary = await fetchJson('/api/apg/summary')
      if (requestSequence !== approvalsRequestSequence) return
      mode = summary.mode
    } catch {
      if (requestSequence !== approvalsRequestSequence) return
      container.innerHTML = ''
      container.hidden = true
      return
    }
    if (mode === 'off' || summary.apg_ui_approval_enhancements_enabled === false) {
      container.innerHTML = ''
      container.hidden = true
      return
    }

    const pending = approvalsData().filter(
      (approval) => approval.category === 'apg_decision' && approval.status === 'pending'
    )
    container.hidden = false
    if (!pending.length) {
      container.innerHTML = `
        <section class="apg-approvals-block">
          <h2>${translated('apg.approvals.title')}</h2>
          <p class="apg-empty">${translated('apg.approvals.empty')}</p>
        </section>`
      return
    }

    container.innerHTML = `
      <section class="apg-approvals-block">
        <h2>${translated('apg.approvals.title')}</h2>
        <div class="apg-decision-list">
          ${pending.map((approval) => `
            <article class="apg-decision-card" data-approval-id="${attr(approval.id)}">
              <div>
                <span class="apg-state-pill apg-severity-warning">${translated('apg.approvals.decision_needed')}</span>
                <h3>${html(approval.action_description)}</h3>
                <p>${html(approval.agent_id)}</p>
              </div>
              <div class="apg-decision-actions">
                <button type="button" class="btn-primary btn-compact" data-apg-action="accept">${translated('apg.approvals.action.accept')}</button>
                <button type="button" class="btn-secondary btn-compact" data-apg-action="request_evidence">${translated('apg.approvals.action.request_evidence')}</button>
                <button type="button" class="btn-secondary btn-compact" data-apg-action="return_for_fix">${translated('apg.approvals.action.return_for_fix')}</button>
                <button type="button" class="btn-danger btn-compact" data-apg-action="block">${translated('apg.approvals.action.block')}</button>
              </div>
              <p class="apg-decision-message" hidden></p>
            </article>`).join('')}
        </div>
      </section>`

    container.querySelectorAll('[data-apg-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const card = button.closest('.apg-decision-card')
        submitDecision(card.dataset.approvalId, button.dataset.apgAction, button)
      })
    })
  }

  Apg.onActivityRendered = async function onActivityRendered() {
    const container = document.getElementById('apgActivitySection')
    if (!container) return
    const requestSequence = ++activityRequestSequence
    // Stay hidden while we don't yet know the mode -- avoids a visible
    // loading-state flash on every activity refresh when APG is off (spec
    // 22: off must leave the DOM effectively unchanged, not intrusive).
    try {
      const summary = await fetchJson('/api/apg/summary')
      if (requestSequence !== activityRequestSequence) return
      if (summary.mode === 'off' || summary.enabled === false || summary.apg_ui_activity_enabled === false) {
        container.innerHTML = ''
        container.hidden = true
        return
      }
      container.hidden = false
      if (summary.projection_error) {
        container.innerHTML = `
          <details class="apg-activity-block" open>
            <summary>${translated('apg.activity.title')}</summary>
            ${retryBanner()}
          </details>`
        bindRetry(container, Apg.onActivityRendered)
        return
      }
      // Fetch the real events feed (item 5/5: genuine event-log, not just
      // attention_items). Fall back to attention_items if the events endpoint
      // is unavailable (backward compat with older sidecar).
      let events = []
      let eventsFallback = false
      try {
        const eventsResult = await fetchJson('/api/apg/events?limit=20')
        if (requestSequence !== activityRequestSequence) return
        events = Array.isArray(eventsResult.events) ? eventsResult.events : []
      } catch {
        eventsFallback = true
      }
      const attentionItems = Array.isArray(summary.attention_items) ? summary.attention_items : []

      if (events.length) {
        container.innerHTML = `
          <details class="apg-activity-block">
            <summary>${translated('apg.activity.title')}</summary>
            <ul class="apg-activity-list">${events.slice(0, 20).map((event) => {
              const icon = event.error ? '⚠️' : '→'
              return `
              <li class="${event.error ? 'apg-event-error' : ''}">
                <span class="apg-event-icon">${icon}</span>
                <span class="apg-event-summary">${html(event.summary)}</span>
                ${event.work_item_id ? `<a class="apg-event-link" data-work-item-id="${attr(event.work_item_id)}">${html(truncate(event.work_item_id, 12))}</a>` : ''}
                <time>${html(formatDate(event.at))}</time>
              </li>`
            }).join('')}</ul>
            ${events.length >= 20 ? `<p class="apg-activity-note">${translated('apg.activity.more')}</p>` : ''}
          </details>`
        // Click-to-open work-item from event link
        container.querySelectorAll('.apg-event-link').forEach((link) => {
          link.addEventListener('click', () => {
            Apg.openWorkItemDetail(link.dataset.workItemId, null)
          })
        })
      } else if (!eventsFallback && attentionItems.length) {
        // No events yet but attention items exist: show fallback.
        container.innerHTML = `
          <details class="apg-activity-block">
            <summary>${translated('apg.activity.title')}</summary>
            <p class="apg-activity-note">${translated('apg.activity.note')}</p>
            <ul class="apg-activity-list">${attentionItems.slice(0, 5).map((item) => `
              <li>
                <span class="apg-state-pill apg-severity-${severityForState(item.display_state)}">${html(stateLabel(item.display_state))}</span>
                <strong>${html(item.title)}</strong>
                <span>${html(item.reason)}</span>
                <time>${html(formatAge(item.age_seconds))}</time>
              </li>`).join('')}</ul>
          </details>`
      } else {
        container.innerHTML = `
          <details class="apg-activity-block">
            <summary>${translated('apg.activity.title')}</summary>
            <p class="apg-empty">${eventsFallback ? translated('apg.common.unavailable_short') : translated('apg.activity.no_events')}</p>
          </details>`
      }
    } catch {
      if (requestSequence !== activityRequestSequence) return
      container.innerHTML = `
        <details class="apg-activity-block" open>
          <summary>${translated('apg.activity.title')}</summary>
          ${retryBanner()}
        </details>`
      bindRetry(container, Apg.onActivityRendered)
    }
  }

  // --- Scope-override Settings UI (spec 14.5) ---

  const SCOPE_MODES = [
    { value: 'inherit', labelKey: 'apg.scope_mode.inherit' },
    { value: 'off', labelKey: 'apg.scope_mode.off' },
    { value: 'observe', labelKey: 'apg.scope_mode.observe' },
    { value: 'assisted', labelKey: 'apg.scope_mode.assisted' },
    { value: 'enforced', labelKey: 'apg.scope_mode.enforced' },
  ]

  const SCOPE_TYPES = [
    { value: 'project', labelKey: 'apg.scope_type.project' },
    { value: 'kanban_card', labelKey: 'apg.scope_type.kanban_card' },
  ]

  function scopeOverrideModeLabel(mode) {
    const entry = SCOPE_MODES.find((m) => m.value === mode)
    return entry ? t(entry.labelKey) : mode
  }

  function scopeOverrideTypeLabel(type) {
    const entry = SCOPE_TYPES.find((m) => m.value === type)
    return entry ? t(entry.labelKey) : type
  }

  async function loadScopeOverrides(container) {
    container.innerHTML = `<p class="apg-loading">${translated('apg.common.loading')}</p>`
    let overrides
    try {
      const result = await fetchJson('/api/apg/scope-overrides')
      overrides = Array.isArray(result.overrides) ? result.overrides : []
    } catch {
      container.innerHTML = `
        <div class="apg-degraded apg-severity-danger">
          <span>${translated('apg.common.unavailable', { msg: '' })}</span>
          <button type="button" class="apg-retry-btn">${translated('apg.common.retry')}</button>
        </div>`
      container.querySelector('.apg-retry-btn')?.addEventListener('click', () => loadScopeOverrides(container))
      return
    }
    renderScopeOverrideTable(container, overrides)
  }

  function renderScopeOverrideTable(container, overrides) {
    const rows = overrides.length
      ? overrides.map((o) => `
          <tr>
            <td>${html(scopeOverrideTypeLabel(o.scope_type))}</td>
            <td><code>${html(o.scope_id)}</code></td>
            <td><span class="apg-mode-chip">${html(scopeOverrideModeLabel(o.mode))}</span></td>
            <td>${html(formatDate(o.updated_at))}</td>
            <td>${html(o.updated_by)}</td>
            <td>
              <button type="button" class="btn-danger btn-compact apg-scope-delete-btn"
                      data-scope-type="${attr(o.scope_type)}"
                      data-scope-id="${attr(o.scope_id)}">
                ${translated('apg.scope_overrides.delete')}
              </button>
            </td>
          </tr>`).join('')
      : `<tr><td colspan="6" class="apg-empty">${translated('apg.scope_overrides.empty')}</td></tr>`

    container.innerHTML = `
      <section class="apg-scope-overrides">
        <h2>${translated('apg.scope_overrides.title')}</h2>
        <p class="apg-scope-desc">${translated('apg.scope_overrides.desc')}</p>
        <div class="apg-scope-table-wrap">
          <table class="apg-scope-table">
            <thead><tr>
              <th>${translated('apg.scope_overrides.scope')}</th>
              <th>${translated('apg.scope_overrides.scope_id')}</th>
              <th>${translated('apg.scope_overrides.mode')}</th>
              <th>${translated('apg.scope_overrides.updated')}</th>
              <th>${translated('apg.scope_overrides.by')}</th>
              <th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <h3>${translated('apg.scope_overrides.add_title')}</h3>
        <form class="apg-scope-add-form" id="apgScopeAddForm">
          <div class="apg-scope-form-row">
            <label>
              ${translated('apg.scope_overrides.scope')}
              <select name="scope_type" required>
                ${SCOPE_TYPES.map((s) => `<option value="${attr(s.value)}">${html(scopeOverrideTypeLabel(s.value))}</option>`).join('')}
              </select>
            </label>
            <label>
              ${translated('apg.scope_overrides.scope_id')}
              <input type="text" name="scope_id" required
                     placeholder="${translated('apg.scope_overrides.scope_id_placeholder')}">
            </label>
            <label>
              ${translated('apg.scope_overrides.mode')}
              <select name="mode" required>
                ${SCOPE_MODES.map((m) => `<option value="${attr(m.value)}">${html(scopeOverrideModeLabel(m.value))}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="apg-scope-form-row">
            <label>
              ${translated('apg.scope_overrides.reason')}
              <input type="text" name="reason" required
                     placeholder="${translated('apg.scope_overrides.reason_placeholder')}">
            </label>
            <button type="submit" class="btn-primary btn-compact">${translated('apg.scope_overrides.add')}</button>
          </div>
        </form>
        <p class="apg-scope-add-message" id="apgScopeAddMessage" hidden></p>
      </section>`

    // Delete buttons
    container.querySelectorAll('.apg-scope-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const scopeType = btn.dataset.scopeType
        const scopeId = btn.dataset.scopeId
        if (!scopeType || !scopeId) return
        const reason = window.prompt(t('apg.scope_overrides.delete_reason'))
        if (reason == null) return
        if (!reason.trim()) {
          window.alert(t('apg.scope_overrides.reason_required'))
          return
        }
        try {
          await fetchJson(
            `/api/apg/scope-overrides/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`,
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ actor: 'dashboard', reason: reason.trim() }),
            }
          )
          await loadScopeOverrides(container)
        } catch (error) {
          window.alert(t('apg.common.unavailable', { msg: error.message }))
        }
      })
    })

    // Add form
    const form = container.querySelector('#apgScopeAddForm')
    const messageEl = container.querySelector('#apgScopeAddMessage')
    form?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const fd = new FormData(form)
      const payload = {
        scope_type: fd.get('scope_type'),
        scope_id: fd.get('scope_id'),
        mode: fd.get('mode'),
        reason: fd.get('reason'),
        actor: 'dashboard',
      }
      if (!payload.scope_id || !payload.reason) {
        if (messageEl) {
          messageEl.hidden = false
          messageEl.className = 'apg-scope-add-message apg-severity-danger'
          messageEl.textContent = t('apg.scope_overrides.all_fields_required')
        }
        return
      }
      try {
        await fetchJson('/api/apg/scope-overrides', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        form.reset()
        if (messageEl) {
          messageEl.hidden = false
          messageEl.className = 'apg-scope-add-message apg-severity-success'
          messageEl.textContent = t('apg.scope_overrides.saved')
        }
        await loadScopeOverrides(container)
      } catch (error) {
        if (messageEl) {
          messageEl.hidden = false
          messageEl.className = 'apg-scope-add-message apg-severity-danger'
          messageEl.textContent = error.message
        }
      }
    })
  }

  Apg.onSettingsRendered = function onSettingsRendered() {
    const container = document.getElementById('apgScopeOverrideWidget')
    if (!container) return
    loadScopeOverrides(container)
  }

  Apg.mount = function mount() {
    if (mounted) return
    mounted = true
    document.addEventListener('marveen:overview-rendered', Apg.renderOverview)
    document.addEventListener('marveen:kanban-rendered', Apg.onKanbanRendered)
    document.addEventListener('marveen:approvals-rendered', Apg.onApprovalsRendered)
    document.addEventListener('marveen:activity-rendered', Apg.onActivityRendered)
    document.addEventListener('marveen:settings-rendered', Apg.onSettingsRendered)
    document.addEventListener('marveen:kanban-card-opened', (event) => {
      Apg.onKanbanCardOpened(event.detail?.cardId)
    })
    // Enforcement: APG_BLOCK_UNACCEPTED_ARCHIVE archive gate (spec 9.5).
    // app.js dispatches a cancelable CustomEvent before every archive attempt;
    // we preventDefault() when the gate blocks (enforced) or the user cancels
    // the warning (assisted).
    document.addEventListener('marveen:kanban-archive-attempt', async (event) => {
      const cardId = event.detail?.cardId
      if (!cardId) return
      await Apg.refreshEnforcement()
      const state = enforcementState
      if (state.mode !== 'assisted' && state.mode !== 'enforced') return
      if (!state.block_unaccepted_archive) return
      let items
      try {
        const result = await fetchJson(
          `/api/apg/work-items?kanban_card_id=${encodeURIComponent(cardId)}&limit=1`
        )
        items = Array.isArray(result.items) ? result.items : []
      } catch { return /* fail-open */ }
      const unaccepted = items.find(
        (item) =>
          item.effective_mode !== 'off'
          && item.acceptance_status !== 'accepted'
          && item.acceptance_status !== 'not_started'
      )
      if (!unaccepted) return
      if (state.mode === 'enforced') {
        window.alert(t('apg.archive.blocked_unaccepted'))
        event.preventDefault()
      } else {
        if (!window.confirm(t('apg.archive.warn_unaccepted'))) event.preventDefault()
      }
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const overlay = document.getElementById('apgWorkItemOverlay')
      if (!overlay?.classList.contains('active')) return
      overlay.classList.remove('active')
      document.body.style.overflow = ''
    })
  }
})(window.Apg)
