// LOCAL-FORK: cos seam (keep on rebase). Mission Control client module for the
// Personal Chief of Staff case store. Read-only: renders "Ma" (today) and
// "Ügyek" (all active) from /api/cos/*. Vanilla JS; the global fetch wrapper in
// app.js attaches the Bearer token, so bare fetch() is authenticated.
//
// Card 3d9d62b1 (2026-08-08): expandable accordion case tiles + denser closed
// tile. Closed tile clamps title to 2 lines with ellipsis, adds one derived
// ball-holder status line (from next_action_owner/waiting_on/status/due_at).
// Expanded panel (~320-400px): next action + owner, deadline/waiting-on with
// elapsed days, timeline (last 3-4 events), attached documents, footer.
// Single-open accordion — opening one closes the previous. Events + documents
// are fetched lazily on first expand from /api/cos/events and /api/cos/documents.
(function () {
  'use strict'

  var SENS_COLOR = {
    PUBLIC: '#9ca3af', PERSONAL: '#60a5fa',
    SENSITIVE_PERSONAL: '#f59e0b', HIGHLY_SENSITIVE: '#ef4444',
  }
  var PRIO_COLOR = { P0: '#ef4444', P1: '#f59e0b', P2: '#60a5fa', P3: '#9ca3af' }

  // Human-readable status labels for the ball-holder line.
  var STATUS_LABEL = {
    NEW: 'Új', TRIAGE: 'Triage', INFO_REQUIRED: 'Infó kell', READY: 'Kész',
    PLANNING: 'Tervezés', AWAITING_APPROVAL: 'Jóváhagyásra vár',
    EXECUTING: 'Folyamatban', WAITING_EXTERNAL: 'Külső félre vár',
    FOLLOW_UP_DUE: 'Követés esedékes', CALL_REQUIRED: 'Hívni kell',
    AWAITING_SELECTION: 'Választásra vár', SCHEDULED: 'Ütemezve',
    BLOCKED: 'Blokkolva', RECOVERY_REQUIRED: 'Helyreállítás kell',
  }

  // ---- Progression labels (card 969e5c3b) ----
  var COMPLETION_LABEL = {
    NOT_STARTED: 'Nincs elkezdve', IN_PROGRESS: 'Folyamatban',
    COMPLETED: 'Kész', BLOCKED: 'Blokkolva', STALLED: 'Elakadt',
  }
  var DECISION_LABEL = {
    COMPLETE: 'Lezárás', RECOVERY_REQUIRED: 'Helyreállítás kell',
    WAIT_EXTERNAL: 'Külső félre vár', ASK_INFORMATION: 'Infó kell',
    REQUEST_APPROVAL: 'Jóváhagyás kell', CALL_REQUIRED: 'Hívni kell',
    CONTINUE_AUTONOMOUSLY: 'Folytatás önállóan',
    REQUEST_DECISION: 'Döntés kell', MANUAL_ACTION_REQUIRED: 'Kézi művelet kell',
  }
  var COMPLETION_COLOR = {
    NOT_STARTED: '#9ca3af', IN_PROGRESS: '#60a5fa',
    COMPLETED: '#22c55e', BLOCKED: '#ef4444', STALLED: '#f59e0b',
  }

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

  // Short date for the closed-tile status line: "aug 10."
  function fmtDateShort(sec) {
    if (!sec) return ''
    try {
      var d = new Date(sec * 1000)
      return d.toLocaleString('hu-HU', { month: 'short' }) + ' ' + d.getDate() + '.'
    } catch (e) { return '' }
  }

  function pill(text, color) {
    return '<span class="cos-pill" style="background:' + color + '22;color:' + color +
      ';border:1px solid ' + color + '55;">' + esc(text) + '</span>'
  }

  // ---- Ball-holder derivation (card 3d9d62b1) ----
  // Derives who holds the ball + when it's due from existing fields.
  // Returns {who, when, days, sub} where one of when/days carries the time signal.
  function ballHolder(c, nowSec) {
    var since = c.follow_up_at || c.updated_at

    // Waiting on an external party — the ball is NOT with the owner.
    if (c.waiting_on) {
      var days = since ? Math.floor((nowSec - since) / 86400) : null
      return { who: 'Külső félre vár', sub: c.waiting_on, days: days }
    }
    if (c.status === 'WAITING_EXTERNAL') {
      var days = since ? Math.floor((nowSec - since) / 86400) : null
      return { who: 'Külső félre vár', days: days }
    }
    if (c.status === 'BLOCKED') {
      var days = since ? Math.floor((nowSec - since) / 86400) : null
      return { who: 'Blokkolva', days: days }
    }

    // Ball is with a person — next_action_owner, or fall back to status label.
    var who = c.next_action_owner || STATUS_LABEL[c.status] || c.status || '—'
    // Humanize: when Istvan is the owner, the dashboard says "Nálad".
    if (who === 'István' || who === 'Istvan') who = 'Nálad'

    var due = c.due_at || c.follow_up_at
    if (due) return { who: who, when: fmtDateShort(due) }
    return { who: who }
  }

  function ballHolderHtml(c, nowSec) {
    var bh = ballHolder(c, nowSec)
    var parts = ['<span class="cos-ball-who">' + esc(bh.who) + '</span>']
    if (bh.days != null && bh.days >= 0) {
      parts.push('<span class="cos-ball-when"> · ' + bh.days + ' napja</span>')
    } else if (bh.when) {
      parts.push('<span class="cos-ball-when"> · ' + esc(bh.when) + '</span>')
    }
    if (bh.sub) {
      parts.push(' <span class="cos-ball-sub">(' + esc(bh.sub) + ')</span>')
    }
    return parts.join('')
  }

  // ---- Case tile (closed) + expand handler (card 3d9d62b1, 969e5c3b) ----
  // ---- Owner-action controls (card 9193eedd) ----
  // Tolerant owner match (card 9193eedd follow-up #3). The next_action_owner
  // field is free text — known forms include "Istvan", "István", and
  // "Chief of Staff / István". Null/undefined/empty means no owner → no control.
  function isIstvanOwner(name) {
    if (!name) return false
    var n = name.toLowerCase()
    return n.indexOf('istvan') !== -1 || n.indexOf('istván') !== -1
  }

  // Derives the control widget from the engine's last decision + NBA.
  // Unknown decisions → no control (fail-safe, §3).
  //
  // Card 9193eedd follow-up #3: the control is rendered ONLY when the next
  // step belongs to Istvan. The field is free text so we match tolerantly
  // against the known forms (Istvan, István, Chief of Staff / István).
  function ownerControl(prog, nextActionOwner) {
    if (!prog || !prog.lastDecision) return ''
    if (!isIstvanOwner(nextActionOwner)) return ''
    var dec = prog.lastDecision
    var runId = esc(prog.lastRunId || '')
    var caseVersion = esc(prog.totalRunCount) // totalRunCount tracks cycle count ≈ version

    // Parse NBA description for ASK_INFORMATION placeholder text.
    var nbaDesc = ''
    try {
      if (prog.nbaDescription) {
        var nba = JSON.parse(prog.nbaDescription)
        nbaDesc = nba.description || ''
      }
    } catch (e) { /* leave empty */ }

    var html = ''
    if (dec === 'REQUEST_DECISION') {
      html = '<div class="cos-owner-ctrl" data-owner-ctrl-decision="' + esc(dec) +
        '" data-source-ref="' + runId + '" data-case-version="' + caseVersion +
        '" data-owner-ctrl-nba="' + esc(prog.nbaDescription || '') + '">' +
        '<div class="cos-owner-radio-group">' +
        '<label class="cos-owner-radio"><input type="radio" name="owner-dec-' + runId + '" value="YES"> Igen</label>' +
        '<label class="cos-owner-radio"><input type="radio" name="owner-dec-' + runId + '" value="NO"> Nem</label>' +
        '</div>' +
        '<textarea class="cos-owner-text" placeholder="Megjegyzés (opcionális)" rows="2"></textarea>' +
        '<button class="cos-owner-btn">Küldés</button>' +
        '</div>'
    } else if (dec === 'ASK_INFORMATION') {
      html = '<div class="cos-owner-ctrl" data-owner-ctrl-decision="' + esc(dec) +
        '" data-source-ref="' + runId + '" data-case-version="' + caseVersion +
        '" data-owner-ctrl-nba="' + esc(prog.nbaDescription || '') + '">' +
        '<input type="text" class="cos-owner-text" placeholder="' + esc(nbaDesc || 'Válasz...') + '">' +
        '<button class="cos-owner-btn">Küldés</button>' +
        '</div>'
    } else if (dec === 'RECOVERY_REQUIRED') {
      html = '<div class="cos-owner-ctrl" data-owner-ctrl-decision="' + esc(dec) +
        '" data-source-ref="' + runId + '" data-case-version="' + caseVersion +
        '" data-owner-ctrl-nba="' + esc(prog.nbaDescription || '') + '">' +
        '<textarea class="cos-owner-text" placeholder="Megjegyzés (opcionális)" rows="2"></textarea>' +
        '<button class="cos-owner-btn">Rendben, mehet tovább</button>' +
        '</div>'
    } else if (dec === 'WAIT_EXTERNAL') {
      html = '<div class="cos-owner-ctrl" data-owner-ctrl-decision="' + esc(dec) +
        '" data-source-ref="' + runId + '" data-case-version="' + caseVersion +
        '" data-owner-ctrl-nba="' + esc(prog.nbaDescription || '') + '">' +
        '<input type="text" class="cos-owner-text" placeholder="Mi érkezett? (rövid leírás)">' +
        '<button class="cos-owner-btn">Megjött a válasz</button>' +
        '</div>'
    }
    // CONTINUE_AUTONOMOUSLY and unknown → no control (fail-safe)
    return html
  }

  function caseTile(c, namespace, nowSec, prog) {
    var prio = PRIO_COLOR[c.priority] || '#9ca3af'
    var sens = SENS_COLOR[c.sensitivity] || '#9ca3af'
    var caseId = esc(c.case_id)
    var ns = esc(namespace)

    // Progression badge (card 969e5c3b): only when progression data exists.
    var progBadgeHtml = ''
    var progNbaHtml = ''
    var progMetaData = ''
    if (prog) {
      var compLabel = COMPLETION_LABEL[prog.semanticCompletionStatus] || prog.semanticCompletionStatus || '—'
      var compColor = COMPLETION_COLOR[prog.semanticCompletionStatus] || '#9ca3af'
      progBadgeHtml = '<span class="cos-prog-badge" style="background:' + compColor + '22;color:' + compColor +
        ';border:1px solid ' + compColor + '55;" title="Progression állapot: ' + esc(compLabel) + '">' +
        esc(compLabel) + '</span>'
      // Next-best-action line: parse JSON description, truncate to ~60 chars.
      var nbaText = ''
      try {
        if (prog.nbaDescription) {
          var nba = JSON.parse(prog.nbaDescription)
          nbaText = nba.description || ''
        }
      } catch (e) { /* leave empty */ }
      if (nbaText) {
        progNbaHtml = '<div class="cos-tile-nba">' + esc(nbaText) + '</div>'
      }
      // Metadata string for data passing (used in detail panel).
      progMetaData = ' data-prog-goal="' + esc(prog.goal || '') + '"' +
        ' data-prog-status="' + esc(prog.semanticCompletionStatus || '') + '"' +
        ' data-prog-decision="' + esc(prog.lastDecision || '') + '"' +
        ' data-prog-decision-reason="' + esc(prog.lastDecisionReason || '') + '"' +
        ' data-prog-plan-version="' + esc(prog.planVersion) + '"' +
        ' data-prog-run-count="' + esc(prog.totalRunCount) + '"' +
        ' data-prog-last-progressed="' + esc(prog.lastProgressedAt) + '"' +
        ' data-prog-last-run-id="' + esc(prog.lastRunId || '') + '"'
    }

    return '<div class="cos-case-tile" data-case-id="' + caseId + '" data-ns="' + ns + '"' +
      ' style="border-left:3px solid ' + prio + ';"' + progMetaData + '>' +
      '<div class="cos-tile-top">' +
        '<strong class="cos-tile-title" title="' + esc(c.title) + '">' + esc(c.title) + '</strong>' +
        '<span class="cos-tile-pills">' +
          pill(c.status, prio) + pill(c.sensitivity, sens) +
          '<span class="cos-tile-type">' + esc(c.case_type) + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="cos-tile-status">' + ballHolderHtml(c, nowSec) + '</div>' +
      ownerControl(prog, c.next_action_owner) +
      (progBadgeHtml ? '<div class="cos-prog-row">' + progBadgeHtml + '</div>' : '') +
      progNbaHtml +
      // Expanded detail placeholder — populated on first expand.
      '<div class="cos-case-detail" hidden></div>' +
    '</div>'
  }

  // ---- Expanded detail panel (populated lazily on first expand) ----
  function renderDetailLoading() {
    return '<div class="cos-detail-loading">Betöltés...</div>'
  }

  function renderDetail(c, events, docs, nowSec, prog) {
    var parts = []

    // 1) Next action + owner (largest, top).
    if (c.next_action) {
      parts.push('<div class="cos-detail-action">' +
        '<div class="cos-detail-label">Következő lépés' +
          (c.next_action_owner ? ' &mdash; ' + esc(c.next_action_owner) : '') + '</div>' +
        '<div class="cos-detail-action-text">' + esc(c.next_action) + '</div>' +
      '</div>')
    }

    // 1b) Progression info (card 969e5c3b): goal, status, last decision.
    if (prog) {
      var progParts = []
      if (prog.goal) {
        progParts.push('<div class="cos-detail-prog-goal">' +
          '<div class="cos-detail-label">Cél</div>' +
          '<div class="cos-detail-prog-goal-text">' + esc(prog.goal) + '</div>' +
        '</div>')
      }
      var compLabel = COMPLETION_LABEL[prog.semanticCompletionStatus] || prog.semanticCompletionStatus || '—'
      var compColor = COMPLETION_COLOR[prog.semanticCompletionStatus] || '#9ca3af'
      var statusLine = '<span class="cos-detail-prog-status" style="color:' + compColor + ';">' +
        esc(compLabel) + '</span>'
      if (prog.planVersion != null) {
        statusLine += ' <span class="cos-detail-prog-meta">· terv v' + esc(prog.planVersion) + '</span>'
      }
      if (prog.totalRunCount != null && prog.totalRunCount > 0) {
        statusLine += ' <span class="cos-detail-prog-meta">· ' + esc(prog.totalRunCount) + ' futtatás</span>'
      }
      if (prog.lastProgressedAt) {
        statusLine += ' <span class="cos-detail-prog-meta">· utoljára ' + fmtDate(prog.lastProgressedAt) + '</span>'
      }
      if (prog.lastDecision) {
        var decLabel = DECISION_LABEL[prog.lastDecision] || prog.lastDecision
        statusLine += ' <span class="cos-detail-prog-decision">· Utolsó döntés: ' + esc(decLabel) + '</span>'
      }
      progParts.push('<div class="cos-detail-prog-status-line">' + statusLine + '</div>')
      if (prog.lastDecisionReason) {
        progParts.push('<div class="cos-detail-prog-reason">' + esc(prog.lastDecisionReason) + '</div>')
      }
      parts.push('<div class="cos-detail-progression">' + progParts.join('') + '</div>')
    }

    // 2) Deadline / waiting-on with elapsed days.
    var deadlineParts = []
    if (c.due_at) {
      deadlineParts.push('<span>Határidő: <strong>' + fmtDate(c.due_at) + '</strong></span>')
      var daysLeft = Math.ceil((c.due_at - nowSec) / 86400)
      if (daysLeft <= 3 && daysLeft >= 0) {
        deadlineParts.push(' <span style="color:#f59e0b;font-size:12px;">(' + daysLeft + ' nap múlva)</span>')
      } else if (daysLeft < 0) {
        deadlineParts.push(' <span style="color:#ef4444;font-size:12px;">(' + Math.abs(daysLeft) + ' napja lejárt)</span>')
      }
    }
    if (c.waiting_on) {
      var since = c.follow_up_at || c.updated_at
      var elapsed = since ? Math.floor((nowSec - since) / 86400) : 0
      deadlineParts.push('<span>⏳ ' + esc(c.waiting_on) + ' <span style="color:var(--text-muted,#888);font-size:12px;">(' + elapsed + ' napja)</span></span>')
    } else if (c.follow_up_at && !c.due_at) {
      deadlineParts.push('<span>Követés: <strong>' + fmtDate(c.follow_up_at) + '</strong></span>')
    }
    if (deadlineParts.length) {
      parts.push('<div class="cos-detail-deadline">' + deadlineParts.join('<br>') + '</div>')
    }

    // 3) Timeline: last 3-4 events.
    if (events && events.length) {
      var timelineHtml = events.slice(0, 4).map(function (ev) {
        var actor = esc(ev.actor || '?')
        var typeLabel = ev.event_type === 'CREATED' ? 'Létrehozva' :
          (ev.event_type === 'STATUS_CHANGED' ? 'Státuszváltás' : esc(ev.event_type))
        var detail = ''
        if (ev.event_type === 'STATUS_CHANGED' && ev.previous_status && ev.new_status) {
          detail = esc(ev.previous_status) + ' → ' + esc(ev.new_status)
        } else if (ev.reason) {
          detail = esc(ev.reason)
        }
        return '<div class="cos-timeline-event">' +
          '<span class="cos-timeline-dot"></span>' +
          '<span class="cos-timeline-date">' + fmtDate(ev.created_at) + '</span>' +
          '<span class="cos-timeline-type">' + typeLabel + '</span>' +
          '<span class="cos-timeline-actor">' + actor + '</span>' +
          (detail ? '<span class="cos-timeline-detail">' + detail + '</span>' : '') +
        '</div>'
      }).join('')
      parts.push('<div class="cos-detail-timeline">' +
        '<div class="cos-detail-label">Idővonal (' + events.length + ' esemény)</div>' +
        timelineHtml + '</div>')
    } else if (events !== null) {
      // events is [] — no events yet (shouldn't happen for real cases but handle gracefully)
      parts.push('<div class="cos-detail-timeline"><div class="cos-detail-label">Idővonal</div>' +
        '<span style="color:var(--text-muted,#888);font-size:12px;">Nincs esemény.</span></div>')
    }

    // 4) Attached documents (clickable).
    if (docs && docs.length) {
      var docsHtml = docs.map(function (d) {
        var fname = esc(d.filename || d.document_id)
        var src = esc(d.source)
        return '<a class="cos-doc-link" href="/api/cos/document-file?doc_id=' + esc(d.document_id) +
          '" target="_blank" rel="noopener" title="' + esc(d.mime_type || '') + ' · forrás: ' + src + '">' +
          '📎 ' + fname + '</a>'
      }).join('')
      parts.push('<div class="cos-detail-documents">' +
        '<div class="cos-detail-label">Dokumentumok (' + docs.length + ')</div>' +
        docsHtml + '</div>')
    } else if (docs !== null) {
      parts.push('<div class="cos-detail-documents"><div class="cos-detail-label">Dokumentumok</div>' +
        '<span style="color:var(--text-muted,#888);font-size:12px;">Nincs csatolt dokumentum.</span></div>')
    }

    // 5) Footer: case_id, source, category.
    var footerItems = []
    footerItems.push('<span class="cos-footer-id">' + esc(c.case_id) + '</span>')
    if (c.source_system) footerItems.push('<span>Forrás: ' + esc(c.source_system) + '</span>')
    if (c.category) footerItems.push('<span>' + esc(c.category) + '</span>')
    parts.push('<div class="cos-detail-footer">' + footerItems.join(' · ') + '</div>')

    return parts.join('')
  }

  // ---- Fetch events + documents for a case, then render detail. ----
  function loadDetail(tile, c, namespace, nowSec, prog) {
    var detailEl = tile.querySelector('.cos-case-detail')
    if (!detailEl) return

    // Already loaded — the caller toggled visibility, nothing more to do.
    if (detailEl.dataset.loaded === '1') return

    detailEl.innerHTML = renderDetailLoading()

    var ns = namespace === 'zst' ? 'zst' : 'personal'
    Promise.all([
      fetch('/api/cos/events?case_id=' + encodeURIComponent(c.case_id) + '&namespace=' + ns)
        .then(function (r) { return r.json() }).catch(function () { return { events: [] } }),
      fetch('/api/cos/documents?case_id=' + encodeURIComponent(c.case_id) + '&namespace=' + ns)
        .then(function (r) { return r.json() }).catch(function () { return { documents: [] } }),
    ]).then(function (res) {
      var events = (res[0] && res[0].events) || []
      var docs = (res[1] && res[1].documents) || []
      detailEl.innerHTML = renderDetail(c, events, docs, nowSec, prog)
      detailEl.dataset.loaded = '1'
    }).catch(function () {
      detailEl.innerHTML = '<div class="cos-detail-loading" style="color:#ef4444;">Hiba a betöltéskor.</div>'
    })
  }

  // ---- Single-open accordion handler (card 3d9d62b1, 969e5c3b) ----
  // Opening one tile closes the previously open one. Clicking an open tile closes it.
  function installAccordion(container, cases, namespace, progMap) {
    var nowSec = Math.floor(Date.now() / 1000)
    var openTile = null

    container.addEventListener('click', function (e) {
      // Card 9193eedd follow-up: clicks inside owner controls must NOT
      // toggle the tile. The owner-action handler lives on document.body
      // so it fires after this handler; returning here lets the event
      // continue to the body handler while the tile stays in its current
      // open/closed state.
      if (e.target.closest('.cos-owner-ctrl')) return

      var tile = e.target.closest('.cos-case-tile')
      if (!tile) return
      var caseId = tile.dataset.caseId
      var detailEl = tile.querySelector('.cos-case-detail')
      if (!detailEl) return

      // Find the case data by case_id.
      var c = null
      for (var i = 0; i < cases.length; i++) {
        if (cases[i].case_id === caseId) { c = cases[i]; break }
      }
      if (!c) return

      // Look up progression data (card 969e5c3b).
      var prog = (progMap && progMap[caseId]) || null

      var isOpen = !detailEl.hidden

      if (isOpen) {
        // Close this tile.
        detailEl.hidden = true
        tile.classList.remove('expanded')
        openTile = null
        return
      }

      // Close previously open tile.
      if (openTile && openTile !== tile) {
        var prevDetail = openTile.querySelector('.cos-case-detail')
        if (prevDetail) { prevDetail.hidden = true }
        openTile.classList.remove('expanded')
      }

      // Open this tile — unhide the detail panel (loadDetail fills it if needed).
      detailEl.hidden = false
      tile.classList.add('expanded')
      openTile = tile

      // Lazy-load detail content (no-op if already loaded).
      loadDetail(tile, c, namespace, nowSec, prog)
    })
  }

  // ---- Section builder ----
  function caseSection(title, cases, namespace, emptyMsg, progMap) {
    var inner
    if (!cases || cases.length === 0) {
      inner = '<p style="color:var(--text-muted,#888);font-size:13px;">' + esc(emptyMsg) + '</p>'
    } else {
      var nowSec = Math.floor(Date.now() / 1000)
      inner = '<div class="cos-case-list" data-ns="' + esc(namespace) + '">' +
        cases.map(function (c) {
          var prog = (progMap && progMap[c.case_id]) || null
          return caseTile(c, namespace, nowSec, prog)
        }).join('') +
      '</div>'
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

  // ---- Inject the COS tile CSS (card 3d9d62b1) ----
  function injectStyles() {
    if (document.getElementById('cos-tile-styles')) return
    var style = document.createElement('style')
    style.id = 'cos-tile-styles'
    style.textContent = [
      '.cos-case-tile {',
      '  border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:8px 12px;margin-bottom:8px;',
      '  cursor:pointer;transition:box-shadow 0.15s,background 0.15s;position:relative;',
      '}',
      '.cos-case-tile:hover { background:var(--accent-soft,rgba(96,165,250,0.05)); }',
      '.cos-case-tile.expanded { box-shadow:0 2px 12px rgba(0,0,0,0.15); }',
      '.cos-tile-top { display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap; }',
      '.cos-tile-title {',
      '  font-size:14px;line-height:1.35;display:-webkit-box;-webkit-box-orient:vertical;',
      '  -webkit-line-clamp:2;overflow:hidden;flex:1;min-width:0;',
      '}',
      '.cos-tile-pills { display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap; }',
      '.cos-tile-type { font-size:11px;color:var(--text-muted,#888); }',
      '.cos-pill { display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;white-space:nowrap; }',
      '.cos-tile-status {',
      '  font-size:12px;margin-top:4px;color:var(--text-muted,#888);',
      '  display:flex;align-items:center;gap:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;',
      '}',
      // Progression badge row — its own line so it never overflows at narrow widths (card 969e5c3b)
      '.cos-prog-row {',
      '  display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:4px;',
      '}',
      '.cos-prog-badge {',
      '  display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;white-space:nowrap;',
      '  font-weight:500;',
      '}',
      // Next-best-action line on closed tile
      '.cos-tile-nba {',
      '  font-size:11px;margin-top:2px;color:var(--text-muted,#888);',
      '  overflow:hidden;white-space:nowrap;text-overflow:ellipsis;',
      '}',
      // Owner-action controls (card 9193eedd) — placed on closed tile.
      '.cos-owner-ctrl {',
      '  display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;',
      '}',
      '.cos-owner-ctrl.recorded { opacity:0.5;pointer-events:none; }',
      '.cos-owner-ctrl.recorded .cos-owner-btn::after { content:" — Rögzítve"; }',
      '.cos-owner-radio-group { display:flex;gap:12px;align-items:center; }',
      '.cos-owner-radio {',
      '  font-size:13px;color:var(--text,#ddd);cursor:pointer;',
      '  display:flex;align-items:center;gap:4px;min-height:44px;',
      '}',
      '.cos-owner-radio input[type="radio"] {',
      '  width:18px;height:18px;accent-color:var(--accent,#60a5fa);cursor:pointer;',
      '}',
      '.cos-owner-text {',
      '  flex:1;min-width:140px;padding:6px 10px;font-size:13px;',
      '  background:var(--input-bg,#1a1a1a);color:var(--text,#ddd);',
      '  border:1px solid var(--border,#2a2a2a);border-radius:6px;',
      '  font-family:inherit;resize:vertical;',
      '}',
      '.cos-owner-text:focus { outline:none;border-color:var(--accent,#60a5fa); }',
      '.cos-owner-btn {',
      '  padding:6px 16px;font-size:13px;font-weight:500;',
      '  background:var(--accent,#60a5fa);color:#fff;border:none;border-radius:6px;',
      '  cursor:pointer;min-height:44px;min-width:44px;white-space:nowrap;',
      '  font-family:inherit;',
      '}',
      '.cos-owner-btn:hover { opacity:0.85; }',
      '.cos-owner-btn:active { opacity:0.7; }',
      // Confirmation modal (card 9193eedd §5)
      '.cos-confirm-overlay {',
      '  position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;',
      '  display:flex;align-items:center;justify-content:center;',
      '}',
      '.cos-confirm-card {',
      '  background:var(--bg,#0d0d0d);border:1px solid var(--border,#2a2a2a);',
      '  border-radius:10px;padding:20px 24px;max-width:400px;width:90vw;',
      '  box-shadow:0 4px 24px rgba(0,0,0,0.4);',
      '}',
      '.cos-confirm-card h3 { margin:0 0 8px;font-size:15px; }',
      '.cos-confirm-card p { margin:0 0 16px;font-size:13px;color:var(--text-muted,#888);line-height:1.5; }',
      '.cos-confirm-actions { display:flex;gap:8px;justify-content:flex-end; }',
      '.cos-confirm-cancel {',
      '  padding:8px 16px;font-size:13px;background:transparent;',
      '  border:1px solid var(--border,#2a2a2a);border-radius:6px;',
      '  color:var(--text-muted,#888);cursor:pointer;font-family:inherit;',
      '}',
      '.cos-confirm-ok {',
      '  padding:8px 16px;font-size:13px;font-weight:500;',
      '  background:var(--accent,#60a5fa);color:#fff;border:none;border-radius:6px;',
      '  cursor:pointer;font-family:inherit;',
      '}',
      '.cos-ball-who { font-weight:500;color:var(--text,#ddd); }',
      '.cos-ball-when { color:var(--text-muted,#888); }',
      '.cos-ball-sub { color:var(--text-muted,#888);overflow:hidden;text-overflow:ellipsis; }',
      // Expanded detail panel
      '.cos-case-detail {',
      '  margin-top:10px;padding-top:10px;border-top:1px solid var(--border,#2a2a2a);',
      '  max-height:400px;overflow-y:auto;',
      '}',
      '.cos-case-detail[hidden] { display:none; }',
      '.cos-detail-loading { color:var(--text-muted,#888);font-size:13px;padding:8px 0; }',
      '.cos-detail-label { font-size:11px;color:var(--text-muted,#888);text-transform:uppercase;',
      '  letter-spacing:0.5px;margin-bottom:4px; }',
      '.cos-detail-action { margin-bottom:10px; }',
      '.cos-detail-action-text { font-size:14px;line-height:1.45;color:var(--text,#ddd); }',
      '.cos-detail-deadline { font-size:12px;color:var(--text-muted,#888);margin-bottom:10px;line-height:1.5; }',
      // Timeline
      '.cos-detail-timeline { margin-bottom:10px; }',
      '.cos-timeline-event {',
      '  display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:12px;',
      '  padding:3px 0;padding-left:12px;border-left:2px solid var(--border,#2a2a2a);margin-left:4px;',
      '}',
      '.cos-timeline-dot {',
      '  width:6px;height:6px;border-radius:50%;background:var(--accent,#60a5fa);',
      '  flex-shrink:0;margin-left:-17px;margin-right:4px;',
      '}',
      '.cos-timeline-date { color:var(--text-muted,#888);font-size:11px;min-width:90px; }',
      '.cos-timeline-type { font-weight:500; }',
      '.cos-timeline-actor { color:var(--text-muted,#888);font-size:11px; }',
      '.cos-timeline-detail { color:var(--text-muted,#888);font-size:11px;width:100%;margin-left:10px; }',
      // Documents
      '.cos-detail-documents { margin-bottom:10px; }',
      '.cos-doc-link {',
      '  display:block;font-size:12px;color:var(--accent,#60a5fa);text-decoration:none;',
      '  padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '}',
      '.cos-doc-link:hover { text-decoration:underline; }',
      // Footer
      '.cos-detail-footer {',
      '  font-size:11px;color:var(--text-muted,#888);padding-top:6px;',
      '  border-top:1px solid var(--border,#2a2a2a);display:flex;gap:8px;flex-wrap:wrap;',
      '}',
      '.cos-footer-id { font-family:monospace; }',
      // Progression detail panel (card 969e5c3b)
      '.cos-detail-progression {',
      '  margin-bottom:10px;padding:8px 10px;',
      '  border:1px solid var(--border,#2a2a2a);border-radius:6px;',
      '  background:var(--accent-soft,rgba(96,165,250,0.03));',
      '}',
      '.cos-detail-prog-goal { margin-bottom:6px; }',
      '.cos-detail-prog-goal-text {',
      '  font-size:13px;line-height:1.4;color:var(--text,#ddd);',
      '}',
      '.cos-detail-prog-status-line {',
      '  font-size:12px;line-height:1.5;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;',
      '}',
      '.cos-detail-prog-status { font-weight:500; }',
      '.cos-detail-prog-meta { color:var(--text-muted,#888);font-size:11px; }',
      '.cos-detail-prog-decision { color:var(--text-muted,#888);font-size:11px; }',
      '.cos-detail-prog-reason {',
      '  font-size:12px;color:var(--text-muted,#888);margin-top:4px;',
      '  font-style:italic;',
      '}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function mount() {
    injectStyles()

    var body = document.getElementById('cosBody')
    if (!body) return
    body.innerHTML = '<p style="color:var(--text-muted,#888);">Betöltés...</p>'
    function j(u) { return fetch(u).then(function (r) { return r.json() }).catch(function () { return {} }) }
    Promise.all([
      j('/api/cos/today'), j('/api/cos/cases'), j('/api/cos/outbound'), j('/api/cos/campaigns'), j('/api/cos/radar'), j('/api/cos/monitoring'), j('/api/cos/analytics'),
      j('/api/cos/zst-today'), j('/api/cos/zst-cases'),
      // Card 969e5c3b: progression views for both domains.
      j('/api/cos/progression?domain=personal'), j('/api/cos/progression?domain=zst'),
    ]).then(function (res) {
      var today = res[0] || {}, all = res[1] || {}, out = res[2] || {}, camp = res[3] || {}, rad = res[4] || {}, mon = res[5] || {}, an = res[6] || {}
      var zstToday = res[7] || {}, zstAll = res[8] || {}
      // Card 969e5c3b: progression views. The endpoint returns an array — .catch
      // returns {} for fetch errors, so normalize to [].
      var personalProg = Array.isArray(res[9]) ? res[9] : []
      var zstProg = Array.isArray(res[10]) ? res[10] : []

      // Build progression lookup maps keyed by caseId for O(1) tile lookup.
      function buildProgMap(progList) {
        var map = {}
        for (var i = 0; i < progList.length; i++) {
          map[progList[i].caseId] = progList[i]
        }
        return map
      }
      var personalProgMap = buildProgMap(personalProg)
      var zstProgMap = buildProgMap(zstProg)

      var personalTodayCases = today.cases || []
      var personalAllCases = all.cases || []
      var zstTodayCases = zstToday.cases || []
      var zstAllCases = zstAll.cases || []

      // Personal namespace (személyes) — full panel including outbound etc.
      var personalHtml =
        caseSection('📌 Ma', personalTodayCases, 'personal', 'Ma nincs esedékes ügy.', personalProgMap) +
        caseSection('🗂 Ügyek', personalAllCases, 'personal', 'Nincs aktív ügy. A COS case-store üres vagy minden ügy lezárt.', personalProgMap) +
        genericSection('📤 Kimenő', out.outbound || [], 'Nincs kimenő művelet.', outboundItem) +
        genericSection('📣 Kampányok', camp.campaigns || [], 'Nincs kampány.', campaignItem) +
        genericSection('🎯 Radar', rad.radar || [], 'Nincs figyelt ár-radar.', radarItem) +
        monitoringSection(mon) +
        analyticsSection(an)

      // ZST Radio / Ceges namespace — card e237797d / db707fcf.
      // Same priority colors (P0 red / P1 amber / P2 blue / P3 grey).
      // HARD RULE: personal_cases and zst_cases are NEVER merged into
      // one list — connector identity is the scope boundary. The toggle
      // enforces this at the UI layer: only one namespace is visible at
      // a time; the two lists are never shown together.
      var zstHtml =
        caseSection('📌 Ma — ZST', zstTodayCases, 'zst', 'Ma nincs esedékes céges ügy.', zstProgMap) +
        caseSection('🗂 Ügyek — ZST', zstAllCases, 'zst', 'Nincs aktív céges ügy.', zstProgMap)

      body.innerHTML =
        '<nav class="tab-nav" id="cosTabNav" style="padding:0;margin-bottom:16px;">' +
          '<button class="tab-btn active" data-tab="personal">Személyes</button>' +
          '<button class="tab-btn" data-tab="zst">Céges</button>' +
        '</nav>' +
        '<div id="cosPanelPersonal">' + personalHtml + '</div>' +
        '<div id="cosPanelZst" hidden>' + zstHtml + '</div>'

      // Merge today+all into a single lookup map per namespace so the accordion
      // can find any case by case_id regardless of which section it appears in.
      function mergeCases(base, extra) {
        var map = {}
        ;(base || []).forEach(function (c) { map[c.case_id] = c })
        ;(extra || []).forEach(function (c) { map[c.case_id] = c })  // extra wins
        return Object.values(map)
      }
      var personalMerged = mergeCases(personalAllCases, personalTodayCases)
      var zstMerged = mergeCases(zstAllCases, zstTodayCases)

      // Install accordion on Personal panel.
      var personalPanel = document.getElementById('cosPanelPersonal')
      if (personalPanel) {
        var personalLists = personalPanel.querySelectorAll('.cos-case-list[data-ns="personal"]')
        personalLists.forEach(function (list) {
          installAccordion(list, personalMerged, 'personal', personalProgMap)
        })
      }

      // Install accordion on ZST panel.
      var zstPanel = document.getElementById('cosPanelZst')
      if (zstPanel) {
        var zstLists = zstPanel.querySelectorAll('.cos-case-list[data-ns="zst"]')
        zstLists.forEach(function (list) {
          installAccordion(list, zstMerged, 'zst', zstProgMap)
        })
      }

      // Toggle handler: clicking a tab shows the matching panel, hides the other.
      // Reuses .tab-btn styles from style.css — .active = accent underline.
      document.getElementById('cosTabNav').addEventListener('click', function (e) {
        var btn = e.target.closest('.tab-btn')
        if (!btn) return
        var tab = btn.dataset.tab
        document.querySelectorAll('#cosTabNav .tab-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.tab === tab)
        })
        var pp = document.getElementById('cosPanelPersonal')
        var zp = document.getElementById('cosPanelZst')
        if (pp) pp.hidden = (tab !== 'personal')
        if (zp) zp.hidden = (tab !== 'zst')
      })

      // Owner-action click delegation (card 9193eedd).
      // Attached to body so it survives re-renders of the cosBody content.
      document.body.addEventListener('click', function (e) {
        var btn = e.target.closest('.cos-owner-btn')
        if (!btn) return
        e.stopPropagation()  // prevent accordion toggle
        e.preventDefault()

        var ctrl = btn.closest('.cos-owner-ctrl')
        if (!ctrl || ctrl.classList.contains('recorded')) return

        var tile = btn.closest('.cos-case-tile')
        if (!tile) return

        var caseId = tile.dataset.caseId
        var ns = tile.dataset.ns || 'personal'
        var decision = ctrl.dataset.ownerCtrlDecision
        var sourceRef = ctrl.dataset.sourceRef
        var caseVersion = parseInt(ctrl.dataset.caseVersion, 10) || 0
        var nbaDescription = ctrl.dataset.ownerCtrlNba || null

        // Map decision → eventType.
        var decisionEventMap = {
          REQUEST_DECISION: 'OWNER_DECISION',
          ASK_INFORMATION: 'OWNER_INFORMATION',
          RECOVERY_REQUIRED: 'OWNER_CONFIRMATION',
          WAIT_EXTERNAL: 'OWNER_INFORMATION',
        }
        var eventType = decisionEventMap[decision]
        if (!eventType) return

        // Read choice (radio) or text (input/textarea).
        var choice = null
        var text = null
        var radio = ctrl.querySelector('input[type="radio"]:checked')
        if (radio) choice = radio.value
        var textEl = ctrl.querySelector('.cos-owner-text')
        if (textEl) text = textEl.value.trim() || null

        // Validate: REQUEST_DECISION requires a choice.
        if (decision === 'REQUEST_DECISION' && !choice) {
          var radios = ctrl.querySelectorAll('input[type="radio"]')
          if (radios.length) { radios[0].focus(); return } // don't submit without choice
        }

        var idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'owner-' + caseId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)

        // Build body — choice/text/reason follow spec §2.
        var body = JSON.stringify({
          eventType: eventType,
          choice: choice,
          text: text,
          sourceReference: sourceRef,
          caseVersion: caseVersion,
          idempotencyKey: idempotencyKey,
          externalEffectAck: false, // round one: no external-effect controls (§5)
          decision: decision,
          nextBestAction: nbaDescription,
        })

        // Grey out immediately (optimistic).
        ctrl.classList.add('recorded')

        fetch('/api/cos/cases/' + ns + '/' + caseId + '/owner-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
        }).then(function (r) { return r.json() }).then(function (data) {
          if (data.error === 'question_stale') {
            // Stale: ungrey, show message, caller must re-render.
            ctrl.classList.remove('recorded')
            var msg = document.createElement('span')
            msg.style.cssText = 'color:#f59e0b;font-size:12px;margin-left:8px;'
            msg.textContent = 'A döntés elavult, új kérdés érkezett — töltsd újra'
            ctrl.appendChild(msg)
            return
          }
          // Success or duplicate: leave greyed. On next mount() the engine
          // state determines whether the control stays or disappears.
        }).catch(function () {
          ctrl.classList.remove('recorded')
        })
      })

      // Confirmation dialog mechanism (card 9193eedd §5).
      // The list of external-effect controls is EMPTY in round one (engine at
      // GATE 2), so showConfirmDialog is never called. It exists so a future
      // card can wire it in by adding decision types to EXTERNAL_EFFECT_DECISIONS.
      window._cosConfirmDialog = function (message) {
        return new Promise(function (resolve) {
          var overlay = document.createElement('div')
          overlay.className = 'cos-confirm-overlay'
          overlay.innerHTML =
            '<div class="cos-confirm-card">' +
            '<h3>Megerősítés</h3>' +
            '<p>' + esc(message) + '</p>' +
            '<div class="cos-confirm-actions">' +
            '<button class="cos-confirm-cancel">Mégsem</button>' +
            '<button class="cos-confirm-ok">Megerősítem</button>' +
            '</div></div>'
          document.body.appendChild(overlay)
          overlay.querySelector('.cos-confirm-cancel').addEventListener('click', function () {
            document.body.removeChild(overlay); resolve(false)
          })
          overlay.querySelector('.cos-confirm-ok').addEventListener('click', function () {
            document.body.removeChild(overlay); resolve(true)
          })
          overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) { document.body.removeChild(overlay); resolve(false) }
          })
        })
      }
    }).catch(function (e) {
      body.innerHTML = '<p style="color:#ef4444;">Hiba a betöltéskor: ' + esc(e && e.message) + '</p>'
    })
  }

  window.CosControl = { mount: mount }
})()
