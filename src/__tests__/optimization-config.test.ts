import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_AUTO_FALLBACKS_PER_PACKAGE,
  MAX_FALLBACK_CANDIDATES,
  canAutoFallback,
} from '../capacity-routing.js'
import {
  DEFAULT_OPTIMIZATION_CONFIG,
  PRESET_MODULES,
  presetForModules,
  readOptimizationConfig,
  validateModuleDependencies,
  writeOptimizationConfig,
  type OptimizationConfig,
  type OptimizationModules,
} from '../optimization/optimization-config.js'

describe('optimization-config', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'optimization-config-'))
    configPath = join(dir, 'optimization-config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const activeConfig = (): OptimizationConfig => ({
    version: 4,
    masterEnabled: true,
    preset: 'active',
    modules: { ...PRESET_MODULES.active },
    routing: { automaticFallback: true },
    ui: {
      defaultWindow: '30d',
      showAllocationCost: true,
    },
    lastEnabledConfiguration: null,
  })

  const writeCurrent = (config: OptimizationConfig): void => {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  }

  describe('safe defaults and presets', () => {
    it('defaults to the safe fail-state', () => {
      expect(DEFAULT_OPTIMIZATION_CONFIG.masterEnabled).toBe(false)
      expect(DEFAULT_OPTIMIZATION_CONFIG.preset).toBe('off')
      expect(Object.values(DEFAULT_OPTIMIZATION_CONFIG.modules).every((enabled) => !enabled)).toBe(true)
    })

    it('identifies every named preset from its exact module map', () => {
      expect(presetForModules(PRESET_MODULES.off)).toBe('off')
      expect(presetForModules(PRESET_MODULES.observation)).toBe('observation')
      expect(presetForModules(PRESET_MODULES.advisory)).toBe('advisory')
      expect(presetForModules(PRESET_MODULES.active)).toBe('active')
    })

    it('returns custom when no named preset exactly matches', () => {
      expect(presetForModules({
        ...PRESET_MODULES.observation,
        contextEfficiency: false,
      })).toBe('custom')
    })
  })

  describe('dependency validation', () => {
    it('forces routing and recommendations off without measurement, leaving market watch untouched', () => {
      const result = validateModuleDependencies({
        ...PRESET_MODULES.active,
        measurement: false,
      })

      expect(result.ok).toBe(false)
      expect(result.correctedModules.runtimeRouting).toBe(false)
      expect(result.correctedModules.recommendations).toBe(false)
      expect(result.correctedModules.marketWatch).toBe(true)
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('runtimeRouting'),
        expect.stringContaining('recommendations'),
      ]))
    })

    it('forces runtime routing off without capacity monitoring', () => {
      const result = validateModuleDependencies({
        ...PRESET_MODULES.active,
        capacityMonitoring: false,
      })

      expect(result.ok).toBe(false)
      expect(result.correctedModules.runtimeRouting).toBe(false)
      expect(result.errors.join(' ')).toContain('capacityMonitoring')
    })

    it('does not double-blame capacityMonitoring when measurement already forced runtimeRouting off (mutation regression)', () => {
      // measurement:false alone is sufficient to force runtimeRouting off; capacityMonitoring
      // being ALSO false must not additionally fire the capacityMonitoring rule against a value
      // that is already false -- that would misattribute the correction to the wrong cause for
      // an operator reading the error list. Only ONE error should mention runtimeRouting.
      const result = validateModuleDependencies({
        ...PRESET_MODULES.active,
        measurement: false,
        capacityMonitoring: false,
      })

      expect(result.ok).toBe(false)
      expect(result.correctedModules.runtimeRouting).toBe(false)
      const runtimeRoutingErrors = result.errors.filter((e) => e.includes('runtimeRouting'))
      expect(runtimeRoutingErrors).toHaveLength(1)
      expect(runtimeRoutingErrors[0]).toContain('measurement')
      expect(result.errors.join(' ')).not.toContain('capacityMonitoring')
    })

    it('forces benchmark recommendations off without recommendations', () => {
      const result = validateModuleDependencies({
        ...PRESET_MODULES.observation,
        recommendations: false,
        benchmarkRecommendations: true,
      })

      expect(result.ok).toBe(false)
      expect(result.correctedModules.benchmarkRecommendations).toBe(false)
      expect(result.errors.join(' ')).toContain('recommendations')
    })

    it('passes a valid custom combination through unchanged', () => {
      const modules: OptimizationModules = {
        measurement: true,
        contextEfficiency: false,
        capacityMonitoring: true,
        runtimeRouting: true,
        recommendations: false,
        marketWatch: true,
        benchmarkRecommendations: false,
      }

      const result = validateModuleDependencies(modules)
      expect(result).toEqual({
        ok: true,
        errors: [],
        correctedModules: modules,
      })
    })
  })

  describe('reading', () => {
    it('returns the safe default and valid:false for a missing file', () => {
      const result = readOptimizationConfig(configPath)
      expect(result.valid).toBe(false)
      expect(result.config).toEqual(DEFAULT_OPTIMIZATION_CONFIG)
      expect(result.errors).not.toHaveLength(0)
    })

    it('reports and self-heals an invalid dependency combination', () => {
      writeCurrent({
        ...activeConfig(),
        modules: {
          ...PRESET_MODULES.active,
          measurement: false,
        },
      })

      const result = readOptimizationConfig(configPath)
      expect(result.valid).toBe(false)
      expect(result.errors.join(' ')).toContain('runtimeRouting')
      expect(result.errors.join(' ')).toContain('measurement')
      expect(result.config.modules.runtimeRouting).toBe(false)
      expect(result.config.modules.recommendations).toBe(false)
      expect(result.config.preset).toBe('custom')
    })
  })

  // OPT-H2 remainder (review 2026-08-12, closed 2026-08-13). Three routing
  // knobs were deleted because nothing read them: `trustedProvidersOnly`,
  // `maxFallbacksPerProfile`, `maxAutomaticFallbacksPerDispatch`. The risk of a
  // deletion like this is twofold -- an existing on-disk config could stop
  // loading, and a later change could quietly reintroduce the fields as
  // decoration. Both are pinned here.
  describe('OPT-H2: the routing block has exactly one knob', () => {
    it('HEADLINE: the deleted knob names appear in no CODE under src/ or web/', () => {
      // Asserted on the source because the defect class is an ABSENCE of
      // readers -- a re-added field would pass every behavioural test in this
      // file while advertising a control that controls nothing.
      //
      // Comments are stripped first, on purpose: the names SHOULD still be
      // written down in the narrative comments that record why they were
      // deleted (optimization-config.ts, optimization-config-audit.ts). Losing
      // that explanation is how a deleted knob gets helpfully re-added.
      const stripComments = (text: string): string => text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      const dead = ['trustedProvidersOnly', 'maxFallbacksPerProfile', 'maxAutomaticFallbacksPerDispatch']
      const offenders: string[] = []
      const walk = (start: string): void => {
        for (const entry of readdirSync(start, { withFileTypes: true })) {
          const full = join(start, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue
            walk(full)
            continue
          }
          if (!/\.(ts|js)$/.test(entry.name)) continue
          const code = stripComments(readFileSync(full, 'utf-8'))
          for (const name of dead) if (code.includes(name)) offenders.push(`${full}: ${name}`)
        }
      }
      for (const root of ['src', 'web']) walk(join(process.cwd(), root))
      expect(offenders).toEqual([])
    })

    it('the committed example config advertises only the wired knob', () => {
      // The example is what an operator copies. Advertising a dead field there
      // is how a knob that controls nothing gets believed in the first place.
      const example = JSON.parse(
        readFileSync(join(process.cwd(), 'config-examples/optimization-config.example.json'), 'utf-8'),
      ) as { routing: Record<string, unknown> }
      expect(Object.keys(example.routing)).toEqual(['automaticFallback'])
    })

    it('an existing on-disk config still carrying the deleted knobs loads unchanged', () => {
      // No migration ships with the deletion, so the normalizer has to be the
      // migration: it whitelists field by field, and the extras simply vanish.
      const legacy = {
        ...activeConfig(),
        routing: {
          automaticFallback: true,
          trustedProvidersOnly: true,
          maxFallbacksPerProfile: 2,
          maxAutomaticFallbacksPerDispatch: 1,
        },
      }
      writeFileSync(configPath, JSON.stringify(legacy, null, 2) + '\n')

      const result = readOptimizationConfig(configPath)
      expect(result.valid).toBe(true)
      expect(result.config.routing).toEqual({ automaticFallback: true })
      expect(result.config.masterEnabled).toBe(true)
      expect(result.config.preset).toBe('active')
    })

    it('a write cannot smuggle the deleted knobs back onto disk', () => {
      // `next.routing` arrives from a PATCH body. Passing it through verbatim
      // would let an untrusted caller repopulate the file with fields the code
      // ignores -- indistinguishable, on the next read of the file by a human,
      // from live settings.
      writeCurrent(activeConfig())
      const result = writeOptimizationConfig({
        ...activeConfig(),
        routing: {
          automaticFallback: false,
          trustedProvidersOnly: false,
          maxFallbacksPerProfile: 99,
        } as unknown as OptimizationConfig['routing'],
      }, { path: configPath })

      expect(result.ok).toBe(true)
      expect(result.config.routing).toEqual({ automaticFallback: false })
      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as OptimizationConfig
      expect(onDisk.routing).toEqual({ automaticFallback: false })
    })

    it('the fallback ceilings stay code constants, not config', () => {
      // The reason `maxAutomaticFallbacksPerDispatch` was deleted rather than
      // wired: a config-settable version would let a dashboard edit RAISE a
      // safety ceiling. capacity-routing.ts owns them and says so.
      expect(MAX_AUTO_FALLBACKS_PER_PACKAGE).toBe(1)
      expect(MAX_FALLBACK_CANDIDATES).toBe(2)
      expect(canAutoFallback(MAX_AUTO_FALLBACKS_PER_PACKAGE)).toBe(false)
    })
  })

  describe('writing', () => {
    it('rejects a stale version without changing the file by even one byte', () => {
      writeCurrent(activeConfig())
      const before = readFileSync(configPath, 'utf-8')

      const result = writeOptimizationConfig({
        ...activeConfig(),
        masterEnabled: false,
      }, { path: configPath, expectedVersion: 3 })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('version_conflict')
      expect(readFileSync(configPath, 'utf-8')).toBe(before)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    })

    it('captures the pre-transition configuration when the master switch turns off', () => {
      const current = activeConfig()
      writeCurrent(current)

      const result = writeOptimizationConfig({
        masterEnabled: false,
        preset: 'off',
        modules: { ...PRESET_MODULES.off },
        routing: {
          ...current.routing,
          automaticFallback: false,
        },
        ui: current.ui,
      }, { path: configPath, expectedVersion: current.version })

      expect(result.ok).toBe(true)
      expect(result.config.lastEnabledConfiguration).toEqual({
        preset: current.preset,
        modules: current.modules,
        routing: current.routing,
      })
    })

    it('preserves the saved enabled configuration across a false-to-false write', () => {
      const saved = {
        preset: 'advisory' as const,
        modules: { ...PRESET_MODULES.advisory },
        routing: activeConfig().routing,
      }
      const current: OptimizationConfig = {
        ...activeConfig(),
        version: 7,
        masterEnabled: false,
        preset: 'off',
        modules: { ...PRESET_MODULES.off },
        lastEnabledConfiguration: saved,
      }
      writeCurrent(current)

      const result = writeOptimizationConfig({
        masterEnabled: false,
        preset: 'custom',
        modules: {
          ...PRESET_MODULES.off,
          marketWatch: true,
        },
        routing: current.routing,
        ui: { ...current.ui, defaultWindow: '7d' },
      }, { path: configPath })

      expect(result.ok).toBe(true)
      expect(result.config.lastEnabledConfiguration).toEqual(saved)
    })

    it('increments the version by exactly one on every successful write', () => {
      const current = activeConfig()
      writeCurrent(current)
      const next = {
        masterEnabled: true,
        preset: 'active' as const,
        modules: { ...PRESET_MODULES.active },
        routing: current.routing,
        ui: current.ui,
      }

      const first = writeOptimizationConfig(next, { path: configPath })
      const second = writeOptimizationConfig(next, { path: configPath })

      expect(first.ok).toBe(true)
      expect(first.config.version).toBe(current.version + 1)
      expect(second.ok).toBe(true)
      expect(second.config.version).toBe(first.config.version + 1)
    })

    it('backs up the exact previous content before overwriting an existing file', () => {
      const current = activeConfig()
      const previousBytes = JSON.stringify(current)
      writeFileSync(configPath, previousBytes)

      const result = writeOptimizationConfig({
        ...current,
        masterEnabled: false,
      }, { path: configPath })

      expect(result.ok).toBe(true)
      expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(previousBytes)
      expect(readFileSync(configPath, 'utf-8')).not.toBe(previousBytes)
    })

    it('writes a new file without requiring or creating a backup', () => {
      const current = activeConfig()
      const result = writeOptimizationConfig({
        masterEnabled: current.masterEnabled,
        preset: current.preset,
        modules: current.modules,
        routing: current.routing,
        ui: current.ui,
      }, { path: configPath })

      expect(result.ok).toBe(true)
      expect(existsSync(configPath)).toBe(true)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    })
  })
})
