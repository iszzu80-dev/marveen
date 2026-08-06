// LOCAL-FORK: cos seam (keep on rebase). Mission Control client module for the
// Personal Chief of Staff case store. Read-only: renders "Ma" (today) and
// "Ügyek" (all active) from /api/cos/*. Vanilla JS; the global fetch wrapper in
// app.js attaches the Bearer token, so bare fetch() is authenticated.
(function () {
  'use strict'

  var SENS_COLOR = {
    PUBLIC: '#9ca3af', PERSONAL: '#60a5fa',
    SENSITIVE_PERSONAL: '#f59e0b', HIGHLY_SENSITIVE: '#ef4444',
  }
  var PRIO_COLOR = { P0: '#ef4444', P1: '#f59e0b', P2: '#60a5fa', P3: '#9ca3af' }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtDate(sec) {
    if (!sec) return ''
    try {
      return new Date(sec * 1000).toLocaleString('hu-HU', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    } catch (e) { return '' }
  }

  function pill(text, color) {
    return '<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;' +
      'background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;">' + esc(text) + '</span>'
  }

  function card(c) {
    var prio = PRIO_COLOR[c.priority] || '#9ca3af'
    var sens = SENS_COLOR[c.sensitivity] || '#9ca3af'
    var meta = []
    if (c.next_action) {
      meta.push('<div style="font-size:13px;margin-top:4px;">→ ' + esc(c.next_action) +
        (c.next_action_owner ? ' <span style="color:var(--text-muted,#888);">(' + esc(c.next_action_owner) + ')</span>' : '') + '</div>')
    }
    if (c.waiting_on) {
      meta.push('<div style="font-size:12px;color:var(--text-muted,#888);margin-top:2px;">⏳ ' + esc(c.waiting_on) + '</div>')
    }
    var due = c.due_at ? fmtDate(c.due_at) : (c.follow_up_at ? fmtDate(c.follow_up_at) : '')
    var dueLabel = due ? '<span style="font-size:12px;color:var(--text-muted,#888);">🗓 ' + esc(due) + '</span>' : ''
    return '<div style="border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px 12px;margin-bottom:8px;' +
      'border-left:3px solid ' + prio + ';">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<strong style="font-size:14px;">' + esc(c.title) + '</strong>' +
        pill(c.status, prio) + pill(c.sensitivity, sens) +
        '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(c.case_type) + '</span>' +
        '<span style="margin-left:auto;">' + dueLabel + '</span>' +
      '</div>' + meta.join('') + '</div>'
  }

  function section(title, cases, emptyMsg) {
    var inner
    if (!cases || cases.length === 0) {
      inner = '<p style="color:var(--text-muted,#888);font-size:13px;">' + esc(emptyMsg) + '</p>'
    } else {
      inner = cases.map(card).join('')
    }
    return '<section style="margin-bottom:24px;">' +
      '<h2 style="font-size:16px;margin:0 0 10px;">' + esc(title) +
      ' <span style="color:var(--text-muted,#888);font-weight:normal;font-size:13px;">(' + (cases ? cases.length : 0) + ')</span></h2>' +
      inner + '</section>'
  }

  // ---- Slice 1+ read-only views: outbound / campaigns / radar ----
  var OUT_COLOR = {
    PLANNED: '#9ca3af', SENDING: '#f59e0b', APPLIED_UNVERIFIED: '#60a5fa', VERIFIED: '#22c55e',
    OUTCOME_UNKNOWN: '#f59e0b', RECOVERY_REQUIRED: '#ef4444',
    FAILED_RETRYABLE: '#f59e0b', FAILED_TERMINAL: '#ef4444', CANCELLED: '#9ca3af',
  }
  var CAMP_COLOR = { DRAFT: '#9ca3af', APPROVED: '#22c55e', PAUSED: '#f59e0b', REVOKED: '#ef4444', COMPLETED: '#60a5fa' }
  var RADAR_COLOR = { ACTIVE: '#60a5fa', PAUSED: '#9ca3af', HIT: '#22c55e', CLOSED: '#9ca3af' }

  function row(left, right, color) {
    return '<div style="border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:8px 12px;margin-bottom:6px;' +
      'border-left:3px solid ' + (color || '#9ca3af') + ';display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
      left + '<span style="margin-left:auto;">' + right + '</span></div>'
  }
  function genericSection(title, items, emptyMsg, renderItem) {
    var inner = (!items || !items.length)
      ? '<p style="color:var(--text-muted,#888);font-size:13px;">' + esc(emptyMsg) + '</p>'
      : items.map(renderItem).join('')
    return '<section style="margin-bottom:24px;"><h2 style="font-size:16px;margin:0 0 10px;">' + esc(title) +
      ' <span style="color:var(--text-muted,#888);font-weight:normal;font-size:13px;">(' + (items ? items.length : 0) + ')</span></h2>' + inner + '</section>'
  }
  function outboundItem(o) {
    var c = OUT_COLOR[o.status] || '#9ca3af'
    return row(
      '<strong style="font-size:13px;">' + esc(o.action_type) + '</strong>' + pill(o.status, c) +
        '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(o.case_id || '') + ' #' + esc(o.sequence_number) + '</span>',
      (o.external_ref ? '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(o.external_ref) + '</span>' : '') +
        (o.attempt > 1 ? ' <span style="font-size:11px;color:#f59e0b;">×' + esc(o.attempt) + '</span>' : ''), c)
  }
  function campaignItem(c) {
    var col = CAMP_COLOR[c.status] || '#9ca3af'
    return row(
      '<strong style="font-size:13px;">' + esc(c.campaign_type) + '</strong>' + pill(c.status, col) +
        (c.allows_free_text ? pill('free-text', '#f59e0b') : '') +
        '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(c.case_id || '') + ' v' + esc(c.version) + '</span>',
      '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(c.approved_current) + ' jóváhagyva</span>', col)
  }
  function radarItem(r) {
    var col = RADAR_COLOR[r.status] || '#9ca3af'
    var price = (r.latest_price != null ? Number(r.latest_price).toLocaleString() + ' ' + esc(r.currency || '') : '—')
    var target = (r.target_price != null ? 'cél ' + Number(r.target_price).toLocaleString() : '')
    return row(
      '<strong style="font-size:13px;">' + esc(r.label) + '</strong>' + pill(r.status, col) +
        '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(r.kind) + '</span>',
      '<span style="font-size:12px;">' + price + '</span> <span style="font-size:11px;color:var(--text-muted,#888);">' + esc(target) + '</span>', col)
  }

  // ---- Monitoring view (#5b): connector health + outbound roll-up + quotas ----
  var CONN_COLOR = { OK: '#22c55e', DEGRADED: '#f59e0b', DOWN: '#ef4444', UNKNOWN: '#9ca3af' }
  function monitoringSection(mon) {
    mon = mon || {}
    var connectors = mon.connectors || []
    var oh = mon.outboundHealth || { byStatus: {}, needsAttention: [] }
    var quotas = mon.quotas || []
    var connHtml = connectors.length ? connectors.map(function (c) {
      var col = CONN_COLOR[c.status] || '#9ca3af'
      return row(
        '<strong style="font-size:13px;">' + esc(c.connector_id) + '</strong>' + pill(c.status, col) +
          '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(c.mode) + '</span>',
        c.last_error ? '<span style="font-size:11px;color:#ef4444;">' + esc(c.last_error) + '</span>'
          : '<span style="font-size:11px;color:var(--text-muted,#888);">' + (c.last_ok_at ? 'ok ' + esc(fmtDate(c.last_ok_at)) : '') + '</span>', col)
    }).join('') : '<p style="color:var(--text-muted,#888);font-size:12px;">Nincs konnektor-adat.</p>'
    var byStatus = oh.byStatus || {}
    var statusPills = Object.keys(byStatus).map(function (s) {
      return pill(s + ': ' + byStatus[s], OUT_COLOR[s] || '#9ca3af')
    }).join(' ') || '<span style="color:var(--text-muted,#888);font-size:12px;">Nincs kimenő sor.</span>'
    var attn = (oh.needsAttention || []).map(function (a) {
      var col = OUT_COLOR[a.status] || '#ef4444'
      return row(
        '<strong style="font-size:13px;">' + esc(a.action_type) + '</strong>' + pill(a.status, col) +
          '<span style="font-size:11px;color:var(--text-muted,#888);">' + esc(a.ledger_id) + '</span>',
        '<span style="font-size:11px;color:#ef4444;">' + esc(a.last_error || 'emberi ellenőrzés kell') + '</span>', col)
    }).join('')
    var quotaHtml = quotas.length ? quotas.map(function (q) {
      var pct = q.max_count ? Math.round(100 * q.used_count / q.max_count) : 0
      var col = pct >= 100 ? '#ef4444' : (pct >= 80 ? '#f59e0b' : '#22c55e')
      return row('<strong style="font-size:13px;">' + esc(q.quota_key) + '</strong>',
        '<span style="font-size:12px;color:' + col + ';">' + esc(q.used_count) + ' / ' + esc(q.max_count) + '</span>', col)
    }).join('') : ''
    return '<section style="margin-bottom:24px;"><h2 style="font-size:16px;margin:0 0 10px;">🩺 Monitoring</h2>' +
      '<div style="font-size:12px;color:var(--text-muted,#888);margin-bottom:4px;">Konnektorok</div>' + connHtml +
      '<div style="font-size:12px;color:var(--text-muted,#888);margin:8px 0 4px;">Kimenő állapot</div><div style="margin-bottom:4px;">' + statusPills + '</div>' +
      (attn ? '<div style="font-size:12px;color:#ef4444;margin:8px 0 4px;">Emberi beavatkozás kell</div>' + attn : '') +
      (quotaHtml ? '<div style="font-size:12px;color:var(--text-muted,#888);margin:8px 0 4px;">Kvóta</div>' + quotaHtml : '') +
      '</section>'
  }

  // ---- Analytics view (#5d): aggregate roll-ups over the COS domain ----
  function countPills(obj, colorMap) {
    var keys = Object.keys(obj || {})
    if (!keys.length) return '<span style="color:var(--text-muted,#888);font-size:12px;">—</span>'
    return keys.map(function (k) { return pill(k + ': ' + obj[k], (colorMap && colorMap[k]) || '#60a5fa') }).join(' ')
  }
  function analyticsSection(an) {
    an = an || {}
    var c = an.cases || {}, r = an.radar || {}, camp = an.campaigns || {}, o = an.outbound || {}
    function line(label, html) {
      return '<div style="margin:6px 0;"><span style="font-size:12px;color:var(--text-muted,#888);">' + label +
        '</span><div style="margin-top:2px;">' + html + '</div></div>'
    }
    return '<section style="margin-bottom:24px;"><h2 style="font-size:16px;margin:0 0 10px;">📊 Analitika</h2>' +
      line('Ügyek (' + (c.total || 0) + ') állapot', countPills(c.byStatus)) +
      line('Ügyek érzékenység', countPills(c.bySensitivity, SENS_COLOR)) +
      line('Radar (' + (r.total || 0) + '): ' + (r.hits || 0) + ' találat, ' + (r.observations || 0) + ' megfigyelés, ' + (r.notifications || 0) + ' értesítés', countPills(r.byStatus, RADAR_COLOR)) +
      line('Kampányok (' + (camp.total || 0) + ')', countPills(camp.byStatus, CAMP_COLOR)) +
      line('Kimenő (' + (o.total || 0) + ')', countPills(o.byStatus, OUT_COLOR)) +
      '</section>'
  }

  function mount() {
    var body = document.getElementById('cosBody')
    if (!body) return
    body.innerHTML = '<p style="color:var(--text-muted,#888);">Betöltés...</p>'
    function j(u) { return fetch(u).then(function (r) { return r.json() }).catch(function () { return {} }) }
    Promise.all([
      j('/api/cos/today'), j('/api/cos/cases'), j('/api/cos/outbound'), j('/api/cos/campaigns'), j('/api/cos/radar'), j('/api/cos/monitoring'), j('/api/cos/analytics'),
    ]).then(function (res) {
      var today = res[0] || {}, all = res[1] || {}, out = res[2] || {}, camp = res[3] || {}, rad = res[4] || {}, mon = res[5] || {}, an = res[6] || {}
      body.innerHTML =
        section('📌 Ma', today.cases || [], 'Ma nincs esedékes ügy.') +
        section('🗂 Ügyek', all.cases || [], 'Nincs aktív ügy. A COS case-store üres vagy minden ügy lezárt.') +
        genericSection('📤 Kimenő', out.outbound || [], 'Nincs kimenő művelet.', outboundItem) +
        genericSection('📣 Kampányok', camp.campaigns || [], 'Nincs kampány.', campaignItem) +
        genericSection('🎯 Radar', rad.radar || [], 'Nincs figyelt ár-radar.', radarItem) +
        monitoringSection(mon) +
        analyticsSection(an)
    }).catch(function (e) {
      body.innerHTML = '<p style="color:#ef4444;">Hiba a betöltéskor: ' + esc(e && e.message) + '</p>'
    })
  }

  window.CosControl = { mount: mount }
})()
