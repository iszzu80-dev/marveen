import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPTIMIZATION_CONFIG, PRESET_MODULES, presetForModules, readOptimizationConfig, validateModuleDependencies, writeOptimizationConfig, } from '../optimization/optimization-config.js';
describe('optimization-config', () => {
    let dir;
    let configPath;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'optimization-config-'));
        configPath = join(dir, 'optimization-config.json');
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const activeConfig = () => ({
        version: 4,
        masterEnabled: true,
        preset: 'active',
        modules: { ...PRESET_MODULES.active },
        routing: {
            automaticFallback: true,
            trustedProvidersOnly: true,
            maxFallbacksPerProfile: 2,
            maxAutomaticFallbacksPerDispatch: 1,
        },
        ui: {
            defaultWindow: '30d',
            showAllocationCost: true,
        },
        lastEnabledConfiguration: null,
    });
    const writeCurrent = (config) => {
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    };
    describe('safe defaults and presets', () => {
        it('defaults to the safe fail-state', () => {
            expect(DEFAULT_OPTIMIZATION_CONFIG.masterEnabled).toBe(false);
            expect(DEFAULT_OPTIMIZATION_CONFIG.preset).toBe('off');
            expect(Object.values(DEFAULT_OPTIMIZATION_CONFIG.modules).every((enabled) => !enabled)).toBe(true);
        });
        it('identifies every named preset from its exact module map', () => {
            expect(presetForModules(PRESET_MODULES.off)).toBe('off');
            expect(presetForModules(PRESET_MODULES.observation)).toBe('observation');
            expect(presetForModules(PRESET_MODULES.advisory)).toBe('advisory');
            expect(presetForModules(PRESET_MODULES.active)).toBe('active');
        });
        it('returns custom when no named preset exactly matches', () => {
            expect(presetForModules({
                ...PRESET_MODULES.observation,
                contextEfficiency: false,
            })).toBe('custom');
        });
    });
    describe('dependency validation', () => {
        it('forces routing and recommendations off without measurement, leaving market watch untouched', () => {
            const result = validateModuleDependencies({
                ...PRESET_MODULES.active,
                measurement: false,
            });
            expect(result.ok).toBe(false);
            expect(result.correctedModules.runtimeRouting).toBe(false);
            expect(result.correctedModules.recommendations).toBe(false);
            expect(result.correctedModules.marketWatch).toBe(true);
            expect(result.errors).toEqual(expect.arrayContaining([
                expect.stringContaining('runtimeRouting'),
                expect.stringContaining('recommendations'),
            ]));
        });
        it('forces runtime routing off without capacity monitoring', () => {
            const result = validateModuleDependencies({
                ...PRESET_MODULES.active,
                capacityMonitoring: false,
            });
            expect(result.ok).toBe(false);
            expect(result.correctedModules.runtimeRouting).toBe(false);
            expect(result.errors.join(' ')).toContain('capacityMonitoring');
        });
        it('does not double-blame capacityMonitoring when measurement already forced runtimeRouting off (mutation regression)', () => {
            // measurement:false alone is sufficient to force runtimeRouting off; capacityMonitoring
            // being ALSO false must not additionally fire the capacityMonitoring rule against a value
            // that is already false -- that would misattribute the correction to the wrong cause for
            // an operator reading the error list. Only ONE error should mention runtimeRouting.
            const result = validateModuleDependencies({
                ...PRESET_MODULES.active,
                measurement: false,
                capacityMonitoring: false,
            });
            expect(result.ok).toBe(false);
            expect(result.correctedModules.runtimeRouting).toBe(false);
            const runtimeRoutingErrors = result.errors.filter((e) => e.includes('runtimeRouting'));
            expect(runtimeRoutingErrors).toHaveLength(1);
            expect(runtimeRoutingErrors[0]).toContain('measurement');
            expect(result.errors.join(' ')).not.toContain('capacityMonitoring');
        });
        it('forces benchmark recommendations off without recommendations', () => {
            const result = validateModuleDependencies({
                ...PRESET_MODULES.observation,
                recommendations: false,
                benchmarkRecommendations: true,
            });
            expect(result.ok).toBe(false);
            expect(result.correctedModules.benchmarkRecommendations).toBe(false);
            expect(result.errors.join(' ')).toContain('recommendations');
        });
        it('passes a valid custom combination through unchanged', () => {
            const modules = {
                measurement: true,
                contextEfficiency: false,
                capacityMonitoring: true,
                runtimeRouting: true,
                recommendations: false,
                marketWatch: true,
                benchmarkRecommendations: false,
            };
            const result = validateModuleDependencies(modules);
            expect(result).toEqual({
                ok: true,
                errors: [],
                correctedModules: modules,
            });
        });
    });
    describe('reading', () => {
        it('returns the safe default and valid:false for a missing file', () => {
            const result = readOptimizationConfig(configPath);
            expect(result.valid).toBe(false);
            expect(result.config).toEqual(DEFAULT_OPTIMIZATION_CONFIG);
            expect(result.errors).not.toHaveLength(0);
        });
        it('reports and self-heals an invalid dependency combination', () => {
            writeCurrent({
                ...activeConfig(),
                modules: {
                    ...PRESET_MODULES.active,
                    measurement: false,
                },
            });
            const result = readOptimizationConfig(configPath);
            expect(result.valid).toBe(false);
            expect(result.errors.join(' ')).toContain('runtimeRouting');
            expect(result.errors.join(' ')).toContain('measurement');
            expect(result.config.modules.runtimeRouting).toBe(false);
            expect(result.config.modules.recommendations).toBe(false);
            expect(result.config.preset).toBe('custom');
        });
    });
    describe('writing', () => {
        it('rejects a stale version without changing the file by even one byte', () => {
            writeCurrent(activeConfig());
            const before = readFileSync(configPath, 'utf-8');
            const result = writeOptimizationConfig({
                ...activeConfig(),
                masterEnabled: false,
            }, { path: configPath, expectedVersion: 3 });
            expect(result.ok).toBe(false);
            expect(result.error).toBe('version_conflict');
            expect(readFileSync(configPath, 'utf-8')).toBe(before);
            expect(existsSync(`${configPath}.bak`)).toBe(false);
        });
        it('captures the pre-transition configuration when the master switch turns off', () => {
            const current = activeConfig();
            writeCurrent(current);
            const result = writeOptimizationConfig({
                masterEnabled: false,
                preset: 'off',
                modules: { ...PRESET_MODULES.off },
                routing: {
                    ...current.routing,
                    automaticFallback: false,
                },
                ui: current.ui,
            }, { path: configPath, expectedVersion: current.version });
            expect(result.ok).toBe(true);
            expect(result.config.lastEnabledConfiguration).toEqual({
                preset: current.preset,
                modules: current.modules,
                routing: current.routing,
            });
        });
        it('preserves the saved enabled configuration across a false-to-false write', () => {
            const saved = {
                preset: 'advisory',
                modules: { ...PRESET_MODULES.advisory },
                routing: activeConfig().routing,
            };
            const current = {
                ...activeConfig(),
                version: 7,
                masterEnabled: false,
                preset: 'off',
                modules: { ...PRESET_MODULES.off },
                lastEnabledConfiguration: saved,
            };
            writeCurrent(current);
            const result = writeOptimizationConfig({
                masterEnabled: false,
                preset: 'custom',
                modules: {
                    ...PRESET_MODULES.off,
                    marketWatch: true,
                },
                routing: current.routing,
                ui: { ...current.ui, defaultWindow: '7d' },
            }, { path: configPath });
            expect(result.ok).toBe(true);
            expect(result.config.lastEnabledConfiguration).toEqual(saved);
        });
        it('increments the version by exactly one on every successful write', () => {
            const current = activeConfig();
            writeCurrent(current);
            const next = {
                masterEnabled: true,
                preset: 'active',
                modules: { ...PRESET_MODULES.active },
                routing: current.routing,
                ui: current.ui,
            };
            const first = writeOptimizationConfig(next, { path: configPath });
            const second = writeOptimizationConfig(next, { path: configPath });
            expect(first.ok).toBe(true);
            expect(first.config.version).toBe(current.version + 1);
            expect(second.ok).toBe(true);
            expect(second.config.version).toBe(first.config.version + 1);
        });
        it('backs up the exact previous content before overwriting an existing file', () => {
            const current = activeConfig();
            const previousBytes = JSON.stringify(current);
            writeFileSync(configPath, previousBytes);
            const result = writeOptimizationConfig({
                ...current,
                masterEnabled: false,
            }, { path: configPath });
            expect(result.ok).toBe(true);
            expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(previousBytes);
            expect(readFileSync(configPath, 'utf-8')).not.toBe(previousBytes);
        });
        it('writes a new file without requiring or creating a backup', () => {
            const current = activeConfig();
            const result = writeOptimizationConfig({
                masterEnabled: current.masterEnabled,
                preset: current.preset,
                modules: current.modules,
                routing: current.routing,
                ui: current.ui,
            }, { path: configPath });
            expect(result.ok).toBe(true);
            expect(existsSync(configPath)).toBe(true);
            expect(existsSync(`${configPath}.bak`)).toBe(false);
        });
    });
});
