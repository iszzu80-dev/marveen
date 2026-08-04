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

  function mount() {
    var body = document.getElementById('cosBody')
    if (!body) return
    body.innerHTML = '<p style="color:var(--text-muted,#888);">Betöltés...</p>'
    Promise.all([
      fetch('/api/cos/today').then(function (r) { return r.json() }),
      fetch('/api/cos/cases').then(function (r) { return r.json() }),
    ]).then(function (res) {
      var today = res[0] || {}, all = res[1] || {}
      body.innerHTML =
        section('📌 Ma', today.cases || [], 'Ma nincs esedékes ügy.') +
        section('🗂 Ügyek', all.cases || [], 'Nincs aktív ügy. A COS case-store üres vagy minden ügy lezárt.')
    }).catch(function (e) {
      body.innerHTML = '<p style="color:#ef4444;">Hiba a betöltéskor: ' + esc(e && e.message) + '</p>'
    })
  }

  window.CosControl = { mount: mount }
})()
