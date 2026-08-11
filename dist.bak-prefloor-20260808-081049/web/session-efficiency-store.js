// Lean Optimization Phase 2 / P2-B -- deployment-local config for the session
// saturation tiers and the task-size workflow policy.
//
// Same shape and defensive style as src/web/context-guard-store.ts: one JSON
// file under the gitignored store/, read fresh on every call, every value pushed
// through a normalizer so a hand-edited or truncated file can never disarm the
// gate or produce NaN thresholds. Missing file => the built-in defaults, which
// reproduce today's live context-guard behaviour (see session-saturation.ts).
//
// The concrete thresholds are DEPLOYMENT-LOCAL by policy (store/ is gitignored);
// the committed illustrative copy is config-examples/session-efficiency.example.json.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PROJECT_ROOT } from '../config.js';
import { normalizeSaturationThresholds, normalizeTaskSizePolicy, DEFAULT_SATURATION_THRESHOLDS, DEFAULT_TASK_SIZE_POLICY, } from '../session-saturation.js';
export const SESSION_EFFICIENCY_PATH = join(PROJECT_ROOT, 'store', 'session-efficiency.json');
function readRaw(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Normalize arbitrary parsed JSON into a complete config. Exported so tests can
 *  exercise the coercion without touching the filesystem. */
export function normalizeSessionEfficiencyConfig(raw) {
    const o = (raw && typeof raw === 'object') ? raw : {};
    const fleetSaturation = normalizeSaturationThresholds(o.saturation);
    const taskSizePolicy = normalizeTaskSizePolicy(o.taskSizePolicy);
    const agents = {};
    if (o.agents && typeof o.agents === 'object') {
        for (const [name, entry] of Object.entries(o.agents)) {
            const e = (entry && typeof entry === 'object') ? entry : {};
            // A per-agent block that omits `saturation` inherits the FLEET values, not
            // the built-in defaults -- otherwise adding a per-agent task-size default
            // would silently reset that agent's thresholds.
            const saturation = 'saturation' in e
                ? normalizeSaturationThresholds({ ...fleetSaturation, ...(e.saturation ?? {}) })
                : fleetSaturation;
            const declared = e.agentDefaultTaskSize;
            const agentDefaultTaskSize = (declared === 'small' || declared === 'normal' || declared === 'large')
                ? declared
                : taskSizePolicy.agentDefault;
            agents[name] = { saturation, agentDefaultTaskSize };
        }
    }
    return { saturation: fleetSaturation, taskSizePolicy, agents };
}
/** The whole config, normalized. Missing/invalid file => built-in defaults. */
export function readSessionEfficiencyConfig(path = SESSION_EFFICIENCY_PATH) {
    return normalizeSessionEfficiencyConfig(readRaw(path));
}
/** One agent's effective thresholds (per-agent override, else fleet, else defaults). */
export function readSaturationThresholdsFor(agent, path = SESSION_EFFICIENCY_PATH) {
    const cfg = readSessionEfficiencyConfig(path);
    return cfg.agents[agent]?.saturation ?? cfg.saturation;
}
/** One agent's default task size for UNMARKED work. Never 'large' unless an
 *  operator explicitly configured it that way. */
export function readAgentDefaultTaskSize(agent, path = SESSION_EFFICIENCY_PATH) {
    const cfg = readSessionEfficiencyConfig(path);
    return cfg.agents[agent]?.agentDefaultTaskSize ?? cfg.taskSizePolicy.agentDefault;
}
export { DEFAULT_SATURATION_THRESHOLDS, DEFAULT_TASK_SIZE_POLICY };
