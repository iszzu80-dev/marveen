// Optimization dashboard -- internal state + URL sync.
// Plain global-scope script (no bundler in this repo, matches /lang/*.js convention).
// Top-level page routing stays owned by app.js's hash router (location.hash === 'optimization');
// this module owns everything AFTER that, via location.search + history.pushState/replaceState,
// so internal view/filter changes never trigger app.js's hashchange-driven switchPage().
window.Optimization = window.Optimization || {}

;(function () {
  const DEFAULT_STATE = () => ({
    view: 'overview',
    window: '30d',
    drawer: null, // { type, id }
  })

  let state = DEFAULT_STATE()
  const listeners = []

  function onChange(fn) { listeners.push(fn) }
  function notify() { listeners.forEach((fn) => { try { fn(state) } catch (e) { console.error('[optimization-state] listener failed', e) } }) }

  function parseSearch() {
    const sp = new URLSearchParams(location.search)
    const next = DEFAULT_STATE()
    const view = sp.get('view')
    if (view === 'overview' || view === 'routing' || view === 'decisions' || view === 'controls') next.view = view
    const windowValue = sp.get('window')
    if (windowValue) next.window = windowValue
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
    if (s.window !== '30d') sp.set('window', s.window)
    if (s.drawer) sp.set('drawer', s.drawer.type + ':' + s.drawer.id)
    const qs = sp.toString()
    return qs ? '?' + qs : ''
  }

  // Only act on optimization's own history entries -- if the hash has moved away from
  // optimization, app.js's own hashchange listener already owns navigating elsewhere.
  function isOnOptimizationPage() {
    return (location.hash || '').replace(/^#/, '') === 'optimization'
  }

  function applyFromLocation() {
    if (!isOnOptimizationPage()) return
    state = parseSearch()
    notify()
  }

  // push=true for real navigation (tab/window changes) so back/forward works.
  function update(patch, push) {
    state = Object.assign({}, state, patch)
    const url = location.pathname + serializeSearch(state) + '#optimization'
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    notify()
  }

  window.addEventListener('popstate', applyFromLocation)

  window.Optimization.State = {
    get: () => state,
    init: applyFromLocation,
    setView: (view) => update({ view }, true),
    setWindow: (windowValue) => update({ window: windowValue }, true),
    openDrawer: (type, id) => update({ drawer: { type, id } }, true),
    closeDrawer: () => update({ drawer: null }, true),
    onChange,
  }
})()
