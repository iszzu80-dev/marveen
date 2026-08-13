// Optimization dashboard -- configuration controls with server previews.
window.Optimization = window.Optimization || {}

;(function () {
  const MODULE_KEYS = [
    'measurement',
    'contextEfficiency',
    'capacityMonitoring',
    'runtimeRouting',
    'recommendations',
    'marketWatch',
    'benchmarkRecommendations',
  ]
  let renderSequence = 0

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
  const H = () => window.Optimization.RenderHelpers

  function labeledBadge(variant, label) {
    const badge = H().statusBadge(variant)
    return badge.slice(0, badge.indexOf('>') + 1) + esc(label) + '</span>'
  }

  function onOffBadge(enabled) {
    return labeledBadge(enabled ? 'ok' : 'unknown', t(enabled ? 'optimization.common.on' : 'optimization.common.off'))
  }

  const KNOWN_PRESETS = ['off', 'observation', 'advisory', 'active', 'custom']

  function presetLabel(preset) {
    return t('optimization.controls.preset.' + (KNOWN_PRESETS.includes(preset) ? preset : 'unknown'))
  }

  function presetBadge(preset) {
    const variant = preset === 'active'
      ? 'ok'
      : preset === 'off'
        ? 'unknown'
        : 'warning'
    return labeledBadge(variant, presetLabel(preset))
  }

  function responseError(response) {
    if (response?.body?.error) return String(response.body.error)
    return t('optimization.http_error', { status: response?.status ?? t('optimization.no_data') })
  }

  function moduleMapText(modules) {
    return MODULE_KEYS.map((key) => t('optimization.module.' + key + '.name')
      + ': ' + t(modules?.[key] ? 'optimization.common.on' : 'optimization.common.off')).join('\n')
  }

  function dependencyText(errors) {
    if (!errors?.length) return ''
    return '\n\n' + t('optimization.controls.dependency_corrections') + '\n' + errors.join('\n')
  }

  function warningHtml(errors) {
    if (!errors.length) return ''
    return `
      <div class="overview-card">
        <div>${labeledBadge('critical', t('optimization.controls.invalid_config'))}</div>
        <ul>${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>
      </div>`
  }

  function moduleRows(config) {
    return MODULE_KEYS.map((key) => `
      <div class="overview-card">
        <div class="cc-drawer-row">
          <label>
            <input
              type="checkbox"
              data-module-toggle="${key}"
              ${config.modules[key] ? 'checked' : ''}
            >
            <strong>${esc(t('optimization.module.' + key + '.name'))}</strong>
          </label>
          ${onOffBadge(config.modules[key])}
        </div>
        <p class="cc-muted">${esc(t('optimization.module.' + key + '.desc'))}</p>
      </div>`).join('')
  }

  async function render(bodyEl, suppliedResult) {
    const sequence = ++renderSequence
    bodyEl.dataset.optimizationView = 'controls'
    bodyEl.innerHTML = `<div class="cc-loading">${esc(t('optimization.loading'))}</div>`

    try {
      const result = suppliedResult || await window.Optimization.Api.settings()
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
      const config = result.config
      const errors = result.errors || []

      bodyEl.innerHTML = `
        ${result.valid === false ? warningHtml(errors) : ''}
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.controls.master_title'))}</div>
          <div class="overview-card">
            <div class="cc-drawer-row">
              <label>
                <input type="checkbox" data-master-toggle ${config.masterEnabled ? 'checked' : ''}>
                <strong>${esc(t('optimization.controls.master_label'))}</strong>
              </label>
              ${onOffBadge(config.masterEnabled)}
            </div>
            <p class="cc-muted">${esc(t('optimization.controls.master_desc'))}</p>
          </div>
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.controls.preset_title'))}</div>
          <div class="overview-card">
            ${presetBadge(config.preset)}
            <p class="cc-muted">${esc(t('optimization.controls.preset_readonly_note'))}</p>
          </div>
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.controls.modules_title'))}</div>
          ${moduleRows(config)}
        </div>
        <div class="cc-section">
          <div class="cc-section-title">${esc(t('optimization.controls.emergency_title'))}</div>
          <div class="overview-card">
            <div class="cc-close-header">
              ${H().statusBadge('critical')}
              <button class="btn-danger" type="button" data-emergency-disable>
                ${esc(t('optimization.controls.emergency_button'))}
              </button>
            </div>
            <p class="cc-muted">${esc(t('optimization.controls.emergency_desc'))}</p>
          </div>
        </div>`

      async function previewConfirmWrite(nextConfig, confirmKey) {
        bodyEl.querySelectorAll('input, button').forEach((control) => { control.disabled = true })
        try {
          const previewResponse = await window.Optimization.Api.saveSettings(nextConfig, config.version, true)
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
          if (!previewResponse.ok) throw new Error(responseError(previewResponse))
          const preview = previewResponse.body
          const confirmation = t(confirmKey)
            + '\n\n'
            + t('optimization.controls.preview_modules')
            + '\n'
            + moduleMapText(preview.wouldApply)
            + dependencyText(preview.dependencyErrors)

          if (!window.confirm(confirmation)) {
            await render(bodyEl, result)
            return
          }

          const saveResponse = await window.Optimization.Api.saveSettings(nextConfig, config.version, false)
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
          if (!saveResponse.ok) throw new Error(responseError(saveResponse))
          window.alert(t('optimization.controls.save_success'))
          await render(bodyEl, {
            config: saveResponse.body.config,
            valid: true,
            errors: [],
          })
        } catch (error) {
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
          window.alert(t('optimization.error_with_message', {
            message: error instanceof Error ? error.message : String(error),
          }))
          await render(bodyEl)
        }
      }

      const masterToggle = bodyEl.querySelector('[data-master-toggle]')
      masterToggle.addEventListener('change', () => {
        const desired = masterToggle.checked
        masterToggle.checked = config.masterEnabled

        // OPT-M4 (review 2026-08-12): the restore offer, finally built.
        //
        // The backend has captured `lastEnabledConfiguration` at every
        // master-OFF transition since day one (optimization-config.ts), the
        // GET /settings response has always carried it, and the spec (§9) and
        // the as-built both promised the operator would be OFFERED it on the
        // way back on -- but nothing ever read the field. Turning the system
        // back on silently kept whatever module map the OFF period had left
        // behind, which after a preset-off is not the map the operator was
        // running before.
        //
        // The offer is a plain confirm because that is the vocabulary this
        // panel already speaks (confirm_master_enable, confirm_emergency):
        // OK restores the stored preset/modules/routing, Cancel turns the
        // system on exactly as it stands now. Either branch then goes through
        // previewConfirmWrite, so the stored configuration is validated by the
        // server's validateModuleDependencies and the operator sees the module
        // map that will ACTUALLY apply -- including any dependency correction
        // -- before it is written. A stored map never bypasses that check.
        const stored = desired ? config.lastEnabledConfiguration : null
        const restore = stored !== null
          && stored !== undefined
          && window.confirm(
            t('optimization.controls.confirm_restore_previous', { preset: presetLabel(stored.preset) })
            + '\n\n' + moduleMapText(stored.modules))

        const nextConfig = restore
          ? Object.assign({}, config, {
              masterEnabled: true,
              preset: stored.preset,
              modules: stored.modules,
              routing: stored.routing,
            })
          : Object.assign({}, config, { masterEnabled: desired })

        previewConfirmWrite(
          nextConfig,
          restore
            ? 'optimization.controls.confirm_master_enable_restored'
            : desired
              ? 'optimization.controls.confirm_master_enable'
              : 'optimization.controls.confirm_master_disable',
        )
      })

      bodyEl.querySelectorAll('[data-module-toggle]').forEach((toggle) => {
        toggle.addEventListener('change', () => {
          const key = toggle.dataset.moduleToggle
          const desired = toggle.checked
          toggle.checked = config.modules[key]
          const nextConfig = Object.assign({}, config, {
            modules: Object.assign({}, config.modules, { [key]: desired }),
          })
          previewConfirmWrite(nextConfig, 'optimization.controls.confirm_module_change')
        })
      })

      // Presets are intentionally read-only here. Their server-owned module maps
      // are not exported to this plain-JS frontend; module writes below let the
      // backend recompute the honest preset without duplicating that logic.

      bodyEl.querySelector('[data-emergency-disable]').addEventListener('click', async () => {
        if (!window.confirm(t('optimization.controls.confirm_emergency'))) return
        bodyEl.querySelectorAll('input, button').forEach((control) => { control.disabled = true })
        try {
          const response = await window.Optimization.Api.emergencyDisable()
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
          if (!response.ok) throw new Error(responseError(response))
          // OPT-H3: HTTP 200 is not "fully stopped" -- the backend reports a
          // half-landed stop via `partial` + `warning` + `stillRunning`
          // (routes/optimization.ts). Swallowing that and alerting success is
          // how an operator walks away from a half-stopped system.
          if (response.body?.partial) {
            window.alert(t('optimization.controls.emergency_partial', {
              stillRunning: response.body.stillRunning || '?',
              warning: response.body.warning || '',
            }))
          } else {
            window.alert(t('optimization.controls.emergency_success'))
          }
          await render(bodyEl, {
            config: response.body.config,
            valid: true,
            errors: [],
          })
        } catch (error) {
          if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
          window.alert(t('optimization.error_with_message', {
            message: error instanceof Error ? error.message : String(error),
          }))
          await render(bodyEl)
        }
      })
    } catch (error) {
      if (sequence !== renderSequence || bodyEl.dataset.optimizationView !== 'controls') return
      bodyEl.innerHTML = `<div class="cc-error">${esc(t('optimization.error_with_message', {
        message: error instanceof Error ? error.message : String(error),
      }))}</div>`
    }
  }

  window.Optimization.Controls = { render }
})()
