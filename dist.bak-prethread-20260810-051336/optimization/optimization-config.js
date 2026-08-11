import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { atomicWriteFileSync } from '../web/atomic-write.js';
export const PRESET_MODULES = {
    off: {
        measurement: false,
        contextEfficiency: false,
        capacityMonitoring: false,
        runtimeRouting: false,
        recommendations: false,
        marketWatch: false,
        benchmarkRecommendations: false,
    },
    observation: {
        measurement: true,
        contextEfficiency: true,
        capacityMonitoring: true,
        runtimeRouting: false,
        recommendations: true,
        marketWatch: true,
        benchmarkRecommendations: false,
    },
    advisory: {
        measurement: true,
        contextEfficiency: true,
        capacityMonitoring: true,
        runtimeRouting: false,
        recommendations: true,
        marketWatch: true,
        benchmarkRecommendations: true,
    },
    active: {
        measurement: true,
        contextEfficiency: true,
        capacityMonitoring: true,
        runtimeRouting: true,
        recommendations: true,
        marketWatch: true,
        benchmarkRecommendations: true,
    },
};
export const DEFAULT_OPTIMIZATION_CONFIG = {
    version: 1,
    masterEnabled: false,
    preset: 'off',
    modules: { ...PRESET_MODULES.off },
    routing: {
        automaticFallback: false,
        trustedProvidersOnly: true,
        maxFallbacksPerProfile: 2,
        maxAutomaticFallbacksPerDispatch: 1,
    },
    ui: {
        defaultWindow: '30d',
        showAllocationCost: true,
    },
    lastEnabledConfiguration: null,
};
export const OPTIMIZATION_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'optimization-config.json');
const MODULE_KEYS = [
    'measurement',
    'contextEfficiency',
    'capacityMonitoring',
    'runtimeRouting',
    'recommendations',
    'marketWatch',
    'benchmarkRecommendations',
];
const NAMED_PRESETS = ['off', 'observation', 'advisory', 'active'];
function asObject(raw) {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
}
function normalizeModules(raw) {
    const o = asObject(raw);
    return {
        measurement: typeof o.measurement === 'boolean' ? o.measurement : DEFAULT_OPTIMIZATION_CONFIG.modules.measurement,
        contextEfficiency: typeof o.contextEfficiency === 'boolean' ? o.contextEfficiency : DEFAULT_OPTIMIZATION_CONFIG.modules.contextEfficiency,
        capacityMonitoring: typeof o.capacityMonitoring === 'boolean' ? o.capacityMonitoring : DEFAULT_OPTIMIZATION_CONFIG.modules.capacityMonitoring,
        runtimeRouting: typeof o.runtimeRouting === 'boolean' ? o.runtimeRouting : DEFAULT_OPTIMIZATION_CONFIG.modules.runtimeRouting,
        recommendations: typeof o.recommendations === 'boolean' ? o.recommendations : DEFAULT_OPTIMIZATION_CONFIG.modules.recommendations,
        marketWatch: typeof o.marketWatch === 'boolean' ? o.marketWatch : DEFAULT_OPTIMIZATION_CONFIG.modules.marketWatch,
        benchmarkRecommendations: typeof o.benchmarkRecommendations === 'boolean'
            ? o.benchmarkRecommendations
            : DEFAULT_OPTIMIZATION_CONFIG.modules.benchmarkRecommendations,
    };
}
function normalizeRouting(raw) {
    const o = asObject(raw);
    const defaults = DEFAULT_OPTIMIZATION_CONFIG.routing;
    return {
        automaticFallback: typeof o.automaticFallback === 'boolean' ? o.automaticFallback : defaults.automaticFallback,
        trustedProvidersOnly: typeof o.trustedProvidersOnly === 'boolean' ? o.trustedProvidersOnly : defaults.trustedProvidersOnly,
        maxFallbacksPerProfile: typeof o.maxFallbacksPerProfile === 'number'
            && Number.isInteger(o.maxFallbacksPerProfile)
            && o.maxFallbacksPerProfile >= 0
            ? o.maxFallbacksPerProfile
            : defaults.maxFallbacksPerProfile,
        maxAutomaticFallbacksPerDispatch: typeof o.maxAutomaticFallbacksPerDispatch === 'number'
            && Number.isInteger(o.maxAutomaticFallbacksPerDispatch)
            && o.maxAutomaticFallbacksPerDispatch >= 0
            ? o.maxAutomaticFallbacksPerDispatch
            : defaults.maxAutomaticFallbacksPerDispatch,
    };
}
function normalizeLastEnabledConfiguration(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const o = raw;
    const modules = validateModuleDependencies(normalizeModules(o.modules)).correctedModules;
    return {
        preset: presetForModules(modules),
        modules,
        routing: normalizeRouting(o.routing),
    };
}
export function presetForModules(modules) {
    for (const preset of NAMED_PRESETS) {
        if (MODULE_KEYS.every((key) => modules[key] === PRESET_MODULES[preset][key]))
            return preset;
    }
    return 'custom';
}
export function validateModuleDependencies(modules) {
    const correctedModules = normalizeModules(modules);
    const errors = [];
    if (!correctedModules.measurement) {
        if (correctedModules.runtimeRouting) {
            correctedModules.runtimeRouting = false;
            errors.push('runtimeRouting was forced off because measurement is required.');
        }
        if (correctedModules.recommendations) {
            correctedModules.recommendations = false;
            errors.push('recommendations was forced off because measurement is required.');
        }
    }
    if (correctedModules.runtimeRouting && correctedModules.capacityMonitoring === false) {
        correctedModules.runtimeRouting = false;
        errors.push('runtimeRouting was forced off because capacityMonitoring is required.');
    }
    if (correctedModules.benchmarkRecommendations && !correctedModules.recommendations) {
        correctedModules.benchmarkRecommendations = false;
        errors.push('benchmarkRecommendations was forced off because recommendations is required.');
    }
    return {
        ok: errors.length === 0,
        errors,
        correctedModules,
    };
}
/** Coerce untrusted parsed JSON into a valid config; junk/partial input degrades to safe defaults. */
export function normalizeOptimizationConfig(raw) {
    const o = asObject(raw);
    const defaults = DEFAULT_OPTIMIZATION_CONFIG;
    const modules = validateModuleDependencies(normalizeModules(o.modules)).correctedModules;
    const ui = asObject(o.ui);
    return {
        version: typeof o.version === 'number' && Number.isInteger(o.version) && o.version >= 1
            ? o.version
            : defaults.version,
        masterEnabled: typeof o.masterEnabled === 'boolean' ? o.masterEnabled : defaults.masterEnabled,
        preset: presetForModules(modules),
        modules,
        routing: normalizeRouting(o.routing),
        ui: {
            defaultWindow: typeof ui.defaultWindow === 'string' && ui.defaultWindow.trim()
                ? ui.defaultWindow
                : defaults.ui.defaultWindow,
            showAllocationCost: typeof ui.showAllocationCost === 'boolean'
                ? ui.showAllocationCost
                : defaults.ui.showAllocationCost,
        },
        lastEnabledConfiguration: normalizeLastEnabledConfiguration(o.lastEnabledConfiguration),
    };
}
export function readOptimizationConfig(path = OPTIMIZATION_CONFIG_PATH) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                config: DEFAULT_OPTIMIZATION_CONFIG,
                valid: false,
                errors: ['Optimization config must contain a JSON object.'],
            };
        }
        const o = parsed;
        const dependencyResult = validateModuleDependencies(normalizeModules(o.modules));
        return {
            config: normalizeOptimizationConfig(parsed),
            valid: dependencyResult.ok,
            errors: dependencyResult.errors,
        };
    }
    catch (error) {
        return {
            config: DEFAULT_OPTIMIZATION_CONFIG,
            valid: false,
            errors: [error instanceof Error ? error.message : String(error)],
        };
    }
}
export function writeOptimizationConfig(next, opts = {}) {
    const path = opts.path ?? OPTIMIZATION_CONFIG_PATH;
    const current = readOptimizationConfig(path).config;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
        return { ok: false, config: current, error: 'version_conflict' };
    }
    const modules = validateModuleDependencies(next.modules).correctedModules;
    const lastEnabledConfiguration = current.masterEnabled && !next.masterEnabled
        ? {
            preset: current.preset,
            modules: current.modules,
            routing: current.routing,
        }
        : current.lastEnabledConfiguration;
    const config = {
        version: current.version + 1,
        masterEnabled: next.masterEnabled,
        preset: presetForModules(modules),
        modules,
        routing: next.routing,
        ui: next.ui,
        lastEnabledConfiguration,
    };
    try {
        // Preserve the exact pre-write bytes in a sibling backup before replacing the live config.
        if (existsSync(path))
            copyFileSync(path, `${path}.bak`);
        atomicWriteFileSync(path, JSON.stringify(config, null, 2) + '\n');
        return { ok: true, config, error: null };
    }
    catch (error) {
        return {
            ok: false,
            config: current,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
export function ensureOptimizationConfigExample(exampleDir) {
    const examplePath = join(exampleDir, 'optimization-config.example.json');
    if (existsSync(examplePath))
        return;
    const example = {
        _doc: 'Illustrative Lean Optimization configuration only. The real deployment-local file lives gitignored at '
            + 'store/optimization-config.json.',
        version: 1,
        masterEnabled: true,
        preset: 'active',
        modules: {
            measurement: true,
            contextEfficiency: true,
            capacityMonitoring: true,
            runtimeRouting: true,
            recommendations: true,
            marketWatch: true,
            benchmarkRecommendations: true,
        },
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
    };
    writeFileSync(examplePath, JSON.stringify(example, null, 2) + '\n');
}
