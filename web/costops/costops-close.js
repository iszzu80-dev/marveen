// CostOps Command Center -- Havi zárás nézet (UI-3 cards #9-11).
// GET /api/costs/period-close returns {month, status, readiness, history, snapshot} verbatim
// (src/web/routes/costs.ts) -- readiness.checks has exactly 6 backend-real checks (period-close.ts
// CloseReadinessResult), grouped below under the spec's 4 conceptual headings for display only;
// no extra checklist item is invented beyond what the backend actually returns.
window.Costops = window.Costops || {}

;(function () {
  const esc = (s) => window.Costops.Charts.esc(s)
  const fmtHuf = (n) => window.Costops.Charts.fmtHuf(n)

  function fmtDate(unixSec) {
    if (!unixSec) return '–'
    return new Date(unixSec * 1000).toLocaleString('hu-HU')
  }

  const STATUS_LABEL = { open: 'NYITOTT', provisional: 'PROVISIONAL', closed: 'LEZÁRT', reopened: 'ÚJRANYITOTT' }

  // GET /api/costs/period-close requires an explicit ?month= (400s without it, unlike /summary
  // and /period which default to the current month) -- resolve state.month=null to an actual
  // YYYY-MM string before calling it.
  function resolveMonth(month) {
    if (month) return month
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  }

  // Groups the 6 backend-real checks (period-close.ts CloseReadinessResult) under the spec's 4
  // conceptual headings (7.2) -- display grouping only, not a backend concept. No 'Output' group:
  // the backend has no dedicated check for "snapshot/report generálható", that's just what the
  // Close button itself does below, not a separate readiness item to fabricate.
  function checklistHtml(checks) {
    const groups = [
      { title: 'Adatlefedettség', items: [
        ['expected_invoices_received', 'Minden várt invoice beérkezett', (c) => c.missing.length ? `Hiányzó: ${c.missing.join(', ')}` : null],
        ['collectors_fresh', 'Collectorok frissek', (c) => c.failed_providers.length ? `Sikertelen: ${c.failed_providers.join(', ')}` : c.stale_providers.length ? `Elavult: ${c.stale_providers.join(', ')}` : null],
      ] },
      { title: 'Accounting', items: [
        ['reconciliation_clean', 'Reconciliation kész', (c) => c.issues.length ? `${c.issues.length} eltérés` : null],
        ['fx_provenance_complete', 'FX-adatok rögzítve', (c) => c.missing_count ? `${c.missing_count} hiányzó FX-adat` : null],
      ] },
      { title: 'Kontroll', items: [
        ['unresolved_alerts', 'Nincs megoldatlan kritikus alert', (c) => c.critical_count ? `${c.critical_count} kritikus (${c.count} összes nyitott)` : null],
        ['estimates_present', 'Estimate-ek elfogadva/kiváltva', (c) => c.estimate_only_sources.length ? `${c.estimate_only_sources.length} estimate-only forrás` : null],
      ] },
    ]
    return groups.map((g) => `
      <div class="cc-checklist-group">
        <div class="cc-checklist-group-title">${esc(g.title)}</div>
        ${g.items.map(([key, label, detail]) => {
          const c = checks[key]
          const d = detail(c)
          return `<div class="cc-check-row ${c.ok ? 'cc-check-ok' : 'cc-check-fail'}">
            <span class="cc-check-icon">${c.ok ? '✓' : '!'}</span>
            <span class="cc-check-label">${esc(label)}</span>
            ${d ? `<span class="cc-check-detail">${esc(d)}</span>` : ''}
          </div>`
        }).join('')}
      </div>`).join('')
  }

  function reconciliationTableHtml(rows) {
    if (!rows || !rows.length) return '<div class="cc-muted">Nincs reconciliation adat.</div>'
    const trs = rows.map((r) => `
      <tr>
        <td data-label="Source">${esc(r.name || r.source_id)}</td>
        <td class="cc-num" data-label="Ledger">${r.expected_amount != null ? fmtHuf(r.expected_amount) : '–'}</td>
        <td class="cc-num" data-label="Invoice">${r.invoice?.net_amount != null ? fmtHuf(r.invoice.net_amount) : r.invoice_amount != null ? fmtHuf(r.invoice_amount) : '–'}</td>
        <td class="cc-num" data-label="Provider">${r.observed_provider_amount != null ? fmtHuf(r.observed_provider_amount) : '–'}</td>
        <td class="cc-num" data-label="Delta">${r.variance != null ? fmtHuf(r.variance) : '–'}</td>
        <td data-label="Status"><span class="cc-status-badge cc-status-${esc(r.status)}">${esc(r.status.replace(/_/g, ' '))}</span></td>
      </tr>`).join('')
    return `<table class="cc-table"><thead><tr><th>Source</th><th>Ledger</th><th>Invoice</th><th>Provider</th><th>Delta</th><th>Status</th></tr></thead><tbody>${trs}</tbody></table>`
  }

  function summaryHtml(summary, label) {
    if (!summary) return '<div class="cc-muted">Az élő összefoglaló jelenleg nem elérhető.</div>'
    return `
      <div class="cc-close-summary">
        <div class="cc-close-summary-title">${esc(label)}</div>
        <div class="cc-drawer-kv">
          <div>Operational spend</div><div>${fmtHuf(summary.operational_spend)}</div>
          ${summary.budget ? `<div>Budget variance</div><div>${fmtHuf(summary.operational_spend - summary.budget.amount)}</div>` : ''}
          ${summary.month_over_month_delta != null ? `<div>MoM változás</div><div>${summary.month_over_month_delta >= 0 ? '+' : ''}${fmtHuf(summary.month_over_month_delta)}</div>` : ''}
        </div>
      </div>`
  }

  function historyHtml(history) {
    if (!history || !history.length) return '<div class="cc-muted">Nincs close/reopen esemény.</div>'
    return history.map((h) => `
      <div class="cc-drawer-row"><span>${h.event_type === 'closed' ? 'Lezárva' : 'Újranyitva'} (${esc(h.actor)})${h.reason ? ' -- ' + esc(h.reason) : ''}</span><span>${fmtDate(h.created_at)}</span></div>`).join('')
  }

  function actionHtml(status, readiness) {
    if (status === 'closed') {
      return `
        <div class="cc-close-action">
          <input type="text" id="ccReopenActor" placeholder="Actor (ki nyitja újra)" class="cc-input">
          <input type="text" id="ccReopenReason" placeholder="Indoklás (kötelező)" class="cc-input">
          <button class="btn-secondary" id="ccReopenBtn">Reopen</button>
        </div>`
    }
    const blockers = readiness.ready ? '' : `
      <div class="cc-close-blockers">
        <div class="cc-check-fail">Blokkoló tételek vannak -- close csak force-szal engedélyezett.</div>
        <label><input type="checkbox" id="ccForceClose"> Force close (indoklás megadása kötelező)</label>
      </div>`
    return `
      <div class="cc-close-action">
        <input type="text" id="ccCloseActor" placeholder="Actor (ki zárja le)" class="cc-input">
        <input type="text" id="ccCloseReason" placeholder="Megjegyzés (opcionális, kivéve force esetén kötelező)" class="cc-input">
        ${blockers}
        <button class="btn-secondary" id="ccCloseBtn">Close</button>
        <div class="cc-muted" id="ccCloseMsg"></div>
      </div>`
  }

  function wireActions(root, month, refresh) {
    root.querySelector('#ccCloseBtn')?.addEventListener('click', async () => {
      const actor = root.querySelector('#ccCloseActor')?.value?.trim()
      const reason = root.querySelector('#ccCloseReason')?.value?.trim() || null
      const force = root.querySelector('#ccForceClose')?.checked === true
      const msg = root.querySelector('#ccCloseMsg')
      if (!actor) { msg.textContent = 'Actor megadása kötelező.'; return }
      if (force && !reason) { msg.textContent = 'Force close esetén indoklás kötelező.'; return }
      msg.textContent = 'Folyamatban...'
      try {
        const { ok, status, body } = await window.Costops.Api.closePeriod(month, actor, reason, force)
        if (!ok || !body.ok) { msg.textContent = body.error || `Sikertelen (${status})`; return }
        refresh()
      } catch (e) { msg.textContent = 'Hálózati hiba: ' + e.message }
    })
    root.querySelector('#ccReopenBtn')?.addEventListener('click', async () => {
      const actor = root.querySelector('#ccReopenActor')?.value?.trim()
      const reason = root.querySelector('#ccReopenReason')?.value?.trim()
      if (!actor || !reason) { alert('Actor és indoklás is kötelező reopenhez.'); return }
      try {
        const { ok, status, body } = await window.Costops.Api.reopenPeriod(month, actor, reason)
        if (!ok || !body.ok) { alert(body.error || `Sikertelen (${status})`); return }
        refresh()
      } catch (e) { alert('Hálózati hiba: ' + e.message) }
    })
  }

  async function render(root, month) {
    root.innerHTML = '<div class="cc-loading">Betöltés...</div>'
    const resolvedMonth = resolveMonth(month)
    // Only period-close is critical (the whole view is built around its status/readiness) --
    // invoice-reconciliation and summary degrade to an empty/partial state on their own failure
    // instead of blanking the entire view, matching the same partial-load convention Overview
    // and Analysis already use for their own non-critical fetches.
    let periodClose, invRecon, summary
    try {
      periodClose = await window.Costops.Api.periodClose(resolvedMonth)
    } catch (e) {
      root.innerHTML = `<div class="cc-error">Betöltés sikertelen: ${esc(e.message)}</div>`
      return
    }
    ;[invRecon, summary] = await Promise.all([
      window.Costops.Api.invoiceReconciliation(resolvedMonth).catch(() => ({ reconciliation: [] })),
      window.Costops.Api.summary(month).catch(() => null),
    ])

    const okCount = Object.values(periodClose.readiness.checks).filter((c) => c.ok).length
    const totalChecks = Object.keys(periodClose.readiness.checks).length
    const exportUrl = window.Costops.Api.exportUrlJson('monthly-snapshot', { month: resolvedMonth })

    root.innerHTML = `
      <div class="cc-close-header">
        <div class="cc-close-month">${esc(periodClose.month)}</div>
        <div class="cc-status-badge cc-status-${periodClose.status}">${STATUS_LABEL[periodClose.status] || esc(periodClose.status)}</div>
      </div>
      <div class="cc-muted" style="margin-bottom:12px">Close readiness: ${okCount}/${totalChecks} ellenőrzés rendben ${periodClose.readiness.ready ? '(zárható)' : '(blokkoló tétel van)'}</div>
      <div class="cc-section">
        <div class="cc-section-title">1. READINESS CHECKLIST</div>
        ${checklistHtml(periodClose.readiness.checks)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">2. RECONCILIATION</div>
        ${reconciliationTableHtml(invRecon.reconciliation)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">3-4. ZÁRÁSI ÖSSZEFOGLALÓ</div>
        ${periodClose.status === 'closed' && periodClose.snapshot
          ? summaryHtml(periodClose.snapshot.summary, 'Lezárt pillanatkép (immutable)')
          : summaryHtml(summary, 'Élő állapot (még nem lezárt)')}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">5. CLOSE / REOPEN</div>
        ${actionHtml(periodClose.status, periodClose.readiness)}
      </div>
      <div class="cc-section">
        <div class="cc-section-title">AUDIT HISTORY</div>
        ${historyHtml(periodClose.history)}
      </div>
      <div class="cc-export-bar">
        <a class="cc-export-link" href="${esc(exportUrl)}" target="_blank" rel="noopener">Monthly snapshot export (JSON)</a>
      </div>`

    wireActions(root, periodClose.month, () => render(root, month))
  }

  window.Costops.Close = { render }
})()
