// CostOps Command Center -- fetch + short in-memory TTL cache (UI-0 doc section 8, lazy-loading
// plan). app.js's global fetch wrapper already attaches the dashboard Bearer token to same-origin
// /api/* calls, so plain fetch() here is enough -- no auth handling needed in this module.
window.Costops = window.Costops || {}

;(function () {
  const CACHE_TTL_MS = 60_000
  const cache = new Map() // url -> { at, promise }

  async function getJson(url) {
    const hit = cache.get(url)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status)
        return res.json()
      })
      .catch((err) => {
        cache.delete(url) // don't cache failures
        throw err
      })
    cache.set(url, { at: Date.now(), promise })
    return promise
  }

  function invalidateAll() { cache.clear() }

  // POSTs are never cached, and always clear the read cache afterward -- a close/reopen changes
  // period-close status, the readiness checklist, and (on close) freezes a snapshot, all of which
  // would otherwise serve stale cached GETs for up to CACHE_TTL_MS.
  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    invalidateAll()
    return { ok: res.ok, status: res.status, body: json }
  }

  function qs(params) {
    const sp = new URLSearchParams()
    Object.keys(params || {}).forEach((k) => {
      const v = params[k]
      if (v !== undefined && v !== null && v !== '') sp.set(k, v)
    })
    const s = sp.toString()
    return s ? '?' + s : ''
  }

  window.Costops.Api = {
    summary: (month) => getJson('/api/costs/summary' + qs({ month })),
    period: (months, month) => getJson('/api/costs/period' + qs({ months, month })),
    alerts: (status) => getJson('/api/costs/alerts' + qs({ status: status || 'all' })),
    recommendations: (status) => getJson('/api/costs/recommendations' + qs({ status: status || 'all' })),
    sourceInventory: () => getJson('/api/costs/source-inventory'),
    reconciliation: (month) => getJson('/api/costs/reconciliation' + qs({ month })),
    budgets: (month) => getJson('/api/costs/budgets' + qs({ month })),
    forecastSnapshots: (month) => getJson('/api/costs/forecast-snapshots' + qs({ month })),
    invoices: (sourceId, month) => getJson('/api/costs/invoices' + qs({ source_id: sourceId, month })),
    periodClose: (month) => getJson('/api/costs/period-close' + qs({ month })),
    invoiceReconciliation: (month) => getJson('/api/costs/invoices/reconciliation' + qs({ month })),
    closePeriod: (month, actor, reason, force) => postJson('/api/costs/period-close/close', { month, actor, reason, force }),
    reopenPeriod: (month, actor, reason) => postJson('/api/costs/period-close/reopen', { month, actor, reason }),
    exportUrl: (kind, params) => '/api/costs/export/' + kind + qs(Object.assign({ format: 'csv' }, params)),
    exportUrlJson: (kind, params) => '/api/costs/export/' + kind + qs(params),
    invalidateAll,
  }
})()
