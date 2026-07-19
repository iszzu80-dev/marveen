/**
 * Memory-pressure state file shared between the independent monitor (component A),
 * the global gate in startAgentProcess (component B), and the active pressure
 * relief logic (component C). Single source of truth, atomic write.
 *
 * P0 commit — Istvan-approved plan, single isolated commit.
 * Do NOT merge memGate logic from fleet-memory-gate.sh into this file.
 * That gate is deliberately fail-open; this one is fail-closed.
 */

export type MemoryPressureState = "normal" | "warning" | "critical" | "emergency" | "recovery";

export interface MemoryPressureSample {
  timestamp: string; // ISO 8601
  memAvailableGiB: number;
  swapUsedGiB: number;
  psiMemorySome: number; // /proc/pressure/memory some avg10
  rssTotalGiB: number;   // sum of marveen agent process trees
}

export interface MemoryPressureReliefAction {
  timestamp: string;
  action: "parked";
  agentName: string;
  pidTreeKilled: number[];
  rssFreedGiB: number;
  reason: string;
}

export interface MemoryPressureStateFile {
  state: MemoryPressureState;
  since: string; // ISO 8601 — when the current state was entered
  lastSample: MemoryPressureSample;
  thresholds: {
    warningMemAvailableGiB: number;
    criticalMemAvailableGiB: number;
    emergencyMemAvailableGiB: number;
    recoveryMinutes: number;
  };
  generation: number; // monotonically increasing, for change detection
  lastAction: MemoryPressureReliefAction | null;
}

export interface MemoryPressureConfig {
  coreAgents: string[];
  thresholds: {
    warningMemAvailableGiB: number;
    criticalMemAvailableGiB: number;
    emergencyMemAvailableGiB: number;
    recoveryMinutes: number;
  };
  monitor: {
    sampleIntervalSeconds: number;
  };
  relief: {
    maxPerCycle: number;
    cooldownSeconds: number;
  };
}

export const DEFAULT_CONFIG: MemoryPressureConfig = {
  coreAgents: ["marveen"],
  thresholds: {
    warningMemAvailableGiB: 2.5,
    criticalMemAvailableGiB: 1.5,
    emergencyMemAvailableGiB: 0.8,
    recoveryMinutes: 5,
  },
  monitor: {
    sampleIntervalSeconds: 20,
  },
  relief: {
    maxPerCycle: 1,
    cooldownSeconds: 60,
  },
};

export const STATE_FILE = "store/runtime/memory-pressure-state.json";
export const CONFIG_FILE = "store/memory-pressure-config.json";
