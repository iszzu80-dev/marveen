// CostOps Command Center -- moduláris shell (UI-1 card #1): tab bar, hónap-választó,
// belső routing dispatch, wide-workspace osztály. Content per tab lives in its own module
// (costops-overview.js now; costops-analysis.js/costops-close.js follow in UI-2/UI-3).
window.Costops = window.Costops || {}

;(function () {
  const TABS = [
    { id: 'overview', label: 'Áttekintés' },
    { id: 'analyze', label: 'Elemzés' },
    { id: 'close', label: 'Havi zárás' },
  ]

  function recentMonths(n) {
    const out = []
    const d = new Date()
    for (let i = 0; i < n; i++) {
      const y = d.getFullYear(), m = d.getMonth() + 1 - i
      const dd = new Date(y, m - 1, 1)
      out.push(dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0'))
    }
    return out
  }

  let mounted = false

  function shellHtml() {
    const months = recentMonths(12)
    return `
      <div class="cc-shell">
        <div class="cc-topbar">
          <div class="cc-tabs" role="tablist">
            ${TABS.map((t) => `<button class="cc-tab" role="tab" data-view="${t.id}">${t.label}</button>`).join('')}
          </div>
          <select class="cc-month-select" id="ccMonthSelect">
            ${months.map((m) => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="cc-body-row">
          <div class="cc-view" id="ccViewBody"></div>
          <div class="cc-drawer" id="ccDrawer"></div>
        </div>
        <div class="cc-drawer-backdrop" id="ccDrawerBackdrop"></div>
      </div>`
  }

  function renderActiveTab() {
    const state = window.Costops.State.get()
    document.querySelectorAll('.cc-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.view))
    const monthSelect = document.getElementById('ccMonthSelect')
    if (monthSelect) monthSelect.value = state.month || recentMonths(1)[0]
    const body = document.getElementById('ccViewBody')
    const drawer = document.getElementById('ccDrawer')
    const backdrop = document.getElementById('ccDrawerBackdrop')
    if (!body) return
    if (state.view === 'overview') window.Costops.Overview.render(body, state.month)
    else if (state.view === 'analyze') window.Costops.Analysis.render(body, state.month)
    else if (state.view === 'close') window.Costops.Close.render(body, state.month)
    if (drawer) window.Costops.Drawer.render(drawer, state.month)
    if (backdrop) backdrop.classList.toggle('cc-drawer-backdrop-open', !!state.drawer)
  }

  // Keyboard operability for the string-templated role="button" rows (bar/table/attention/
  // savings) -- a plain <div tabindex="0" role="button"> is focusable but, unlike a real
  // <button>, does NOT activate on Enter/Space by default. One delegated listener covers every
  // such row across all views instead of duplicating the same handler at each render site.
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
    root.querySelectorAll('.cc-tab').forEach((btn) => {
      btn.addEventListener('click', () => window.Costops.State.setView(btn.dataset.view))
    })
    const monthSelect = root.querySelector('#ccMonthSelect')
    if (monthSelect) monthSelect.addEventListener('change', () => window.Costops.State.setMonth(monthSelect.value))
    root.querySelector('#ccDrawerBackdrop')?.addEventListener('click', () => window.Costops.State.closeDrawer())
    wireKeyboardActivation(root)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && window.Costops.State.get().drawer) window.Costops.State.closeDrawer()
    })
  }

  function mount() {
    const page = document.getElementById('costs-ccPage')
    if (!page) { console.error('[costops-shell] #costs-ccPage not found'); return }
    document.querySelector('main')?.classList.add('costs-cc-active')
    if (!mounted) {
      const body = page.querySelector('#costsCcBody')
      body.innerHTML = shellHtml()
      wireEvents(page)
      window.Costops.State.onChange(renderActiveTab)
      mounted = true
    }
    window.Costops.State.init()
    renderActiveTab()
  }

  window.Costops.mount = mount
})()
