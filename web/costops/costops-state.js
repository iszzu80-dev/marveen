// CostOps Command Center -- internal state + URL sync (UI-0 doc section 6).
// Plain global-scope script (no bundler in this repo, matches /lang/*.js convention).
// Top-level page routing stays owned by app.js's hash router (location.hash === 'costs-cc');
// this module owns everything AFTER that, via location.search + history.pushState/replaceState,
// so internal view/filter changes never trigger app.js's hashchange-driven switchPage().
window.Costops = window.Costops || {}

;(function () {
  const DEFAULT_STATE = () => ({
    view: 'overview',
    month: null, // null = current month
    analyze: { period: '3', group: 'provider', compare: 'none', filters: {} },
    drawer: null, // { type, id } -- unused until UI-2
  })

  let state = DEFAULT_STATE()
  const listeners = []

  function onChange(fn) { listeners.push(fn) }
  function notify() { listeners.forEach((fn) => { try { fn(state) } catch (e) { console.error('[costops-state] listener failed', e) } }) }

  function parseSearch() {
    const sp = new URLSearchParams(location.search)
    const next = DEFAULT_STATE()
    const view = sp.get('view')
    if (view === 'overview' || view === 'analyze' || view === 'close') next.view = view
    const month = sp.get('month')
    if (month && /^\d{4}-\d{2}$/.test(month)) next.month = month
    if (sp.get('period')) next.analyze.period = sp.get('period')
    if (sp.get('group')) next.analyze.group = sp.get('group')
    if (sp.get('compare')) next.analyze.compare = sp.get('compare')
    const provider = sp.get('provider')
    const sourceType = sp.get('source_type')
    if (provider) next.analyze.filters.provider = provider
    if (sourceType) next.analyze.filters.source_type = sourceType
    const drawerRaw = sp.get('drawer')
    if (drawerRaw && drawerRaw.includes(':')) {
      const idx = drawerRaw.indexOf(':')
      next.drawer = { type: drawerRaw.slice(0, idx), id: drawerRaw.slice(idx + 1) }
    }
    return next
  }

  function serializeSearch(s) {
    const sp = new URLSearchParams()
    if (s.view !== 'overview') sp.set('view', s.view)
    if (s.month) sp.set('month', s.month)
    if (s.view === 'analyze') {
      if (s.analyze.period !== '3') sp.set('period', s.analyze.period)
      if (s.analyze.group !== 'provider') sp.set('group', s.analyze.group)
      if (s.analyze.compare !== 'none') sp.set('compare', s.analyze.compare)
      if (s.analyze.filters.provider) sp.set('provider', s.analyze.filters.provider)
      if (s.analyze.filters.source_type) sp.set('source_type', s.analyze.filters.source_type)
    }
    if (s.drawer) sp.set('drawer', s.drawer.type + ':' + s.drawer.id)
    const qs = sp.toString()
    return qs ? '?' + qs : ''
  }

  // Only act on costs-cc's own history entries -- if the hash has moved away from
  // costs-cc, app.js's own hashchange listener already owns navigating elsewhere.
  function isOnCostsCcPage() {
    return (location.hash || '').replace(/^#/, '') === 'costs-cc'
  }

  function applyFromLocation() {
    if (!isOnCostsCcPage()) return
    state = parseSearch()
    notify()
  }

  // push=true for real navigation (tab switch, month change) so back/forward works;
  // push=false (replaceState) for in-place filter tweaks that shouldn't spam history.
  function update(patch, push) {
    state = Object.assign({}, state, patch)
    const url = location.pathname + serializeSearch(state) + '#costs-cc'
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    notify()
  }

  window.addEventListener('popstate', applyFromLocation)

  window.Costops.State = {
    get: () => state,
    init: applyFromLocation,
    setView: (view) => update({ view }, true),
    setMonth: (month) => update({ month }, true),
    setAnalyze: (patch, push) => update({ analyze: Object.assign({}, state.analyze, patch) }, !!push),
    openDrawer: (type, id) => update({ drawer: { type, id } }, true),
    closeDrawer: () => update({ drawer: null }, true),
    onChange,
  }
})()
