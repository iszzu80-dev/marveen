// Optimization dashboard -- fetch + short in-memory TTL cache. app.js's global fetch wrapper
// already attaches the dashboard Bearer token to same-origin /api/* calls, so plain fetch()
// here is enough -- no auth handling needed in this module.
window.Optimization = window.Optimization || {}

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

  // Mutations are never cached and always clear the read cache afterward.
  async function postJson2(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    invalidateAll()
    return { ok: res.ok, status: res.status, body: json }
  }

  async function postJson(url, body) {
    return postJson2('POST', url, body)
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

  window.Optimization.Api = {
    summary: (from, to) => getJson('/api/optimization/summary' + qs({ from, to })),
    routing: (opts) => getJson('/api/optimization/routing' + qs({ agent: opts?.agent, state: opts?.state, problematicOnly: opts?.problematicOnly })),
    routingPreview: (agent) => postJson('/api/optimization/routing/preview', { agent }),
    recommendations: (status, from, to) => getJson('/api/optimization/recommendations' + qs({ status, from, to })),
    recommendationEvents: (packageId) => getJson('/api/optimization/recommendations/events' + qs({ package_id: packageId })),
    decide: (packageId, status, actor, note, deferredUntil) => postJson('/api/optimization/recommendations/decision', { package_id: packageId, status, actor, note, deferredUntil }),
    settings: () => getJson('/api/optimization/settings'),
    saveSettings: (config, expectedVersion, preview) => postJson2('PATCH', '/api/optimization/settings', Object.assign({}, config, { expectedVersion, preview })),
    emergencyDisable: () => postJson('/api/optimization/emergency-disable', {}),
    audit: () => getJson('/api/optimization/audit'),
    invalidateAll,
  }
})()
