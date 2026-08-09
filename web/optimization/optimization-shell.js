// Optimization dashboard -- modular shell: global status, tab bar, internal routing dispatch,
// keyboard activation, and drawer dismissal. Content per tab lives in its own module.
window.Optimization = window.Optimization || {}

;(function () {
  const TABS = [
    { id: 'overview', labelKey: 'optimization.tab.overview' },
    { id: 'routing', labelKey: 'optimization.tab.routing' },
    { id: 'decisions', labelKey: 'optimization.tab.decisions' },
    { id: 'controls', labelKey: 'optimization.tab.controls' },
  ]

  const STATUS_LABEL_KEYS = {
    ok: 'optimization.status.ok',
    observation: 'optimization.status.observation',
    attention_needed: 'optimization.status.attention_needed',
    partially_disabled: 'optimization.status.partially_disabled',
    disabled: 'optimization.status.disabled',
  }

  const STATUS_VARIANTS = {
    ok: 'ok',
    observation: 'warning',
    attention_needed: 'critical',
    partially_disabled: 'warning',
    disabled: 'disabled',
  }

  let mounted = false
  let lastSummary = null

  function shellHtml() {
    return `
      <div class="opt-shell">
        <header class="opt-status-header">
          <div>
            <h1 class="opt-page-title"></h1>
            <p class="opt-page-subtitle"></p>
          </div>
          <div class="opt-status-line">
            <span class="opt-status-badge opt-status-disabled"></span>
            <span class="opt-status-detail"></span>
          </div>
        </header>
        <div class="opt-tabs" role="tablist">
          ${TABS.map((tab) => `<button class="opt-tab" role="tab" data-view="${tab.id}"></button>`).join('')}
        </div>
        <div class="opt-body-row">
          <div class="opt-view" id="optimizationViewBody"></div>
          <div class="opt-drawer" id="optimizationDrawer"></div>
        </div>
        <div class="opt-drawer-backdrop" id="optimizationDrawerBackdrop"></div>
      </div>`
  }

  function formatFreshness(value) {
    if (!Number.isFinite(value)) return t('optimization.no_data')
    const locale = window._lang === 'en' ? 'en-US' : 'hu-HU'
    const formatted = new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value * 1000))
    return t('optimization.status.freshness', { value: formatted })
  }

  function renderStatusHeader() {
    const header = document.querySelector('#optimizationPage .opt-status-header')
    if (!header) return
    const title = header.querySelector('.opt-page-title')
    const subtitle = header.querySelector('.opt-page-subtitle')
    const badge = header.querySelector('.opt-status-badge')
    const detail = header.querySelector('.opt-status-detail')
    if (title) title.textContent = t('optimization.page_title')
    if (subtitle) subtitle.textContent = t('optimization.page_subtitle')
    if (!badge || !detail) return

    if (!lastSummary) {
      badge.className = 'opt-status-badge opt-status-disabled'
      badge.textContent = t('optimization.no_data')
      detail.textContent = ''
      return
    }

    const state = STATUS_LABEL_KEYS[lastSummary.system_state] ? lastSummary.system_state : 'disabled'
    badge.className = 'opt-status-badge opt-status-' + STATUS_VARIANTS[state]
    badge.textContent = t(STATUS_LABEL_KEYS[state])
    const modules = t('optimization.status.modules', {
      active: Number.isFinite(lastSummary.active_module_count) ? lastSummary.active_module_count : t('optimization.no_data'),
      total: 7,
    })
    detail.textContent = '· ' + modules + ' · ' + formatFreshness(lastSummary.data_freshness)
  }

  function renderActiveTab() {
    const state = window.Optimization.State.get()
    document.querySelectorAll('#optimizationPage .opt-tab').forEach((btn) => {
      const tab = TABS.find((item) => item.id === btn.dataset.view)
      if (tab) btn.textContent = t(tab.labelKey)
      const active = btn.dataset.view === state.view
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-selected', active ? 'true' : 'false')
      btn.tabIndex = active ? 0 : -1
    })
    renderStatusHeader()
    const body = document.getElementById('optimizationViewBody')
    const drawer = document.getElementById('optimizationDrawer')
    const backdrop = document.getElementById('optimizationDrawerBackdrop')
    if (!body) return
    if (state.view === 'overview') window.Optimization.Overview?.render?.(body)
    else if (state.view === 'routing') window.Optimization.Routing?.render?.(body)
    else if (state.view === 'decisions') window.Optimization.Decisions?.render?.(body)
    else if (state.view === 'controls') window.Optimization.Controls?.render?.(body)
    if (drawer) window.Optimization.Drawer?.render?.(drawer)
    if (backdrop) backdrop.classList.toggle('opt-drawer-backdrop-open', !!state.drawer)
  }

  // A delegated listener makes string-templated role="button" rows activate on Enter/Space.
  function wireKeyboardActivation(root) {
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const el = e.target.closest('[role="button"]')
      if (!el || !root.contains(el)) return
      e.preventDefault()
      el.click()
    })
  }

  function wireEvents(root) {
    root.querySelectorAll('.opt-tab').forEach((btn) => {
      btn.addEventListener('click', () => window.Optimization.State.setView(btn.dataset.view))
    })
    root.querySelector('#optimizationDrawerBackdrop')?.addEventListener('click', () => window.Optimization.State.closeDrawer())
    wireKeyboardActivation(root)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && window.Optimization.State.get().drawer) window.Optimization.State.closeDrawer()
    })
  }

  function setStatusFromSummary(summary) {
    lastSummary = summary || null
    renderStatusHeader()
  }

  function mount() {
    const page = document.getElementById('optimizationPage')
    if (!page) { console.error('[optimization-shell] #optimizationPage not found'); return }
    if (!mounted) {
      const body = page.querySelector('#optimizationBody')
      if (!body) { console.error('[optimization-shell] #optimizationBody not found'); return }
      body.innerHTML = shellHtml()
      wireEvents(page)
      window.Optimization.State.onChange(renderActiveTab)
      mounted = true
    }
    window.Optimization.State.init()
    renderActiveTab()
  }

  window.Optimization.Shell = {
    renderActiveTab,
    setStatusFromSummary,
  }
  window.Optimization.mount = mount
})()
