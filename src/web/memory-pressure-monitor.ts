#!/usr/bin/env node
/**
 * Memory-pressure monitor (component A of P0 build).
 *
 * Runs INDEPENDENTLY of the dashboard — a systemd USER service triggered by a
 * systemd timer every 15-30s. If the dashboard dies or the channel-monitor
 * event loop blocks, this must keep running.
 *
 * ZERO LLM CALLS. Reads /proc/meminfo, /proc/pressure/memory, /proc/self/status
 * and `ps` outputs. Writes an atomic JSON state file on state-change only.
 * Identical state → no write, no repeat report.
 *
 * State machine with hysteresis:
 *   normal → warning (MemAvailable < 2.5 GiB)
 *   warning → critical (MemAvailable < 1.5 GiB)
 *   critical → emergency (MemAvailable < 0.8 GiB)
 *   any → recovery (>= 5 min stable normal)
 *
 * PSI and swap are SUPPLEMENTARY conditions — they can escalate but never
 * de-escalate alone. Hysteresis prevents flapping.
 *
 * Schema v2 (2026-07-20): pressureState split from monitorHealth.
 * The monitor self-assesses its health and writes it into the state file.
 * The gate reads monitorHealth directly — no function call, no stale path.
 */

import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync, statSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type {
  MemoryPressureState,
  MemoryPressureSample,
  MemoryPressureStateFile,
  MemoryPressureConfig,
  MeasurementCapabilities,
  HealthReasonCode,
} from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE, CONFIG_FILE } from "./memory-pressure-types.js";
import { relievePressure, updateStateAction } from "./memory-pressure-gate.js";

// ── Data path resolution ───────────────────────────────────────────────────
// Code dependencies (scripts, JS modules) live INSIDE the release directory
// and are resolved relative to THIS file via import.meta.url. Data paths
// (state file, config, audit log, agents-desired) live under MARVEEN_HOME
// which is set by the systemd unit. No process.cwd() fallback — a missing
// MARVEEN_HOME is a configuration error and must fail loudly.

function resolveDataPath(relative: string): string {
  const home = process.env.MARVEEN_HOME;
  if (!home) {
    // Test mode: MARVEEN_MEM_PRESSURE_TEST_STATE implies a hermetic test
    // environment where data paths are absolute overrides and MARVEEN_HOME
    // is intentionally absent (the test must not touch the live store).
    if (process.env.MARVEEN_MEM_PRESSURE_TEST_STATE) {
      return `/tmp/mem-pressure-test/${relative}`;
    }
    throw new Error("MARVEEN_HOME is not set — systemd unit must provide this env var");
  }
  return `${home}/${relative}`;
}

function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return resolveDataPath(STATE_FILE);
}

function loadConfig(): MemoryPressureConfig {
  const configPath = resolveDataPath(CONFIG_FILE);
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<MemoryPressureConfig>;
      return {
        coreAgents: raw.coreAgents ?? DEFAULT_CONFIG.coreAgents,
        thresholds: { ...DEFAULT_CONFIG.thresholds, ...raw.thresholds },
        monitor: { ...DEFAULT_CONFIG.monitor, ...raw.monitor },
        relief: { ...DEFAULT_CONFIG.relief, ...raw.relief },
      };
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_CONFIG;
}

function readMemInfo(): { memAvailableKiB: number; swapUsedKiB: number } {
  let memAvailableKiB = 0;
  let memTotalKiB = 0;
  let swapFreeKiB = 0;
  let swapTotalKiB = 0;
  try {
    const raw = readFileSync("/proc/meminfo", "utf-8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("MemAvailable:")) memAvailableKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("MemTotal:")) memTotalKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("SwapFree:")) swapFreeKiB = Number(line.match(/\d+/)?.[0] ?? 0);
      if (line.startsWith("SwapTotal:")) swapTotalKiB = Number(line.match(/\d+/)?.[0] ?? 0);
    }
  } catch { /* /proc not available; return zeros (non-Linux) */ }
  return {
    memAvailableKiB,
    swapUsedKiB: swapTotalKiB > 0 ? swapTotalKiB - swapFreeKiB : 0,
  };
}

function readPsiMemorySome(): number {
  try {
    const raw = readFileSync("/proc/pressure/memory", "utf-8");
    const someMatch = raw.match(/some avg10=(\d+\.\d+)/);
    return someMatch ? Number(someMatch[1]) : 0;
  } catch { return 0; }
}

/**
 * Call the ONE authoritative process-tree measurement script (list-agent-rss.sh).
 * This replaces the broken cmdline-regex approach that measured 0.012 GiB against
 * ~2.2 GiB real (commit a6b9743). The script walks from tmux pane PIDs — session
 * name IS the agent identity, not a cmdline heuristic.
 *
 * Returns the full measurement including per-agent RSS, status, and count.
 * On ANY failure (script crash, timeout, unparseable output), returns a synthetic
 * error result with totalRssBytes: null — never a false zero.
 */
function readAgentRss(): import("./memory-pressure-types.js").AgentRssMeasurement {
  // Release-local copy — NOT INSTALL_DIR, which is the shared checkout.
  // A branch switch by another agent must not blind the measurement (card 5213e06c).
  const monitorDir = dirname(new URL(import.meta.url).pathname);
  const script = `${monitorDir}/list-agent-rss.sh`;
  try {
    const output = execSync(
      `bash "${script}" --json`,
      { timeout: 8000, encoding: "utf-8" },
    );
    const parsed = JSON.parse(output.trim()) as import("./memory-pressure-types.js").AgentRssMeasurement;

    // Defensive: if the script returned status "ok" but totalRssBytes is missing
    // or null, treat as error — a measurement that reports success but provides
    // no value is corrupt.
    if (parsed.status === "ok" && (parsed.totalRssBytes === null || parsed.totalRssBytes === undefined)) {
      return {
        source: "list-agent-rss.sh",
        status: "error",
        error: "script returned ok but totalRssBytes is null",
        measuredAgentCount: 0,
        failedAgentCount: 0,
        agents: [],
        totalRssBytes: null,
      };
    }

    return parsed;
  } catch (err) {
    return {
      source: "list-agent-rss.sh",
      status: "error",
      error: err instanceof Error ? err.message : "script execution failed",
      measuredAgentCount: 0,
      failedAgentCount: 0,
      agents: [],
      totalRssBytes: null,
    };
  }
}

/** Read expected agent count from the agent inventory (agents-desired.json).
 *  This is the canonical list of agents that SHOULD be running, maintained by
 *  the dashboard. Returns null if the file is unreadable — a null
 *  expectedAgentCount means "we don't know how many to expect", which makes
 *  partial status less actionable but is honest about the uncertainty. */
function readExpectedAgentCount(): number | null {
  try {
    const path = resolveDataPath("store/agents-desired.json");
    if (!existsSync(path)) return null;
    const agents = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(agents)) return agents.length;
    return null;
  } catch { return null; }
}

function sample(
  config: MemoryPressureConfig,
  rss: import("./memory-pressure-types.js").AgentRssMeasurement,
): MemoryPressureSample {
  const mem = readMemInfo();
  return {
    timestamp: new Date().toISOString(),
    memAvailableGiB: mem.memAvailableKiB / 1048576,
    swapUsedGiB: mem.swapUsedKiB / 1048576,
    psiMemorySome: readPsiMemorySome(),
    agentProcessTreeRssBytes: rss.totalRssBytes,
    measuredAgentCount: rss.measuredAgentCount,
    expectedAgentCount: readExpectedAgentCount(),
    agentRssMeasurementStatus: rss.status,
    agentRssMeasurementSource: "list-agent-rss.sh",
  };
}

function computeNextState(
  current: MemoryPressureState,
  sample: MemoryPressureSample,
  since: string,
  thresholds: MemoryPressureConfig["thresholds"],
): MemoryPressureState {
  const av = sample.memAvailableGiB;

  // Emergency: critically low memory
  if (av < thresholds.emergencyMemAvailableGiB) return "emergency";

  // Critical: severe memory pressure
  if (av < thresholds.criticalMemAvailableGiB) return "critical";

  // Warning: elevated memory pressure
  if (av < thresholds.warningMemAvailableGiB) return "warning";

  // Sample is in normal range (av >= warning threshold). What happens next
  // depends on where we are now (hysteresis).

  // Recovery → normal: lock has already been released (the gate allows
  // non-core starts in both recovery and normal). After recoveryMinutes of
  // stable normal samples, declare the incident fully resolved and return
  // to the baseline state. This is NOT terminal — see gate.ts which
  // already allows non-core starts during recovery.
  if (current === "recovery") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "normal";
    return "recovery";
  }

  // Emergency / critical / warning: stepwise de-escalation. Must stay at
  // normal thresholds for recoveryMinutes before entering recovery.
  if (current === "emergency" || current === "critical" || current === "warning") {
    const sinceMs = new Date(since).getTime();
    const stableMs = thresholds.recoveryMinutes * 60 * 1000;
    if (Date.now() - sinceMs >= stableMs) return "recovery";
    // Not yet stable — keep current state. This is the hysteresis that prevents flapping.
    return current;
  }

  return "normal";
}

// ── Measurement capabilities (v2) ───────────────────────────────────────────

/**
 * Evaluate what this monitor can actually measure RIGHT NOW.
 * Written into the state file so the gate and health check can decide
 * fail-closed without calling back into monitor code.
 */
function computeMeasurementCapabilities(
  rssResult: import("./memory-pressure-types.js").AgentRssMeasurement,
): MeasurementCapabilities {
  // Host memory: /proc/meminfo is a kernel interface. On Linux it always works.
  // If it returned zeros, it's still "ok" — we measured, the value is just zero.
  const hostMemory: MeasurementCapabilities["hostMemory"] = "ok";

  // Agent RSS: what does the measurement script tell us?
  let agentProcessTreeRss: MeasurementCapabilities["agentProcessTreeRss"];
  if (rssResult.status === "ok") {
    agentProcessTreeRss = "ok";
  } else if (rssResult.status === "partial") {
    agentProcessTreeRss = "partial";
  } else {
    // status === "error" — but WHY? Distinguish "script missing/not-executable"
    // (dependency_failed) from "script exists but execution failed" (error).
    const monitorDir = dirname(new URL(import.meta.url).pathname);
    const script = `${monitorDir}/list-agent-rss.sh`;
    try {
      if (!existsSync(script)) {
        agentProcessTreeRss = "dependency_failed";
      } else {
        // Script exists but execution failed — could be timeout, parse error, etc.
        agentProcessTreeRss = "error";
      }
    } catch {
      agentProcessTreeRss = "error";
    }
  }

  return { hostMemory, agentProcessTreeRss };
}

// ── Monitor health self-assessment (v2) ─────────────────────────────────────

/**
 * The monitor evaluates its OWN health during main() and writes it into the
 * state file. The gate reads monitorHealth directly — no function call, no
 * stale code path. The gate's ONLY job is to check the state file.
 *
 * This function answers: given what we just measured and what we know about
 * our runtime environment, are we healthy?
 */
function computeMonitorHealth(
  capabilities: MeasurementCapabilities,
  release: { commit: string | null; releaseId: string | null },
): { monitorHealth: "healthy" | "unhealthy"; healthReasonCode: HealthReasonCode; healthDetails: string } {
  const problems: string[] = [];

  // Check 1: can we measure agent RSS at all?
  if (capabilities.agentProcessTreeRss === "dependency_failed") {
    problems.push("Agent RSS collector script missing or not executable");
    return {
      monitorHealth: "unhealthy",
      healthReasonCode: "AGENT_RSS_COLLECTOR_FAILED",
      healthDetails: problems.join("; "),
    };
  }

  // Check 2: agent RSS measurement errored
  if (capabilities.agentProcessTreeRss === "error") {
    problems.push("Agent RSS measurement failed (script execution error)");
    return {
      monitorHealth: "unhealthy",
      healthReasonCode: "AGENT_RSS_COLLECTOR_FAILED",
      healthDetails: problems.join("; "),
    };
  }

  // Check 3: host memory measurement
  if (capabilities.hostMemory === "error") {
    problems.push("Host memory measurement failed (/proc/meminfo unreadable)");
    return {
      monitorHealth: "unhealthy",
      healthReasonCode: "HOST_MEMORY_MEASUREMENT_FAILED",
      healthDetails: problems.join("; "),
    };
  }

  // Check 4: release match — does the running code match what's installed?
  // Only meaningful when running from a release (not source tree / dev mode).
  if (release.commit && release.releaseId) {
    try {
      const installedRelease = readInstalledReleaseId();
      if (installedRelease !== null && release.releaseId !== installedRelease) {
        problems.push(
          `Running release ${release.releaseId} but ${installedRelease} is installed — superseded monitor still active`,
        );
        return {
          monitorHealth: "unhealthy",
          healthReasonCode: "MONITOR_RELEASE_MISMATCH",
          healthDetails: problems.join("; "),
        };
      }
    } catch { /* release symlink not available; skip this check */ }
  }

  // Healthy
  return {
    monitorHealth: "healthy",
    healthReasonCode: "OK",
    healthDetails: capabilities.agentProcessTreeRss === "partial"
      ? "monitor healthy (RSS measurement partial)"
      : "monitor healthy",
  };
}

// ── Dependency closure self-audit (v2) ──────────────────────────────────────

/**
 * Check that a release-local dependency actually exists inside the release
 * directory and is executable (for scripts). Returns an error message or null.
 * This is a RUNTIME self-audit — the build-time check in install-monitor.sh
 * is the primary gate, but this catches post-install corruption.
 */
function auditReleaseLocalDep(relativePath: string, mustBeExecutable: boolean): string | null {
  const monitorDir = dirname(new URL(import.meta.url).pathname);
  const fullPath = `${monitorDir}/${relativePath}`;
  try {
    if (!existsSync(fullPath)) {
      return `missing: ${relativePath}`;
    }
    if (mustBeExecutable) {
      try {
        execSync(`test -x "${fullPath}"`, { timeout: 1000 });
      } catch {
        return `not executable: ${relativePath}`;
      }
    }
    return null;
  } catch (err) {
    return `cannot stat ${relativePath}: ${err instanceof Error ? err.message : "unknown"}`;
  }
}

/**
 * At runtime, verify the release has no dangling references to the shared
 * checkout. This catches post-install corruption (e.g. git clean removed a
 * release file that the symlink still points to).
 */
function auditReleaseClosure(): { status: "ok" | "missing_dependency" | "dependency_outside_release"; errors: string[] } {
  const errors: string[] = [];

  // Critical release-local dependencies
  const deps = [
    { path: "list-agent-rss.sh", executable: true },
  ];

  for (const dep of deps) {
    const err = auditReleaseLocalDep(dep.path, dep.executable);
    if (err) errors.push(err);
  }

  if (errors.length > 0) {
    return { status: "missing_dependency", errors };
  }

  return { status: "ok", errors: [] };
}

// ── Atomic write ────────────────────────────────────────────────────────────

function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function loadStateFile(statePath: string): MemoryPressureStateFile | null {
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8")) as MemoryPressureStateFile;
    }
  } catch { /* corrupt or missing; start fresh */ }
  return null;
}

/** Resolve the running monitor's release metadata. Returns null if not
 *  installed via install-monitor.sh (e.g. running from source tree). */
function readReleaseMetadata(): { commit: string | null; releaseId: string | null } {
  try {
    // When running from a release, the release.json is next to the JS file.
    const monitorDir = dirname(new URL(import.meta.url).pathname);
    const manifestPath = `${monitorDir}/release.json`;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return {
        commit: manifest.commit ?? null,
        releaseId: manifest.releaseId ?? null,
      };
    }
  } catch { /* not installed via install-monitor.sh */ }
  return { commit: null, releaseId: null };
}

/** Read the installed release ID from the monitor-current symlink target.
 *  Uses readlinkSync (NOT existsSync) — existsSync follows the symlink and
 *  would silently return false on a dangling symlink, disabling this check
 *  in the exact case where it matters most. */
function readInstalledReleaseId(): string | null {
  try {
    const home = process.env.MARVEEN_HOME;
    if (!home) return null;
    const link = `${home}/releases/monitor-current`;
    const target = readlinkSync(link);  // throws if no link, reads link itself
    return target.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const config = loadConfig();
  const statePath = resolveStatePath();
  const prev = loadStateFile(statePath);

  // ONE measurement call per cycle — sample() and computeMeasurementCapabilities()
  // share the same RSS result. No double invocation of the script.
  const rssResult = readAgentRss();
  const currentSample = sample(config, rssResult);

  // Resolve previous state, handling both v1 (state/since) and v2 (pressureState/pressureStateSince)
  const prevPressureState: MemoryPressureState =
    prev?.pressureState ?? prev?.state ?? "normal";
  const prevPressureSince: string =
    prev?.pressureStateSince ?? prev?.since ?? currentSample.timestamp;

  const measurementOk = currentSample.agentRssMeasurementStatus !== "error";
  const now = new Date().toISOString();

  const nextPressureState = computeNextState(prevPressureState, currentSample, prevPressureSince, config.thresholds);

  // No state change → write nothing. Zero repeat reports, zero LLM calls.
  if (nextPressureState === prevPressureState && prevPressureState !== "normal") {
    // In non-normal states, we still update the sample every N samples for freshness,
    // but avoid writing every cycle. Write on generation % 3 === 0 (every ~60s at 20s interval).
    if ((prev?.generation ?? 0) % 3 !== 0) return;
  }

  // ── Active pressure relief (component C) ───────────────────────────────
  // At most ONE agent per cycle. NEVER touches core agents.
  // reliefCooldown prevents re-parking within the cooldown window.
  let reliefAction = prev?.lastAction ?? null;
  if (
    (nextPressureState === "critical" || nextPressureState === "emergency") &&
    nextPressureState !== prevPressureState
  ) {
    reliefAction = relievePressure(nextPressureState) ?? reliefAction;
  }

  // ── v2: measurement capabilities + monitor health ──────────────────────
  const detailedCapabilities = computeMeasurementCapabilities(rssResult);
  const release = readReleaseMetadata();
  const health = computeMonitorHealth(detailedCapabilities, release);

  // Runtime dependency closure audit
  const closureAudit = auditReleaseClosure();

  // ── Dead-guard detection fields ────────────────────────────────────────
  const lastSuccessfulMeasurementTime = measurementOk
    ? now
    : (prev?.lastSuccessfulMeasurementTime ?? now);
  const lastMeasurementStatus: "ok" | "failed" = measurementOk ? "ok" : "failed";

  // Build the state file — v2 schema with backward-compat aliases
  const stateFile: MemoryPressureStateFile = {
    // v2 separated fields
    pressureState: nextPressureState,
    pressureStateSince: nextPressureState !== prevPressureState ? currentSample.timestamp : prevPressureSince,
    monitorHealth: health.monitorHealth,
    healthReasonCode: health.healthReasonCode,
    healthDetails: health.healthDetails,
    measurementCapabilities: detailedCapabilities,
    dependencyClosureStatus: closureAudit.status,
    dependencyClosureErrors: closureAudit.errors,

    // Backward-compat aliases
    state: nextPressureState,
    since: nextPressureState !== prevPressureState ? currentSample.timestamp : prevPressureSince,

    // Unchanged fields
    lastSample: currentSample,
    thresholds: config.thresholds,
    generation: (prev?.generation ?? 0) + 1,
    lastAction: reliefAction,
    lastSuccessfulMeasurementTime,
    lastMeasurementStatus,
    monitorBuildCommit: release.commit ?? prev?.monitorBuildCommit ?? null,
    releaseId: release.releaseId ?? prev?.releaseId ?? null,
  };

  atomicWrite(statePath, JSON.stringify(stateFile, null, 2));
}

main();
