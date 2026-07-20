// CostOps Command Center -- univerzális részletpanel (UI-2 card #7, spec section 6).
// One drawer component for all entity types it's actually reachable for in UI-2: source (from
// the Elemzés table), alert / recommendation (from the Áttekintés attention/savings rows).
// NOT wired in UI-2 (scoping decision, not an oversight -- noted to Marveen at milestone):
// - "invoice" as its own entry point: no getInvoiceById exists, only listInvoices(source_id);
//   invoices are shown as a sub-section of the source drawer instead (below).
// - "ledger" / correction-chain audit: needs a raw ledger line id, which no UI-2 element
//   (source-granular, not ledger-line-granular) currently exposes.
// - ack/resolve/accept/dismiss actions: card #7 asked for viewing + audit, not state-changing
//   actions -- read-only for now, a natural follow-up rather than in-scope here.
window.Costops = window.Costops || {}

;(function () {
  const esc = (s) => window.Costops.Charts.esc(s)
  const fmtHuf = (n) => window.Costops.Charts.fmtHuf(n)
  const humanize = (s) => String(s || '').replace(/_/g, ' ')

  function fmtDate(unixSec) {
    if (!unixSec) return '–'
    return new Date(unixSec * 1000).toLocaleDateString('hu-HU')
  }

  async function renderSource(body, id, month) {
    const [summary, inventory, reconciliation, invoicesRes] = await Promise.all([
      window.Costops.Api.summary(month),
      window.Costops.Api.sourceInventory().catch(() => ({ sources: [] })),
      window.Costops.Api.reconciliation(month).catch(() => ({ reconciliation: [] })),
      window.Costops.Api.invoices(id, month).catch(() => ({ invoices: [] })),
    ])
    const src = (summary.all_sources || []).find((s) => s.source_id === id)
    const inv = (inventory.sources || []).find((s) => s.source_id === id)
    const rec = (reconciliation.reconciliation || []).find((r) => r.source_id === id)
    const invoices = invoicesRes.invoices || []
    if (!src && !inv) { body.innerHTML = '<div class="cc-error">Forrás nem található.</div>'; return }

    body.innerHTML = `
      <div class="cc-drawer-title">${esc((src || inv).name || id)}</div>
      <div class="cc-drawer-kv">
        <div>Provider</div><div>${esc((src || inv).provider)}</div>
        <div>Típus</div><div>${esc(humanize((src || inv).source_type))}</div>
        ${src ? `<div>Havi költés</div><div>${fmtHuf(src.spend)}</div>` : ''}
        ${src && src.forecast_month_end != null ? `<div>Forecast</div><div>${fmtHuf(src.forecast_month_end)}</div>` : ''}
        ${src && src.original_amount != null ? `<div>Eredeti összeg</div><div>${src.original_amount} ${esc(src.original_currency || '')}</div>` : ''}
      </div>
      <div class="cc-drawer-section-title">ADATBIZALOM</div>
      <div class="cc-drawer-kv">
        <div>Provenance</div><div>${esc(humanize(src?.confidence))}</div>
        ${inv ? `<div>Freshness</div><div>${esc(inv.freshness)}</div>` : ''}
        ${inv ? `<div>Lifecycle</div><div>${esc(inv.lifecycle)}</div>` : ''}
        ${rec ? `<div>Reconciliation</div><div>${esc(rec.status)}${rec.variance != null ? ` (${fmtHuf(rec.variance)} eltérés)` : ''}</div>` : ''}
        ${inv?.owner ? `<div>Owner</div><div>${esc(inv.owner)}</div>` : ''}
        ${inv?.blocker ? `<div>Blokkoló</div><div>${esc(inv.blocker)}</div>` : ''}
      </div>
      <div class="cc-drawer-section-title">KAPCSOLÓDÓ</div>
      ${invoices.length
        ? `<div class="cc-muted">${invoices.length} invoice</div>` + invoices.slice(0, 5).map((i) => `
            <div class="cc-drawer-row"><span>${esc(i.billing_period_start || '')} – ${esc(i.billing_period_end || '')}</span><span>${fmtHuf(i.net_amount)}</span></div>`).join('')
        : '<div class="cc-muted">Nincs kapcsolódó invoice.</div>'}`
  }

  async function renderAlert(body, dedupKey) {
    const res = await window.Costops.Api.alerts('all').catch(() => ({ alerts: [] }))
    const a = (res.alerts || []).find((x) => x.dedup_key === dedupKey)
    if (!a) { body.innerHTML = '<div class="cc-error">Alert nem található.</div>'; return }
    body.innerHTML = `
      <div class="cc-drawer-title">${esc(humanize(a.type))}</div>
      <div class="cc-drawer-kv">
        <div>Súlyosság</div><div>${esc(a.severity)}</div>
        <div>Első előfordulás</div><div>${fmtDate(a.first_seen)}</div>
        <div>Utolsó előfordulás</div><div>${fmtDate(a.last_seen)}</div>
        <div>Állapot</div><div>${a.resolved_at ? 'resolved' : a.acknowledged_at ? 'acknowledged' : 'open'}</div>
      </div>
      <div class="cc-drawer-section-title">EVIDENCE</div>
      <pre class="cc-evidence">${esc(JSON.stringify(a.evidence, null, 2))}</pre>
      <div class="cc-drawer-section-title">AUDIT HISTORY</div>
      <div class="cc-drawer-row"><span>Első észlelés</span><span>${fmtDate(a.first_seen)}</span></div>
      ${a.acknowledged_at ? `<div class="cc-drawer-row"><span>Nyugtázva (${esc(a.acknowledged_by || '')})</span><span>${fmtDate(a.acknowledged_at)}</span></div>` : ''}
      ${a.resolved_at ? `<div class="cc-drawer-row"><span>Megoldva</span><span>${fmtDate(a.resolved_at)}</span></div>` : ''}`
  }

  async function renderRecommendation(body, dedupKey) {
    const res = await window.Costops.Api.recommendations('all').catch(() => ({ recommendations: [] }))
    const r = (res.recommendations || []).find((x) => x.dedup_key === dedupKey)
    if (!r) { body.innerHTML = '<div class="cc-error">Ajánlás nem található.</div>'; return }
    body.innerHTML = `
      <div class="cc-drawer-title">${esc(humanize(r.type))}</div>
      <div class="cc-drawer-kv">
        <div>Jelenlegi havi költség</div><div>${fmtHuf(r.current_monthly_cost)}</div>
        <div>Becsült havi megtakarítás</div><div>${fmtHuf(r.estimated_monthly_saving)}</div>
        <div>Becsült éves megtakarítás</div><div>${fmtHuf(r.estimated_annual_saving)}</div>
        <div>Kockázat</div><div>${esc(r.risk)}</div>
        <div>Confidence</div><div>${esc(r.confidence)}</div>
        <div>Állapot</div><div>${esc(r.status)}</div>
      </div>
      ${r.human_decision_required ? `<div class="cc-drawer-section-title">SZÜKSÉGES DÖNTÉS</div><div class="cc-muted">${esc(r.human_decision_required)}</div>` : ''}
      ${r.rollback_note ? `<div class="cc-drawer-section-title">ROLLBACK</div><div class="cc-muted">${esc(r.rollback_note)}</div>` : ''}
      <div class="cc-drawer-section-title">EVIDENCE</div>
      <pre class="cc-evidence">${esc(JSON.stringify(r.evidence, null, 2))}</pre>`
  }

  async function render(container, month) {
    const state = window.Costops.State.get()
    const drawer = state.drawer
    if (!drawer) { container.classList.remove('cc-drawer-open'); container.innerHTML = ''; return }
    container.classList.add('cc-drawer-open')
    container.innerHTML = `
      <div class="cc-drawer-header"><button class="cc-drawer-close" id="ccDrawerClose">× Bezárás</button></div>
      <div class="cc-drawer-body" id="ccDrawerBody"><div class="cc-loading">Betöltés...</div></div>`
    container.querySelector('#ccDrawerClose').addEventListener('click', () => window.Costops.State.closeDrawer())
    const body = container.querySelector('#ccDrawerBody')
    try {
      if (drawer.type === 'source') await renderSource(body, drawer.id, month)
      else if (drawer.type === 'alert') await renderAlert(body, drawer.id)
      else if (drawer.type === 'recommendation') await renderRecommendation(body, drawer.id)
      else body.innerHTML = `<div class="cc-muted">Ismeretlen típus: ${esc(drawer.type)}</div>`
    } catch (e) {
      body.innerHTML = `<div class="cc-error">Betöltés sikertelen: ${esc(e.message)}</div>`
    }
  }

  window.Costops.Drawer = { render }
})()
