/**
 * Memory-pressure gate (component B + C of P0 build).
 *
 * B: Global gate in startAgentProcess() — forbids non-core agent start/restart
 *    during warning/critical/emergency. Fail-closed. Core list from explicit config.
 * C: Active pressure relief — at critical, park the largest idle non-core agent,
 *    verify child tree is gone, audit-log every action.
 *
 * Istvan-approved plan, single isolated commit.
 *
 * Schema v2 (2026-07-20): reads pressureState and monitorHealth directly from
 * the state file. Does NOT call checkMonitorHealth() — the monitor self-assesses
 * its health and writes it into the state file. The gate trusts the state file.
 * RSS measurement failure → fail-closed for non-core starts and eviction.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type { MemoryPressureState, MemoryPressureStateFile, MemoryPressureConfig, MemoryPressureReliefAction } from "./memory-pressure-types.js";
import { DEFAULT_CONFIG, STATE_FILE, CONFIG_FILE } from "./memory-pressure-types.js";

const DASHBOARD_PORT = 3420;
const DASHBOARD_TOKEN_PATH = "store/.dashboard-token";

// ── Data path resolution ───────────────────────────────────────────────────
// Code deps are release-local (resolved via import.meta.url). Data paths
// (state file, config, audit log, dashboard token) live under MARVEEN_HOME.
// No process.cwd() fallback — a missing MARVEEN_HOME is a configuration error.

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

/** Resolve the state file path. When MARVEEN_MEM_PRESSURE_TEST_STATE is set,
 *  use it directly (absolute temp path for hermetic testing). Otherwise
 *  resolve the default relative path against MARVEEN_HOME. Checked at CALL
 *  time, not at module load — the env var may be set after import. */
function resolveStatePath(): string {
  const override = process.env.MARVEEN_MEM_PRESSURE_TEST_STATE;
  if (override) return override;
  return resolveDataPath(STATE_FILE);
}

// ── Gate (component B) ──────────────────────────────────────────────────────

export interface GateResult {
  allowed: boolean;
  reason: string;
}

/** Reads the current memory-pressure state. Returns null if the state file
 *  cannot be read or parsed — the caller treats this as FAIL-CLOSED for
 *  non-core agents (a broken gate must NOT fail-open). */
function readState(): MemoryPressureStateFile | null {
  try {
    const path = resolveStatePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryPressureStateFile;
  } catch {
    return null;
  }
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

function isCoreAgent(name: string, config: MemoryPressureConfig): boolean {
  return config.coreAgents.includes(name);
}

/**
 * Resolve the pressure state from a state file, handling both v1 (state field)
 * and v2 (pressureState field) schemas.
 */
function getPressureState(state: MemoryPressureStateFile): MemoryPressureState {
  return state.pressureState ?? state.state ?? "normal";
}

/**
 * Resolve monitor health from a state file. v2 files have monitorHealth
 * directly. v1 files (pre-split schema) — we infer health from
 * lastMeasurementStatus: "failed" means unhealthy because the monitor
 * couldn't measure.
 */
function getMonitorHealth(state: MemoryPressureStateFile): "healthy" | "unhealthy" {
  if (state.monitorHealth) return state.monitorHealth;
  // v1 fallback: infer from measurement status
  if (state.lastMeasurementStatus === "failed") return "unhealthy";
  return "healthy";
}

/**
 * Called at the top of startAgentProcess() to gate non-core agent starts
 * under memory pressure. FAIL-CLOSED: a gate error or missing state file
 * blocks non-core starts (opposite of the existing fail-open memGate).
 *
 * Core agents always pass, even in emergency (the operator's primary bot
 * must survive). Manual override via MARVEEN_MEM_PRESSURE_OVERRIDE env var.
 *
 * v2: reads monitorHealth and measurementCapabilities directly from the
 * state file. Does NOT call checkMonitorHealth() — the monitor writes its
 * own health assessment, and the gate trusts it. If the monitor is dead,
 * the state file goes stale and freshness checks catch it.
 */
export function memoryPressureGate(agentName: string): GateResult {
  // Manual override for emergencies — operator explicitly allows a start.
  // Format: MARVEEN_MEM_PRESSURE_OVERRIDE=1 or MARVEEN_MEM_PRESSURE_OVERRIDE=agent1,agent2
  const override = process.env.MARVEEN_MEM_PRESSURE_OVERRIDE;
  if (override) {
    if (override === "1" || override.split(",").map(s => s.trim()).includes(agentName)) {
      return { allowed: true, reason: "manual-override" };
    }
  }

  const config = loadConfig();

  // Core agents always pass — the operator's primary bot must never be gated.
  if (isCoreAgent(agentName, config)) {
    return { allowed: true, reason: "core-agent" };
  }

  const state = readState();

  // FAIL-CLOSED: no state file → gate is active, block non-core.
  if (!state) {
    return { allowed: false, reason: "gate-error: no state file (fail-closed)" };
  }

  // ── v2: check monitorHealth first ──────────────────────────────────────
  // A state file that says "unhealthy" means the monitor detected its own
  // degradation. Trust it. This covers: RSS collector broken, release
  // mismatch, host memory unreadable.
  const monitorHealth = getMonitorHealth(state);
  if (monitorHealth === "unhealthy") {
    const reasonCode = state.healthReasonCode ?? "MONITOR_EXECUTION_FAILED";
    const details = state.healthDetails ?? "monitor self-reported unhealthy";
    return {
      allowed: false,
      reason: `monitor unhealthy: ${reasonCode} — ${details}`,
    };
  }

  // ── v2: check measurement capabilities ─────────────────────────────────
  // Even if the monitor says "healthy", verify the RSS measurement is working.
  // A broken RSS collector means we can't select eviction candidates safely.
  const caps = state.measurementCapabilities;
  if (caps) {
    if (caps.agentProcessTreeRss === "error" || caps.agentProcessTreeRss === "dependency_failed") {
      return {
        allowed: false,
        reason: `measurement degraded: agent RSS ${caps.agentProcessTreeRss} — cannot safely gate or evict`,
      };
    }
  }

  // ── Pressure state gating ──────────────────────────────────────────────
  const pressureState = getPressureState(state);

  if (pressureState === "normal" || pressureState === "recovery") {
    return { allowed: true, reason: `pressureState=${pressureState} monitor=healthy` };
  }

  // warning, critical, emergency: block non-core starts.
  return {
    allowed: false,
    reason: `pressureState=${pressureState} memAvailable=${state.lastSample.memAvailableGiB.toFixed(1)}GiB threshold=${state.thresholds.warningMemAvailableGiB}GiB`,
  };
}

// ── Active pressure relief (component C) ────────────────────────────────────

/** List running agent tmux sessions with their total process-tree RSS.
 *  Calls the ONE authoritative measurement script (list-agent-rss.sh --json)
 *  — same source the monitor uses for telemetry. Returns agents sorted by
 *  RSS descending. RSS is in bytes for precision; convert to GiB for display.
 *
 *  Returns empty array when measurement is unavailable — the caller MUST
 *  treat this as "cannot evict safely", not "zero agents running". */
function listAgentRss(): { name: string; rssBytes: number }[] {
  try {
    // Release-local copy — NOT MARVEEN_HOME, which is the shared checkout.
    const monitorDir = dirname(new URL(import.meta.url).pathname);
    const script = `${monitorDir}/list-agent-rss.sh`;
    const output = execSync(`bash "${script}" --json`, { timeout: 8000, encoding: "utf-8" });
    const parsed = JSON.parse(output.trim()) as import("./memory-pressure-types.js").AgentRssMeasurement;
    if (parsed.status === "error" || !parsed.agents) return [];
    // Sort by RSS descending (largest first — eviction targets the biggest)
    return parsed.agents
      .map(a => ({ name: a.name, rssBytes: a.rssBytes }))
      .sort((a, b) => b.rssBytes - a.rssBytes);
  } catch { return []; }
}

/** Check if an agent is idle (no active tool calls, no pending prompts).
 *  Best-effort heuristic via tmux capture-pane. BIASED TOWARD SAFETY:
 *  an ambiguous read (noise, connection loss, multi-line output, or any
 *  content that isn't clearly a settled prompt) is treated as NOT idle.
 *  A false idle → parks a busy agent and loses work. A false busy →
 *  skips this candidate and picks the next one (or does nothing). The
 *  cost asymmetry is large, so we default to "not idle" when uncertain. */
function isAgentIdle(name: string): boolean {
  try {
    const session = `agent-${name}`;
    // Capture last 8 lines (not 3) — a busy agent mid-response can have
    // a stray ">" in a code block or quoted text. More context reduces
    // false positives.
    const capture = execSync(
      `tmux capture-pane -t "${session}" -p 2>/dev/null | tail -8`,
      { timeout: 2000, encoding: "utf-8" },
    );
    const lines = capture.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return false; // empty pane = can't tell → assume busy

    const lastLine = lines[lines.length - 1] ?? "";
    const secondLast = lines.length >= 2 ? lines[lines.length - 2] : "";

    // Spinner characters mean the model is streaming — definitely busy.
    for (const spinner of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
      if (lastLine.includes(spinner)) return false;
    }

    // "Thinking..." or "API Error" — model is mid-turn or recovering.
    if (lastLine.includes("Thinking") || lastLine.includes("API Error")) return false;

    // A settled prompt typically ends with ">" followed by a space or end-of-line.
    // Require BOTH: ">" present AND no evidence of streaming/in-progress output.
    const hasPrompt = lastLine.includes(">");
    if (!hasPrompt) return false;

    // Additional guard: if the second-to-last line is non-empty and doesn't
    // look like completed output (ends with a prompt too, or is blank), the
    // agent might be mid-response with a ">" character in old output.
    // A truly idle agent has the cursor sitting at the prompt — the last line
    // is the ONLY line with a fresh ">".
    const secondHasPrompt = secondLast.includes(">");
    if (secondHasPrompt && !secondLast.endsWith(">")) {
      // ">" appears in both lines but not at end → likely code/output, not a prompt
      return false;
    }

    return true;
  } catch { return false; }
}

function readDashboardToken(): string | null {
  try {
    const tokenPath = resolveDataPath(DASHBOARD_TOKEN_PATH);
    if (!existsSync(tokenPath)) return null;
    return readFileSync(tokenPath, "utf-8").trim();
  } catch { return null; }
}

function writeAuditLog(entry: MemoryPressureReliefAction): void {
  const auditPath = resolveDataPath("store/runtime/memory-pressure-audit.jsonl");
  const line = JSON.stringify(entry) + "\n";
  try {
    const { appendFileSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, line, "utf-8");
  } catch { /* best-effort audit; never crash the monitor */ }
}

/**
 * Verify the agent's process tree is truly gone after a park. ALL checks use
 * the ONE authoritative collector (list-agent-rss.sh) — no separate ps
 * invocations. One definition of the process tree, everywhere.
 */
function verifyProcessTreeGone(name: string): boolean {
  try {
    // Wait for processes to settle after the stop signal
    execSync("sleep 1", { timeout: 2000 });

    // Check 1: agent absent from the shared collector output.
    const after = listAgentRss();
    const agent = after.find(a => a.name === name);
    if (!agent) return true;  // not in the tree → process tree is gone

    // Check 2: agent present but with negligible RSS. This can happen
    // when the agent is mid-exit — give it one more beat and re-check.
    if (agent.rssBytes <= 10 * 1024 * 1024) {  // <= 10 MiB = exiting
      execSync("sleep 0.5", { timeout: 1000 });
      const recheck = listAgentRss();
      const recheckAgent = recheck.find(a => a.name === name);
      if (!recheckAgent) return true;          // gone after the extra beat
      if (recheckAgent.rssBytes === 0) return true;  // fully drained
      return false;  // RSS is non-zero after two checks → park failed
    }

    // Agent present with significant RSS → park did NOT free memory.
    return false;
  } catch { return false; }
}

/**
 * Stop an agent via the dashboard's canonical stop API. This is the SAME path
 * the operator uses (POST /api/agents/:name/stop), which does:
 *   tmux kill-session + sleep 2 + reapChannelOrphans
 * and keeps run-state bookkeeping consistent.
 *
 * Falls back to direct tmux kill + orphan sweep if the dashboard is unreachable
 * (e.g. the dashboard itself is the OOM victim and its event loop is blocked).
 */
function stopAgentViaApi(name: string): boolean {
  const token = readDashboardToken();
  if (!token) return false;

  try {
    const stopUrl = `http://localhost:${DASHBOARD_PORT}/api/agents/${encodeURIComponent(name)}/stop`;
    const result = execSync(
      `curl -s --max-time 8 -X POST "${stopUrl}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      { timeout: 10000, encoding: "utf-8" },
    );
    const parsed = JSON.parse(result.trim());
    return parsed.ok === true;
  } catch {
    return false; // dashboard unreachable or returned an error
  }
}

/**
 * Fallback stop: direct tmux kill-session + settle + orphan sweep.
 * Used when the dashboard stop API is unreachable. Less precise than the
 * canonical stopAgentProcess path (cannot call reapChannelOrphans because
 * that function lives inside the dashboard process), but still does a
 * best-effort cleanup of surviving processes.
 */
function stopAgentFallback(name: string): void {
  try {
    execSync(`tmux kill-session -t "agent-${name}" 2>/dev/null`, { timeout: 5000 });
  } catch { /* session may already be gone */ }

  // Let processes settle — tmux sends SIGHUP, children need time to exit
  try {
    execSync("sleep 2", { timeout: 4000 });
  } catch { /* timeout on sleep is harmless */ }

  // Sweep surviving processes.
  try {
    execSync(`pkill -f "agent-${name}" 2>/dev/null || true`, { timeout: 3000 });
  } catch { /* pkill returns non-zero if no matches — that's fine */ }

  // Extra beat for pkill to take effect
  try {
    execSync("sleep 1", { timeout: 2000 });
  } catch { /* harmless */ }
}

/**
 * Check whether RSS measurement is available for eviction selection.
 * Reads the state file to get measurementCapabilities — if we can't
 * measure agent RSS, we can't safely pick an eviction candidate.
 */
function canMeasureForEviction(): boolean {
  try {
    const state = readState();
    if (!state) return false;
    const caps = state.measurementCapabilities;
    if (!caps) {
      // Pre-v2 state file — check lastMeasurementStatus as proxy
      return state.lastMeasurementStatus !== "failed";
    }
    return caps.agentProcessTreeRss === "ok" || caps.agentProcessTreeRss === "partial";
  } catch {
    return false;
  }
}

/**
 * Active pressure relief. Called by the monitor when state transitions to
 * critical or emergency. At most ONE agent per cycle. NEVER touches core agents.
 *
 * v2: refuses to evict when RSS measurement is unavailable — cannot safely
 * select candidates without measurement. Returns null with auditable reason.
 */
export function relievePressure(state: MemoryPressureState): MemoryPressureReliefAction | null {
  // ── v2: gate eviction on measurement availability ────────────────────
  if (!canMeasureForEviction()) {
    const action: MemoryPressureReliefAction = {
      timestamp: new Date().toISOString(),
      action: "parked",
      agentName: "",
      pidTreeKilled: [],
      rssFreedGiB: 0,
      reason: `eviction-blocked: RSS measurement unavailable — cannot safely select eviction candidate (pressureState=${state})`,
    };
    writeAuditLog(action);
    return action;  // Return the blocked-action so the monitor records it
  }

  const config = loadConfig();
  const agents = listAgentRss();

  // ── v2: empty agent list with measurement ok means genuinely zero agents ─
  // (measurement unavailability is already handled above)

  // Filter: non-core only, idle only
  const candidates = agents.filter(a => {
    if (config.coreAgents.includes(a.name)) return false;
    return isAgentIdle(a.name);
  });

  if (candidates.length === 0) return null;

  // Pick the largest idle non-core agent
  const target = candidates[0];

  // Record pre-stop RSS for the audit log before we free it
  const rssBeforeBytes = target.rssBytes;
  const rssBeforeGiB = rssBeforeBytes / 1073741824;

  try {
    // Verify the agent session still exists before we try to stop it
    const existsBefore = execSync(
      `tmux ls 2>/dev/null | grep -c "^agent-${target.name}:" || echo 0`,
      { timeout: 2000, encoding: "utf-8" },
    );
    if (Number(existsBefore.trim()) === 0) return null; // already gone, race with manual stop

    // PRIMARY PATH: dashboard stop API (kill-session + settle + reapChannelOrphans).
    const apiSuccess = stopAgentViaApi(target.name);

    if (!apiSuccess) {
      // FALLBACK: dashboard unreachable — direct stop with orphan sweep.
      stopAgentFallback(target.name);
    }

    // VERIFY: the process tree is actually gone.
    const verified = verifyProcessTreeGone(target.name);

    const action: MemoryPressureReliefAction = {
      timestamp: new Date().toISOString(),
      action: "parked",
      agentName: target.name,
      pidTreeKilled: [],
      rssFreedGiB: verified ? rssBeforeGiB : 0,
      reason: `memory-pressure-${state}: rssBefore=${rssBeforeGiB.toFixed(1)}GiB agent=${target.name} apiStop=${apiSuccess} verified=${verified}`,
    };

    writeAuditLog(action);
    return action;
  } catch (err) {
    // Failed to park — log and move on. Never crash the monitor.
    const action: MemoryPressureReliefAction = {
      timestamp: new Date().toISOString(),
      action: "parked",
      agentName: target.name,
      pidTreeKilled: [],
      rssFreedGiB: 0,
      reason: `relief-failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
    writeAuditLog(action);
    return action;
  }
}

/**
 * Update the state file's lastAction field after a successful park.
 * Called by the monitor so the gate can read which agent was last parked.
 */
export function updateStateAction(action: MemoryPressureReliefAction | null): void {
  if (!action) return;
  const statePath = resolveStatePath();
  try {
    if (!existsSync(statePath)) return;
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as MemoryPressureStateFile;
    state.lastAction = action;
    const tmp = statePath + ".tmp";
    const { writeFileSync, renameSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, statePath);
  } catch { /* best-effort */ }
}
