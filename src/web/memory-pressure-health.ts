/**
 * Monitor health check (P0 phase 2, requirement D).
 *
 * Health must NOT be inferred from "timer active + state file exists" alone.
 * The incident at 05:20-05:28 proved this: the timer was active, the state
 * file existed, but every single run was failing (Module not found after a
 * branch switch).
 *
 * Required condition for healthy:
 *   1. State file exists AND is fresh (mtime age ≤ 2 monitor cycles)
 *   2. Last measurement status = "ok" (not "failed")
 *   3. Last successful measurement is fresh (age ≤ 2 monitor cycles)
 *
 * Failure modes surfaced explicitly:
 *   MONITOR_STATE_STALE       — state file missing or too old
 *   MONITOR_EXECUTION_FAILED  — state file fresh but last measurement failed
 *
 * v2 (2026-07-20): reads the separated pressureState/monitorHealth schema.
 * Falls back to v1 fields when reading older state files. Adds
 * HealthReasonCode for auditable failure attribution.
 *
 * This module checks the STATE FILE only. Systemd timer/service health is
 * reported by the state file's freshness and lastMeasurementStatus — a
 * failing service cannot update the state file.
 */

import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import type { MemoryPressureStateFile, HealthReasonCode } from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE } from "./memory-pressure-types.js";

export type MonitorFailureMode =
  | "MONITOR_STATE_STALE"
  | "MONITOR_EXECUTION_FAILED"
  | "MONITOR_RELEASE_MISMATCH";

export interface MonitorHealth {
  healthy: boolean;
  failureMode: MonitorFailureMode | null;
  /** Human-readable diagnostic for logs/notifications. */
  details: string;
  /** When the state file was last modified (epoch ms), or null if missing. */
  stateFileMtimeMs: number | null;
  /** How old the last successful measurement is (seconds), or null if unknown. */
  lastSuccessAgeSeconds: number | null;
  /** The state file's generation at time of check, or null. */
  stateGeneration: number | null;
  /** v2: health reason code from the state file, or computed by this check. */
  healthReasonCode: HealthReasonCode | null;
  /** v2: measurement capabilities from the state file, if present. */
  measurementCapabilities: import("./memory-pressure-types.js").MeasurementCapabilities | null;
}

// ── Data path resolution ───────────────────────────────────────────────────

function resolveDataPath(relative: string): string {
  const home = process.env.MARVEEN_HOME;
  if (!home) {
    if (process.env.MARVEEN_MEM_PRESSURE_TEST_STATE) {
      return `/tmp/mem-pressure-test/${relative}`;
    }
    throw new Error("MARVEEN_HOME is not set");
  }
  return `${home}/${relative}`;
}

function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return resolveDataPath(STATE_FILE);
}

export function loadStateFile(): MemoryPressureStateFile | null {
  try {
    const path = resolveStatePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryPressureStateFile;
  } catch {
    return null;
  }
}

/**
 * The release the monitor SHOULD be running from: the target of the
 * releases/monitor-current symlink. Returns null when the symlink is absent
 * (e.g. a dev box that never ran install-monitor.sh) — in that case we cannot
 * compare, so we do not fail the health check on it.
 */
function readInstalledReleaseId(): string | null {
  try {
    const override = process.env.MARVEEN_MEM_PRESSURE_TEST_RELEASE_LINK;
    const link = override ?? resolveDataPath("releases/monitor-current");
    // readlinkSync, NOT existsSync: existsSync FOLLOWS the symlink, so a
    // DANGLING monitor-current (release dir deleted, e.g. by git clean) would
    // return false and silently disable this whole check — the one case where
    // it matters most. readlinkSync reads the link itself and throws only when
    // there is no link at all.
    const target = readlinkSync(link);
    return target.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

/**
 * Check monitor health from the state file alone.
 *
 * The state file IS the monitor's heartbeat. If the timer fires but the
 * service crashes (import error, syntax error, missing dependency), the
 * state file is never updated — mtime ages, lastMeasurementStatus stays
 * "failed", and this function returns unhealthy.
 *
 * v2: reads pressureState/monitorHealth/measurementCapabilities from the
 * state file. Falls back to v1 fields for older state files.
 *
 * @param stateFile  Pre-loaded state file (for test injection), or null to load from disk.
 * @param nowMs      Current time in epoch ms (for test injection).
 * @param maxCycles  Max allowed age in monitor cycles (default 2).
 */
export function checkMonitorHealth(
  stateFile?: MemoryPressureStateFile | null,
  nowMs?: number,
  maxCycles?: number,
): MonitorHealth {
  const now = nowMs ?? Date.now();
  const cycles = maxCycles ?? 2;
  const maxAgeMs = cycles * DEFAULT_CONFIG.monitor.sampleIntervalSeconds * 1000; // 2 × 20s = 40s

  const statePath = resolveStatePath();

  // ── State file existence + freshness ───────────────────────────────────
  let stateFileMtimeMs: number | null = null;

  try {
    if (existsSync(statePath)) {
      stateFileMtimeMs = statSync(statePath).mtimeMs;
    }
  } catch {
    // stat failed — treat as missing
  }

  if (stateFileMtimeMs === null) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: "state file missing — monitor has never written or was deleted",
      stateFileMtimeMs: null,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
      healthReasonCode: "MONITOR_STATE_STALE",
      measurementCapabilities: null,
    };
  }

  const stateAgeMs = now - stateFileMtimeMs;

  if (stateAgeMs > maxAgeMs) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: `state file age ${Math.round(stateAgeMs / 1000)}s exceeds max ${Math.round(maxAgeMs / 1000)}s (${cycles} cycles)`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
      healthReasonCode: "MONITOR_STATE_STALE",
      measurementCapabilities: null,
    };
  }

  // ── Load content ───────────────────────────────────────────────────────
  const state = stateFile ?? loadStateFile();

  if (!state) {
    return {
      healthy: false,
      failureMode: "MONITOR_STATE_STALE",
      details: "state file exists but cannot be parsed — corrupt or empty",
      stateFileMtimeMs,
      lastSuccessAgeSeconds: null,
      stateGeneration: null,
      healthReasonCode: "MONITOR_STATE_STALE",
      measurementCapabilities: null,
    };
  }

  // ── v2: if the state file self-declares unhealthy, trust it ──────────
  if (state.monitorHealth === "unhealthy") {
    const reasonCode = state.healthReasonCode ?? "MONITOR_EXECUTION_FAILED";
    const details = state.healthDetails ?? "monitor self-reported unhealthy";
    return {
      healthy: false,
      failureMode: "MONITOR_EXECUTION_FAILED",
      details: `monitor self-reported unhealthy: ${reasonCode} — ${details}`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: null,
      stateGeneration: state.generation,
      healthReasonCode: reasonCode,
      measurementCapabilities: state.measurementCapabilities ?? null,
    };
  }

  // ── v2: check measurement capabilities ────────────────────────────────
  if (state.measurementCapabilities) {
    const caps = state.measurementCapabilities;
    if (caps.agentProcessTreeRss === "dependency_failed") {
      return {
        healthy: false,
        failureMode: "MONITOR_EXECUTION_FAILED",
        details: "Agent RSS collector missing or not executable (dependency_failed)",
        stateFileMtimeMs,
        lastSuccessAgeSeconds: null,
        stateGeneration: state.generation,
        healthReasonCode: "AGENT_RSS_COLLECTOR_FAILED",
        measurementCapabilities: caps,
      };
    }
    if (caps.agentProcessTreeRss === "error") {
      return {
        healthy: false,
        failureMode: "MONITOR_EXECUTION_FAILED",
        details: "Agent RSS measurement failed (script execution error)",
        stateFileMtimeMs,
        lastSuccessAgeSeconds: null,
        stateGeneration: state.generation,
        healthReasonCode: "AGENT_RSS_COLLECTOR_FAILED",
        measurementCapabilities: caps,
      };
    }
    if (caps.hostMemory === "error") {
      return {
        healthy: false,
        failureMode: "MONITOR_EXECUTION_FAILED",
        details: "Host memory measurement failed (/proc/meminfo unreadable)",
        stateFileMtimeMs,
        lastSuccessAgeSeconds: null,
        stateGeneration: state.generation,
        healthReasonCode: "HOST_MEMORY_MEASUREMENT_FAILED",
        measurementCapabilities: caps,
      };
    }
  }

  // ── Last measurement status (v1 compat) ────────────────────────────────
  const lastStatus = state.lastMeasurementStatus ?? "ok"; // pre-D fields default ok
  const lastSuccessTime = state.lastSuccessfulMeasurementTime
    ? new Date(state.lastSuccessfulMeasurementTime).getTime()
    : null;

  if (lastStatus === "failed") {
    return {
      healthy: false,
      failureMode: "MONITOR_EXECUTION_FAILED",
      details: `last measurement status is "failed" — timer may be firing but service execution is broken`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
      stateGeneration: state.generation,
      healthReasonCode: "MONITOR_EXECUTION_FAILED",
      measurementCapabilities: state.measurementCapabilities ?? null,
    };
  }

  // ── Last successful measurement freshness ──────────────────────────────
  if (lastSuccessTime !== null) {
    const successAgeMs = now - lastSuccessTime;
    if (successAgeMs > maxAgeMs) {
      return {
        healthy: false,
        failureMode: "MONITOR_STATE_STALE",
        details: `last successful measurement age ${Math.round(successAgeMs / 1000)}s exceeds max ${Math.round(maxAgeMs / 1000)}s (${cycles} cycles)`,
        stateFileMtimeMs,
        lastSuccessAgeSeconds: Math.round(successAgeMs / 1000),
        stateGeneration: state.generation,
        healthReasonCode: "AGENT_RSS_MEASUREMENT_STALE",
        measurementCapabilities: state.measurementCapabilities ?? null,
      };
    }
  }

  // ── Release match ──────────────────────────────────────────────────────
  const installedRelease = readInstalledReleaseId();
  if (installedRelease !== null && state.releaseId && state.releaseId !== installedRelease) {
    return {
      healthy: false,
      failureMode: "MONITOR_RELEASE_MISMATCH",
      details: `state written by release ${state.releaseId} but ${installedRelease} is installed — a superseded monitor is still running`,
      stateFileMtimeMs,
      lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
      stateGeneration: state.generation,
      healthReasonCode: "MONITOR_RELEASE_MISMATCH",
      measurementCapabilities: state.measurementCapabilities ?? null,
    };
  }

  // ── Resolve the pressure state for the diagnostic message (v1+v2 compat) ─
  const pressureState = state.pressureState ?? state.state ?? "normal";

  // ── All checks passed ─────────────────────────────────────────────────
  return {
    healthy: true,
    failureMode: null,
    details: `monitor healthy — generation ${state.generation}, pressureState=${pressureState}, lastSuccessAge=${lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : '?'}s`,
    stateFileMtimeMs,
    lastSuccessAgeSeconds: lastSuccessTime ? Math.round((now - lastSuccessTime) / 1000) : null,
    stateGeneration: state.generation,
    healthReasonCode: "OK",
    measurementCapabilities: state.measurementCapabilities ?? null,
  };
}
