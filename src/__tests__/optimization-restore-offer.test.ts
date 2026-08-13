// OPT-M4 (review 2026-08-12): the `lastEnabledConfiguration` restore offer.
//
// The backend captured the field at every master-OFF transition from day one
// and GET /api/optimization/settings has always returned it, but NOTHING read
// it -- while the owner spec (§9: "visszakapcsoláskor ajánlja: Előző
// konfiguráció visszaállítása") and the as-built
// (optimization-dashboard-as-built.md:83, "restored on request when turning
// back on") both stated the feature existed. A documented feature with zero
// readers is the same class as a switch that reports success without acting.
//
// The offer itself lives in the plain-JS frontend, which has no test harness in
// this repo, so it is pinned the way the rest of this program pins
// frontend-side guarantees: by scanning the source for the properties that
// must be there (the same technique as optimization-master-and-emergency.ts's
// HEADLINE tests). The BACKEND half -- that a restored configuration still goes
// through validateModuleDependencies and can never write an illegal module map
// -- is exercised for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRESET_MODULES,
  readOptimizationConfig,
  writeOptimizationConfig,
  type OptimizationConfig,
} from '../optimization/optimization-config.js'

const CONTROLS = join(process.cwd(), 'web/optimization/optimization-controls.js')
const controlsSrc = (): string => readFileSync(CONTROLS, 'utf-8')

describe('OPT-M4: the re-enable restore offer exists in the frontend', () => {
  it('HEADLINE: the master toggle reads lastEnabledConfiguration on the way ON', () => {
    // The defect was an ABSENCE -- the field name appeared nowhere in web/ --
    // so absence is exactly what has to be pinned.
    const src = controlsSrc()
    expect(src).toMatch(/config\.lastEnabledConfiguration/)
    // ...and only on the way ON. Reading it while turning the system OFF would
    // offer to restore the state the operator is in the middle of leaving.
    expect(src).toMatch(/desired \? config\.lastEnabledConfiguration : null/)
  })

  it('the offer is a confirm, and declining still turns the system on', () => {
    const src = controlsSrc()
    expect(src).toMatch(/window\.confirm\(\s*t\('optimization\.controls\.confirm_restore_previous'/)
    // The Cancel branch must fall back to the plain enable, not abort: the
    // operator asked for the system to come on, the restore is the extra.
    expect(src).toMatch(/Object\.assign\(\{\}, config, \{ masterEnabled: desired \}\)/)
  })

  it('restoring sends the stored preset, modules AND routing with masterEnabled true', () => {
    // A partial restore (modules only) would leave the routing block from the
    // OFF period behind, which is not "the previous configuration".
    const src = controlsSrc()
    const at = src.indexOf('const nextConfig = restore')
    expect(at).toBeGreaterThan(-1)
    const branch = src.slice(at, at + 400)
    expect(branch).toMatch(/masterEnabled: true/)
    expect(branch).toMatch(/preset: stored\.preset/)
    expect(branch).toMatch(/modules: stored\.modules/)
    expect(branch).toMatch(/routing: stored\.routing/)
  })

  it('the restore write goes through previewConfirmWrite, never straight to save', () => {
    // previewConfirmWrite is what runs the server-side preview
    // (validateModuleDependencies) and shows the operator the module map that
    // will ACTUALLY apply. A stored configuration must not skip that.
    const src = controlsSrc()
    const at = src.indexOf('const stored = desired')
    expect(at).toBeGreaterThan(-1)
    const handler = src.slice(at)
    const previewAt = handler.indexOf('previewConfirmWrite(')
    expect(previewAt).toBeGreaterThan(-1)
    // No direct save between the offer and the preview call.
    expect(handler.slice(0, previewAt)).not.toMatch(/saveSettings\(/)
    expect(handler).toMatch(/optimization\.controls\.confirm_master_enable_restored/)
  })

  it('both new i18n keys exist in BOTH languages', () => {
    // A key present in one language only renders as the raw key string for
    // half the fleet's operators.
    for (const lang of ['en', 'hu']) {
      const src = readFileSync(join(process.cwd(), `web/lang/${lang}.js`), 'utf-8')
      expect(src).toContain("'optimization.controls.confirm_restore_previous'")
      expect(src).toContain("'optimization.controls.confirm_master_enable_restored'")
      // The preset placeholder the controls module interpolates.
      const line = src.split('\n').find((l) => l.includes("'optimization.controls.confirm_restore_previous'"))
      expect(line).toContain('{preset}')
    }
  })
})

describe('OPT-M4: a restored configuration is still dependency-validated', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'optimization-restore-'))
    configPath = join(dir, 'optimization-config.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (config: OptimizationConfig): void => {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  }

  const base = (over: Partial<OptimizationConfig> = {}): OptimizationConfig => ({
    version: 3,
    masterEnabled: false,
    preset: 'off',
    modules: { ...PRESET_MODULES.off },
    routing: { automaticFallback: false },
    ui: { defaultWindow: '30d', showAllocationCost: true },
    lastEnabledConfiguration: null,
    ...over,
  })

  it('a hand-edited illegal stored map is corrected the moment it is READ', () => {
    // The stored block is not a trusted input just because the system wrote it
    // once: store/optimization-config.json is a hand-editable local file, and
    // the module rules may also have tightened since the snapshot was taken.
    write(base({
      lastEnabledConfiguration: {
        preset: 'active',
        // measurement:false with runtimeRouting:true is exactly the combination
        // validateModuleDependencies exists to refuse.
        modules: { ...PRESET_MODULES.active, measurement: false },
        routing: { automaticFallback: true },
      },
    }))

    const stored = readOptimizationConfig(configPath).config.lastEnabledConfiguration
    expect(stored).not.toBeNull()
    expect(stored?.modules.measurement).toBe(false)
    expect(stored?.modules.runtimeRouting).toBe(false)
    expect(stored?.modules.recommendations).toBe(false)
    // The label is recomputed from the corrected map, so it cannot keep
    // claiming 'active' for a map that is no longer active.
    expect(stored?.preset).toBe('custom')
  })

  it('restoring writes the corrected map, not the illegal one', () => {
    const saved = {
      preset: 'active' as const,
      modules: { ...PRESET_MODULES.active },
      routing: { automaticFallback: true },
    }
    write(base({ lastEnabledConfiguration: saved }))

    // What the frontend PATCHes on restore: the stored block plus masterEnabled.
    // Sent here with a deliberately corrupted module map to prove the write path
    // itself validates, not just the read.
    const result = writeOptimizationConfig({
      masterEnabled: true,
      preset: saved.preset,
      modules: { ...saved.modules, capacityMonitoring: false },
      routing: saved.routing,
      ui: base().ui,
    }, { path: configPath })

    expect(result.ok).toBe(true)
    expect(result.config.masterEnabled).toBe(true)
    expect(result.config.modules.runtimeRouting).toBe(false)
    expect(result.config.preset).toBe('custom')
    expect(result.config.routing).toEqual({ automaticFallback: true })
  })

  it('a clean restore round-trips exactly: off captures it, on gives it back', () => {
    // The end-to-end promise in one assertion. Start active, turn master off
    // (the capture), then re-enable with what was captured.
    const active = base({
      version: 1,
      masterEnabled: true,
      preset: 'active',
      modules: { ...PRESET_MODULES.active },
      routing: { automaticFallback: true },
    })
    write(active)

    const off = writeOptimizationConfig({
      masterEnabled: false,
      preset: 'off',
      modules: { ...PRESET_MODULES.off },
      routing: { automaticFallback: false },
      ui: active.ui,
    }, { path: configPath })
    const stored = off.config.lastEnabledConfiguration
    expect(stored).toEqual({
      preset: 'active',
      modules: { ...PRESET_MODULES.active },
      routing: { automaticFallback: true },
    })

    const back = writeOptimizationConfig({
      masterEnabled: true,
      preset: stored!.preset,
      modules: stored!.modules,
      routing: stored!.routing,
      ui: active.ui,
    }, { path: configPath })

    expect(back.ok).toBe(true)
    expect(back.config.masterEnabled).toBe(true)
    expect(back.config.preset).toBe('active')
    expect(back.config.modules).toEqual(PRESET_MODULES.active)
    expect(back.config.routing).toEqual({ automaticFallback: true })
    // Read it off disk too -- the returned object is not the file.
    const onDisk = readOptimizationConfig(configPath).config
    expect(onDisk.masterEnabled).toBe(true)
    expect(onDisk.modules).toEqual(PRESET_MODULES.active)
  })
})
